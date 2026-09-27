import type { FileKind } from '../../src/utilities';

import { describe, expect } from 'vitest';
import { fc, test } from '@fast-check/vitest';

import { stripConsole } from '../../src/utilities';

/**
 * One pathological input: a fragment repeated many times, each copy opening something that never closes
 */
interface PathologicalShape {
	name: string;
	fragment: string;
	fileKind: FileKind;
}

const SHAPES: readonly PathologicalShape[] = [
	{ name: 'unclosed parentheses', fragment: 'console.log(', fileKind: 'script' },
	{ name: 'unclosed nested parentheses', fragment: 'console.log((', fileKind: 'ts' },
	{ name: 'unclosed template literals', fragment: 'console.log(`${', fileKind: 'script' },
	{ name: 'unclosed quotes', fragment: "console.log('", fileKind: 'script' },
	{ name: 'unclosed block comments', fragment: 'console.log(/*', fileKind: 'script' },
	{ name: 'unclosed script tags', fragment: '<script>console.log(', fileKind: 'markup' },
	{ name: 'unclosed slots', fragment: '{console.log(', fileKind: 'markup' },
	{ name: 'unclosed Vue interpolations', fragment: '{{ console.log(', fileKind: 'vue' },
	{ name: 'unclosed Astro expressions', fragment: '---\n{console.log(', fileKind: 'astro' },
	{ name: 'unclosed HTML scripts', fragment: '<script type="module">console.log(`', fileKind: 'html' },
	{ name: 'unclosed Markdown fences', fragment: '```\n{console.log(', fileKind: 'markdown' },
	{ name: 'unclosed JSX elements', fragment: '<a>{console.log(<b>', fileKind: 'script' },
];

/**
 * Repeat count of the smallest input; the larger ones hold 4 and 16 times as many copies
 */
const BASE_COPY_COUNT = 1_000;

const SCALE_FACTORS = [1, 4, 16] as const;

/**
 * Growth allowed from the smallest to the largest input: 16 for a linear scan, 256 for a quadratic one. The margin
 * absorbs timer noise and garbage-collection pauses without letting a quadratic scan through.
 */
const MAX_GROWTH_RATIO = 80;

/**
 * Duration below which a measurement is read as noise, so a fast machine cannot fail on the ratio of two tiny times
 */
const NOISE_FLOOR_IN_MS = 2;

const PROPERTY_TIMEOUT_IN_MS = 60_000;

/**
 * Times the fastest of a few strips of the same input, so a single garbage-collection pause does not count.
 *
 * @param input - The source to strip.
 * @param fileKind - The kind of source.
 *
 * @returns The shortest duration measured, in milliseconds.
 */
function measureStrip(input: string, fileKind: FileKind): number {
	const DURATIONS = [0, 1, 2].map(() => {
		const STARTED_AT = performance.now();
		const OUTPUT = stripConsole(input, { fileKind });
		const DURATION_IN_MS = performance.now() - STARTED_AT;

		// The output is read so that the call cannot be optimized away
		if (OUTPUT.length > input.length * 2) {
			throw new Error('stripping more than doubled the length of the source');
		}

		return DURATION_IN_MS;
	});

	return Math.min(...DURATIONS);
}

/**
 * Asserts that stripping a repeated unit grows linearly from the smallest to the largest scale.
 *
 * @param unit - The text repeated to build each input.
 * @param fileKind - The kind of source.
 * @param copyCount - How many copies of the unit the smallest input holds.
 */
function expectLinearGrowth(unit: string, fileKind: FileKind, copyCount = BASE_COPY_COUNT): void {
	const [SMALL = 0, , LARGE = 0] = SCALE_FACTORS.map((factor) =>
		measureStrip(unit.repeat(copyCount * factor), fileKind),
	);

	expect(Math.max(LARGE, NOISE_FLOOR_IN_MS)).toBeLessThan(Math.max(SMALL, NOISE_FLOOR_IN_MS) * MAX_GROWTH_RATIO);
}

const SHAPE_ARBITRARY = fc.constantFrom(...SHAPES);

const UNIT_ARBITRARY = fc.record({
	shape: SHAPE_ARBITRARY,
	extraFragments: fc.array(
		SHAPE_ARBITRARY.map((shape) => shape.fragment),
		{ maxLength: 2 },
	),
	separator: fc.constantFrom('', '\n', ' ', 'console.log(1);\n', '}'),
});

describe('stripConsole running time', () => {
	test.each(SHAPES)('grows linearly on $name', ({ fragment, fileKind }) => {
		expectLinearGrowth(fragment, fileKind);
	});

	test.prop([UNIT_ARBITRARY], { numRuns: 8, seed: 7 })(
		'grows linearly on mixed pathological fragments',
		({ shape, extraFragments, separator }) => {
			const FRAGMENTS = [shape.fragment, ...extraFragments];

			// Each input keeps about the size of a single-shape one, whatever the number of fragments per unit
			expectLinearGrowth(
				FRAGMENTS.join(separator) + separator,
				shape.fileKind,
				Math.ceil(BASE_COPY_COUNT / FRAGMENTS.length),
			);
		},
		PROPERTY_TIMEOUT_IN_MS,
	);
});
