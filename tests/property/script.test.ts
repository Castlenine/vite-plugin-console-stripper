import type { FileKind } from '../../src/utilities';

import { Script } from 'node:vm';

import { describe, expect, it } from 'vitest';
import { fc, test } from '@fast-check/vitest';
import { parseSync } from 'vite';

import { createScanContext, getOptions, scanConsoleCalls, stripConsole } from '../../src/utilities';

/**
 * What stripping must do to a generated fragment: a `stripped` one holds a call whose `S<n>_` marker must disappear
 * from the output, a `kept` one must reach the output verbatim
 */
type FragmentRole = 'kept' | 'stripped';

interface Fragment {
	code: string;
	role: FragmentRole;
}

/**
 * Builds one fragment, numbered so that every marker and declared name of a generated program is unique
 */
type FragmentFactory = (index: number) => Fragment;

type Language = 'js' | 'ts' | 'tsx';

interface Program {
	language: Language;
	fragments: Fragment[];
}

// ─── Fragment pools ─────────────────────────────────────────────────────────────

function stripped(build: (marker: string, index: number) => string): FragmentFactory {
	return (index) => ({ code: build(`S${index}_`, index), role: 'stripped' });
}

function kept(build: (marker: string, index: number) => string): FragmentFactory {
	return (index) => ({ code: build(`K${index}_`, index), role: 'kept' });
}

/**
 * Stripped calls that run in a plain script, in every call form the plugin matches
 */
const EXECUTABLE_STRIPPED_CALLS: readonly FragmentFactory[] = [
	stripped((marker) => `console.log('${marker}');`),
	stripped((marker) => `console.log('${marker}')`),
	stripped((marker) => `console?.log('${marker}');`),
	stripped((marker) => `console.debug?.('${marker}')`),
	stripped((marker) => `console['log']('${marker}');`),
	stripped((marker) => `console["trace"]('${marker}')`),
	stripped((marker) => `console.debug\`${marker}\`;`),
	stripped((marker) => `window.console.log('${marker}');`),
	stripped((marker) => `globalThis.console.trace('${marker}')`),
	stripped((marker) => `self.console.table(['${marker}']);`),
	stripped((marker) => `global.console.log('${marker}')`),
	stripped((marker) => `console.log(\n\t'${marker}',\n\t(1 + 2) * f(3),\n\t\`t \${v}\`,\n);`),
	stripped((marker) => `console.log('${marker} )(', ")\\"(", \`)\${'('}\`, /\\)/);`),
	stripped((marker) => `if (v) console.log('${marker}');`),
	stripped((marker) => `if (v) {\n\tconsole.log('${marker}')\n}`),
	stripped((marker, index) => `const r${index} = console.log('${marker}');`),
	stripped((marker) => `f(console.log('${marker}'));`),
	stripped((marker) => `v && console.log('${marker}')`),
	stripped((marker) => `f(1), console.log('${marker}')`),
	stripped((marker, index) => `function g${index}() {\n\tconsole.log('${marker}');\n\treturn ${index};\n}`),
	stripped((marker) => `try {\n\tf(1);\n} catch {\n\tconsole.log('${marker}')\n}`),
	stripped((marker, index) => `class C${index} {\n\tstatic {\n\t\tconsole.log('${marker}')\n\t}\n}`),
	stripped((marker) => `console.log('${marker}'); f(2);`),
	stripped((marker) => `f(3); console.log('${marker}') // trailing comment`),
	stripped((marker) => `console.log('${marker}', console.error('${marker}n'))`),
];

/**
 * Kept calls, ordinary code and literals mentioning `console.log(` that run in a plain script. Several of them start
 * with `(`, `[`, `` ` ``, `/`, `+` or `-`, which continue the previous line when it lacks a semicolon.
 */
const EXECUTABLE_KEPT_CODE: readonly FragmentFactory[] = [
	kept((marker) => `console.error('${marker}');`),
	kept((marker) => `console.warn('${marker}')`),
	kept((marker) => `console.info?.('${marker}');`),
	kept((marker) => `window.console.clear('${marker}')`),
	kept((marker) => `// console-stripper-ignore-next-line\nconsole.log('${marker}');`),
	kept(
		(marker) =>
			`// console-stripper-ignore-start\nconsole.log('${marker}')\nconsole.debug('${marker}b');\n// console-stripper-ignore-end`,
	),
	kept((marker, index) => `const b${index} = console.log.bind(console, '${marker}');`),
	kept((marker, index) => `const ref${index} = console.log; // ${marker}`),
	kept((marker, index) => `const s${index} = 'console.log(${marker})';`),
	kept((marker, index) => `const d${index} = "console.log(\\"${marker}\\")"`),
	kept((marker, index) => `const t${index} = \`console.log(\${'${marker}'})\`;`),
	kept((marker) => `// console.log('${marker}')`),
	kept((marker) => `/* console.log('${marker}') */`),
	kept((marker, index) => `const re${index} = /console\\.log\\('${marker}'\\)/;`),
	kept((marker, index) => `let q${index} = ${index} // ${marker}`),
	kept((marker) => `trace.push('${marker}');`),
	kept((marker) => `trace.push('${marker}')`),
	kept((marker) => `[1, '${marker}'].forEach((item) => trace.push(item))`),
	kept((marker) => `(trace).push('${marker}')`),
	kept((marker) => `\`${marker}\`.trim()`),
	kept((marker) => `/${marker}/.test('x')`),
	kept((marker, index) => `+${index} // ${marker}`),
	kept((marker, index) => `-${index} // ${marker}`),
];

/**
 * Fragments valid in every language, which a script cannot run: they are only parsed
 */
const PARSED_ONLY_CODE: readonly FragmentFactory[] = [
	kept((marker) => `new console.log('${marker}');`),
	kept((marker) => `!= 1 // ${marker}`),
	stripped((marker, index) => `label${index}: console.log('${marker}');`),
	stripped((marker, index) => `switch (v) {\n\tcase ${index}: console.log('${marker}')\n}`),
];

const TYPESCRIPT_CODE: readonly FragmentFactory[] = [
	stripped((marker) => `console.log<string>('${marker}');`),
	stripped((marker) => `console.log!('${marker}')`),
	stripped((marker, index) => `function h${index}(): void {\n\tconsole.log('${marker}')\n}`),
	stripped((marker, index) => `namespace N${index} {\n\tconsole.log('${marker}')\n}`),
	kept((marker, index) => `let n${index}: number = ${index} // ${marker}`),
	kept((marker, index) => `const w${index} = (v as string).length; // ${marker}`),
];

const JSX_CODE: readonly FragmentFactory[] = [
	kept((marker, index) => `const e${index} = <p>console.log('${marker}')</p>;`),
	kept((marker, index) => `const a${index} = <p title="console.log('${marker}')" />;`),
	stripped((marker, index) => `const j${index} = <p>{console.log('${marker}')}</p>;`),
	stripped((marker, index) => `const o${index} = <b onClick={() => console.log('${marker}')}>x</b>;`),
];

const POOLS: Record<Language, readonly FragmentFactory[]> = {
	js: [...EXECUTABLE_STRIPPED_CALLS, ...EXECUTABLE_KEPT_CODE, ...PARSED_ONLY_CODE, ...JSX_CODE],
	ts: [...EXECUTABLE_STRIPPED_CALLS, ...EXECUTABLE_KEPT_CODE, ...PARSED_ONLY_CODE, ...TYPESCRIPT_CODE],
	tsx: [...EXECUTABLE_STRIPPED_CALLS, ...EXECUTABLE_KEPT_CODE, ...PARSED_ONLY_CODE, ...TYPESCRIPT_CODE, ...JSX_CODE],
};

/**
 * The file kind the plugin resolves for each language, and the file name that selects it in the parser
 */
const LANGUAGE_SETUP: Record<Language, { fileKind: FileKind; fileName: string }> = {
	js: { fileKind: 'script', fileName: 'input.jsx' },
	ts: { fileKind: 'ts', fileName: 'input.ts' },
	tsx: { fileKind: 'script', fileName: 'input.tsx' },
};

const VOID_EXPRESSION_REGEX = /\(?void 0\)?/;

const FILLER_REGEX = /^[\s;]*$/;

const MARKER_REGEX = /[KS]\d+_/g;

const RUN_OPTIONS = { numRuns: 300, seed: 20_260_925 } as const;

// ─── Arbitraries ────────────────────────────────────────────────────────────────

function createFragmentsArbitrary(pool: readonly FragmentFactory[]): fc.Arbitrary<Fragment[]> {
	return fc
		.array(fc.constantFrom(...pool), { minLength: 1, maxLength: 12 })
		.map((factories) => factories.map((factory, index) => factory(index)));
}

const PROGRAM_ARBITRARY: fc.Arbitrary<Program> = fc
	.constantFrom<Language>('js', 'ts', 'tsx')
	.chain((language) => createFragmentsArbitrary(POOLS[language]).map((fragments) => ({ language, fragments })));

const EXECUTABLE_FRAGMENTS_ARBITRARY = createFragmentsArbitrary([
	...EXECUTABLE_STRIPPED_CALLS,
	...EXECUTABLE_KEPT_CODE,
]);

// ─── Helpers ────────────────────────────────────────────────────────────────────

function toSource(fragments: readonly Fragment[]): string {
	return `${fragments.map((fragment) => fragment.code).join('\n')}\n`;
}

/**
 * Reports whether a text is what an edit may remove around a call, or insert in its place: whitespace, semicolons and
 * at most one `void 0`, optionally parenthesized.
 */
function isEditFiller(text: string): boolean {
	return FILLER_REGEX.test(text.replace(VOID_EXPRESSION_REGEX, ''));
}

function strip(input: string, fileKind: FileKind): string {
	return stripConsole(input, { fileKind });
}

function parseErrors(fileName: string, code: string): string[] {
	return parseSync(fileName, code, { sourceType: 'module' }).errors.map((error) => error.message);
}

/**
 * Finds where each fragment starts in the output, searching in order.
 *
 * @returns The index of every fragment, `-1` for a fragment missing from the output after the previous one.
 */
function findInOrder(output: string, codes: readonly string[]): number[] {
	let searchFrom = 0;

	return codes.map((code) => {
		const INDEX = output.indexOf(code, searchFrom);

		searchFrom = INDEX === -1 ? searchFrom : INDEX + code.length;

		return INDEX;
	});
}

interface ExecutionOutcome {
	trace: string[];
	calls: string[];
	error: string | null;
}

/**
 * Runs a script in a fresh context whose `console` records every call.
 *
 * @returns What the script pushed to `trace`, every console call as `method:arguments`, and the name of the error it
 *   threw, if any.
 */
function execute(code: string): ExecutionOutcome {
	const TRACE: string[] = [];
	const CALLS: string[] = [];
	const CONSOLE = Object.fromEntries(
		['log', 'debug', 'trace', 'table', 'error', 'warn', 'info', 'clear'].map((method) => [
			method,

			function record(...values: unknown[]) {
				CALLS.push(`${method}:${values.map(String).join(',')}`);
			},
		]),
	);
	const SANDBOX: Record<string, unknown> = { trace: TRACE, console: CONSOLE, v: 1, f: (value: unknown) => value };

	SANDBOX.window = SANDBOX;
	SANDBOX.self = SANDBOX;
	SANDBOX.global = SANDBOX;

	try {
		new Script(code).runInNewContext(SANDBOX, { timeout: 1_000 });

		return { trace: TRACE, calls: CALLS, error: null };
	} catch (error) {
		return { trace: TRACE, calls: CALLS, error: error instanceof Error ? error.name : 'unknown' };
	}
}

// ─── Properties ─────────────────────────────────────────────────────────────────

describe('stripConsole on generated scripts', () => {
	test.prop([PROGRAM_ARBITRARY], RUN_OPTIONS)('is idempotent', ({ language, fragments }) => {
		const { fileKind } = LANGUAGE_SETUP[language];
		const ONCE = strip(toSource(fragments), fileKind);

		expect(strip(ONCE, fileKind)).toBe(ONCE);
	});

	test.prop([PROGRAM_ARBITRARY], RUN_OPTIONS)('keeps a parsable program parsable', ({ language, fragments }) => {
		const { fileKind, fileName } = LANGUAGE_SETUP[language];
		const INPUT = toSource(fragments);

		fc.pre(parseErrors(fileName, INPUT).length === 0);

		expect(parseErrors(fileName, strip(INPUT, fileKind))).toStrictEqual([]);
	});

	test.prop([PROGRAM_ARBITRARY], RUN_OPTIONS)(
		'drops every stripped call and keeps every other fragment verbatim, in order',
		({ language, fragments }) => {
			const OUTPUT = strip(toSource(fragments), LANGUAGE_SETUP[language].fileKind);
			const KEPT_CODES = fragments.filter((fragment) => fragment.role === 'kept').map((fragment) => fragment.code);
			const STRIPPED_MARKERS = fragments
				.filter((fragment) => fragment.role === 'stripped')
				.flatMap((fragment) => fragment.code.match(MARKER_REGEX) ?? []);

			expect(findInOrder(OUTPUT, KEPT_CODES)).not.toContain(-1);
			expect(STRIPPED_MARKERS.filter((marker) => OUTPUT.includes(marker))).toStrictEqual([]);
		},
	);

	test.prop([PROGRAM_ARBITRARY], RUN_OPTIONS)(
		'only edits console-call spans, in order and without overlap',
		({ language, fragments }) => {
			const { fileKind } = LANGUAGE_SETUP[language];
			const INPUT = toSource(fragments);
			const { edits } = scanConsoleCalls(INPUT, createScanContext(getOptions(), fileKind));
			let lastEnd = 0;

			for (const EDIT of edits) {
				const REMOVED = INPUT.slice(EDIT.start, EDIT.end);

				expect(EDIT.start).toBeGreaterThanOrEqual(lastEnd);
				expect(REMOVED.match(/K\d+_/g)).toBeNull();
				expect(REMOVED.includes('console') || isEditFiller(REMOVED)).toBe(true);
				expect(isEditFiller(EDIT.replacement)).toBe(true);

				lastEnd = EDIT.end;
			}
		},
	);

	test.prop([EXECUTABLE_FRAGMENTS_ARBITRARY], RUN_OPTIONS)(
		'runs like the input minus the stripped calls',
		(fragments) => {
			const INPUT = toSource(fragments);
			const BEFORE = execute(INPUT);

			fc.pre(BEFORE.error == null);

			expect(execute(strip(INPUT, 'script'))).toStrictEqual({
				trace: BEFORE.trace,
				calls: BEFORE.calls.filter((call) => !/S\d+_/.test(call)),
				error: null,
			});
		},
	);

	test.prop([fc.string({ unit: 'binary' }), fc.constantFrom<FileKind>('script', 'ts')], RUN_OPTIONS)(
		'never throws on arbitrary text and stays idempotent',
		(input, fileKind) => {
			const ONCE = strip(input, fileKind);

			expect(strip(ONCE, fileKind)).toBe(ONCE);
		},
	);
});

describe('stripConsole regressions', () => {
	// A semicolon-less line ends before a run of removed calls only through ASI, so the run leaves a guard behind
	// when the next line starts with `[`, `(`, `` ` ``, `/`, `+` or `-`, even when its first call ends with `;`
	it('guards the next line when a semicolon-terminated removed call is followed by another', () => {
		const OUTPUT = stripConsole('a()\nconsole.log(1);\nconsole.log(2);\n[1].forEach(f)\n');

		expect(parseSync('input.js', OUTPUT, { sourceType: 'module' }).program.body).toHaveLength(2);
	});
});
