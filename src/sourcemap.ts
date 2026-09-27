import type { Edit } from './types';

/**
 * Source map v3 object, as accepted by Vite's `transform` hook (`map`)
 */
interface SourceMap {
	version: 3;
	sources: string[];
	sourcesContent: string[];
	names: string[];
	mappings: string;
}

/**
 * The inputs of one source map generation
 */
interface EditSourceMapOptions {
	/** The original source code */
	source: string;
	/** Sorted, non-overlapping edits, each replacing a `[start, end)` character range */
	edits: readonly Edit[];
	/** The original file name or path, used as the single source entry of the map */
	file: string;
}

/**
 * One segment of a decoded `mappings` field that points into a source
 */
interface MappedSegment {
	generatedColumn: number;
	sourceIndex: number;
	originalLine: number;
}

const BASE64_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const WORD_CHARACTER_REGEX = /\w/;
const ASCII_LIMIT = 128;
const NEWLINE_CODE = 10;
const NOT_FOUND = -1;
const VLQ_DIGIT_BITS = 5;
const VLQ_VALUE_MASK = 31;
const VLQ_CONTINUATION_FLAG = 32;
/** The widest shift a VLQ digit may be read at while the decoded value still fits a 32-bit integer */
const VLQ_SHIFT_LIMIT = 25;
const UNMAPPED_SEGMENT_LENGTH = 1;
const MAPPED_SEGMENT_LENGTH = 4;
const NAMED_SEGMENT_LENGTH = 5;

/**
 * The value of each base64 digit, indexed by ASCII character code; `-1` for a character that is not a digit
 */
const BASE64_VALUES = Int8Array.from({ length: ASCII_LIMIT }, (_, code) =>
	BASE64_CHARACTERS.indexOf(String.fromCharCode(code)),
);

/**
 * `1` for each ASCII character code `WORD_CHARACTER_REGEX` matches, which is the definition of a word character
 * magic-string's `hires: 'boundary'` mode uses; every code outside ASCII is a non-word character
 */
const WORD_CHARACTER_TABLE = Uint8Array.from({ length: ASCII_LIMIT }, (_, code) =>
	WORD_CHARACTER_REGEX.test(String.fromCharCode(code)) ? 1 : 0,
);

/**
 * Encodes a single integer value as a base64 VLQ (Variable Length Quantity) string.
 *
 * @remarks
 * Base64 VLQ is the encoding format used for numbers in source map `mappings` fields.
 * This function encodes both positive and negative integers using bitwise operations,
 * setting the least significant bit for sign and using continuation bits for multi-digit numbers.
 *
 * @param value - The integer to encode. Can be positive, negative, or zero.
 *
 * @returns The VLQ Base64-encoded string representation.
 *
 * @see [Source Map V3 Spec](https://sourcemaps.info/spec.html)
 */
function encodeVlq(value: number): string {
	let vlq = value < 0 ? (-value << 1) | 1 : value << 1;
	let output = '';

	do {
		let digit = vlq & VLQ_VALUE_MASK;

		vlq >>>= VLQ_DIGIT_BITS;

		if (vlq > 0) {
			digit |= VLQ_CONTINUATION_FLAG;
		}

		output += BASE64_CHARACTERS.charAt(digit);
	} while (vlq > 0);

	return output;
}

/**
 * Decodes the `mappings` field of a source map into the segments of each generated line.
 *
 * @remarks
 * Only what locating an original line needs is kept: the original column and the name index are read, so that the
 * values after them stay aligned, and then dropped. A segment mapping its column to no source is dropped too, though
 * its column still moves the next one.
 *
 * @param mappings - The `mappings` field, as found in a map another tool produced.
 *
 * @returns One array per generated line, holding its segments in column order.
 *
 * @throws When the field is not valid base64 VLQ, which a caller reading a third-party map has to recover from.
 *
 * @see [Source Map V3 Spec](https://sourcemaps.info/spec.html)
 */
function decodeMappings(mappings: string): MappedSegment[][] {
	const LINES: MappedSegment[][] = [];
	const FIELDS: number[] = [];

	let segments: MappedSegment[] = [];
	let generatedColumn = 0;
	let sourceIndex = 0;
	let originalLine = 0;
	let value = 0;
	let shift = 0;

	/**
	 * Closes the segment whose fields were just read, advancing the running positions by its relative values.
	 *
	 * @throws When the segment carries a number of fields the specification does not define.
	 */
	function endSegment(): void {
		const [GENERATED_COLUMN = 0, SOURCE_INDEX = 0, ORIGINAL_LINE = 0] = FIELDS;
		const FIELD_COUNT = FIELDS.length;

		FIELDS.length = 0;
		generatedColumn += GENERATED_COLUMN;

		if (FIELD_COUNT === UNMAPPED_SEGMENT_LENGTH) {
			return;
		}

		if (FIELD_COUNT !== MAPPED_SEGMENT_LENGTH && FIELD_COUNT !== NAMED_SEGMENT_LENGTH) {
			throw new Error(`decodeMappings found a segment of ${FIELD_COUNT} fields`);
		}

		sourceIndex += SOURCE_INDEX;
		originalLine += ORIGINAL_LINE;
		segments.push({ generatedColumn, sourceIndex, originalLine });
	}

	for (let index = 0; index <= mappings.length; index++) {
		const CHARACTER = mappings.charAt(index);

		if (CHARACTER === ',' || CHARACTER === ';' || CHARACTER === '') {
			if (shift !== 0) {
				throw new Error('decodeMappings found a truncated VLQ value');
			}

			if (FIELDS.length > 0) {
				endSegment();
			}

			if (CHARACTER !== ',') {
				LINES.push(segments);
				segments = [];
				generatedColumn = 0;
			}

			continue;
		}

		const DIGIT = BASE64_VALUES[CHARACTER.charCodeAt(0)] ?? NOT_FOUND;

		if (DIGIT === NOT_FOUND || shift > VLQ_SHIFT_LIMIT) {
			throw new Error(`decodeMappings found an invalid VLQ digit at index ${index}`);
		}

		value |= (DIGIT & VLQ_VALUE_MASK) << shift;

		if ((DIGIT & VLQ_CONTINUATION_FLAG) !== 0) {
			shift += VLQ_DIGIT_BITS;
			continue;
		}

		FIELDS.push((value & 1) === 1 ? -(value >>> 1) : value >>> 1);
		value = 0;
		shift = 0;
	}

	return LINES;
}

function isWordCharacter(code: number): boolean {
	return code < ASCII_LIMIT && WORD_CHARACTER_TABLE[code] === 1;
}

/**
 * Builds the `mappings` string one generated line at a time, encoding every segment as deltas from the previous one
 */
class MappingsWriter {
	readonly #lines: string[] = [];
	#segments: string[] = [];
	#lastGeneratedColumn = 0;
	#lastOriginalLine = 0;
	#lastOriginalColumn = 0;

	addSegment(generatedColumn: number, originalLine: number, originalColumn: number): void {
		// The source index delta is always `A` (zero): the map names a single source
		this.#segments.push(
			`${encodeVlq(generatedColumn - this.#lastGeneratedColumn)}A${encodeVlq(originalLine - this.#lastOriginalLine)}${encodeVlq(originalColumn - this.#lastOriginalColumn)}`,
		);
		this.#lastGeneratedColumn = generatedColumn;
		this.#lastOriginalLine = originalLine;
		this.#lastOriginalColumn = originalColumn;
	}

	endLine(): void {
		this.#lines.push(this.#segments.join(','));
		this.#segments = [];
		this.#lastGeneratedColumn = 0;
	}

	toString(): string {
		this.endLine();

		return this.#lines.join(';');
	}
}

/**
 * Generates a source map for a given source with the specified edits applied.
 *
 * The kept text is described the way magic-string's `hires: 'boundary'` mode describes it: every non-word character
 * carries a segment of its own, and a run of word characters (`\w`) carries one segment at its first character. A run
 * is cut at each line start and at each edit, so that the first character following an edit always resolves to its
 * true original position. The text an edit inserts is emitted as a single segment pointing at the start of the range
 * it replaces, and a removed range emits nothing.
 *
 * @param options - The source, the edits to map, and the file to name as the map's single source.
 *
 * @returns The generated SourceMap object, whose `sourcesContent` carries the original source.
 *
 * @throws When an edit inserts a newline, which the single-segment encoding of a replacement cannot describe.
 */
function generateEditSourceMap(options: EditSourceMapOptions): SourceMap {
	const { source, edits, file } = options;
	const HAS_MULTILINE_REPLACEMENT = edits.some((edit) => edit.replacement.includes('\n'));

	if (HAS_MULTILINE_REPLACEMENT) {
		throw new Error('generateEditSourceMap cannot map a replacement containing a newline');
	}

	const WRITER = new MappingsWriter();

	let generatedColumn = 0;
	let originalLine = 0;
	let originalColumn = 0;

	/**
	 * Emits the segments of the kept range `[from, to)`, advancing the generated and original positions through it.
	 *
	 * @param from - Start index of the kept range in the original source.
	 * @param to - End index, exclusive, of the kept range.
	 */
	function writeKept(from: number, to: number): void {
		// Starts `false` so that the first character of the range, which follows an edit, always opens a segment
		let isInWord = false;

		for (let index = from; index < to; index++) {
			const CODE = source.charCodeAt(index);

			if (CODE === NEWLINE_CODE) {
				WRITER.endLine();

				generatedColumn = 0;
				originalLine++;
				originalColumn = 0;
				isInWord = false;
				continue;
			}

			const IS_WORD_CHARACTER = isWordCharacter(CODE);

			if (!IS_WORD_CHARACTER || !isInWord) {
				WRITER.addSegment(generatedColumn, originalLine, originalColumn);
			}

			isInWord = IS_WORD_CHARACTER;
			generatedColumn++;
			originalColumn++;
		}
	}

	/**
	 * Advances the original position over a replaced range, which the generated code no longer holds.
	 *
	 * @param from - Start index of the replaced range in the original source.
	 * @param to - End index, exclusive, of the replaced range.
	 */
	function skipReplaced(from: number, to: number): void {
		for (let index = from; index < to; index++) {
			if (source.charCodeAt(index) === NEWLINE_CODE) {
				originalLine++;
				originalColumn = 0;
			} else {
				originalColumn++;
			}
		}
	}

	let cursor = 0;

	// Emit the kept text before each edit and then its replacement, then advance the original position through the
	// replaced content; whatever follows the last edit is emitted afterward
	for (const EDIT of edits) {
		writeKept(cursor, EDIT.start);

		if (EDIT.replacement !== '') {
			WRITER.addSegment(generatedColumn, originalLine, originalColumn);

			generatedColumn += EDIT.replacement.length;
		}

		skipReplaced(EDIT.start, EDIT.end);
		cursor = EDIT.end;
	}

	writeKept(cursor, source.length);

	return { version: 3, sources: [file], sourcesContent: [source], names: [], mappings: WRITER.toString() };
}

export type { EditSourceMapOptions, MappedSegment, SourceMap };

export { decodeMappings, encodeVlq, generateEditSourceMap };
