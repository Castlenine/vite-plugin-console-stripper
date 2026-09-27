import type { Edit } from './types';

import { readFileSync } from 'node:fs';

import { decodedMappings, TraceMap, originalPositionFor as traceOriginalPosition } from '@jridgewell/trace-mapping';
import { describe, expect, it } from 'vitest';
import remapping from '@jridgewell/remapping';

import { applyEdits, createScanContext, getOptions, scanConsoleCalls } from './utilities';
import { decodeMappings as decodeSourceMappings, encodeVlq, generateEditSourceMap } from './sourcemap';

const BASE64_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

type Segment = [generatedColumn: number, originalLine: number, originalColumn: number];

/**
 * Decodes a string of Base64 VLQ-encoded values into an array of numbers.
 *
 * VLQ (Variable Length Quantity) is used in source maps to efficiently encode numbers.
 * Each value in the input string is decoded by interpreting Base64-encoded segments,
 * handling sign and multi-byte sequences according to the VLQ specification.
 *
 * @param input - The Base64 VLQ-encoded string to decode.
 *
 * @returns An array of decoded numbers.
 */
function decodeVlqs(input: string): number[] {
	const VALUES: number[] = [];

	let value = 0;
	let shift = 0;

	for (const CHARACTER of input) {
		const DIGIT = BASE64_CHARACTERS.indexOf(CHARACTER);

		value += (DIGIT & 31) << shift;
		shift += 5;

		if ((DIGIT & 32) === 0) {
			VALUES.push(value & 1 ? -(value >>> 1) : value >>> 1);
			value = 0;
			shift = 0;
		}
	}

	return VALUES;
}

/**
 * Decodes a VLQ-encoded source map `mappings` string into absolute segments per generated line.
 *
 * This function parses the `mappings` string from a source map, accumulating segment deltas into absolute positions.
 * Each decoded segment is a tuple representing the column in the generated file, the corresponding original line,
 * and the original column (all zero-based). It assumes only one source file (source index is dropped).
 *
 * @param mappings - The VLQ-encoded mappings string from a source map.
 *
 * @returns An array of segments for each generated line. Each segment is a tuple of `[generatedColumn, originalLine, originalColumn]`.
 */
function decodeMappings(mappings: string): Segment[][] {
	let originalLine = 0;
	let originalColumn = 0;

	return mappings.split(';').map((line) => {
		let generatedColumn = 0;

		return line
			.split(',')
			.filter((segment) => segment !== '')
			.map((segment) => {
				const [generatedDelta = 0, , lineDelta = 0, columnDelta = 0] = decodeVlqs(segment);

				generatedColumn += generatedDelta;
				originalLine += lineDelta;
				originalColumn += columnDelta;

				return [generatedColumn, originalLine, originalColumn];
			});
	});
}

/**
 * Resolves the original position (`line` and `column`, both 1-based) for a given position in the generated code,
 * as interpreted from a VLQ source map mappings string.
 *
 * The lookup mimics the behavior of a source map consumer: it finds the closest mapping segment whose generated
 * column is less than or equal to the provided column, and returns the corresponding original line and column. If
 * there is no such mapping segment, returns `null`.
 *
 * @param mappings - The VLQ-encoded source map `mappings` string.
 * @param line - The 1-based generated line number for which to resolve the original position.
 * @param column - The 1-based generated column number for which to resolve the original position.
 *
 * @returns An object with the original `line` (1-based) and `column` (0-based), or `null` if not found.
 */
function originalPositionFor(mappings: string, line: number, column: number): { line: number; column: number } | null {
	const SEGMENTS = decodeMappings(mappings)[line - 1] ?? [];
	const MATCH = SEGMENTS.filter(([generatedColumn]) => generatedColumn <= column).at(-1);

	return MATCH ? { line: MATCH[1] + 1, column: MATCH[2] } : null;
}

/**
 * Collects the edits the plugin would apply to the given source with the default options.
 *
 * @param source - The source to scan.
 *
 * @returns The edits, in source order.
 */
function getEdits(source: string): Edit[] {
	return scanConsoleCalls(source, createScanContext(getOptions(), 'script')).edits;
}

/**
 * Lists the integers of the half-open `[from, to)` range.
 *
 * @param from - The first integer of the range.
 * @param to - The integer closing the range, which is not part of it.
 *
 * @returns The integers of the range, in order.
 */
function listRange(from: number, to: number): number[] {
	return Array.from({ length: Math.max(0, to - from) }, (_, offset) => from + offset);
}

/**
 * Resolves, for each character of the edited output, the index it comes from in the original source.
 *
 * The characters an edit inserts all come from the start of the range that edit replaces, which is the position the
 * map is expected to point them at.
 *
 * @param source - The original source.
 * @param edits - The edits applied to it, in source order.
 *
 * @returns One original index per character of the edited output.
 */
function getOriginIndexes(source: string, edits: readonly Edit[]): number[] {
	const EDITED = edits.map((edit, index) => [
		...listRange(index === 0 ? 0 : (edits[index - 1]?.end ?? 0), edit.start),
		...listRange(0, edit.replacement.length).map(() => edit.start),
	]);

	return [...EDITED.flat(), ...listRange(edits.at(-1)?.end ?? 0, source.length)];
}

/**
 * Resolves the line and column of a character index in a source.
 *
 * @param source - The source holding the index.
 * @param index - The character index to locate.
 *
 * @returns The 1-based line and the 0-based column of the index.
 */
function getPositionOf(source: string, index: number): { line: number; column: number } {
	const LINES = source.slice(0, index).split('\n');

	return { line: LINES.length, column: (LINES.at(-1) ?? '').length };
}

/**
 * Asserts that every non-empty generated line starts on the original position its first character comes from.
 *
 * @param source - The source to map.
 * @param edits - The edits applied to it, in source order.
 */
function expectLineStartsMapped(source: string, edits: readonly Edit[]): void {
	const MAPPINGS = generateEditSourceMap({ source, edits, file: 'x.ts' }).mappings;
	const ORIGINS = getOriginIndexes(source, edits);

	let generatedIndex = 0;

	applyEdits(source, edits)
		.split('\n')
		.forEach((line, lineIndex) => {
			if (line !== '') {
				expect(originalPositionFor(MAPPINGS, lineIndex + 1, 0)).toEqual(
					getPositionOf(source, ORIGINS[generatedIndex] ?? 0),
				);
			}

			generatedIndex += line.length + 1;
		});
}

describe('encodeVlq', () => {
	it('encodes small, negative and multi-digit values', () => {
		expect(encodeVlq(0)).toBe('A');
		expect(encodeVlq(1)).toBe('C');
		expect(encodeVlq(-1)).toBe('D');
		expect(encodeVlq(15)).toBe('e');
		expect(encodeVlq(16)).toBe('gB');
		expect(encodeVlq(32)).toBe('gC');
		expect(encodeVlq(-1000)).toBe('x+B');
	});

	it('round-trips through the test decoder', () => {
		const VALUES = [0, 1, -1, 31, 32, 1023, -1024, 123456];

		expect(decodeVlqs(VALUES.map(encodeVlq).join(''))).toEqual(VALUES);
	});
});

describe('decodeMappings', () => {
	it('decodes absolute segments line by line, dropping the unmapped ones', () => {
		expect(decodeSourceMappings('AAAA,SACA;;CADA,K')).toEqual([
			[
				{ generatedColumn: 0, sourceIndex: 0, originalLine: 0 },
				{ generatedColumn: 9, sourceIndex: 0, originalLine: 1 },
			],
			[],
			[{ generatedColumn: 1, sourceIndex: 0, originalLine: 0 }],
		]);
	});

	it('lets an unmapped segment move the column of the next one', () => {
		expect(decodeSourceMappings('K,AAAA')).toEqual([[{ generatedColumn: 5, sourceIndex: 0, originalLine: 0 }]]);
	});

	it('decodes an empty field as a single empty line', () => {
		expect(decodeSourceMappings('')).toEqual([[]]);
	});

	it('matches trace-mapping on the source map Astro attaches to a compiled component', () => {
		const COMPILED = readFileSync(
			new URL('../tests/fixtures/astro-compiled/index.compiled.js', import.meta.url),
			'utf8',
		);
		const PAYLOAD = /base64,([\w+/=]+)/.exec(COMPILED)?.[1] ?? '';
		const MAP = JSON.parse(Buffer.from(PAYLOAD, 'base64').toString('utf8')) as { mappings: string };
		const EXPECTED = decodedMappings(new TraceMap(MAP as ConstructorParameters<typeof TraceMap>[0])).map((line) =>
			line
				.filter((segment) => segment.length > 1)
				.map((segment) => ({ generatedColumn: segment[0], sourceIndex: segment[1], originalLine: segment[2] })),
		);

		expect(EXPECTED.flat().length).toBeGreaterThan(0);
		expect(decodeSourceMappings(MAP.mappings)).toEqual(EXPECTED);
	});

	it('rejects a field that is not base64 VLQ', () => {
		expect(() => decodeSourceMappings('AA!A')).toThrow('decodeMappings found an invalid VLQ digit at index 2');
		expect(() => decodeSourceMappings('g')).toThrow('decodeMappings found a truncated VLQ value');
		expect(() => decodeSourceMappings('AA')).toThrow('decodeMappings found a segment of 2 fields');
		expect(() => decodeSourceMappings('ggggggA')).toThrow('decodeMappings found an invalid VLQ digit at index 6');
		expect(() => decodeSourceMappings('AAéA')).toThrow('decodeMappings found an invalid VLQ digit at index 2');
	});
});

describe('generateEditSourceMap', () => {
	const SOURCE = 'const a = 1;\nconsole.log(a);\nconst b = console.log(a) ?? 2;\n';
	const EDITS = getEdits(SOURCE);
	const MAP = generateEditSourceMap({ source: SOURCE, edits: EDITS, file: '/repo/src/app.ts' });

	it('describes the single original source', () => {
		expect(applyEdits(SOURCE, EDITS)).toBe('const a = 1;\nconst b = void 0 ?? 2;\n');
		expect(MAP).toMatchObject({
			version: 3,
			sources: ['/repo/src/app.ts'],
			sourcesContent: [SOURCE],
			names: [],
		});
	});

	it('has one mappings line per generated line', () => {
		expect(MAP.mappings.split(';')).toHaveLength(3);
	});

	it('describes a line no edit touches with a segment per non-word character and per word start', () => {
		// `const a = 1;`: the words `const`, `a` and `1` open one segment each, every other character has its own
		expect(decodeMappings(MAP.mappings)[0]).toEqual([
			[0, 0, 0],
			[5, 0, 5],
			[6, 0, 6],
			[7, 0, 7],
			[8, 0, 8],
			[9, 0, 9],
			[10, 0, 10],
			[11, 0, 11],
		]);
		expect(originalPositionFor(MAP.mappings, 1, 6)).toEqual({ line: 1, column: 6 });
		// A character inside a word resolves to the start of that word
		expect(originalPositionFor(MAP.mappings, 1, 3)).toEqual({ line: 1, column: 0 });
	});

	it('maps the line that moved up over a removed one to its own original line', () => {
		expect(originalPositionFor(MAP.mappings, 2, 0)).toEqual({ line: 3, column: 0 });
	});

	it('leaves a blank line of the original source unmapped', () => {
		const BLANK = 'const a = 1;\n\nconsole.log(1);\n\nconst b = 2;\n';
		const BLANK_EDITS = getEdits(BLANK);
		const BLANK_MAP = generateEditSourceMap({ source: BLANK, edits: BLANK_EDITS, file: 'blank.ts' });

		expect(applyEdits(BLANK, BLANK_EDITS)).toBe('const a = 1;\n\n\nconst b = 2;\n');
		expect(originalPositionFor(BLANK_MAP.mappings, 2, 0)).toBeNull();
		expect(originalPositionFor(BLANK_MAP.mappings, 4, 0)).toEqual({ line: 5, column: 0 });
		expectLineStartsMapped(BLANK, BLANK_EDITS);
	});

	it('maps the inserted replacement to the start of the call it replaces', () => {
		expect(originalPositionFor(MAP.mappings, 2, 10)).toEqual({ line: 3, column: 10 });
	});

	it('maps the token following a replacement to its original column', () => {
		// `const b = console.log(a) ?? 2;` became `const b = void 0 ?? 2;`
		expect(originalPositionFor(MAP.mappings, 2, 16)).toEqual({ line: 3, column: 24 });
		expect(originalPositionFor(MAP.mappings, 2, 20)).toEqual({ line: 3, column: 28 });
	});

	it('maps the token following an inline removal to its original column', () => {
		const INLINE = 'foo(); console.log(1); bar();';
		const INLINE_EDITS = getEdits(INLINE);
		const INLINE_MAP = generateEditSourceMap({ source: INLINE, edits: INLINE_EDITS, file: 'inline.ts' });

		expect(applyEdits(INLINE, INLINE_EDITS)).toBe('foo();  bar();');
		expect(originalPositionFor(INLINE_MAP.mappings, 1, 8)).toEqual({ line: 1, column: 23 });
		expectLineStartsMapped(INLINE, INLINE_EDITS);
	});

	it('maps a line that moved up after a multiline call was removed', () => {
		const MULTILINE = "const a = 1;\nconsole.log(\n\t'x',\n);\nconst b = 2;\n";
		const MULTILINE_EDITS = getEdits(MULTILINE);
		const MULTILINE_MAP = generateEditSourceMap({ source: MULTILINE, edits: MULTILINE_EDITS, file: 'multiline.ts' });

		expect(applyEdits(MULTILINE, MULTILINE_EDITS)).toBe('const a = 1;\nconst b = 2;\n');
		expect(originalPositionFor(MULTILINE_MAP.mappings, 2, 0)).toEqual({ line: 5, column: 0 });
		expectLineStartsMapped(MULTILINE, MULTILINE_EDITS);
	});

	it('maps the tail a multiline replacement joined to the line the call opened on', () => {
		const JOINED = 'const a = console.log(\n\t1,\n) ?? 2;\nnext();\n';
		const JOINED_EDITS = getEdits(JOINED);
		const JOINED_MAP = generateEditSourceMap({ source: JOINED, edits: JOINED_EDITS, file: 'joined.ts' });

		expect(applyEdits(JOINED, JOINED_EDITS)).toBe('const a = void 0 ?? 2;\nnext();\n');
		// `void 0` spans the generated columns 10 to 15, so the kept tail resumes at 16, on the original line 3
		expect(originalPositionFor(JOINED_MAP.mappings, 1, 10)).toEqual({ line: 1, column: 10 });
		expect(originalPositionFor(JOINED_MAP.mappings, 1, 16)).toEqual({ line: 3, column: 1 });
		expect(originalPositionFor(JOINED_MAP.mappings, 1, 20)).toEqual({ line: 3, column: 5 });
		expectLineStartsMapped(JOINED, JOINED_EDITS);
	});

	it('maps every line of a file whose lines end with a carriage return', () => {
		const CRLF = 'const a = 1;\r\nconsole.log(a);\r\nconst b = console.log(a) ?? 2;\r\nconst c = 3;\r\n';
		const CRLF_EDITS = getEdits(CRLF);
		const CRLF_MAP = generateEditSourceMap({ source: CRLF, edits: CRLF_EDITS, file: 'crlf.ts' });

		expect(applyEdits(CRLF, CRLF_EDITS)).toBe('const a = 1;\r\nconst b = void 0 ?? 2;\r\nconst c = 3;\r\n');
		expect(originalPositionFor(CRLF_MAP.mappings, 2, 16)).toEqual({ line: 3, column: 24 });
		expect(originalPositionFor(CRLF_MAP.mappings, 3, 0)).toEqual({ line: 4, column: 0 });
		expectLineStartsMapped(CRLF, CRLF_EDITS);
	});

	it('maps every line following a whole-line removal to its true original position', () => {
		const CASES = [
			{
				source: 'const a = 1;\nconsole.log(1);\nconst b = 2;\nconst c = 3;\n',
				stripped: 'const a = 1;\nconst b = 2;\nconst c = 3;\n',
				movedFromLine: 3,
			},
			{
				source: 'const a = 1;\n\tconsole.log(\n\t\t1,\n\t);\nconst b = 2;\nconst c = 3;\n',
				stripped: 'const a = 1;\nconst b = 2;\nconst c = 3;\n',
				movedFromLine: 5,
			},
			{
				source: 'const a = 1;\r\nconsole.log(1);\r\nconst b = 2;\r\nconst c = 3;\r\n',
				stripped: 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n',
				movedFromLine: 3,
			},
			{
				source: 'const a = 1;\r\n\tconsole.log(\r\n\t\t1,\r\n\t);\r\nconst b = 2;\r\nconst c = 3;\r\n',
				stripped: 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n',
				movedFromLine: 5,
			},
		];

		CASES.forEach((removal) => {
			const EDITS = getEdits(removal.source);
			const MAPPINGS = generateEditSourceMap({ source: removal.source, edits: EDITS, file: 'line.ts' }).mappings;

			expect(applyEdits(removal.source, EDITS)).toBe(removal.stripped);
			expect(originalPositionFor(MAPPINGS, 2, 0)).toEqual({ line: removal.movedFromLine, column: 0 });
			expect(originalPositionFor(MAPPINGS, 3, 0)).toEqual({ line: removal.movedFromLine + 1, column: 0 });
			expectLineStartsMapped(removal.source, EDITS);
		});
	});

	it('counts a character outside the basic plane as the two columns it occupies', () => {
		const ASTRAL = 'const a = "😀😀" + console.log(1);\nconst b = 2;\n';
		const ASTRAL_EDITS = getEdits(ASTRAL);
		const ASTRAL_MAP = generateEditSourceMap({ source: ASTRAL, edits: ASTRAL_EDITS, file: 'astral.ts' });

		expect(applyEdits(ASTRAL, ASTRAL_EDITS)).toBe('const a = "😀😀" + void 0;\nconst b = 2;\n');
		// The two surrogate pairs of the string literal push the call to the column 19
		expect(originalPositionFor(ASTRAL_MAP.mappings, 1, 6)).toEqual({ line: 1, column: 6 });
		expect(originalPositionFor(ASTRAL_MAP.mappings, 1, 19)).toEqual({ line: 1, column: 19 });
		expect(originalPositionFor(ASTRAL_MAP.mappings, 1, 25)).toEqual({ line: 1, column: 33 });
		expectLineStartsMapped(ASTRAL, ASTRAL_EDITS);
	});

	it('maps a file whose first character starts an edit', () => {
		const AT_START = 'console.log(1);\nconst a = 1;\n';
		const AT_START_EDITS = getEdits(AT_START);
		const REPLACED = 'console.log(1) ?? fallback();\nconst a = 1;\n';
		const REPLACED_EDITS = getEdits(REPLACED);
		const REPLACED_MAP = generateEditSourceMap({ source: REPLACED, edits: REPLACED_EDITS, file: 'start.ts' });

		expect(applyEdits(AT_START, AT_START_EDITS)).toBe('const a = 1;\n');
		expect(applyEdits(REPLACED, REPLACED_EDITS)).toBe('void 0 ?? fallback();\nconst a = 1;\n');
		expect(originalPositionFor(REPLACED_MAP.mappings, 1, 0)).toEqual({ line: 1, column: 0 });
		expect(originalPositionFor(REPLACED_MAP.mappings, 1, 6)).toEqual({ line: 1, column: 14 });
		expectLineStartsMapped(AT_START, AT_START_EDITS);
		expectLineStartsMapped(REPLACED, REPLACED_EDITS);
	});

	it('maps a file whose last character ends an edit', () => {
		const AT_END = 'const a = 1;\nconsole.log(a);';
		const AT_END_EDITS = getEdits(AT_END);
		const REPLACED = 'const a = 1;\nconst b = console.log(a)';
		const REPLACED_EDITS = getEdits(REPLACED);
		const REPLACED_MAP = generateEditSourceMap({ source: REPLACED, edits: REPLACED_EDITS, file: 'end.ts' });

		expect(applyEdits(AT_END, AT_END_EDITS)).toBe('const a = 1;\n');
		expect(applyEdits(REPLACED, REPLACED_EDITS)).toBe('const a = 1;\nconst b = void 0');
		expect(originalPositionFor(REPLACED_MAP.mappings, 2, 10)).toEqual({ line: 2, column: 10 });
		expectLineStartsMapped(AT_END, AT_END_EDITS);
		expectLineStartsMapped(REPLACED, REPLACED_EDITS);
	});

	it('maps two edits touching each other', () => {
		const ADJACENT = 'const a = 1;\nconsole.log(1);console.log(2);\nconst b = 2;\n';
		const ADJACENT_EDITS = getEdits(ADJACENT);
		const ADJACENT_MAP = generateEditSourceMap({ source: ADJACENT, edits: ADJACENT_EDITS, file: 'adjacent.ts' });

		expect(ADJACENT_EDITS).toHaveLength(2);
		expect(ADJACENT_EDITS[0]?.end).toBe(ADJACENT_EDITS[1]?.start);
		expect(applyEdits(ADJACENT, ADJACENT_EDITS)).toBe('const a = 1;\nconst b = 2;\n');
		expect(originalPositionFor(ADJACENT_MAP.mappings, 2, 0)).toEqual({ line: 3, column: 0 });
		expectLineStartsMapped(ADJACENT, ADJACENT_EDITS);
	});

	it('emits the segments of a line in strictly increasing generated columns', () => {
		const MIXED = 'const a = 1;\nfoo(); console.log(1); bar(console.log(2), console.log(3));\nconst b = 2;\n';
		const MIXED_EDITS = getEdits(MIXED);
		const COLUMNS = decodeMappings(
			generateEditSourceMap({ source: MIXED, edits: MIXED_EDITS, file: 'mixed.ts' }).mappings,
		);

		COLUMNS.forEach((segments) => {
			const GENERATED_COLUMNS = segments.map(([generatedColumn]) => generatedColumn);

			expect(GENERATED_COLUMNS).toEqual([...GENERATED_COLUMNS].sort((first, second) => first - second));
			expect(new Set(GENERATED_COLUMNS).size).toBe(GENERATED_COLUMNS.length);
		});

		expectLineStartsMapped(MIXED, MIXED_EDITS);
	});

	it('produces an identity map without edits', () => {
		expect(decodeMappings(generateEditSourceMap({ source: 'ab\ncd', edits: [], file: 'x' }).mappings)).toEqual([
			[[0, 0, 0]],
			[[0, 1, 0]],
		]);
	});

	it('rejects a replacement holding a newline', () => {
		expect(() =>
			generateEditSourceMap({ source: 'ab', edits: [{ start: 0, end: 1, replacement: 'x\ny' }], file: 'x' }),
		).toThrow(/cannot map a replacement containing a newline/);
	});

	it('maps an insertion at the start of a file opening on a blank line', () => {
		const INSERTED = generateEditSourceMap({
			source: '\nab',
			edits: [{ start: 0, end: 0, replacement: ';' }],
			file: 'x',
		});

		expect(decodeMappings(INSERTED.mappings)).toEqual([[[0, 0, 0]], [[0, 1, 0]]]);
	});
});

describe('generateEditSourceMap fuzzing', () => {
	const CASE_COUNT = 500;
	const MAX_PIECE_COUNT = 60;
	const MAX_REMOVED_LENGTH = 6;
	const EDIT_PROBABILITY = 0.12;
	const PIECES = ['ab', 'x', '_', '9', '$', ' ', '\t', '(', ')', ';', '.', '"', '\n', '\r\n', 'é', '😀'] as const;
	const REPLACEMENTS = ['', 'void 0', '(void 0)', ';', 'q'] as const;
	const WORD_CHARACTER_REGEX = /\w/;

	/**
	 * One randomly generated source together with sorted, non-overlapping edits over it
	 */
	interface FuzzCase {
		source: string;
		edits: Edit[];
	}

	/**
	 * A 1-based line and a 0-based column, as trace-mapping reads and returns them
	 */
	interface Position {
		line: number;
		column: number;
	}

	/**
	 * Where one character of the edited output comes from
	 */
	interface GeneratedOrigin {
		/** The index of the character in the original source, or the start of the range an inserted one replaced */
		originalIndex: number;
		isInserted: boolean;
	}

	/**
	 * Builds the seeded mulberry32 generator, so that a failing case reproduces on every run.
	 *
	 * @param seed - The initial state.
	 *
	 * @returns A function returning the next pseudo-random number of `[0, 1)`.
	 */
	function createRandom(seed: number): () => number {
		let state = seed;

		return () => {
			state = (state + 0x6d2b79f5) | 0;

			let mixed = Math.imul(state ^ (state >>> 15), 1 | state);

			mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);

			return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
		};
	}

	/**
	 * Reads one entry of a list, failing the test instead of yielding `undefined` for an index out of range.
	 *
	 * @param entries - The list to read.
	 * @param index - The index of the entry.
	 *
	 * @returns The entry.
	 */
	function getAt<Entry>(entries: readonly Entry[], index: number): Entry {
		const ENTRY = entries[index];

		if (ENTRY == null) {
			throw new Error(`no entry at index ${index}`);
		}

		return ENTRY;
	}

	/**
	 * Picks one entry of a non-empty list.
	 *
	 * @param random - The generator to draw from.
	 * @param entries - The entries to pick from.
	 *
	 * @returns The picked entry.
	 */
	function pick<Entry>(random: () => number, entries: readonly Entry[]): Entry {
		return getAt(entries, Math.floor(random() * entries.length));
	}

	/**
	 * Generates one random source and random edits over it. An empty insertion is never drawn: the plugin never emits
	 * one, and it would change nothing a consumer could observe.
	 *
	 * @param random - The generator to draw from.
	 *
	 * @returns The generated case.
	 */
	function createFuzzCase(random: () => number): FuzzCase {
		const PIECE_COUNT = 1 + Math.floor(random() * MAX_PIECE_COUNT);
		const SOURCE = Array.from({ length: PIECE_COUNT }, () => pick(random, PIECES)).join('');
		const EDITS: Edit[] = [];

		let index = 0;

		while (index <= SOURCE.length) {
			if (random() < EDIT_PROBABILITY) {
				const END = Math.min(SOURCE.length, index + Math.floor(random() * MAX_REMOVED_LENGTH));
				const REPLACEMENT = pick(random, END === index ? REPLACEMENTS.slice(1) : REPLACEMENTS);

				EDITS.push({ start: index, end: END, replacement: REPLACEMENT });
				index = END + 1;
			} else {
				index++;
			}
		}

		return { source: SOURCE, edits: EDITS };
	}

	/**
	 * Resolves the 1-based line and 0-based column of every index of a text.
	 *
	 * @param text - The text to locate the indexes of.
	 *
	 * @returns One position per index, plus the position just past the end.
	 */
	function listPositions(text: string): Position[] {
		let line = 1;
		let column = 0;

		return Array.from({ length: text.length + 1 }, (_, index) => {
			const POSITION = { line, column };

			if (text.charAt(index) === '\n') {
				line++;
				column = 0;
			} else {
				column++;
			}

			return POSITION;
		});
	}

	/**
	 * Resolves, for each character of the edited output, where it comes from in the original source.
	 *
	 * @param source - The original source.
	 * @param edits - The edits applied to it, in source order.
	 *
	 * @returns One origin per character of the edited output.
	 */
	function listOrigins(source: string, edits: readonly Edit[]): GeneratedOrigin[] {
		function listKeptOrigins(from: number, to: number): GeneratedOrigin[] {
			return listRange(from, to).map((originalIndex) => ({ originalIndex, isInserted: false }));
		}

		return [
			...edits.flatMap((edit, index) => [
				...listKeptOrigins(index === 0 ? 0 : getAt(edits, index - 1).end, edit.start),
				...listRange(0, edit.replacement.length).map(() => ({ originalIndex: edit.start, isInserted: true })),
			]),
			...listKeptOrigins(edits.at(-1)?.end ?? 0, source.length),
		];
	}

	/**
	 * Resolves the original index a generated character must map to under the boundary semantics: an inserted
	 * character maps to the start of the range it replaced, a non-word character to itself, and a word character to the
	 * first character of its word, as long as the word is contiguous in the original source.
	 *
	 * @param output - The edited output.
	 * @param origins - The origin of each character of the output.
	 * @param generatedIndex - The index of the character in the output.
	 *
	 * @returns The expected original index.
	 */
	function getExpectedOriginalIndex(
		output: string,
		origins: readonly GeneratedOrigin[],
		generatedIndex: number,
	): number {
		const ORIGIN = getAt(origins, generatedIndex);

		if (ORIGIN.isInserted || !WORD_CHARACTER_REGEX.test(output.charAt(generatedIndex))) {
			return ORIGIN.originalIndex;
		}

		let tokenStart = generatedIndex;

		while (tokenStart > 0 && WORD_CHARACTER_REGEX.test(output.charAt(tokenStart - 1))) {
			const PREVIOUS = getAt(origins, tokenStart - 1);

			if (PREVIOUS.isInserted || PREVIOUS.originalIndex !== getAt(origins, tokenStart).originalIndex - 1) {
				break;
			}

			tokenStart--;
		}

		return getAt(origins, tokenStart).originalIndex;
	}

	it('resolves every generated character to its exact token start in the original source', () => {
		const RANDOM = createRandom(0x5eed);

		Array.from({ length: CASE_COUNT }, () => createFuzzCase(RANDOM)).forEach(({ source, edits }) => {
			const OUTPUT = applyEdits(source, edits);
			const ORIGINS = listOrigins(source, edits);
			const ORIGINAL_POSITIONS = listPositions(source);
			const GENERATED_POSITIONS = listPositions(OUTPUT);
			const TRACER = new TraceMap(generateEditSourceMap({ source, edits, file: 'fuzz.ts' }));

			expect(ORIGINS).toHaveLength(OUTPUT.length);

			listRange(0, OUTPUT.length)
				.filter((generatedIndex) => OUTPUT.charAt(generatedIndex) !== '\n')
				.forEach((generatedIndex) => {
					const EXPECTED = getAt(ORIGINAL_POSITIONS, getExpectedOriginalIndex(OUTPUT, ORIGINS, generatedIndex));

					expect(traceOriginalPosition(TRACER, getAt(GENERATED_POSITIONS, generatedIndex))).toMatchObject(EXPECTED);
				});
		});
	});
});

describe('generateEditSourceMap composition', () => {
	it('keeps the original columns through a chain of transforms', () => {
		const SOURCE = 'const total = compute(value) + 2;\nconsole.log(total);\nexport { total };\n';
		const STRIP_EDITS = getEdits(SOURCE);
		const STRIPPED = applyEdits(SOURCE, STRIP_EDITS);
		const RENAME_START = STRIPPED.indexOf('compute');
		const RENAME_EDITS = [{ start: RENAME_START, end: RENAME_START + 'compute'.length, replacement: 'run' }];
		const STRIP_MAP = generateEditSourceMap({ source: SOURCE, edits: STRIP_EDITS, file: 'app.ts' });
		const RENAME_MAP = generateEditSourceMap({ source: STRIPPED, edits: RENAME_EDITS, file: 'stripped.js' });
		const COMPOSED = remapping(RENAME_MAP, (file) => (file === 'stripped.js' ? STRIP_MAP : null));
		const TRACER = new TraceMap(COMPOSED.toString());

		expect(applyEdits(STRIPPED, RENAME_EDITS)).toBe('const total = run(value) + 2;\nexport { total };\n');
		expect(COMPOSED.sources).toEqual(['app.ts']);
		expect(COMPOSED.sourcesContent).toEqual([SOURCE]);
		// The first line is untouched by the strip, so only word-level segments carry its columns through the chain
		expect(traceOriginalPosition(TRACER, { line: 1, column: 14 })).toMatchObject({ line: 1, column: 14 });
		expect(traceOriginalPosition(TRACER, { line: 1, column: 18 })).toMatchObject({ line: 1, column: 22 });
		expect(traceOriginalPosition(TRACER, { line: 1, column: 25 })).toMatchObject({ line: 1, column: 29 });
		expect(traceOriginalPosition(TRACER, { line: 2, column: 9 })).toMatchObject({ line: 3, column: 9 });
	});
});
