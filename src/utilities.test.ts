import type { ConsoleMethod, Options } from './types';
import type { FileKind, IgnoreMatcher, StripConsoleOptions } from './utilities';

import { Script } from 'node:vm';
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';
import { parseSync } from 'vite';

import {
	ANY_DEPTH_DEFAULT_IGNORE_PATHS,
	applyEdits,
	ASTRO_EXTENSIONS,
	cleanIgnoredPaths,
	createCodeMask,
	createExtensionMatcher,
	createIgnoreMatcher,
	createScanContext,
	createSourceLayout,
	DEFAULT_EXTENSIONS,
	DEFAULT_IGNORE_PATHS,
	DEFAULT_METHODS,
	getDirectiveScope,
	getFileKind,
	getOptions,
	getOwningPackage,
	getProjectIgnoredPaths,
	getUserIgnoredPaths,
	hasConsoleToken,
	hasIgnoreDirectiveToken,
	HTML_EXTENSIONS,
	isDependencyPath,
	JAVASCRIPT_EXTENSIONS,
	JSX_EXTENSIONS,
	ROOT_ANCHORED_DEFAULT_IGNORE_PATHS,
	scanCompiledAstroComponent,
	scanConsoleCalls,
	SCRIPT_EXTENSIONS,
	stripConsole,
	stripQuery,
	SVELTE_EXTENSIONS,
	toRelativePath,
	TYPESCRIPT_EXTENSIONS,
	VUE_EXTENSIONS,
} from './utilities';

const ALL_CONSOLE_METHODS: ConsoleMethod[] = [
	'assert',
	'clear',
	'count',
	'countReset',
	'debug',
	'dir',
	'dirxml',
	'error',
	'exception',
	'group',
	'groupCollapsed',
	'groupEnd',
	'info',
	'log',
	'profile',
	'profileEnd',
	'table',
	'time',
	'timeEnd',
	'timeLog',
	'timeStamp',
	'trace',
	'warn',
];

/**
 * The documented default method list, written out so that a change to `DEFAULT_METHODS` fails the suite
 */
const EXPECTED_DEFAULT_METHODS = [
	'assert',
	'count',
	'countReset',
	'debug',
	'dir',
	'dirxml',
	'group',
	'groupCollapsed',
	'groupEnd',
	'log',
	'profile',
	'profileEnd',
	'table',
	'time',
	'timeEnd',
	'timeLog',
	'timeStamp',
	'trace',
];

const EXPECTED_SCRIPT_EXTENSIONS = ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx'];
const EXPECTED_DEFAULT_EXTENSIONS = [...EXPECTED_SCRIPT_EXTENSIONS, 'svelte', 'vue', 'astro', 'html', 'htm'];

const EXPECTED_ROOT_ANCHORED_DEFAULT_IGNORE_PATHS = [
	'.idea',
	'.vscode',
	'.DS_Store',
	'Thumbs.db',
	'.env',
	'.env.*',
	'logs',
	'*.log',
	'public',
	'build',
	'.svelte-kit',
	'dist',
	'.nuxt',
	'.output',
	'.nitro',
	'.data',
	'.next',
	'out',
	'.react-router',
	'.astro',
	'.solid',
	'.vinxi',
	'.tanstack',
	'.angular',
	'e2e',
	'angular.json',
	'browserslist',
	'.vercel',
	'.netlify',
	'.wrangler',
	'.cache',
];

interface StripExpectation {
	source: string;
	expected: string;
	options?: StripConsoleOptions;
	/**
	 * File name handed to the parser, whose extension selects the language of a script. Default: `'fixture.js'`
	 *
	 * The statement regions of a document (`<script>` blocks, Astro frontmatter) are always parsed as TypeScript.
	 */
	fileName?: string;
	/** `true` for a fixture that is not valid source on purpose, whose output is then not parsed */
	isInvalidSource?: boolean;
}

/**
 * Mask value of a character that never executes: markup text, a JSX child, a data block
 */
const TEXT_MASK_VALUE = 3;

/**
 * Builds the project ignore matcher from partial plugin options, defaulting the parts the ignore rules do not read.
 *
 * @param options - The ignore-related plugin options under test.
 *
 * @returns A matcher reporting whether a path relative to the Vite root is ignored.
 */
function createIgnoreMatcherFor(options: Options): IgnoreMatcher {
	return createIgnoreMatcher(getProjectIgnoredPaths(getOptions(options)));
}

/**
 * Finds the end of the first call written in the given source, through the scan that strips it.
 *
 * @param source - The source holding exactly one `console.log` call to measure, as a statement of its own.
 *
 * @returns The index of the call's closing parenthesis, or `-1` when the call cannot be delimited and is left alone.
 */
function findFirstCallEnd(source: string): number {
	const EDIT = scanConsoleCalls(source, createScanContext(getOptions(), 'script')).edits[0];

	return EDIT == null ? -1 : EDIT.end - 1;
}

/**
 * Lists the code regions of a document, each as the text it covers and whether statements may be removed there.
 *
 * @param source - The document to map.
 * @param fileKind - The kind of document.
 *
 * @returns One `[text, allowsStatements]` pair per region, in source order.
 */
function getCodeRegions(source: string, fileKind: FileKind): [string, boolean][] {
	return createSourceLayout(source, fileKind).regions.map((region) => [
		source.slice(region.start, region.end),
		region.allowsStatements,
	]);
}

/**
 * Reports whether every character of a range of a document is text, which no edit ever touches.
 *
 * @param source - The document to map.
 * @param fileKind - The kind of document.
 * @param text - A substring of the document, located by its first occurrence.
 *
 * @returns `true` when the mask marks the whole substring as text.
 */
function isTextRange(source: string, fileKind: FileKind, text: string): boolean {
	const START = source.indexOf(text);

	return [...createCodeMask(source, fileKind).slice(START, START + text.length)].every(
		(value) => value === TEXT_MASK_VALUE,
	);
}

/**
 * Lists the parse errors of a stripped output: the whole output for a script, and each statement region
 * (`<script>` block, Astro frontmatter) for a document, whose other regions are expressions or text.
 *
 * @param output - The stripped output.
 * @param fileKind - The kind of the output.
 * @param fileName - The file name selecting the language of a script.
 *
 * @returns The message of every parse error, empty when the output parses.
 */
function getParseErrors(output: string, fileKind: FileKind, fileName: string): string[] {
	const PROGRAMS =
		fileKind === 'script' || fileKind === 'ts'
			? [{ fileName, code: output }]
			: createSourceLayout(output, fileKind)
					.regions.filter((region) => region.allowsStatements)
					.map((region) => ({ fileName: 'region.ts', code: output.slice(region.start, region.end) }));

	return PROGRAMS.flatMap((program) =>
		parseSync(program.fileName, program.code, { sourceType: 'unambiguous' }).errors.map((error) => error.message),
	);
}

/**
 * Strips a fixture, asserts the exact output and then asserts that the output still parses.
 *
 * @remarks
 * The validity check is the invariant that matters: a golden string can be updated by mistake, a syntax error
 * cannot. The output is parsed by Oxc, the parser Vite itself uses, with the language its file name selects.
 *
 * @param expectation - The fixture, its expected output, the plugin options and the file name selecting the language.
 *
 * @throws When the output differs from `expected` or does not parse.
 */
function expectStripped(expectation: StripExpectation): void {
	const OUTPUT = stripConsole(expectation.source, expectation.options);

	expect(OUTPUT).toBe(expectation.expected);

	if (expectation.isInvalidSource === true) {
		return;
	}

	expect(
		getParseErrors(OUTPUT, expectation.options?.fileKind ?? 'script', expectation.fileName ?? 'fixture.js'),
	).toEqual([]);
}

describe('DEFAULT_METHODS', () => {
	it('strips the noisy methods and keeps the informative ones', () => {
		expect(DEFAULT_METHODS).toEqual(EXPECTED_DEFAULT_METHODS);
	});
});

describe('getOptions', () => {
	it('resolves every field from an empty call', () => {
		expect(getOptions()).toEqual({
			methods: EXPECTED_DEFAULT_METHODS,
			extensions: EXPECTED_DEFAULT_EXTENSIONS,
			ignoreComments: true,
			ignoreFolders: [],
			ignoreFiles: [],
			ignoreDefaults: true,
			stripDependencies: true,
			ignoreDependencies: [],
			verbose: false,
		});
	});

	it('replaces non-array values with the defaults', () => {
		// @ts-expect-error -- deliberately malformed input
		const RESOLVED = getOptions({ methods: 'log', extensions: null, ignoreFolders: 1, ignoreFiles: {} });

		expect(RESOLVED.methods).toEqual(EXPECTED_DEFAULT_METHODS);
		expect(RESOLVED.extensions).toEqual(EXPECTED_DEFAULT_EXTENSIONS);
		expect(RESOLVED.ignoreFolders).toEqual([]);
		expect(RESOLVED.ignoreFiles).toEqual([]);
	});

	it('accepts every known console method', () => {
		expect(getOptions({ methods: ALL_CONSOLE_METHODS }).methods).toEqual(ALL_CONSOLE_METHODS);
	});

	it('drops unknown method names', () => {
		// @ts-expect-error -- deliberately malformed input
		expect(getOptions({ methods: ['log', 'nope', 42, null, 'warn'] }).methods).toEqual(['log', 'warn']);
	});

	it('keeps an explicitly empty method list', () => {
		expect(getOptions({ methods: [] }).methods).toEqual([]);
	});

	it('drops empty and non-string extensions', () => {
		// @ts-expect-error -- deliberately malformed input
		expect(getOptions({ extensions: ['ts', '', '  ', 7] }).extensions).toEqual(['ts']);
	});

	it('trims and de-duplicates extensions', () => {
		expect(getOptions({ extensions: [' ts ', 'ts', '.vue\t'] }).extensions).toEqual(['ts', '.vue']);
		expect(createExtensionMatcher(getOptions({ extensions: [' vue '] }).extensions)('/src/App.vue')).toBe(true);
	});

	it('drops empty and non-string ignore paths', () => {
		// @ts-expect-error -- deliberately malformed input
		const RESOLVED = getOptions({ ignoreFolders: ['src', 3, ''], ignoreFiles: [null, 'a.ts', '  '] });

		expect(RESOLVED.ignoreFolders).toEqual(['src']);
		expect(RESOLVED.ignoreFiles).toEqual(['a.ts']);
	});

	it('reads every flag with an explicit comparison', () => {
		const FLAGS = { ignoreComments: false, ignoreDefaults: false, verbose: true };

		expect(getOptions(FLAGS)).toMatchObject(FLAGS);
		// @ts-expect-error -- deliberately malformed input
		expect(getOptions({ verbose: 'yes' })).toMatchObject({ verbose: false });
	});

	it('keeps stripDependencies false', () => {
		expect(getOptions({ stripDependencies: false }).stripDependencies).toBe(false);
		// @ts-expect-error -- deliberately malformed input
		expect(getOptions({ stripDependencies: 'no' }).stripDependencies).toBe(true);
	});

	it('trims, filters and de-duplicates ignoreDependencies', () => {
		// @ts-expect-error -- deliberately malformed input
		const RESOLVED = getOptions({ ignoreDependencies: [' lodash ', 'lodash', '', '  ', 7, null, '@scope/pkg'] });

		expect(RESOLVED.ignoreDependencies).toEqual(['lodash', '@scope/pkg']);
		// @ts-expect-error -- deliberately malformed input
		expect(getOptions({ ignoreDependencies: 'lodash' }).ignoreDependencies).toEqual([]);
	});
});

describe('cleanIgnoredPaths', () => {
	it('trims, strips leading ./ and /, strips trailing / and de-duplicates', () => {
		expect(cleanIgnoredPaths([' ./src/tests/ ', 'src/tests', '/public', 'Header.svelte'])).toEqual([
			'src/tests',
			'public',
			'Header.svelte',
		]);
	});

	it('drops empty and root-only tokens', () => {
		expect(cleanIgnoredPaths(['', ' ', '.', './', '/', '/.', '..', '../'])).toEqual([]);
	});

	it('strips leading parent segments and turns Windows separators into slashes', () => {
		expect(cleanIgnoredPaths(['../src/tests', '../../dist/', 'src\\tests\\', '.\\lib\\a.ts'])).toEqual([
			'src/tests',
			'dist',
			'lib/a.ts',
		]);
		expect(createIgnoreMatcherFor({ ignoreFolders: ['..\\src\\tests'] })('src/tests/a.ts')).toBe(true);
	});

	it('drops non-string entries', () => {
		// @ts-expect-error -- deliberately malformed input
		expect(cleanIgnoredPaths([null, 42, 'dist'])).toEqual(['dist']);
	});
});

describe('getProjectIgnoredPaths', () => {
	it('merges folders, files and the defaults, splitting them by matching depth', () => {
		const RESULT = getProjectIgnoredPaths(getOptions({ ignoreFolders: ['src/tests'], ignoreFiles: ['Header.svelte'] }));

		expect(RESULT.anyDepth).toEqual(['src/tests', 'Header.svelte', 'node_modules', '.git']);
		expect(RESULT.rootAnchored).toEqual(EXPECTED_ROOT_ANCHORED_DEFAULT_IGNORE_PATHS);
	});

	it('omits the defaults when ignoreDefaults is false', () => {
		expect(getProjectIgnoredPaths(getOptions({ ignoreFolders: ['x'], ignoreDefaults: false }))).toEqual({
			anyDepth: ['x'],
			rootAnchored: [],
		});
	});
});

describe('getUserIgnoredPaths', () => {
	it('never includes a built-in token', () => {
		const RESULT = getUserIgnoredPaths(getOptions({ ignoreFolders: ['src/tests'], ignoreFiles: ['Header.svelte'] }));

		expect(RESULT).toEqual(['src/tests', 'Header.svelte']);
		expect(RESULT).not.toContain('dist');
		expect(RESULT).not.toContain('node_modules');
	});
});

describe('isDependencyPath', () => {
	it('recognizes a file installed under node_modules', () => {
		expect(isDependencyPath('/p/node_modules/lodash/dist/x.js')).toBe(true);
		expect(isDependencyPath('node_modules/lodash/x.js')).toBe(true);
		expect(isDependencyPath('C:\\p\\node_modules\\lodash\\x.js')).toBe(true);
		expect(isDependencyPath('/p/node_modules/lodash/x.js?used')).toBe(true);
	});

	it('does not recognize a project file', () => {
		expect(isDependencyPath('/p/src/app.ts')).toBe(false);
		expect(isDependencyPath('/p/src/node_modules')).toBe(false);
		expect(isDependencyPath('/p/src/my_node_modules/x.js')).toBe(false);
	});
});

describe('getOwningPackage', () => {
	it('resolves plain, scoped and nested packages', () => {
		expect(getOwningPackage('/p/node_modules/lodash/dist/x.js')).toBe('lodash');
		expect(getOwningPackage('/p/node_modules/@scope/pkg/x.js')).toBe('@scope/pkg');
		expect(getOwningPackage('/p/node_modules/a/node_modules/b/x.js')).toBe('b');
	});

	it('resolves a package inside the pnpm store', () => {
		expect(getOwningPackage('/p/node_modules/.pnpm/a@1.0.0/node_modules/a/dist/x.js')).toBe('a');
		expect(getOwningPackage('/p/node_modules/.pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg/x.js')).toBe('@scope/pkg');
	});

	it('resolves Windows separators and ignores the query suffix', () => {
		expect(getOwningPackage('C:\\p\\node_modules\\@scope\\pkg\\x.js')).toBe('@scope/pkg');
		expect(getOwningPackage('/p/node_modules/lodash/x.js?used&lang.js')).toBe('lodash');
		expect(getOwningPackage('node_modules/lodash/x.js')).toBe('lodash');
	});

	it('returns null for a project file or a malformed tail', () => {
		expect(getOwningPackage('/p/src/app.ts')).toBeNull();
		expect(getOwningPackage('/p/node_modules/')).toBeNull();
		expect(getOwningPackage('/p/node_modules/@scope')).toBeNull();
		expect(getOwningPackage('/p/node_modules/@scope/')).toBeNull();
	});

	it('returns null for a dot-directory, which no package name can be', () => {
		expect(getOwningPackage('/p/node_modules/.pnpm/a@1.0.0/x.js')).toBeNull();
		expect(getOwningPackage('/p/node_modules/.vite/deps/some-logger.js')).toBeNull();
		expect(getOwningPackage('/p/node_modules/.bin/tool')).toBeNull();
		// The real pnpm layout still resolves, through the `node_modules` segment the store holds
		expect(getOwningPackage('/p/node_modules/.pnpm/a@1.0.0/node_modules/a/dist/x.js')).toBe('a');
	});
});

describe('hasConsoleToken', () => {
	it('rejects a source without the console identifier', () => {
		expect(hasConsoleToken('const a = 1;')).toBe(false);
		expect(hasConsoleToken('console.log(1);')).toBe(true);
	});
});

describe('stripQuery', () => {
	it('removes the Vite query suffix', () => {
		expect(stripQuery('/src/App.svelte?svelte&type=style&lang.css')).toBe('/src/App.svelte');
		expect(stripQuery('/src/App.svelte')).toBe('/src/App.svelte');
	});

	it('removes a #hash suffix, alone or after a query', () => {
		expect(stripQuery('/src/app.ts#hash')).toBe('/src/app.ts');
		expect(stripQuery('/src/app.ts?raw#hash')).toBe('/src/app.ts');
	});

	it('keeps a # written in a folder name', () => {
		expect(stripQuery('/a#b/app.ts')).toBe('/a#b/app.ts');
		expect(stripQuery('/a#b/app.ts?raw')).toBe('/a#b/app.ts');
	});
});

describe('toRelativePath', () => {
	it('resolves ids inside the root', () => {
		expect(toRelativePath('/opt/buildhome/repo/src/App.svelte', '/opt/buildhome/repo')).toBe('src/App.svelte');
	});

	it('resolves ids outside the root', () => {
		expect(toRelativePath('/opt/.pnpm/x/node_modules/y/index.js', '/opt/buildhome/repo')).toBe(
			'../../.pnpm/x/node_modules/y/index.js',
		);
	});

	it('strips the query suffix first', () => {
		expect(toRelativePath('/repo/src/App.svelte?svelte&type=style', '/repo')).toBe('src/App.svelte');
	});
});

describe('extension presets', () => {
	it('holds lower-case extensions without a leading dot and without duplicates', () => {
		const PRESETS = [
			JAVASCRIPT_EXTENSIONS,
			TYPESCRIPT_EXTENSIONS,
			JSX_EXTENSIONS,
			SCRIPT_EXTENSIONS,
			SVELTE_EXTENSIONS,
			VUE_EXTENSIONS,
			ASTRO_EXTENSIONS,
			HTML_EXTENSIONS,
			DEFAULT_EXTENSIONS,
		];

		for (const PRESET of PRESETS) {
			expect(PRESET).toEqual(PRESET.map((extension) => extension.toLowerCase()));
			expect(PRESET.some((extension) => extension.startsWith('.'))).toBe(false);
			expect(new Set(PRESET).size).toBe(PRESET.length);
		}
	});

	it('names the expected extensions', () => {
		expect(JAVASCRIPT_EXTENSIONS).toEqual(['js', 'mjs', 'cjs']);
		expect(TYPESCRIPT_EXTENSIONS).toEqual(['ts', 'mts', 'cts']);
		expect(JSX_EXTENSIONS).toEqual(['jsx', 'tsx']);
		expect(SVELTE_EXTENSIONS).toEqual(['svelte']);
		expect(VUE_EXTENSIONS).toEqual(['vue']);
		expect(ASTRO_EXTENSIONS).toEqual(['astro']);
		expect(HTML_EXTENSIONS).toEqual(['html', 'htm']);
	});

	it('freezes every exported constant', () => {
		const EXPORTED = [
			JAVASCRIPT_EXTENSIONS,
			TYPESCRIPT_EXTENSIONS,
			JSX_EXTENSIONS,
			SCRIPT_EXTENSIONS,
			SVELTE_EXTENSIONS,
			VUE_EXTENSIONS,
			ASTRO_EXTENSIONS,
			HTML_EXTENSIONS,
			DEFAULT_EXTENSIONS,
			ANY_DEPTH_DEFAULT_IGNORE_PATHS,
			ROOT_ANCHORED_DEFAULT_IGNORE_PATHS,
			DEFAULT_IGNORE_PATHS,
			DEFAULT_METHODS,
		];

		for (const CONSTANT of EXPORTED) {
			expect(Object.isFrozen(CONSTANT)).toBe(true);
		}
	});

	it('rejects a consumer trying to grow a preset', () => {
		expect(() => (DEFAULT_EXTENSIONS as string[]).push('evil')).toThrow(TypeError);
		expect(() => (DEFAULT_METHODS as ConsoleMethod[]).push('error')).toThrow(TypeError);
		expect(DEFAULT_EXTENSIONS).not.toContain('evil');
	});

	it('resolves the defaults into a fresh mutable copy', () => {
		const RESOLVED = getOptions();

		expect(RESOLVED.extensions).not.toBe(DEFAULT_EXTENSIONS);
		expect(RESOLVED.methods).not.toBe(DEFAULT_METHODS);
		expect(Object.isFrozen(RESOLVED.extensions)).toBe(false);
		expect(Object.isFrozen(RESOLVED.methods)).toBe(false);
	});

	it('lists the documented extensions of every preset', () => {
		expect(JAVASCRIPT_EXTENSIONS).toEqual(['js', 'mjs', 'cjs']);
		expect(TYPESCRIPT_EXTENSIONS).toEqual(['ts', 'mts', 'cts']);
		expect(JSX_EXTENSIONS).toEqual(['jsx', 'tsx']);
		expect(SVELTE_EXTENSIONS).toEqual(['svelte']);
		expect(VUE_EXTENSIONS).toEqual(['vue']);
		expect(ASTRO_EXTENSIONS).toEqual(['astro']);
		expect(HTML_EXTENSIONS).toEqual(['html', 'htm']);
	});

	it('composes the unions from the single-framework presets', () => {
		expect(SCRIPT_EXTENSIONS).toEqual(EXPECTED_SCRIPT_EXTENSIONS);
		expect(DEFAULT_EXTENSIONS).toEqual(EXPECTED_DEFAULT_EXTENSIONS);
	});
});

describe('getFileKind', () => {
	it('classifies every script preset extension as script, and the TypeScript ones that cannot hold JSX as ts', () => {
		expect(SCRIPT_EXTENSIONS.map((extension) => [extension, getFileKind(`/repo/src/app.${extension}`)])).toEqual([
			['js', 'script'],
			['mjs', 'script'],
			['cjs', 'script'],
			['ts', 'ts'],
			['mts', 'ts'],
			['cts', 'ts'],
			['jsx', 'script'],
			['tsx', 'script'],
		]);
	});

	it('classifies the Svelte preset as markup and the Vue one as vue', () => {
		for (const EXTENSION of SVELTE_EXTENSIONS) {
			expect(getFileKind(`/repo/src/App.${EXTENSION}`)).toBe('markup');
		}

		for (const EXTENSION of VUE_EXTENSIONS) {
			expect(getFileKind(`/repo/src/App.${EXTENSION}`)).toBe('vue');
		}
	});

	it('classifies the Markdown-based templates as markdown', () => {
		expect(getFileKind('/repo/src/Post.md')).toBe('markdown');
		expect(getFileKind('/repo/src/Post.mdx')).toBe('markdown');
		expect(getFileKind('/repo/src/Post.svx')).toBe('markdown');
	});

	it('classifies the astro preset as astro', () => {
		for (const EXTENSION of ASTRO_EXTENSIONS) {
			expect(getFileKind(`/repo/src/Page.${EXTENSION}`)).toBe('astro');
		}
	});

	it('classifies the html preset as html', () => {
		for (const EXTENSION of HTML_EXTENSIONS) {
			expect(getFileKind(`/repo/${EXTENSION === 'htm' ? 'page' : 'index'}.${EXTENSION}`)).toBe('html');
		}
	});

	it('ignores case and the query suffix', () => {
		expect(getFileKind('/repo/src/App.VUE')).toBe('vue');
		expect(getFileKind('/repo/index.HTML')).toBe('html');
		expect(getFileKind('/repo/src/app.TSX')).toBe('script');
		expect(getFileKind('/repo/src/page.ASTRO?astro&index=0')).toBe('astro');
		expect(getFileKind('/repo/src/App.svelte?svelte&type=script&lang.ts')).toBe('markup');
	});

	it('falls back to markup for an unknown or missing extension', () => {
		expect(getFileKind('/repo/src/App.marko')).toBe('markup');
		expect(getFileKind('/repo/src/App.whatever')).toBe('markup');
		expect(getFileKind('/repo/Makefile')).toBe('markup');
	});

	it('resolves a compound name on its final extension', () => {
		expect(getFileKind('/repo/src/Counter.svelte.ts')).toBe('ts');
		expect(getFileKind('/repo/src/Counter.svelte.js')).toBe('script');
		expect(getFileKind('/repo/src/Counter.svelte')).toBe('markup');
	});

	it('treats a Vite html-proxy script module as script', () => {
		expect(getFileKind('/repo/index.html?html-proxy&index=0.js')).toBe('script');
		expect(getFileKind('/repo/index.html?html-proxy&index=12.js')).toBe('script');
	});

	it('leaves an html-proxy style module as html', () => {
		expect(getFileKind('/repo/index.html?html-proxy&direct&index=0.css')).toBe('html');
		expect(getFileKind('/repo/index.html?html-proxy&inline-css&style-attr&index=0.css')).toBe('html');
	});

	it('treats a framework script sub-request as script', () => {
		expect(getFileKind('/repo/src/Foo.vue?vue&type=script&setup=true&lang.ts')).toBe('script');
		expect(getFileKind('/repo/src/Page.astro?astro&type=script&index=0&lang.ts')).toBe('script');
	});

	it('leaves the other sub-requests of a component alone', () => {
		expect(getFileKind('/repo/src/Foo.vue?vue&type=style&index=0&lang.css')).toBe('vue');
		expect(getFileKind('/repo/src/Foo.vue?vue&type=template&id=abc')).toBe('vue');
		expect(getFileKind('/repo/src/Page.astro?astro&type=style&index=0&lang.css')).toBe('astro');
		expect(getFileKind('/repo/src/Foo.vue')).toBe('vue');
	});

	it('reads the query as parameters rather than as text', () => {
		expect(getFileKind('/repo/src/Foo.vue?vue&type=scriptx')).toBe('vue');
		expect(getFileKind('/repo/src/Foo.vue?vue&mytype=script')).toBe('vue');
		expect(getFileKind('/repo/src/Foo.vue?type=script')).toBe('vue');
		expect(getFileKind('/repo/src/Foo.vue?vuex&type=script')).toBe('vue');
	});
});

describe('default ignore tokens', () => {
	it('splits the defaults into an any-depth group and a root-anchored group', () => {
		expect(ANY_DEPTH_DEFAULT_IGNORE_PATHS).toEqual(['node_modules', '.git']);
		expect(ROOT_ANCHORED_DEFAULT_IGNORE_PATHS).toEqual(EXPECTED_ROOT_ANCHORED_DEFAULT_IGNORE_PATHS);
		expect(DEFAULT_IGNORE_PATHS).toEqual(['node_modules', '.git', ...EXPECTED_ROOT_ANCHORED_DEFAULT_IGNORE_PATHS]);
	});
});

describe('createIgnoreMatcher', () => {
	const isIgnoredPath = createIgnoreMatcherFor({});

	it('does not match a source file against the defaults', () => {
		expect(isIgnoredPath('src/components/Button.svelte')).toBe(false);
	});

	it('matches only on segment boundaries', () => {
		expect(isIgnoredPath('buildhome/repo/src/App.svelte')).toBe(false);
		expect(isIgnoredPath('src/distribution/App.svelte')).toBe(false);
		expect(isIgnoredPath('build/app.js')).toBe(true);
		expect(isIgnoredPath('.svelte-kit/generated/root.svelte')).toBe(true);
	});

	it('anchors every default but node_modules and .git to the first segment under the root', () => {
		expect(isIgnoredPath('src/routes/public/+page.svelte')).toBe(false);
		expect(isIgnoredPath('src/routes/logs/+page.svelte')).toBe(false);
		expect(isIgnoredPath('src/lib/build/Step.svelte')).toBe(false);
		expect(isIgnoredPath('src/e2e/Foo.tsx')).toBe(false);
		expect(isIgnoredPath('src/dist/Bar.svelte')).toBe(false);
		expect(isIgnoredPath('public/x.html')).toBe(true);
		expect(isIgnoredPath('logs/x.html')).toBe(true);
		expect(isIgnoredPath('e2e/Foo.tsx')).toBe(true);
	});

	it('anchors every framework and deploy-adapter token to the first segment under the root', () => {
		const TOKENS = [
			'.output',
			'.nitro',
			'.data',
			'out',
			'.react-router',
			'.astro',
			'.solid',
			'.vinxi',
			'.tanstack',
			'.angular',
			'.vercel',
			'.netlify',
			'.wrangler',
		];

		for (const TOKEN of TOKENS) {
			expect(ROOT_ANCHORED_DEFAULT_IGNORE_PATHS).toContain(TOKEN);
			expect(isIgnoredPath(`${TOKEN}/Page.tsx`)).toBe(true);
			expect(isIgnoredPath(`src/${TOKEN}/Page.tsx`)).toBe(false);
		}
	});

	it('no longer ignores the Remix cache folder, which no Remix version generates', () => {
		expect(ROOT_ANCHORED_DEFAULT_IGNORE_PATHS).not.toContain('.remix');
		expect(isIgnoredPath('.remix/x.jsx')).toBe(false);
	});

	it('matches node_modules and .git at any depth', () => {
		expect(isIgnoredPath('packages/a/node_modules/x/y.jsx')).toBe(true);
		expect(isIgnoredPath('packages/a/.git/x.svelte')).toBe(true);
	});

	it('matches dependencies resolved outside the root', () => {
		expect(isIgnoredPath('../../.pnpm/x/node_modules/y/dist/index.js')).toBe(true);
	});

	it('keeps configured tokens matching at any depth', () => {
		const isConfiguredPath = createIgnoreMatcherFor({
			ignoreFolders: ['src/tests'],
			ignoreFiles: ['Header.svelte'],
		});

		expect(isConfiguredPath('src/tests/a.svelte')).toBe(true);
		expect(isConfiguredPath('src/tests-e2e/a.svelte')).toBe(false);
		expect(isConfiguredPath('lib/src/tests/a.svelte')).toBe(true);
		expect(isConfiguredPath('src/layouts/Header.svelte')).toBe(true);
		expect(isConfiguredPath('src/layouts/SubHeader.svelte')).toBe(false);
	});

	it('matches multi-segment tokens', () => {
		const isConfiguredPath = createIgnoreMatcherFor({ ignoreFiles: ['src/components/Modal.svelte'] });

		expect(isConfiguredPath('src/components/Modal.svelte')).toBe(true);
		expect(isConfiguredPath('src/components/Modal.svelte.bak')).toBe(false);
	});

	it('supports * within a segment', () => {
		const isConfiguredPath = createIgnoreMatcherFor({ ignoreFiles: ['*.log', '.env.*', '*.stories.svelte'] });

		expect(isConfiguredPath('logs/server.log')).toBe(true);
		expect(isConfiguredPath('.env.production')).toBe(true);
		expect(isConfiguredPath('src/Button.stories.svelte')).toBe(true);
		expect(createIgnoreMatcherFor({ ignoreFiles: ['a*b.svelte'] })('src/a/b.svelte')).toBe(false);
	});

	it('treats regex characters in tokens literally', () => {
		const isConfiguredPath = createIgnoreMatcherFor({ ignoreFolders: ['(group)'] });

		expect(isConfiguredPath('src/(group)/page.svelte')).toBe(true);
		expect(isConfiguredPath('src/group/page.svelte')).toBe(false);
	});

	it('ignores nothing when the defaults are off and no token is configured', () => {
		const isIgnoredPathWithoutDefaults = createIgnoreMatcherFor({ ignoreDefaults: false });

		expect(isIgnoredPathWithoutDefaults('node_modules/x/y.svelte')).toBe(false);
		expect(isIgnoredPathWithoutDefaults('build/app.js')).toBe(false);
		expect(isIgnoredPathWithoutDefaults('')).toBe(false);
	});

	it('keeps configured tokens when the defaults are off', () => {
		const isConfiguredPath = createIgnoreMatcherFor({ ignoreFolders: ['x'], ignoreDefaults: false });

		expect(isConfiguredPath('x/a.svelte')).toBe(true);
		expect(isConfiguredPath('build/app.js')).toBe(false);
	});
});

describe('createExtensionMatcher', () => {
	it('matches configured extensions case-insensitively', () => {
		const IS_SVELTE = createExtensionMatcher(['svelte']);

		expect(IS_SVELTE('/src/App.svelte')).toBe(true);
		expect(IS_SVELTE('/src/App.SVELTE')).toBe(true);
		expect(createExtensionMatcher(['svelte', 'ts'])('/src/App.vue')).toBe(false);
	});

	it('ignores the query suffix', () => {
		expect(createExtensionMatcher(['svelte'])('/src/App.svelte?svelte&type=style&lang.css')).toBe(true);
	});

	it('accepts extensions with a leading dot and escapes them', () => {
		expect(createExtensionMatcher(['.svelte'])('/src/a.svelte')).toBe(true);
		expect(createExtensionMatcher(['svelte'])('/src/axsvelte')).toBe(false);
	});

	it('returns false without extensions', () => {
		expect(createExtensionMatcher([])('/src/App.svelte')).toBe(false);
	});

	it('tells two lists apart when one holds the separator of the other', () => {
		expect(createExtensionMatcher(['a|b'])('/src/f.a')).toBe(false);
		expect(createExtensionMatcher(['a', 'b'])('/src/f.a')).toBe(true);
	});

	it('keeps two matchers built from different lists independent', () => {
		const IS_SCRIPT = createExtensionMatcher(['ts']);
		const IS_MARKUP = createExtensionMatcher(['vue']);

		expect(IS_SCRIPT('/src/a.ts')).toBe(true);
		expect(IS_MARKUP('/src/a.ts')).toBe(false);
		expect(IS_SCRIPT('/src/App.vue')).toBe(false);
		expect(IS_MARKUP('/src/App.vue')).toBe(true);
	});
});

describe('createCodeMask', () => {
	it('marks string, template text and comment characters', () => {
		//                a  '  b  '  `  c  $  {  d  }  e  `  /  /  f
		const SOURCE = "a'b'`c${d}e`//f";

		expect([...createCodeMask(SOURCE, 'script')].join('')).toBe('011111110111222');
	});

	it('tells a comment apart from literal content', () => {
		const SOURCE = "'a'/*b*/";

		expect([...createCodeMask(SOURCE, 'script')]).toEqual([1, 1, 1, 2, 2, 2, 2, 2]);
	});

	it('closes a quoted string at the end of its line', () => {
		const SOURCE = "don't\nconsole.log(1);";

		expect(createCodeMask(SOURCE, 'script')[SOURCE.indexOf('console')]).toBe(0);
	});

	it('marks a regular expression literal but not a division', () => {
		const REGEX_SOURCE = 'x = /a\\)b/;';
		const DIVISION_SOURCE = 'x = a / b;';

		expect([...createCodeMask(REGEX_SOURCE, 'script')].slice(4, 10)).toEqual([1, 1, 1, 1, 1, 1]);
		expect(createCodeMask(DIVISION_SOURCE, 'script')[6]).toBe(0);
	});

	it('bounds an unterminated regular expression to its own line', () => {
		const SOURCE = 'x = /a\nconsole.log(1);';

		expect(createCodeMask(SOURCE, 'script')[SOURCE.indexOf('console')]).toBe(0);
	});

	it('reads a keyword a comment or a newline separates from a value as a keyword', () => {
		const COMMENT_SOURCE = 'x = a /* c */ in /a)b/;';
		const NEWLINE_SOURCE = 'x = a\nin /a)b/;';
		const INSTANCEOF_SOURCE = 'x = a instanceof /a)b/.constructor;';

		expect(createCodeMask(COMMENT_SOURCE, 'script')[COMMENT_SOURCE.indexOf(')')]).toBe(1);
		expect(createCodeMask(NEWLINE_SOURCE, 'script')[NEWLINE_SOURCE.indexOf(')')]).toBe(1);
		expect(createCodeMask(INSTANCEOF_SOURCE, 'script')[INSTANCEOF_SOURCE.indexOf(')')]).toBe(1);
	});

	it('ends a word at a gap instead of fusing the identifiers around it', () => {
		const COMMENT_SOURCE = 'x = in/* c */stanceof /a)b/;';
		const SPACE_SOURCE = 'x = typ eof /a)b/;';

		expect(createCodeMask(COMMENT_SOURCE, 'script')[COMMENT_SOURCE.indexOf(')')]).toBe(0);
		expect(createCodeMask(SPACE_SOURCE, 'script')[SPACE_SOURCE.indexOf(')')]).toBe(0);
	});

	it('reads a slash after a value as a division even when that value is named like a keyword', () => {
		const IDENTIFIER_SOURCE = 'x = a / b / c;';
		const PREFIXED_SOURCE = 'x = index / 2 / 3;';
		const MEMBER_SOURCE = 'x = a.in / 2 / 3;';
		const BRACKET_SOURCE = 'x = f(a) / 2 / 3 + b[0] / 4 / 5;';

		expect(createCodeMask(IDENTIFIER_SOURCE, 'script')[IDENTIFIER_SOURCE.indexOf('b')]).toBe(0);
		expect(createCodeMask(PREFIXED_SOURCE, 'script')[PREFIXED_SOURCE.indexOf('2')]).toBe(0);
		expect(createCodeMask(MEMBER_SOURCE, 'script')[MEMBER_SOURCE.indexOf('2')]).toBe(0);
		expect(createCodeMask(BRACKET_SOURCE, 'script')[BRACKET_SOURCE.indexOf('2')]).toBe(0);
		expect(createCodeMask(BRACKET_SOURCE, 'script')[BRACKET_SOURCE.indexOf('4')]).toBe(0);
	});

	it('does not open a regular expression on a markup closing tag', () => {
		const SOURCE = '<p>a</p>\n{console.log(1)}';

		expect(createCodeMask(SOURCE, 'markup')[SOURCE.indexOf('console')]).toBe(0);
	});

	it('marks markup comments in markup files only', () => {
		const SOURCE = '<!-- a -->b';

		expect(createCodeMask(SOURCE, 'markup')[2]).toBe(2);
		expect(createCodeMask(SOURCE, 'script')[2]).toBe(0);
	});

	it('reads a slash after a postfix increment or decrement as a division', () => {
		const SOURCE = "x = a++ / 2 + b-- / 3; y = '";

		expect(createCodeMask(SOURCE, 'script')[SOURCE.indexOf('2')]).toBe(0);
		expect(createCodeMask(SOURCE, 'script')[SOURCE.indexOf('3')]).toBe(0);
	});

	it('reads a slash after default or after a control header as a regular expression', () => {
		const DEFAULT_SOURCE = 'export default /[)]/;';
		const IF_SOURCE = 'if (x) /[)]/.test(y);';
		const WHILE_SOURCE = 'while (x) /[)]/.exec(y);';
		const CALL_SOURCE = 'f(x) / 2 / 3;';

		expect(createCodeMask(DEFAULT_SOURCE, 'script')[DEFAULT_SOURCE.indexOf(')')]).toBe(1);
		expect(createCodeMask(IF_SOURCE, 'script')[IF_SOURCE.lastIndexOf(')]')]).toBe(1);
		expect(createCodeMask(WHILE_SOURCE, 'script')[WHILE_SOURCE.lastIndexOf(')]')]).toBe(1);
		expect(createCodeMask(CALL_SOURCE, 'script')[CALL_SOURCE.indexOf('2')]).toBe(0);
	});

	it('continues a string over an escaped carriage return and line feed', () => {
		const SOURCE = "const s = 'a\\\r\nb';\r\nnext();";

		expect(createCodeMask(SOURCE, 'script')[SOURCE.indexOf('b')]).toBe(1);
		expect(createCodeMask(SOURCE, 'script')[SOURCE.indexOf('next')]).toBe(0);
	});

	it('reads <!-- as a single-line comment inside a script block only', () => {
		const SOURCE = '<script>\n<!-- a\nb();\n</script>';

		expect(createCodeMask(SOURCE, 'html')[SOURCE.indexOf('a\n')]).toBe(2);
		expect(createCodeMask(SOURCE, 'html')[SOURCE.indexOf('b();')]).toBe(0);
	});

	it('marks the text children of a JSX element as text and its expression containers as code', () => {
		const SOURCE = "const a = <p title='x'>it's {b} `c`</p>;\nd();";
		const MASK = createCodeMask(SOURCE, 'script');

		expect(MASK[SOURCE.indexOf("it's")]).toBe(TEXT_MASK_VALUE);
		expect(MASK[SOURCE.indexOf('`c`')]).toBe(TEXT_MASK_VALUE);
		expect(MASK[SOURCE.indexOf("'x'")]).toBe(1);
		expect(MASK[SOURCE.indexOf('b}')]).toBe(0);
		expect(MASK[SOURCE.indexOf('d()')]).toBe(0);
	});

	it('reads TypeScript type parameters, type assertions and comparisons as code', () => {
		// The first three hold the closing tag a JSX element would need, so only the type parameter shape keeps them code
		const SOURCES = [
			'const f = <T,>(a: T) => a; g(); const s = "</T>";',
			'const f = <T extends U>(a: T) => a; g(); const s = "</T>";',
			'const f = <const T,>(a: T) => a; g(); const s = "</const>";',
			'const a = <number>b; g();',
			'const a = b < c && d > e; g(); const s = "</c>";',
		];

		for (const SOURCE of SOURCES) {
			expect(createCodeMask(SOURCE, 'script')[SOURCE.indexOf('g()')]).toBe(0);
		}
	});
});

describe('createSourceLayout', () => {
	it('spans a whole script with one region holding statements', () => {
		expect(getCodeRegions('const a = 1;', 'script')).toEqual([['const a = 1;', true]]);
	});

	it('finds script blocks and Astro frontmatter', () => {
		const SOURCE = '---\nconst a = 1;\n---\n<script lang="ts">\nconst b = 2;\n</script>\n<p />';

		expect(getCodeRegions(SOURCE, 'astro')).toEqual([
			['const a = 1;\n', true],
			['\nconst b = 2;\n', true],
		]);
	});

	it('reads the frontmatter fence of a markup file as text instead', () => {
		const SOURCE = '---\nconst a = 1;\n---\n<script>\nconst b = 2;\n</script>\n<p />';

		expect(getCodeRegions(SOURCE, 'markup')).toEqual([['\nconst b = 2;\n', true]]);
		expect(isTextRange(SOURCE, 'markup', '---\nconst a = 1;\n---')).toBe(true);
	});

	it('reads a front matter fence written after a byte order mark', () => {
		expect(getCodeRegions('﻿---\nconst a = 1;\n---\n<p />', 'astro')).toEqual([['const a = 1;\n', true]]);
		expect(isTextRange('﻿---\ntitle: a\n---\n# a', 'markup', '---\ntitle: a\n---')).toBe(true);
	});

	it('finds the expression slots of a template, where no statement may be removed', () => {
		expect(getCodeRegions('<p>{value}</p>', 'markup')).toEqual([['value', false]]);
		expect(getCodeRegions('<p>{{ value }}</p>', 'markup')).toEqual([['{ value }', false]]);
		expect(getCodeRegions('<p a={b}>{c}</p>', 'astro')).toEqual([
			['b', false],
			['c', false],
		]);
		expect(getCodeRegions('<p>{value}</p>', 'html')).toEqual([]);
	});

	it('finds the value of a Vue expression attribute in markup only', () => {
		const SOURCE = '<a @click="a()" v-on:focus="b()" :title="c" v-if="d" #item="e" title="f"></a>';

		expect(getCodeRegions(SOURCE, 'markup')).toEqual([
			['a()', false],
			['b()', false],
			['c', false],
			['d', false],
			['e', false],
		]);
		expect(getCodeRegions(SOURCE, 'astro')).toEqual([]);
	});

	it('skips the sigil and the name of a Svelte block tag', () => {
		expect(getCodeRegions('{#if a}x{:else if b}y{:else}z{/if}{@html c}', 'markup')).toEqual([
			[' a', false],
			[' b', false],
			['', false],
			[' c', false],
		]);
	});

	it('reads markup text, a style block and a markup comment as text', () => {
		const SOURCE = '<p>Use console.log(x)</p><style>a { b: c }</style><!-- d -->';

		expect(getCodeRegions(SOURCE, 'markup')).toEqual([]);
		expect(isTextRange(SOURCE, 'markup', '<p>Use console.log(x)</p><style>a { b: c }</style>')).toBe(true);
		expect(createCodeMask(SOURCE, 'markup')[SOURCE.indexOf('d -->')]).toBe(2);
	});

	it('reads a data block as text, tags included', () => {
		const SOURCE = '<script type="application/json">{ "a": 1 }</script>';

		expect(getCodeRegions(SOURCE, 'html')).toEqual([]);
		expect(isTextRange(SOURCE, 'html', SOURCE)).toBe(true);
	});

	it('matches the tag names case-insensitively and allows spacing in the closing tag', () => {
		expect(getCodeRegions('<SCRIPT>const a = 1;</Script\n\t>', 'html')).toEqual([['const a = 1;', true]]);
	});

	it('ignores an opener that no closing tag follows', () => {
		expect(getCodeRegions('<script>const a = 1;\n<p />', 'html')).toEqual([]);
		expect(getCodeRegions('<scriptable>const a = 1;</script>', 'html')).toEqual([]);
		expect(getCodeRegions('<script>a</scriptx>', 'html')).toEqual([]);
		expect(getCodeRegions('<script>a</script', 'html')).toEqual([]);
		expect(getCodeRegions('<script>a</script \t', 'html')).toEqual([]);
	});

	it('never looks for a script opener in the frontmatter, a comment or an attribute value', () => {
		expect(getCodeRegions('---\nconst a = "<script>";\n---\n<script>b</script>', 'astro')).toEqual([
			['const a = "<script>";\n', true],
			['b', true],
		]);
		expect(getCodeRegions('<!-- <script> -->\n<script>b</script>', 'html')).toEqual([['b', true]]);
		expect(getCodeRegions('<p title="<script>"></p>\n<script>b</script>', 'html')).toEqual([['b', true]]);
	});

	it('leaves the rest of a document as text after a tag that never closes', () => {
		expect(getCodeRegions('<p title="a>\n<script>b</script>', 'html')).toEqual([]);
		expect(getCodeRegions('<p onclick={a>\n<script>b</script>', 'markup')).toEqual([]);
	});

	it('disables the later slots, and only them, after a slot that never closes', () => {
		expect(getCodeRegions('{a}\n{ `b\n<script>c</script>', 'markup')).toEqual([
			['a', false],
			['c', true],
		]);
	});
});

describe('delimiting a call', () => {
	it('finds the matching parenthesis across nested calls, strings and template literals', () => {
		const SOURCE = "console.log(fn('a)b'), `x${inner(1)}y`, 'c(')";

		expect(findFirstCallEnd(SOURCE)).toBe(SOURCE.length - 1);
	});

	it('treats an escaped quote inside a string as text', () => {
		const SOURCE = 'console.log(\'a\\\')b\', "c\\")d")';

		expect(findFirstCallEnd(SOURCE)).toBe(SOURCE.length - 1);
	});

	it('ignores parentheses and quotes written in a comment', () => {
		const SOURCE = "console.log(a /* ) it's */, b // )\n)";

		expect(findFirstCallEnd(SOURCE)).toBe(SOURCE.length - 1);
	});

	it('ignores a parenthesis written in a regular expression literal', () => {
		const SOURCE = 'console.log(text.replace(/\\)/g, ""))';

		expect(findFirstCallEnd(SOURCE)).toBe(SOURCE.length - 1);
	});

	it('accepts a function body holding braces and semicolons', () => {
		const SOURCE = 'console.log(() => { const a = 1; return a; })';

		expect(findFirstCallEnd(SOURCE)).toBe(SOURCE.length - 1);
	});

	it('returns -1 for a parenthesis written inside a literal', () => {
		const SOURCE = "const a = 'console.log(1)';";

		expect(findFirstCallEnd(SOURCE)).toBe(-1);
	});

	it('returns -1 when the parentheses are unbalanced', () => {
		expect(findFirstCallEnd("console.log('a';")).toBe(-1);
		expect(findFirstCallEnd('console.log(fn(1);')).toBe(-1);
	});

	it('returns -1 on a structurally impossible argument list', () => {
		expect(findFirstCallEnd('console.log(a}b)')).toBe(-1);
		expect(findFirstCallEnd('console.log(a; b)')).toBe(-1);
		expect(findFirstCallEnd('console.log({ a: 1)')).toBe(-1);
	});
});

describe('applyEdits', () => {
	it('returns the input unchanged without edits', () => {
		expect(applyEdits('abc', [])).toBe('abc');
	});

	it('rejects unsorted or overlapping edits', () => {
		expect(() =>
			applyEdits('abcdef', [
				{ start: 2, end: 4, replacement: '' },
				{ start: 1, end: 5, replacement: '' },
			]),
		).toThrow(/sorted by start index and non-overlapping/);
		expect(() => applyEdits('abcdef', [{ start: 4, end: 2, replacement: '' }])).toThrow(/non-overlapping/);
	});
});

describe('stripConsole removals', () => {
	it('removes a standalone statement together with its semicolon', () => {
		expectStripped({ source: "console.log('a');", expected: '' });
		expectStripped({ source: 'const a = 1;\nconsole.log(a);\nfoo(a);', expected: 'const a = 1;\nfoo(a);' });
	});

	it('removes a statement written without a semicolon', () => {
		expectStripped({ source: 'console.log(1)\nfoo()', expected: 'foo()' });
		expectStripped({
			source: 'const a = 1\nconsole.log(a)\nconst b = 2\n',
			expected: 'const a = 1\nconst b = 2\n',
		});
	});

	it('removes a multiline call', () => {
		expectStripped({ source: "console.log(\n\t'a',\n\t'b',\n);\nfoo();", expected: 'foo();' });
	});

	it('removes a call written as the only statement of a block', () => {
		expectStripped({ source: 'function f() { console.log(1) }', expected: 'function f() {  }' });
	});

	it('removes a call preceded by a comment', () => {
		expectStripped({ source: '// Debug\nconsole.log(1);', expected: '// Debug\n' });
		expectStripped({ source: '/* Debug */ console.log(1);', expected: '/* Debug */ ' });
	});

	it('removes a call followed by a trailing comment', () => {
		expectStripped({ source: 'console.log(1) // note', expected: ' // note' });
	});

	it('removes a call opening a statement that follows a closing brace', () => {
		expectStripped({ source: 'function f() {\n}\nconsole.log(1);', expected: 'function f() {\n}\n' });
	});

	it('strips every default method and keeps the informative ones', () => {
		const STRIPPED = DEFAULT_METHODS.map((method) => `console.${method}(1);`).join('');

		expectStripped({ source: STRIPPED, expected: '' });
		expectStripped({
			source: 'console.error(1);console.warn(1);console.info(1);console.clear();',
			expected: 'console.error(1);console.warn(1);console.info(1);console.clear();',
		});
	});

	it('honorsa custom method list', () => {
		expectStripped({
			source: "console.error('x');console.log('y');",
			expected: "console.log('y');",
			options: { methods: ['error'] },
		});
	});

	it('drops unknown method names instead of matching them', () => {
		expectStripped({
			source: 'console.log(1);console.nope(1);',
			expected: 'console.nope(1);',
			// @ts-expect-error -- deliberately malformed input
			options: { methods: ['nope', 'log'] },
		});
	});

	it('is a no-op when the method list is empty', () => {
		expectStripped({ source: 'console.log(1);', expected: 'console.log(1);', options: { methods: [] } });
	});

	it('tolerates whitespace around the dot and the parenthesis', () => {
		expectStripped({ source: 'console . log (1);', expected: '' });
	});

	it('includes a global qualifier in the edited range', () => {
		expectStripped({ source: 'window.console.log(1);', expected: '' });
		expectStripped({ source: 'globalThis . console.log(1);', expected: '' });
		expectStripped({ source: 'const a = self.console.log(1);', expected: 'const a = void 0;' });
		expectStripped({ source: 'const a = global.console.log(1);', expected: 'const a = void 0;' });
	});

	it('leaves an identifier merely ending in console untouched', () => {
		expectStripped({
			source: 'const $console = g();\n$console.log(1);\nfoo();',
			expected: 'const $console = g();\n$console.log(1);\nfoo();',
		});

		expectStripped({
			source: 'class C { #console = x; m() { this.#console.log(1); } }',
			expected: 'class C { #console = x; m() { this.#console.log(1); } }',
		});

		expectStripped({ source: 'obj.$console.log(1);', expected: 'obj.$console.log(1);' });
		expectStripped({
			source: 'const é$console = x;\né$console.log(1);',
			expected: 'const é$console = x;\né$console.log(1);',
		});

		expectStripped({
			source: 'const éconsole = x;\néconsole.log(1);',
			expected: 'const éconsole = x;\néconsole.log(1);',
		});

		expectStripped({ source: '_console.log(1)', expected: '_console.log(1)' });
		expectStripped({ source: 'console$.log(1)', expected: 'console$.log(1)' });
	});

	it('leaves any other member access untouched', () => {
		expectStripped({ source: 'foo.console.log(1);', expected: 'foo.console.log(1);' });
		expectStripped({ source: 'a.window.console.log(1);', expected: 'a.window.console.log(1);' });
		expectStripped({ source: 'window?.console.log(1);', expected: 'window?.console.log(1);' });
		expectStripped({ source: 'myconsole.log(1);', expected: 'myconsole.log(1);' });
	});

	it('edits a nested console call only once', () => {
		expectStripped({ source: 'console.log(console.log(1));', expected: '' });
		expectStripped({ source: 'console.error(console.log(1));', expected: 'console.error(void 0);' });
	});

	it('keeps a call holding a template literal, a comment or a quote in its arguments', () => {
		expectStripped({ source: 'console.log(`a${fn(b)}c`);', expected: '' });
		expectStripped({ source: 'console.log(`a${`b${c(1)}d`}e`);\nfoo();\n', expected: 'foo();\n' });
		expectStripped({ source: "console.log(a /* ) */, 'it(s');", expected: '' });
		expectStripped({ source: 'console.log(`a\\`)b`);', expected: '' });
	});

	it('leaves an unbalanced call untouched', () => {
		// The call never closes on purpose, so neither the fixture nor its output parses
		expectStripped({ source: "console.log('a';", expected: "console.log('a';", isInvalidSource: true });
	});

	it('leaves console text written inside a string or a comment untouched', () => {
		expectStripped({ source: "const s = 'console.log(1)';", expected: "const s = 'console.log(1)';" });
		expectStripped({ source: '// console.log(1)\nfoo();', expected: '// console.log(1)\nfoo();' });
		expectStripped({ source: '/* console.log(1); */', expected: '/* console.log(1); */' });
	});

	it('returns the input unchanged when no console call is present', () => {
		expectStripped({ source: 'const a = 1;', expected: 'const a = 1;' });
	});
});

describe('stripConsole whole-line removals', () => {
	it('removes the line a statement was alone on', () => {
		expectStripped({ source: 'before();\nconsole.log(1);\nafter();', expected: 'before();\nafter();' });
		expectStripped({ source: 'before();\r\nconsole.log(1);\r\nafter();', expected: 'before();\r\nafter();' });
	});

	it('leaves no blank line behind two statements written on consecutive lines', () => {
		expectStripped({
			source: 'before();\nconsole.log(1);\nconsole.log(2);\nafter();',
			expected: 'before();\nafter();',
		});
	});

	it('keeps a blank line the source already held', () => {
		expectStripped({
			source: 'before();\n\nconsole.log(1);\n\nafter();',
			expected: 'before();\n\n\nafter();',
		});
	});

	it('keeps the line of a statement sharing it with other code or a comment', () => {
		expectStripped({ source: 'a(); console.log(1); b();', expected: 'a();  b();' });
		expectStripped({ source: 'if (x) { console.log(1); }', expected: 'if (x) {  }' });
		expectStripped({ source: 'a();\nconsole.log(1); // note\nb();', expected: 'a();\n // note\nb();' });
	});

	it('removes the indentation of a last line closing the file without a line break', () => {
		expectStripped({ source: 'a();\n\tconsole.log(1);', expected: 'a();\n' });
	});

	it('never reaches past the block or the fence enclosing the statement', () => {
		expectStripped({
			source: '<script>console.log(1);</script>\n',
			expected: '<script></script>\n',
			options: { fileKind: 'html' },
		});

		expectStripped({
			source: '<script>\n\tconsole.log(1);\n</script>\n',
			expected: '<script>\n</script>\n',
			options: { fileKind: 'html' },
		});

		expectStripped({
			source: '---\nconsole.log(1);\n---\n<p>a</p>\n',
			expected: '---\n---\n<p>a</p>\n',
			options: { fileKind: 'astro' },
		});
	});

	it('takes the last line of the frontmatter with its statement, leaving no blank line before the fence', () => {
		expectStripped({
			source: '---\nconst a = 1;\nconsole.log(2);\n---\n<p>x</p>',
			expected: '---\nconst a = 1;\n---\n<p>x</p>',
			options: { fileKind: 'astro' },
		});

		expectStripped({
			source: '---\r\nconst a = 1;\r\nconsole.log(2);\r\n---\r\n<p>x</p>',
			expected: '---\r\nconst a = 1;\r\n---\r\n<p>x</p>',
			options: { fileKind: 'astro' },
		});
	});

	it('reads an empty frontmatter as one, closing on the line right after its opening fence', () => {
		expect(getCodeRegions('---\n---\n<p>{a}</p>\n---\nb\n', 'astro')).toEqual([
			['', true],
			['a', false],
		]);
		expectStripped({
			source: '---\n---\n<p>{console.log(1)}</p>\n',
			expected: '---\n---\n<p>{void 0}</p>\n',
			options: { fileKind: 'astro' },
		});
	});

	it('keeps the last frontmatter statement a next-line directive protects, and removes the one before it', () => {
		expectStripped({
			source: '---\nconsole.log(1);\n// console-stripper-ignore-next-line\nconsole.log(2);\n---\n<p />\n',
			expected: '---\n// console-stripper-ignore-next-line\nconsole.log(2);\n---\n<p />\n',
			options: { fileKind: 'astro' },
		});

		expectStripped({
			source: '---\n// console-stripper-ignore-next-line\nconsole.log(1);\nconsole.log(2);\n---\n<p />\n',
			expected: '---\n// console-stripper-ignore-next-line\nconsole.log(1);\n---\n<p />\n',
			options: { fileKind: 'astro' },
		});
	});
});

describe('stripConsole multiline calls', () => {
	it('removes a call whose object and array arguments span several lines', () => {
		expectStripped({
			source: 'const a = 1;\nconsole.log(\n\t{\n\t\ta: 1,\n\t\tb: [2, 3],\n\t},\n\t[\n\t\t4,\n\t\t5,\n\t],\n);\nfoo();',
			expected: 'const a = 1;\nfoo();',
		});
	});

	it('removes a call holding a template literal that spans lines and closes a parenthesis', () => {
		expectStripped({
			source: 'const a = 1;\nconsole.log(\n\t`x\n)y${fn({ x: ")" })}z`,\n);\nfoo();',
			expected: 'const a = 1;\nfoo();',
		});
	});

	it('removes a call whose callback argument holds statements and a misleading comment', () => {
		expectStripped({
			source:
				'const a = 1;\nconsole.log(\n\titems.map((item) => {\n\t\t// ) tricky ;\n\t\treturn item;\n\t}),\n);\nfoo();',
			expected: 'const a = 1;\nfoo();',
		});
	});

	it('removes a call commented between its arguments', () => {
		expectStripped({
			source: 'const a = 1;\nconsole.log(\n\t1, // first\n\t/* second */ 2,\n);\nfoo();',
			expected: 'const a = 1;\nfoo();',
		});
	});

	it('removes a call holding a regular expression and parenthesized strings', () => {
		expectStripped({
			source: 'const a = 1;\nconsole.log(\n\t/\\)/,\n\t")(",\n\t\'(\',\n);\nfoo();',
			expected: 'const a = 1;\nfoo();',
		});
	});

	it('removes a call whose callee is split over several lines', () => {
		expectStripped({ source: 'console\n\t.log(\n\t\t1\n\t)\n;', expected: ';' });
	});

	it('removes a multiline call automatic semicolon insertion terminates on both sides', () => {
		expectStripped({ source: 'a()\nconsole.log(\n\t1\n)\nb()', expected: 'a()\nb()' });
	});

	it('removes a multiline call written with carriage returns', () => {
		expectStripped({ source: 'a();\r\nconsole.log(\r\n\t1\r\n);\r\nb();', expected: 'a();\r\nb();' });
	});

	it('removes a multiline call indented inside a function block', () => {
		expectStripped({
			source: 'function f() {\n\tconsole.log(\n\t\t"x",\n\t);\n\treturn 1;\n}',
			expected: 'function f() {\n\treturn 1;\n}',
		});
	});

	it('replaces a multiline call written in expression position', () => {
		expectStripped({ source: 'ok && console.log(\n\t1,\n\t2\n);', expected: 'ok && void 0;' });
		expectStripped({ source: 'const f = () =>\n\tconsole.log(\n\t\t1,\n\t);', expected: 'const f = () =>\n\tvoid 0;' });
	});

	it('removes a multiline call forming the body of an arrow function block', () => {
		expectStripped({
			source: 'const f = () => {\n\tconsole.log(\n\t\t1,\n\t);\n\treturn 2;\n};',
			expected: 'const f = () => {\n\treturn 2;\n};',
		});
	});

	it('removes two consecutive multiline calls without leaving a blank line', () => {
		expectStripped({
			source: 'const a = 1;\nconsole.log(\n\t1,\n);\nconsole.log(\n\t2,\n);\nfoo();',
			expected: 'const a = 1;\nfoo();',
		});
	});

	it('keeps a multiline call to a method the options keep', () => {
		const SOURCE = 'const a = 1;\nconsole.error(\n\t"kept",\n);\nfoo();';

		expectStripped({ source: SOURCE, expected: SOURCE });
	});

	it('keeps a multiline call protected by a directive and removes the one that follows', () => {
		expectStripped({
			source: '// console-stripper-ignore-next-line\nconsole.log(\n\t1,\n);\nconsole.log(\n\t2,\n);\nfoo();',
			expected: '// console-stripper-ignore-next-line\nconsole.log(\n\t1,\n);\nfoo();',
		});
	});

	it('removes a multiline call from a component script and replaces the one in an attribute', () => {
		const BLOCK = '<script lang="ts">\n\tconsole.log(\n\t\t1,\n\t);\n\tconst a = 2;\n</script>\n';
		const ATTRIBUTE = '<button onclick={() => console.log(\n\ta,\n)}>x</button>\n';

		expectStripped({
			source: `${BLOCK}${ATTRIBUTE}`,
			expected: '<script lang="ts">\n\tconst a = 2;\n</script>\n<button onclick={() => void 0}>x</button>\n',
			options: { fileKind: 'markup' },
		});
	});
});

describe('stripConsole expression replacements', () => {
	it('replaces a brace-less if body without swallowing the next statement', () => {
		expectStripped({ source: 'if (x) console.log(1);\nfoo();', expected: 'if (x) void 0;\nfoo();' });
		expectStripped({
			source: 'if (x) /* c */ console.log(1);\nfoo();',
			expected: 'if (x) /* c */ void 0;\nfoo();',
		});

		expectStripped({
			source: 'if (x) console.log(1);\nelse console.log(2);\nfoo();\n',
			expected: 'if (x) void 0;\nelse void 0;\nfoo();\n',
		});
	});

	it('replaces a call used inside a larger expression', () => {
		expectStripped({ source: 'x && console.log(1);', expected: 'x && void 0;' });
		expectStripped({ source: 'const f = () => console.log(x);', expected: 'const f = () => void 0;' });
		expectStripped({ source: 'const a = b ? console.log(1) : 2;', expected: 'const a = b ? void 0 : 2;' });
		expectStripped({ source: 'const a = console.log(1);', expected: 'const a = void 0;' });
		expectStripped({ source: 'foo(console.log(1));', expected: 'foo(void 0);' });
		expectStripped({ source: 'switch (x) { case 1: console.log(1); }', expected: 'switch (x) { case 1: void 0; }' });
		expectStripped({ source: 'do console.log(1); while (x);', expected: 'do void 0; while (x);' });
	});

	it('parenthesizes the replacement when the call result is used', () => {
		expectStripped({ source: 'const a = console.log(1).foo;\n', expected: 'const a = (void 0).foo;\n' });
		expectStripped({ source: 'const a = console.log(1)[0];\n', expected: 'const a = (void 0)[0];\n' });
		expectStripped({ source: 'const a = console.log(1)(2);\n', expected: 'const a = (void 0)(2);\n' });
		expectStripped({ source: 'const a = console.log(1)`x`;\n', expected: 'const a = (void 0)`x`;\n' });
		expectStripped({ source: 'console.log(1).foo;\n', expected: '(void 0).foo;\n' });
	});

	it('does not read a literal following the call as a statement terminator', () => {
		expectStripped({ source: 'function f() { console.log(1)`x`; }\n', expected: 'function f() { (void 0)`x`; }\n' });
	});

	it('never empties a JSX expression container', () => {
		expectStripped({
			source: '<div a={console.log(1)} />;\n',
			expected: '<div a={void 0} />;\n',
			fileName: 'fixture.jsx',
		});

		expectStripped({
			source: 'const C = () => <div onClick={() => console.log(1)}>{console.log(2)}</div>;\n',
			expected: 'const C = () => <div onClick={() => void 0}>{void 0}</div>;\n',
			fileName: 'fixture.jsx',
		});
	});

	it('still removes a statement from every form of block', () => {
		expectStripped({ source: '{ console.log(1) }', expected: '{  }' });
		expectStripped({ source: 'function f() { console.log(1) }', expected: 'function f() {  }' });
		expectStripped({ source: 'const f = () => { console.log(1) };', expected: 'const f = () => {  };' });
		expectStripped({ source: 'class A { m() { console.log(1) } }', expected: 'class A { m() {  } }' });
		expectStripped({
			source: 'try { console.log(1) } finally { console.log(2) }',
			expected: 'try {  } finally {  }',
		});

		expectStripped({ source: 'do { console.log(1) } while (x);', expected: 'do {  } while (x);' });
		expectStripped({
			source: 'if (x) { console.log(1) } else { console.log(2) }',
			expected: 'if (x) {  } else {  }',
		});

		expectStripped({ source: 'outer: { console.log(1) }', expected: 'outer: {  }' });
	});

	it('never removes a clause of a for header', () => {
		expectStripped({
			source: 'for (let i = 0; console.log(i); i++) { work(i); }',
			expected: 'for (let i = 0; void 0; i++) { work(i); }',
		});

		expectStripped({ source: 'for (;console.log(1);) {}', expected: 'for (;void 0;) {}' });
		expectStripped({ source: 'for (a; console.log(b); c) {}', expected: 'for (a; void 0; c) {}' });
		expectStripped({
			source: 'for (\n\tlet i = 0;\n\tconsole.log(i);\n\ti++\n) { work(i); }',
			expected: 'for (\n\tlet i = 0;\n\tvoid 0;\n\ti++\n) { work(i); }',
		});

		expectStripped({ source: 'for (console.log(1); i < 2; i++) {}', expected: 'for (void 0; i < 2; i++) {}' });
		expectStripped({ source: 'for (a; b; console.log(1)) {}', expected: 'for (a; b; void 0) {}' });
	});

	it('never removes a clause of a for header holding a long literal', () => {
		const HEADER_START = `let i = 0, s = "${'x'.repeat(4100)}"`;

		expectStripped({
			source: `for (${HEADER_START}; console.log(i); i++) { x(); }`,
			expected: `for (${HEADER_START}; void 0; i++) { x(); }`,
		});
	});

	it('never removes a clause of a long for header', () => {
		const HEADER_START = `let i = 0, s = ${'1 + '.repeat(1100)}1`;

		expectStripped({
			source: `for (${HEADER_START}; console.log(i); i++) { x(); }`,
			expected: `for (${HEADER_START}; void 0; i++) { x(); }`,
		});
	});

	it('removes a call written after a long balanced literal, whatever its brackets', () => {
		const ARRAY = `const A = [${'1, '.repeat(1400)}1];`;
		const OBJECT = `const A = {${'a: 1, '.repeat(1400)}};`;

		expectStripped({ source: `${ARRAY}\nconsole.log(1);\nfoo();`, expected: `${ARRAY}\nfoo();` });
		expectStripped({ source: `${OBJECT}\nconsole.log(1);\nfoo();`, expected: `${OBJECT}\nfoo();` });
	});

	it('still removes a statement from the body of a for loop', () => {
		expectStripped({
			source: 'for (let i = 0; i < n; i++) { console.log(i); }',
			expected: 'for (let i = 0; i < n; i++) {  }',
		});

		expectStripped({ source: 'for (const a of b) console.log(a);', expected: 'for (const a of b) void 0;' });
		expectStripped({
			source: 'async function f() { for await (const a of b) { console.log(a); } }',
			expected: 'async function f() { for await (const a of b) {  } }',
		});
	});

	it('still removes a statement written after a semicolon inside an argument list', () => {
		expectStripped({
			source: 'setTimeout(() => { a(); console.log(1); }, 0);',
			expected: 'setTimeout(() => { a();  }, 0);',
		});

		expectStripped({
			source: 'run(function () {\n\tconst a = 1;\n\tconsole.log(a);\n\treturn a;\n});',
			expected: 'run(function () {\n\tconst a = 1;\n\treturn a;\n});',
		});
	});

	it('still removes a statement written after a very long one', () => {
		const PREVIOUS = `const A = '${'x'.repeat(8000)}';`;

		expectStripped({ source: `${PREVIOUS}\nconsole.log(1);\nfoo();`, expected: `${PREVIOUS}\nfoo();` });
	});

	it('replaces a call closing the file', () => {
		expectStripped({ source: 'const a = console.log(1)', expected: 'const a = void 0' });
	});

	it('parenthesizes the replacement of an optional chain and an exponentiation', () => {
		expectStripped({ source: 'x = console.log(1)?.(2);', expected: 'x = (void 0)?.(2);' });
		expectStripped({ source: 'x = console.log(1)?.x.y;', expected: 'x = (void 0)?.x.y;' });
		expectStripped({ source: 'const a = console.log(1) ** 2;', expected: 'const a = (void 0) ** 2;' });
		expectStripped({ source: 'const a = console.log(1)\n** 2;', expected: 'const a = (void 0)\n** 2;' });
	});

	it('leaves a construction exactly as written', () => {
		expectStripped({ source: 'new console.log(1);', expected: 'new console.log(1);' });
		expectStripped({ source: 'x = new window.console.log(1);', expected: 'x = new window.console.log(1);' });
	});

	it('keeps a word written right against the call apart from the replacement', () => {
		expectStripped({ source: 'x = console.log(1)in b;', expected: 'x = void 0 in b;' });
		expectStripped({ source: 'x = console.log(1)instanceof B;', expected: 'x = void 0 instanceof B;' });
		expectStripped({ source: 'x = console.log(1) in b;', expected: 'x = void 0 in b;' });
	});

	it('leaves an operator the replacement already binds tighter than unparenthesized', () => {
		expectStripped({ source: 'const b = console.log(a) ?? 2;', expected: 'const b = void 0 ?? 2;' });
		expectStripped({ source: 'const b = console.log(a) ? 1 : 2;', expected: 'const b = void 0 ? 1 : 2;' });
		expectStripped({ source: 'const b = console.log(a) * 2;', expected: 'const b = void 0 * 2;' });
	});

	it('never replaces a call inside a template placeholder as if it were a statement', () => {
		expectStripped({
			source: 'function f() {\n\t`${console.log(1)}`;\n}\n',
			expected: 'function f() {\n\t`${void 0}`;\n}\n',
		});
	});
});

describe('stripConsole automatic semicolon insertion', () => {
	it('keeps a removed statement from fusing its neighbors', () => {
		expectStripped({
			source: 'const f = function () {}\nconsole.log(1)\n-1\n',
			expected: 'const f = function () {}\n;\n-1\n',
		});

		expectStripped({ source: 'const a = {}\nconsole.log(1)\n+1\n', expected: 'const a = {}\n;\n+1\n' });
		expectStripped({ source: 'const a = {}\nconsole.log(1)\n`x`\n', expected: 'const a = {}\n;\n`x`\n' });
	});

	it('does not add a semicolon when the removed statement had one', () => {
		expectStripped({ source: 'const a = b;\nconsole.log(1);\n-1;\n', expected: 'const a = b;\n-1;\n' });
	});

	it('guards a removed statement the next line could have fused with the line above', () => {
		expectStripped({
			source: 'const a = b\nconsole.log(1)\n(function () {})()\n',
			expected: 'const a = b\n;\n(function () {})()\n',
		});

		expectStripped({
			source: 'const a = b\nconsole.log(1)\n[1].forEach(f)\n',
			expected: 'const a = b\n;\n[1].forEach(f)\n',
		});
	});

	it('guards a removed statement ending in a semicolon that followed a function expression', () => {
		expectStripped({
			source: 'var f = function () {}\nconsole.log(1);\n(c)();\n',
			expected: 'var f = function () {}\n;\n(c)();\n',
		});

		expectStripped({
			source: 'const o = {}\nconsole.log(1);\n[1].forEach(f);\n',
			expected: 'const o = {}\n;\n[1].forEach(f);\n',
		});
	});

	it('keeps the observable behavior of a removed statement ending in a semicolon', () => {
		const SOURCE = 'var f = function () { return 1; }\nconsole.log(1);\n(g)();\nresult = typeof f;\n';
		const OUTPUT = stripConsole(SOURCE);
		const AFTER = { console: { log: vi.fn() }, g: vi.fn(), result: '' };

		new Script(OUTPUT).runInNewContext(AFTER);

		expect(AFTER.result).toBe('function');
		expect(AFTER.g).toHaveBeenCalledOnce();
	});

	it('adds no guard after a statement a semicolon or a brace already ended', () => {
		expectStripped({ source: 'a();\nconsole.log(1)\n(b)();\n', expected: 'a();\n(b)();\n' });
		expectStripped({ source: '{\nconsole.log(1)\n(b)();\n}\n', expected: '{\n(b)();\n}\n' });
	});

	it('guards a run of removed statements the next line could have fused with the line above', () => {
		expectStripped({
			source: 'a()\nconsole.log(1);\nconsole.log(2);\n[1].forEach(f)\n',
			expected: 'a()\n;\n[1].forEach(f)\n',
		});

		expectStripped({ source: 'a()\nconsole.log(1); console.log(2);\n(b)\n', expected: 'a()\n;\n(b)\n' });
		expectStripped({ source: 'a()\nconsole.log(1);\nconsole.log(2);\n`t`\n', expected: 'a()\n;\n`t`\n' });
		expectStripped({
			source: 'a()\nconsole.log(1);\nconsole.log(2);\n/r/.test(s)\n',
			expected: 'a()\n;\n/r/.test(s)\n',
		});

		expectStripped({ source: 'a()\nconsole.log(1);\nconsole.log(2);\n+b\n', expected: 'a()\n;\n+b\n' });
		expectStripped({ source: 'a()\nconsole.log(1);\nconsole.log(2);\n-b\n', expected: 'a()\n;\n-b\n' });
		expectStripped({ source: 'a()\nconsole.log(1)\nconsole.log(2);\n[1]\n', expected: 'a()\n;\n[1]\n' });
		expectStripped({ source: 'a()\nconsole.log(1); // x\nconsole.log(2);\n[1]\n', expected: 'a()\n // x\n;\n[1]\n' });
	});

	it('guards a run of removed statements inside a block and with CRLF line breaks', () => {
		expectStripped({
			source: 'function f() {\n  a()\n  console.log(1);\n  console.log(2);\n  [1].forEach(f)\n}\n',
			expected: 'function f() {\n  a()\n  ;\n  [1].forEach(f)\n}\n',
		});

		expectStripped({
			source: 'a()\r\nconsole.log(1);\r\nconsole.log(2);\r\n[1].forEach(f)\r\n',
			expected: 'a()\r\n;\r\n[1].forEach(f)\r\n',
		});
	});

	it('adds no guard to a run of removed statements at the end of the file or after a semicolon or a brace', () => {
		expectStripped({ source: 'a()\nconsole.log(1);\nconsole.log(2);\n', expected: 'a()\n' });
		expectStripped({ source: 'a();\nconsole.log(1);\nconsole.log(2);\n[1]\n', expected: 'a();\n[1]\n' });
		expectStripped({ source: 'a();\nconsole.log(1)\nconsole.log(2)\n[1]\n', expected: 'a();\n[1]\n' });
		expectStripped({ source: '{\nconsole.log(1);\nconsole.log(2);\n[1]\n}\n', expected: '{\n[1]\n}\n' });
	});

	it('prefixes a parenthesized replacement with a semicolon after a value on the line above', () => {
		expectStripped({ source: 'var f = {}\nconsole.log(1)?.y;\n', expected: 'var f = {}\n;(void 0)?.y;\n' });
		expectStripped({ source: 'var r = /a/\nconsole.log(1).y;\n', expected: 'var r = /a/\n;(void 0).y;\n' });
		expectStripped({ source: 'const a = b\nconsole.log(1).y;\n', expected: 'const a = b\n;(void 0).y;\n' });
		expectStripped({
			source: 'if (a) {} console.log(1).y;\n',
			expected: 'if (a) {} ;(void 0).y;\n',
		});
	});

	it('never prefixes a replacement after a keyword or a control header', () => {
		expectStripped({ source: 'x = typeof console.log(1).y;\n', expected: 'x = typeof (void 0).y;\n' });
		expectStripped({ source: 'if (x) console.log(1).y;\n', expected: 'if (x) (void 0).y;\n' });
	});

	it('keeps the observable behavior of a removed semicolon-less statement', () => {
		const SOURCE = 'const f = function () {}\nconsole.log(1)\n-1\nresult = typeof f;\n';
		const OUTPUT = stripConsole(SOURCE);
		const BEFORE = { console: { log: vi.fn() }, result: '' };
		const AFTER = { console: { log: vi.fn() }, result: '' };

		new Script(SOURCE).runInNewContext(BEFORE);
		new Script(OUTPUT).runInNewContext(AFTER);

		expect(AFTER.result).toBe(BEFORE.result);
		expect(AFTER.result).toBe('function');
	});
});

describe('stripConsole statement continuation', () => {
	/**
	 * Operators opening the line below a call, each with the replacement that call must become. A statement is only
	 * removed when automatic semicolon insertion really ended it, which none of these operators lets happen.
	 */
	const CONTINUATIONS: readonly (readonly [string, string])[] = [
		['.x', '(void 0)'],
		[', b', 'void 0'],
		['? a : b', 'void 0'],
		['?.x', '(void 0)'],
		['% 2', 'void 0'],
		['< 2', 'void 0'],
		['> 2', 'void 0'],
		['== b', 'void 0'],
		['=== b', 'void 0'],
		['!= b', 'void 0'],
		['!== b', 'void 0'],
		['&& b()', 'void 0'],
		['|| b()', 'void 0'],
		['?? b', 'void 0'],
		['^ 2', 'void 0'],
		['& 2', 'void 0'],
		['| 2', 'void 0'],
		['>> 2', 'void 0'],
		['instanceof B', 'void 0'],
		['in o', 'void 0'],
		['* 2', 'void 0'],
		['/ 2', 'void 0'],
	];

	it('replaces a call whose expression continues on the next line', () => {
		for (const [OPERATOR, REPLACEMENT] of CONTINUATIONS) {
			expectStripped({
				source: `const a = 1;\nconsole.log(1)\n${OPERATOR};`,
				expected: `const a = 1;\n${REPLACEMENT}\n${OPERATOR};`,
			});
		}
	});

	it('replaces a call the next line assigns to', () => {
		// `console.log(1) = 2` has no valid assignment target, so the fixture never compiled and only the shape of the
		// output can be asserted
		expect(stripConsole('const a = 1;\nconsole.log(1)\n= 2;')).toBe('const a = 1;\nvoid 0\n= 2;');
	});

	it('still removes a call the next line cannot continue', () => {
		expectStripped({ source: 'const a = 1;\nconsole.log(1)\nfoo();', expected: 'const a = 1;\nfoo();' });
		expectStripped({
			source: 'const a = 1;\nconsole.log(1)\ninstance.run();',
			expected: 'const a = 1;\ninstance.run();',
		});

		expectStripped({ source: 'const a = {}\nconsole.log(1)\n+1\n', expected: 'const a = {}\n;\n+1\n' });
		expectStripped({ source: 'const a = 1;\nconsole.log(1)\nfoo', expected: 'const a = 1;\nfoo' });
	});

	it('reads `!=` opening the next line as a continuation, and a lone `!` as a new statement', () => {
		expectStripped({ source: 'x = y\nconsole.log(1)\n!= z', expected: 'x = y\nvoid 0\n!= z' });
		expectStripped({ source: 'a\nconsole.log(1)\n!b', expected: 'a\n!b' });
	});

	it('does not read the tag closing a script block as a continuation', () => {
		expectStripped({
			source: '<script>\nconsole.log(1)\n</script>\n<p>a</p>\n',
			expected: '<script>\n</script>\n<p>a</p>\n',
			options: { fileKind: 'html' },
		});
	});
});

describe('stripConsole regular expression literals', () => {
	it('does not read a regular expression as a comment or a string', () => {
		expectStripped({ source: "console.log(/'/, x);\nfoo(bar);\nbaz(qux);\n", expected: 'foo(bar);\nbaz(qux);\n' });
		expectStripped({ source: 'const RE = /`/;\nconsole.log(1);\nfoo();\n', expected: 'const RE = /`/;\nfoo();\n' });
		expectStripped({
			source: 'const RE = /[/]/;\nconsole.log(1);\nfoo();\n',
			expected: 'const RE = /[/]/;\nfoo();\n',
		});

		expectStripped({
			source: 'const RE = /a\\/\\/b/;\nconsole.log(1);\nfoo();\n',
			expected: 'const RE = /a\\/\\/b/;\nfoo();\n',
		});
	});

	it('handles a regular expression written inside the arguments', () => {
		expectStripped({ source: "console.log(text.replace(/\\)/g, ''));\nnext();\n", expected: 'next();\n' });
		expectStripped({ source: 'console.log(/\\)/.test(x));\nfoo();\n', expected: 'foo();\n' });
	});

	it('handles a regular expression written after a keyword inside the arguments', () => {
		expectStripped({
			source: "const x = 1, y = 'a';\nconsole.log(x, y in /\\)/ );",
			expected: "const x = 1, y = 'a';\n",
		});

		expectStripped({
			source: "const y = 'a';\nconsole.log(y instanceof /x/.constructor);\nfoo();\n",
			expected: "const y = 'a';\nfoo();\n",
		});
	});

	it('keeps the rest of an arrow body after a regular expression argument', () => {
		expectStripped({
			source: "items.map((item) => {\n\tconsole.log(/'/); item.tag = 'a';\n\treturn item;\n});\n",
			expected: "items.map((item) => {\n\t item.tag = 'a';\n\treturn item;\n});\n",
		});
	});

	it('reads a slash after a value as a division', () => {
		expectStripped({
			source: 'const c = a / b / d;\nconsole.log(c);\nfoo();\n',
			expected: 'const c = a / b / d;\nfoo();\n',
		});

		expectStripped({ source: 'x = y / 2; console.log(1); z = w / 3;\n', expected: 'x = y / 2;  z = w / 3;\n' });
	});

	it('reads a slash opening the file as a regular expression', () => {
		expectStripped({ source: "/a'b/.test(x);\nconsole.log(1);\nfoo();\n", expected: "/a'b/.test(x);\nfoo();\n" });
	});

	it('reads a slash after an arrow as a regular expression', () => {
		expectStripped({
			source: 'const f = () => /a/.test(x);\nconsole.log(1);\nfoo();\n',
			expected: 'const f = () => /a/.test(x);\nfoo();\n',
		});
	});
});

describe('stripConsole html files', () => {
	const HTML: StripConsoleOptions = { fileKind: 'html' };

	it('removes a statement from a script block', () => {
		expectStripped({
			source: '<p>hello</p>\n<script>\n\tconsole.log(1);\n\tconst a = 2;\n</script>\n',
			expected: '<p>hello</p>\n<script>\n\tconst a = 2;\n</script>\n',
			options: HTML,
		});

		expectStripped({
			source: '<script type="module">\n\tconsole.log(1);\n</script>\n',
			expected: '<script type="module">\n</script>\n',
			options: HTML,
		});

		expectStripped({
			source: '<script lang="ts">\n\tconsole.log(1);\n</script>\n',
			expected: '<script lang="ts">\n</script>\n',
			options: HTML,
		});
	});

	it('leaves inert page text exactly as written', () => {
		const SAMPLE = '<p>Use <code>console.log(x)</code> to debug</p>\n';
		const TEXT = '<p>console.log(value) is handy</p>\n';
		const SLOT = '<div>{console.log(1)}</div>\n';

		expectStripped({ source: SAMPLE, expected: SAMPLE, options: HTML });
		expectStripped({ source: TEXT, expected: TEXT, options: HTML });
		expectStripped({ source: SLOT, expected: SLOT, options: HTML });
	});

	it('leaves a document without a script block unchanged', () => {
		const SOURCE = '<!doctype html>\n<html>\n<body>console.log(1)</body>\n</html>\n';

		expectStripped({ source: SOURCE, expected: SOURCE, options: HTML });
	});

	it('never edits a data block', () => {
		for (const TYPE of ['application/json', 'application/ld+json', 'importmap', 'text/template', 'text/x-template']) {
			const SOURCE = `<script type="${TYPE}">\nconsole.log(1);\n</script>\n`;

			expectStripped({ source: SOURCE, expected: SOURCE, options: HTML });
		}
	});

	it('reads the type attribute whatever its quoting', () => {
		const SINGLE = "<script type='application/json'>console.log(1)</script>\n";
		const UNQUOTED = '<script type=application/json>console.log(1)</script>\n';

		expectStripped({ source: SINGLE, expected: SINGLE, options: HTML });
		expectStripped({ source: UNQUOTED, expected: UNQUOTED, options: HTML });
	});

	it('reads only the MIME essence of the type attribute', () => {
		expectStripped({
			source: '<script type="text/javascript; charset=utf-8">console.log(1);</script>\n',
			expected: '<script type="text/javascript; charset=utf-8"></script>\n',
			options: HTML,
		});

		expectStripped({
			source: '<script type="text/javascript ;charset=utf-8">console.log(1);</script>\n',
			expected: '<script type="text/javascript ;charset=utf-8"></script>\n',
			options: HTML,
		});

		expectStripped({
			source: '<script type="module">console.log(1);</script>\n',
			expected: '<script type="module"></script>\n',
			options: HTML,
		});

		const JSON_BLOCK = '<script type="application/json; charset=utf-8">console.log(1)</script>\n';

		expectStripped({ source: JSON_BLOCK, expected: JSON_BLOCK, options: HTML });
	});

	it('handles a script tag with a src and an empty body', () => {
		expectStripped({
			source: '<script src="a.js"></script>\n<script>console.log(1);</script>\n',
			expected: '<script src="a.js"></script>\n<script></script>\n',
			options: HTML,
		});
	});

	it('never edits the inline body of a script that loads its code elsewhere', () => {
		expectStripped({
			source: '<script src="a.js">console.log(ignored);</script>\n<script>console.log(1);</script>\n',
			expected: '<script src="a.js">console.log(ignored);</script>\n<script></script>\n',
			options: HTML,
		});
	});

	it('does not read data-src or srcset as src', () => {
		expectStripped({
			source: '<script data-src="a.js">console.log(1);</script>\n',
			expected: '<script data-src="a.js"></script>\n',
			options: HTML,
		});

		expectStripped({
			source: '<script srcset="a.js">console.log(1);</script>\n',
			expected: '<script srcset="a.js"></script>\n',
			options: HTML,
		});
	});

	it('reads a > written inside an attribute value', () => {
		expectStripped({
			source: '<script data-x="a>b">console.log(1);</script>\n',
			expected: '<script data-x="a>b"></script>\n',
			options: HTML,
		});

		expectStripped({
			source: "<script data-x='a>b'>console.log(1);</script>\n",
			expected: "<script data-x='a>b'></script>\n",
			options: HTML,
		});
	});

	it('treats a block holding a nested script opener as inert', () => {
		const SOURCE = '<script>const a = 1;<p>x</p><script>console.log(1);</script>\n';

		expectStripped({ source: SOURCE, expected: SOURCE, options: HTML });
	});

	it('does not count a script opener written inside a string', () => {
		expectStripped({
			source: '<script>const s = "<script>"; console.log(1);</script>\n',
			expected: '<script>const s = "<script>"; </script>\n',
			options: HTML,
		});
	});

	it('does not count a script opener written inside a comment, whatever precedes it', () => {
		// Lower-casing `İ` yields two characters, which used to shift every offset the code mask is then read with
		expectStripped({
			source: "<script>\nconst T = 'İİİİİİİ';\n// <script\nconsole.log(1);\n</script>\n",
			expected: "<script>\nconst T = 'İİİİİİİ';\n// <script\n</script>\n",
			options: HTML,
		});
	});

	it('reads a nested opener whatever its case', () => {
		const SOURCE = '<script>const a = 1;<p>x</p><SCRIPT>console.log(1);</script>\n';

		expectStripped({ source: SOURCE, expected: SOURCE, options: HTML });
	});

	it('never lets an edit reach past the block that holds it', () => {
		const SOURCE = '<script>console.log(1</script>\n<p>a)</p>\n<footer>keep</footer>';

		// The block's call never closes inside it on purpose, so the block does not parse
		expectStripped({ source: SOURCE, expected: SOURCE, options: HTML, isInvalidSource: true });
	});

	it('honorsa directive written in a markup comment', () => {
		const SOURCE = '<!-- console-stripper-ignore-next-line -->\n<script>console.log(1);</script>\n';

		expectStripped({ source: SOURCE, expected: SOURCE, options: HTML });
	});
});

describe('stripConsole self-closing script tags', () => {
	const SWALLOWED_TEXT = '<script src="a.js" /><p>console.log(oops)</p><script>real(); console.log(1);</script>';
	const SWALLOWED_STATEMENT = '<script src="a.js" />;console.log(oops);<script>real();</script>';

	it('never edits page text a self-closing script tag swallowed', () => {
		for (const KIND of ['html', 'markup'] as const) {
			expectStripped({
				source: SWALLOWED_TEXT,
				expected: SWALLOWED_TEXT,
				options: { fileKind: KIND },
			});

			expectStripped({
				source: SWALLOWED_STATEMENT,
				expected: SWALLOWED_STATEMENT,
				options: { fileKind: KIND },
			});
		}
	});

	it('resumes stripping after a well-formed script tag that follows', () => {
		expectStripped({
			source: '<script src="a.js"></script>\n<p>console.log(text)</p>\n<script>console.log(1);</script>\n',
			expected: '<script src="a.js"></script>\n<p>console.log(text)</p>\n<script></script>\n',
			options: { fileKind: 'html' },
		});
	});
});

describe('stripConsole markup files', () => {
	const MARKUP: StripConsoleOptions = { fileKind: 'markup' };

	it('never removes a statement from a markup expression slot', () => {
		expectStripped({
			source: '<p>{console.log(value)}</p>\n',
			expected: '<p>{void 0}</p>\n',
			options: MARKUP,
		});

		expectStripped({
			source: '<template>{{ console.log(value) }}</template>\n',
			expected: '<template>{{ void 0 }}</template>\n',
			options: MARKUP,
		});
	});

	it('removes a statement inside a script block', () => {
		expectStripped({
			source: '<script>\n\tconsole.log(1);\n\tconst a = 2;\n</script>\n<p>{console.log(a)}</p>\n',
			expected: '<script>\n\tconst a = 2;\n</script>\n<p>{void 0}</p>\n',
			options: MARKUP,
		});
	});

	it('removes a statement inside Astro frontmatter', () => {
		expectStripped({
			source: '---\nconsole.log(1);\nconst a = 2;\n---\n<p>{console.log(a)}</p>\n',
			expected: '---\nconst a = 2;\n---\n<p>{void 0}</p>\n',
			options: { fileKind: 'astro' },
		});
	});

	it('does not let a closing tag open a regular expression', () => {
		expectStripped({
			source: "<p>a</p>\n<p>don't</p>\n<p>{console.log(1)}</p>\n",
			expected: "<p>a</p>\n<p>don't</p>\n<p>{void 0}</p>\n",
			options: MARKUP,
		});
	});

	it('behaves as markup for an unknown extension', () => {
		expectStripped({
			source: '<script>\n\tconsole.log(1);\n</script>\n<p>{console.log(2)}</p>\n',
			expected: '<script>\n</script>\n<p>{void 0}</p>\n',
			options: MARKUP,
		});
	});

	it('never edits a data block', () => {
		const SOURCE = '<script type="application/json">\nconsole.log(1);\n</script>\n<p>{console.log(2)}</p>\n';

		expectStripped({
			source: SOURCE,
			expected: '<script type="application/json">\nconsole.log(1);\n</script>\n<p>{void 0}</p>\n',
			options: MARKUP,
		});
	});

	it('never edits the front matter of a document that is not an Astro component', () => {
		const SOURCE = '---\ntitle: console.log(1)\n---\n# hi';

		expectStripped({ source: SOURCE, expected: SOURCE, options: MARKUP });
		expectStripped({
			source: SOURCE,
			expected: '---\ntitle: void 0\n---\n# hi',
			options: { fileKind: 'astro' },
		});
	});

	it('never lets an edit reach past the block that holds it', () => {
		const SOURCE = '<script>console.log(1</script>\n<p>a)</p>\n<footer>keep</footer>';

		// The block's call never closes inside it on purpose, so the block does not parse
		expectStripped({ source: SOURCE, expected: SOURCE, options: MARKUP, isInvalidSource: true });
	});

	it('honorsa directive written in a markup comment', () => {
		expectStripped({
			source: '<!-- console-stripper-ignore-next-line -->\n<p>{console.log(1)}</p>\n<p>{console.log(2)}</p>\n',
			expected: '<!-- console-stripper-ignore-next-line -->\n<p>{console.log(1)}</p>\n<p>{void 0}</p>\n',
			options: MARKUP,
		});
	});
});

describe('stripConsole ignore directives', () => {
	it('keeps the call on the line below an ignore-next-line directive', () => {
		expectStripped({
			source: '// console-stripper-ignore-next-line\nconsole.log(1);\nconsole.log(2);',
			expected: '// console-stripper-ignore-next-line\nconsole.log(1);\n',
		});
	});

	it('accepts a reason on an ignore-next-line directive', () => {
		const SOURCE = '/* console-stripper-ignore-next-line: support needs it */\nconsole.log(1);';

		expectStripped({ source: SOURCE, expected: SOURCE });
	});

	it('protects a multiline call whose first line is protected', () => {
		expectStripped({
			source: '// console-stripper-ignore-next-line\nconsole.group(\n\tconsole.log(1)\n);\nconsole.log(2);\n',
			expected: '// console-stripper-ignore-next-line\nconsole.group(\n\tconsole.log(1)\n);\n',
		});

		expectStripped({
			source: '// console-stripper-ignore-next-line\nconsole.error(\n\tconsole.log(1)\n);\nconsole.log(2);\n',
			expected: '// console-stripper-ignore-next-line\nconsole.error(\n\tconsole.log(1)\n);\n',
		});
	});

	it('keeps every call inside a start/end block', () => {
		const KEPT = [
			'// console-stripper-ignore-start',
			'console.log(1);',
			'console.log(2);',
			'// console-stripper-ignore-end',
		];

		expectStripped({
			source: [...KEPT, 'console.log(3);'].join('\n'),
			expected: [...KEPT, ''].join('\n'),
		});
	});

	it('accepts a reason on a start directive and runs an unterminated block to the end of the file', () => {
		const SOURCE = '<!-- console-stripper-ignore-start: demo page -->\nconsole.log(1);\nconsole.log(2);';

		expectStripped({ source: SOURCE, expected: SOURCE, options: { fileKind: 'markup' } });
	});

	it('keeps the whole file on a file-level directive within the first ten lines', () => {
		const SOURCE = '// console-stripper-ignore\nconsole.log(1);';
		const WITH_REASON = '// console-stripper-ignore: vendored file\nconsole.log(1);';

		expectStripped({ source: SOURCE, expected: SOURCE });
		expectStripped({ source: WITH_REASON, expected: WITH_REASON });
	});

	it('ignores a file-level directive placed after the tenth line', () => {
		const FILLER = Array.from({ length: 10 }, (_value, index) => `const a${index} = ${index};`);

		expectStripped({
			source: [...FILLER, '// console-stripper-ignore', 'console.log(1);'].join('\n'),
			expected: [...FILLER, '// console-stripper-ignore', ''].join('\n'),
		});
	});

	it('ignores a directive token written outside a comment', () => {
		expectStripped({
			source: "const TOKEN = 'console-stripper-ignore';\nconsole.log(1);\n",
			expected: "const TOKEN = 'console-stripper-ignore';\n",
		});

		expectStripped({
			source: "const TOKEN = 'console-stripper-ignore-next-line';\nconsole.log(1);\n",
			expected: "const TOKEN = 'console-stripper-ignore-next-line';\n",
		});
	});

	it('ignores an unknown directive suffix', () => {
		expectStripped({
			source: '// console-stripper-ignore-maybe\nconsole.log(1);\n',
			expected: '// console-stripper-ignore-maybe\n',
		});
	});

	it('protects only the line below a directive written above a callback', () => {
		expectStripped({
			source: '// console-stripper-ignore-next-line\nrun(() => {\n\tconsole.log(1);\n});\n',
			expected: '// console-stripper-ignore-next-line\nrun(() => {\n});\n',
		});

		expectStripped({
			source: '// console-stripper-ignore-next-line\nconsole.log(1); run(() => {\n\tconsole.log(2);\n});\n',
			expected: '// console-stripper-ignore-next-line\nconsole.log(1); run(() => {\n});\n',
		});
	});

	it('protects a tagged template call and every call nested in it', () => {
		expectStripped({
			source: '// console-stripper-ignore-next-line\nconsole.log`a ${console.log(1)}`;\nconsole.log(2);\n',
			expected: '// console-stripper-ignore-next-line\nconsole.log`a ${console.log(1)}`;\n',
		});
	});

	it('ignores every directive when ignoreComments is false', () => {
		expectStripped({
			source: '// console-stripper-ignore\nconsole.log(1);',
			expected: '// console-stripper-ignore\n',
			options: { ignoreComments: false },
		});

		expectStripped({
			source: '// console-stripper-ignore-next-line\nconsole.log(1);',
			expected: '// console-stripper-ignore-next-line\n',
			options: { ignoreComments: false },
		});
	});
});

describe('stripConsole call forms', () => {
	it('strips an optional member, an optional call and a quoted computed member', () => {
		expectStripped({ source: 'console?.log(1);\nfoo();\n', expected: 'foo();\n' });
		expectStripped({ source: 'console.log?.(1);\nfoo();\n', expected: 'foo();\n' });
		expectStripped({ source: 'console[\'log\'](1);\nconsole["debug"](2);\nfoo();\n', expected: 'foo();\n' });
		expectStripped({ source: 'console?.["log"](1);\nfoo();\n', expected: 'foo();\n' });
		expectStripped({ source: 'const a = console?.log(1) ?? 2;\n', expected: 'const a = void 0 ?? 2;\n' });
	});

	it('strips a call carrying TypeScript type arguments or a non-null assertion', () => {
		expectStripped({ source: 'console.log<string>(a);\nfoo();\n', expected: 'foo();\n', fileName: 'fixture.ts' });
		expectStripped({
			source: 'console.table<Map<string, number[]>>(a);\nfoo();\n',
			expected: 'foo();\n',
			fileName: 'fixture.ts',
		});

		expectStripped({ source: 'console.log!(a);\nfoo();\n', expected: 'foo();\n', fileName: 'fixture.ts' });
	});

	it('strips a tagged template call as a whole', () => {
		expectStripped({ source: 'console.log`x ${a} y`;\nfoo();\n', expected: 'foo();\n' });
		expectStripped({ source: 'const a = console.log`x ${`}`} y`;\n', expected: 'const a = void 0;\n' });
	});

	it('strips every call form behind a global qualifier', () => {
		expectStripped({
			source: 'window.console?.log(1);\nglobalThis.console["log"](2);\nself.console.log`x`;\nfoo();\n',
			expected: 'foo();\n',
		});
	});

	it('still tells a longer method name apart from its prefix', () => {
		expectStripped({ source: 'console.time("a");\nconsole.timeEnd("a");\nfoo();\n', expected: 'foo();\n' });
		expectStripped({
			source: 'console.timeEnd("a");',
			expected: 'console.timeEnd("a");',
			options: { methods: ['time'] },
		});
	});

	it('leaves a member read without a call, and a kept method, untouched', () => {
		const SOURCE =
			'const f = console.log.bind(console);\nconst g = console.log;\nconsole.logger(1);\nconsole["error"](1);\n';

		expectStripped({ source: SOURCE, expected: SOURCE });
	});
});

describe('stripConsole semicolon-less statements', () => {
	it('removes a statement automatic semicolon insertion terminates after a value', () => {
		expectStripped({ source: 'foo()\nconsole.log(1)\nbar()\n', expected: 'foo()\nbar()\n' });
		expectStripped({
			source: 'const a = [1]\nconsole.log(a)\nconst b = 2\n',
			expected: 'const a = [1]\nconst b = 2\n',
		});

		expectStripped({ source: "const s = 'x'\nconsole.log(s)\nfoo()\n", expected: "const s = 'x'\nfoo()\n" });
		expectStripped({ source: 'i++\nconsole.log(i)\nfoo()\n', expected: 'i++\nfoo()\n' });
		expectStripped({ source: 'a.if\nconsole.log(1)\n', expected: 'a.if\n' });
		expectStripped({ source: 'const t = `x`\nconsole.log(t)\n', expected: 'const t = `x`\n' });
	});

	it('guards the removal when the next line could continue the value above', () => {
		expectStripped({ source: 'foo()\nconsole.log(1)\n(bar)()\n', expected: 'foo()\n;\n(bar)()\n' });
	});

	it('keeps replacing a call a keyword or a control header still owns', () => {
		expectStripped({ source: 'if (x)\nconsole.log(1)\nfoo()\n', expected: 'if (x)\nvoid 0\nfoo()\n' });
		expectStripped({ source: 'while (x)\nconsole.log(1)\n', expected: 'while (x)\nvoid 0\n' });
		expectStripped({ source: 'if (x) foo()\nelse\nconsole.log(1)\n', expected: 'if (x) foo()\nelse\nvoid 0\n' });
		expectStripped({ source: 'const f = () =>\nconsole.log(1)\n', expected: 'const f = () =>\nvoid 0\n' });
		expectStripped({
			source: 'function f() {\n\treturn\n\tconsole.log(1)\n}\n',
			expected: 'function f() {\n\treturn\n\tvoid 0\n}\n',
		});
	});
});

describe('stripConsole blocks', () => {
	it('removes a statement from a catch block and a class static block', () => {
		expectStripped({ source: 'try { a() } catch { console.log(1) }', expected: 'try { a() } catch {  }' });
		expectStripped({ source: 'class A { static { console.log(1) } }', expected: 'class A { static {  } }' });
	});

	it('removes a statement from a function carrying a TypeScript return type', () => {
		expectStripped({
			source: 'function f(): void { console.log(1) }',
			expected: 'function f(): void {  }',
			fileName: 'fixture.ts',
		});

		expectStripped({
			source: 'async function f(): Promise<Map<string, number[]>> {\n\tconsole.log(1);\n\treturn new Map();\n}\n',
			expected: 'async function f(): Promise<Map<string, number[]>> {\n\treturn new Map();\n}\n',
			fileName: 'fixture.ts',
		});

		expectStripped({
			source: "class A { get x(): number | 'a' { console.log(1); return 1; } }",
			expected: "class A { get x(): number | 'a' {  return 1; } }",
			fileName: 'fixture.ts',
		});
	});

	it('still reads an object literal after a colon as an expression', () => {
		expectStripped({ source: 'const o = { a: { b: console.log(1) } };', expected: 'const o = { a: { b: void 0 } };' });
		expectStripped({ source: 'x = c ? a : { b: console.log(1) };', expected: 'x = c ? a : { b: void 0 };' });
	});
});

describe('stripConsole shared lines', () => {
	it('removes a line holding nothing but stripped statements', () => {
		expectStripped({ source: 'a();\nconsole.log(1); console.log(2);\nb();\n', expected: 'a();\nb();\n' });
		expectStripped({
			source: 'function f() {\n\tconsole.log(1);\tconsole.log(2);console.log(3);\n\treturn 1;\n}\n',
			expected: 'function f() {\n\treturn 1;\n}\n',
		});

		expectStripped({ source: 'a();\r\nconsole.log(1); console.log(2);\r\nb();\r\n', expected: 'a();\r\nb();\r\n' });
	});

	it('keeps one edit per stripped call', () => {
		const SOURCE = 'a();\nconsole.log(1); console.log(2);\nb();\n';
		const SCAN = scanConsoleCalls(SOURCE, createScanContext(getOptions(), 'script'));

		expect(SCAN).toEqual({
			edits: [
				{ start: 5, end: 20, replacement: '' },
				{ start: 20, end: 37, replacement: '' },
			],
			skipped: [],
			isFileIgnored: false,
		});
	});

	it('reports a source a file-level directive keeps whole', () => {
		const CONTEXT = createScanContext(getOptions(), 'script');

		expect(scanConsoleCalls('// console-stripper-ignore\nconsole.log(1);\n', CONTEXT)).toEqual({
			edits: [],
			skipped: [],
			isFileIgnored: true,
		});

		expect(scanConsoleCalls('const a = 1;\n', CONTEXT)).toEqual({ edits: [], skipped: [], isFileIgnored: false });
		expect(
			scanConsoleCalls('// console-stripper-ignore\nconsole.log(1);\n', { ...CONTEXT, ignoreComments: false }).edits,
		).toHaveLength(1);
	});

	it('reads the scope of the directives alone, without scanning the calls', () => {
		const CONTEXT = createScanContext(getOptions(), 'ts');

		expect(getDirectiveScope('// console-stripper-ignore\nimport type { A } from "a";\n', CONTEXT)).toBe('file');
		expect(getDirectiveScope('// console-stripper-ignore-next-line\nconsole.log(1);\n', CONTEXT)).toBe('lines');
		expect(getDirectiveScope('/* console-stripper-ignore-start */\nconsole.log(1);\n', CONTEXT)).toBe('lines');
		expect(getDirectiveScope('console.log(1);\n// console-stripper-ignore-end\n', CONTEXT)).toBe('lines');
		expect(getDirectiveScope(`${'\n'.repeat(10)}// console-stripper-ignore\n`, CONTEXT)).toBe('none');
		expect(getDirectiveScope('const a = "console-stripper-ignore-next-line";\n', CONTEXT)).toBe('none');
		expect(getDirectiveScope('console.log(1);\n', CONTEXT)).toBe('none');
		expect(getDirectiveScope('// console-stripper-ignore-next-line\n', { ...CONTEXT, ignoreComments: false })).toBe(
			'none',
		);
	});

	it('finds the ignore directive token anywhere in a source', () => {
		expect(hasIgnoreDirectiveToken('const a = 1; // console-stripper-ignore-next-line\n')).toBe(true);
		expect(hasIgnoreDirectiveToken('const a = "console-stripper-ignore";\n')).toBe(true);
		expect(hasIgnoreDirectiveToken('console.log(1);\n')).toBe(false);
	});

	it('keeps a line other code still shares', () => {
		expectStripped({ source: 'console.log(1); a(); console.log(2);\n', expected: ' a(); \n' });
		expectStripped({ source: 'console.log(1); console.log(2); // note\n', expected: '  // note\n' });
	});
});

describe('scanConsoleCalls undelimited calls', () => {
	const SCRIPT_CONTEXT = createScanContext(getOptions(), 'script');

	it('reports a call whose closing parenthesis is missing, and keeps it', () => {
		expect(scanConsoleCalls('a();\nconsole.log(1;\n', SCRIPT_CONTEXT)).toEqual({
			edits: [],
			skipped: [5],
			isFileIgnored: false,
		});
	});

	it('reports every call left in place while still stripping the delimited ones', () => {
		const SOURCE = 'console.log(1);\nconsole.debug(2;\nconsole.trace(3;\n';
		const SCAN = scanConsoleCalls(SOURCE, SCRIPT_CONTEXT);

		expect(SCAN.skipped).toEqual([16, 33]);
		expect(applyEdits(SOURCE, SCAN.edits)).toBe('console.debug(2;\nconsole.trace(3;\n');
	});

	it('reports a tagged template that never closes', () => {
		expect(scanConsoleCalls('console.log`a', SCRIPT_CONTEXT).skipped).toEqual([0]);
	});

	it('reports a call of a script block that closes past the end of the block', () => {
		const SCAN = scanConsoleCalls('<script>console.log(1</script><p>a)</p>\n', createScanContext(getOptions(), 'html'));

		expect(SCAN).toEqual({ edits: [], skipped: [8], isFileIgnored: false });
	});

	it('does not report a call written as text, a constructed call or a protected call', () => {
		expect(scanConsoleCalls('// console.log(1\nconst a = "console.log(2";\n', SCRIPT_CONTEXT).skipped).toEqual([]);
		expect(scanConsoleCalls('new console.log(1;\n', SCRIPT_CONTEXT).skipped).toEqual([]);
		expect(scanConsoleCalls('// console-stripper-ignore-next-line\nconsole.log(1;\n', SCRIPT_CONTEXT).skipped).toEqual(
			[],
		);
	});
});

describe('stripConsole text in markup and JSX', () => {
	it('leaves markup text byte-identical', () => {
		const SOURCE = '<p>Use console.log(x) to debug</p>\n';

		for (const KIND of ['markup', 'astro'] as const) {
			expectStripped({ source: SOURCE, expected: SOURCE, options: { fileKind: KIND } });
		}
	});

	it('edits only the expressions of a Vue template', () => {
		expectStripped({
			source:
				'<template>\n\t<p>console.log(a) {{ console.log(b) }}</p>\n' +
				'\t<button @click="console.log(c)" v-on:focus="console.log(d)" :title="console.log(e)" title="console.log(f)">x</button>\n' +
				'</template>\n',
			expected:
				'<template>\n\t<p>console.log(a) {{ void 0 }}</p>\n' +
				'\t<button @click="void 0" v-on:focus="void 0" :title="void 0" title="console.log(f)">x</button>\n' +
				'</template>\n',
			options: { fileKind: 'vue' },
		});
	});

	it('reads a single brace of a Vue template as text, in the text and in a tag', () => {
		const SOURCE =
			'<template>\n\t<pre>function f() { console.log(1) }</pre>\n\t<p data-a={console.log(2)}>{{ console.log(3) }}</p>\n</template>\n';

		expectStripped({
			source: SOURCE,
			expected:
				'<template>\n\t<pre>function f() { console.log(1) }</pre>\n\t<p data-a={console.log(2)}>{{ void 0 }}</p>\n</template>\n',
			options: { fileKind: getFileKind('/repo/src/App.vue') },
		});

		expect(getCodeRegions(SOURCE, 'vue')).toEqual([['{ console.log(3) }', false]]);
		expectStripped({
			source: '<script setup>\nconsole.log(1);\n</script>\n<template><p>{</p>{{ a }}</template>\n',
			expected: '<script setup>\n</script>\n<template><p>{</p>{{ a }}</template>\n',
			options: { fileKind: 'vue' },
		});
	});

	it('keeps a single brace a slot in a Svelte or unknown markup template', () => {
		expectStripped({
			source: '<pre>function f() { console.log(1) }</pre>\n',
			expected: '<pre>function f() { void 0 }</pre>\n',
			options: { fileKind: getFileKind('/repo/src/App.svelte') },
		});
	});

	it('edits only the expressions of a Svelte template', () => {
		expectStripped({
			source:
				'{#if console.log(a)}<p>console.log(b)</p>{:else if console.log(c)}x{/if}\n' +
				'<button onclick={() => console.log(d)} title="console.log(e)">{@html console.log(f)}</button>\n',
			expected:
				'{#if void 0}<p>console.log(b)</p>{:else if void 0}x{/if}\n' +
				'<button onclick={() => void 0} title="console.log(e)">{@html void 0}</button>\n',
			options: { fileKind: 'markup' },
		});
	});

	it('never opens a regular expression on a Svelte closing block tag', () => {
		expectStripped({
			source: '{#if a}x{/if}<p>{console.log(1)}</p>\n',
			expected: '{#if a}x{/if}<p>{void 0}</p>\n',
			options: { fileKind: 'markup' },
		});
	});

	it('edits the expressions of an Astro template, but not the text of the JSX they hold', () => {
		expectStripped({
			source:
				'---\nconst a = 1;\n---\n<ul>{items.map((item) => <li>console.log(item) {console.log(item)}</li>)}</ul>\n',
			expected: '---\nconst a = 1;\n---\n<ul>{items.map((item) => <li>console.log(item) {void 0}</li>)}</ul>\n',
			options: { fileKind: 'astro' },
		});
	});

	it('leaves the content of a style block byte-identical', () => {
		const SOURCE = '<style>.a::before { content: "{console.log(1)}"; }</style>\n';

		expectStripped({ source: SOURCE, expected: SOURCE, options: { fileKind: 'markup' } });
	});

	it('leaves the text of a JSX element byte-identical', () => {
		expectStripped({
			source: 'const C = () => <p>Use console.log(x) to debug</p>;\n',
			expected: 'const C = () => <p>Use console.log(x) to debug</p>;\n',
			fileName: 'fixture.jsx',
		});

		expectStripped({
			source:
				'const C = () => (\n\t<div title="console.log(a)" onClick={() => console.log(b)}>\n' +
				"\t\tconsole.log(c) it's {console.log(d)}\n\t\t<>console.log(e)</>\n\t\t<br/>console.log(f)\n\t</div>\n);\n" +
				'console.log(g);\n',
			expected:
				'const C = () => (\n\t<div title="console.log(a)" onClick={() => void 0}>\n' +
				"\t\tconsole.log(c) it's {void 0}\n\t\t<>console.log(e)</>\n\t\t<br/>console.log(f)\n\t</div>\n);\n",
			fileName: 'fixture.jsx',
		});
	});

	it('still strips the code around TypeScript type parameters and type assertions', () => {
		expectStripped({
			source: 'const id = <T,>(value: T) => value;\nconsole.log(id(1));\n',
			expected: 'const id = <T,>(value: T) => value;\n',
			fileName: 'fixture.tsx',
		});

		expectStripped({
			source: 'const f = <T extends object>(v: T) => v;\nconsole.log(f);\nconst c = <number>value;\nconsole.log(c);\n',
			expected: 'const f = <T extends object>(v: T) => v;\nconst c = <number>value;\n',
			fileName: 'fixture.ts',
		});
	});
});

describe('stripConsole document regions', () => {
	it('never lets a quote or a backtick of the markup change how a script block is read', () => {
		expectStripped({
			source: '<template><p>Type ` here</p></template>\n<script>\nconsole.log(1);\n</script>\n',
			expected: '<template><p>Type ` here</p></template>\n<script>\n</script>\n',
			options: { fileKind: 'markup' },
		});

		expectStripped({
			source: '<script type="text/template">`</script>\n<script>\nconsole.log(1);\n</script>\n',
			expected: '<script type="text/template">`</script>\n<script>\n</script>\n',
			options: { fileKind: 'html' },
		});
	});

	it('never reads a script opener written in the frontmatter, a comment or an attribute value', () => {
		expectStripped({
			source: '---\nconst tag = "<script>";\n---\n<p>{console.log(1)}</p>\n<script>console.log(2);</script>\n',
			expected: '---\nconst tag = "<script>";\n---\n<p>{void 0}</p>\n<script></script>\n',
			options: { fileKind: 'astro' },
		});

		expectStripped({
			source: '<!-- <script> -->\n<script>\n\tconsole.log(1);\n</script>\n',
			expected: '<!-- <script> -->\n<script>\n</script>\n',
			options: { fileKind: 'html' },
		});

		expectStripped({
			source: '<div title="<script>"></div>\n<script>\n\tconsole.log(1);\n</script>\n',
			expected: '<div title="<script>"></div>\n<script>\n</script>\n',
			options: { fileKind: 'html' },
		});
	});

	it('does not count a tag merely starting with script as a nested opener', () => {
		expectStripped({
			source: '<script>\nconst tag = a <scripts> b;\nconsole.log(1);\n</script>\n',
			expected: '<script>\nconst tag = a <scripts> b;\n</script>\n',
			options: { fileKind: 'html' },
		});
	});

	it('reads the attributes of a script tag quote-aware and by name', () => {
		const SLASH_SEPARATED = '<script/type="text/html">console.log(1);</script>\n';
		const UPPERCASE_SOURCE = '<SCRIPT TYPE="MODULE" SRC="a.js">console.log(1);</SCRIPT>\n';
		const BOOLEAN_SOURCE = '<script src>console.log(1);</script>\n';

		for (const SOURCE of [SLASH_SEPARATED, UPPERCASE_SOURCE, BOOLEAN_SOURCE]) {
			expectStripped({ source: SOURCE, expected: SOURCE, options: { fileKind: 'html' } });
		}

		expectStripped({
			source: '<script data-x=" src" data-y=" type=text/html">console.log(1);</script>\n',
			expected: '<script data-x=" src" data-y=" type=text/html"></script>\n',
			options: { fileKind: 'html' },
		});
	});

	it('reads a front matter fence written after a byte order mark', () => {
		expectStripped({
			source: '﻿---\nconsole.log(1);\nconst a = 1;\n---\n<p />\n',
			expected: '﻿---\nconst a = 1;\n---\n<p />\n',
			options: { fileKind: 'astro' },
		});

		const SOURCE = '﻿---\ntitle: console.log(1)\n---\n# hi\n';

		expectStripped({ source: SOURCE, expected: SOURCE, options: { fileKind: 'markup' } });
	});

	it('reads a legacy <!-- inside a script block as a single-line comment', () => {
		expectStripped({
			source: '<script>\n<!-- hide from old browsers\nconsole.log(1);\n</script>\n',
			expected: '<script>\n<!-- hide from old browsers\n</script>\n',
			options: { fileKind: 'html' },
		});
	});
});

describe('stripConsole regular expression and division', () => {
	it('keeps stripping after a division following a postfix operator', () => {
		expectStripped({
			source: 'x = a++ / 2; console.log(1); y = b-- / 3;\n',
			expected: 'x = a++ / 2;  y = b-- / 3;\n',
		});
	});

	it('keeps stripping after a regular expression following default or a control header', () => {
		expectStripped({ source: "export default /'/;\nconsole.log(1);\n", expected: "export default /'/;\n" });
		expectStripped({ source: "if (x) /'/.test(y);\nconsole.log(1);\n", expected: "if (x) /'/.test(y);\n" });
		expectStripped({ source: "while (x) /'/.exec(y);\nconsole.log(1);\n", expected: "while (x) /'/.exec(y);\n" });
	});

	it('keeps stripping after a string continued over a carriage return and line feed', () => {
		expectStripped({
			source: "const s = 'a\\\r\nb';\r\nconsole.log(1);\r\n",
			expected: "const s = 'a\\\r\nb';\r\n",
		});
	});
});

describe('stripConsole pathological inputs', () => {
	const REPEAT_COUNT = 4000;

	it('leaves thousands of calls that never close untouched', () => {
		const SOURCE = 'console.log('.repeat(REPEAT_COUNT);

		expect(stripConsole(SOURCE)).toBe(SOURCE);
	});

	it('leaves thousands of script blocks that never close untouched', () => {
		const SOURCE = '<script>console.log(1);\n'.repeat(REPEAT_COUNT);

		expect(stripConsole(SOURCE, { fileKind: 'html' })).toBe(SOURCE);
	});

	it('reads thousands of opening tags that never close in linear time', () => {
		const UNTERMINATED_TAGS = `console.log(1);${'<script'.repeat(REPEAT_COUNT * 10)}`;
		const UNTERMINATED_VALUES = `console.log(1);${'<script a="'.repeat(REPEAT_COUNT * 5)}`;
		const UNTERMINATED_SLOTS = `console.log(1);${'<a {'.repeat(REPEAT_COUNT * 10)}`;

		expect(stripConsole(UNTERMINATED_TAGS, { fileKind: 'html' })).toBe(UNTERMINATED_TAGS);
		expect(stripConsole(UNTERMINATED_VALUES, { fileKind: 'html' })).toBe(UNTERMINATED_VALUES);
		expect(stripConsole(UNTERMINATED_SLOTS, { fileKind: 'markup' })).toBe(UNTERMINATED_SLOTS);
	});

	it('reads thousands of slots that never close in linear time', () => {
		const SOURCE = `${'{`'.repeat(REPEAT_COUNT * 10)}<script>console.log(1);</script>`;

		expect(stripConsole(SOURCE, { fileKind: 'markup' })).toBe(`${'{`'.repeat(REPEAT_COUNT * 10)}<script></script>`);
	});

	it('reads thousands of type assertions in linear time', () => {
		const SOURCE = `${'x = <T>y;\n'.repeat(REPEAT_COUNT * 10)}console.log(1);\n`;

		expect(stripConsole(SOURCE)).toBe('x = <T>y;\n'.repeat(REPEAT_COUNT * 10));
	});

	it('empties thousands of closed script blocks', () => {
		expectStripped({
			source: '<script>console.log(1);</script>\n'.repeat(REPEAT_COUNT),
			expected: '<script></script>\n'.repeat(REPEAT_COUNT),
			options: { fileKind: 'html' },
		});
	});
});

describe('stripConsole statement positions', () => {
	it('replaces the brace-less body of every loop', () => {
		expectStripped({ source: 'do console.log(1); while (x);\n', expected: 'do void 0; while (x);\n' });
		expectStripped({ source: 'for (;;) console.log(1);\n', expected: 'for (;;) void 0;\n' });
		expectStripped({ source: 'for (const a of b) console.log(a);\n', expected: 'for (const a of b) void 0;\n' });
		expectStripped({ source: 'while (x) console.log(1);\n', expected: 'while (x) void 0;\n' });
		expectStripped({ source: 'if (a) b(); else console.log(1);\n', expected: 'if (a) b(); else void 0;\n' });
	});

	it('replaces the statement a label or a case clause owns', () => {
		expectStripped({ source: 'label: console.log(1);\nfoo();\n', expected: 'label: void 0;\nfoo();\n' });
		expectStripped({ source: 'label:\nconsole.log(1);\nfoo();\n', expected: 'label:\nvoid 0;\nfoo();\n' });
		expectStripped({
			source: 'switch (x) {\n\tcase 1:\n\t\tconsole.log(1);\n\t\tbreak;\n\tdefault: console.log(2);\n}\n',
			expected: 'switch (x) {\n\tcase 1:\n\t\tvoid 0;\n\t\tbreak;\n\tdefault: void 0;\n}\n',
		});
	});

	it('replaces the operand of export default and of every operator keyword', () => {
		expectStripped({
			source: 'export default console.log(1);\n',
			expected: 'export default void 0;\n',
			fileName: 'fixture.mjs',
		});

		expectStripped({
			source: 'function* g() {\n\tyield console.log(1);\n}\n',
			expected: 'function* g() {\n\tyield void 0;\n}\n',
		});

		expectStripped({
			source: 'async function f() {\n\tawait console.log(1);\n}\n',
			expected: 'async function f() {\n\tawait void 0;\n}\n',
		});

		expectStripped({
			source: 'function f() {\n\tthrow console.log(1);\n}\n',
			expected: 'function f() {\n\tthrow void 0;\n}\n',
		});

		expectStripped({ source: 'x = typeof console.log(1);\n', expected: 'x = typeof void 0;\n' });
		expectStripped({ source: 'x = delete console.log(1);\n', expected: 'x = delete void 0;\n' });
		expectStripped({ source: 'a(), console.log(1), b();\n', expected: 'a(), void 0, b();\n' });
	});

	it('replaces a class field initializer and removes a statement from an accessor body', () => {
		expectStripped({
			source:
				'class A {\n\tstatic b = console.log(1);\n\t#c = console.log(2);\n\tget d() {\n\t\tconsole.log(3);\n\t\treturn 1;\n\t}\n\tset d(value) {\n\t\tconsole.log(value);\n\t}\n}\n',
			expected:
				'class A {\n\tstatic b = void 0;\n\t#c = void 0;\n\tget d() {\n\t\treturn 1;\n\t}\n\tset d(value) {\n\t}\n}\n',
		});
	});

	// A namespace body is not recognized as a block: its statements are replaced, which keeps the output valid
	it('replaces a statement of a TypeScript namespace opening the file or following a JSX element', () => {
		expectStripped({
			source: 'namespace N {\n\tconsole.log(1);\n}\n',
			expected: 'namespace N {\n\tvoid 0;\n}\n',
			fileName: 'fixture.ts',
		});

		expectStripped({
			source: 'const a = <p>x</p>\nnamespace N {\n\tconsole.log(1);\n}\n',
			expected: 'const a = <p>x</p>\nnamespace N {\n\tvoid 0;\n}\n',
			fileName: 'fixture.tsx',
		});
	});

	it('removes a statement following a parenthesized await', () => {
		expectStripped({ source: 'await (p);\nconsole.log(1);\n', expected: 'await (p);\n', fileName: 'fixture.mjs' });
	});
});

describe('stripConsole file shapes', () => {
	it('returns an empty file and a file holding only a stripped call as empty', () => {
		expectStripped({ source: '', expected: '' });
		expectStripped({ source: 'console.log(1);\n', expected: '' });
		expectStripped({ source: 'console.log(1)', expected: '' });
		expectStripped({ source: '\tconsole.log(1);\r\n', expected: '' });
	});

	it('removes a whole line ended by a carriage return and a line feed', () => {
		expectStripped({ source: 'a();\r\nconsole.log(1);\r\nb();\r\n', expected: 'a();\r\nb();\r\n' });
	});

	it('removes the whole first line of a file starting with a byte order mark', () => {
		expectStripped({ source: '﻿console.log(1);\nfoo();\n', expected: '﻿foo();\n' });
		expectStripped({ source: '﻿\tconsole.log(1);\r\nfoo();\r\n', expected: '﻿foo();\r\n' });
		expectStripped({ source: '﻿console.log(1); foo();\n', expected: '﻿ foo();\n' });
		expectStripped({
			source: '﻿<script>\nconsole.log(1);\n</script>\n',
			expected: '﻿<script>\n</script>\n',
			options: { fileKind: 'markup' },
			fileName: 'fixture.svelte',
		});
	});

	it('keeps the statement line of a byte order mark written past the start of the file', () => {
		expectStripped({ source: 'foo();\n﻿console.log(1);\n', expected: 'foo();\n﻿\n' });
	});

	it('reads unicode identifiers as identifiers', () => {
		expectStripped({
			source: 'const café = 1;\nconsole.log(café);\nconst π = 2;\n',
			expected: 'const café = 1;\nconst π = 2;\n',
		});

		expectStripped({
			source: 'const ñconsole = x;\nñconsole.log(1);\n',
			expected: 'const ñconsole = x;\nñconsole.log(1);\n',
		});
	});
});

describe('stripConsole JSX elements', () => {
	it('leaves the text of a fragment and of a self-closing element as written', () => {
		expectStripped({
			source: 'const a = <>console.log(1)</>;\nconsole.log(2);\n',
			expected: 'const a = <>console.log(1)</>;\n',
			fileName: 'fixture.jsx',
		});

		expectStripped({
			source: 'const a = <Foo/>;\nconsole.log(1);\n',
			expected: 'const a = <Foo/>;\n',
			fileName: 'fixture.jsx',
		});
	});

	it('finds the closing tag of every element sharing a name', () => {
		expectStripped({
			source: 'const a = <p>one</p>;\nconst b = <p>console.log(1)</p>;\nconsole.log(2);\n',
			expected: 'const a = <p>one</p>;\nconst b = <p>console.log(1)</p>;\n',
			fileName: 'fixture.jsx',
		});
	});

	it('tells a closing tag apart from a longer one sharing its prefix', () => {
		expectStripped({
			source: 'const a = <b><bold>console.log(1)</bold></b >;\nconsole.log(2);\n',
			expected: 'const a = <b><bold>console.log(1)</bold></b >;\n',
			fileName: 'fixture.jsx',
		});
	});

	it('never reads a `<` of a TypeScript file that cannot hold JSX as an element', () => {
		const SOURCE = 'const x = <T>y;\nconst s = "{console.log(1)}";\nconst t = "</T>";\nconsole.log(2);\n';

		for (const ID of ['/repo/src/a.ts', '/repo/src/a.mts', '/repo/src/a.cts']) {
			expectStripped({
				source: SOURCE,
				expected: 'const x = <T>y;\nconst s = "{console.log(1)}";\nconst t = "</T>";\n',
				options: { fileKind: getFileKind(ID) },
				fileName: 'fixture.ts',
			});
		}
	});

	it('removes a semicolon-less statement following a JSX element', () => {
		expectStripped({
			source: 'const a = <p>x</p>\nconsole.log(1)\n',
			expected: 'const a = <p>x</p>\n',
			fileName: 'fixture.jsx',
		});
	});

	it('strips the Qwik idioms of a component', () => {
		expectStripped({
			source:
				"import { component$, useTask$ } from '@builder.io/qwik';\n\nexport default component$(() => {\n\tuseTask$(() => {\n\t\tconsole.log('task');\n\t});\n\n\treturn <button onClick$={() => console.log('click')}>console.log(text)</button>;\n});\n",
			expected:
				"import { component$, useTask$ } from '@builder.io/qwik';\n\nexport default component$(() => {\n\tuseTask$(() => {\n\t});\n\n\treturn <button onClick$={() => void 0}>console.log(text)</button>;\n});\n",
			fileName: 'fixture.tsx',
		});
	});
});

describe('stripConsole unterminated constructs', () => {
	it('leaves a tagged template that never closes untouched', () => {
		// The template never closes on purpose, so neither the fixture nor its output parses
		expectStripped({
			source: 'console.log`unterminated\n',
			expected: 'console.log`unterminated\n',
			isInvalidSource: true,
		});
	});

	it('leaves a tagged template its script block leaves open, even when a slot left open read it as closed', () => {
		// The slot opened by the first `{` never closes, so it is read as text; the template it saw closing after
		// `</script>` is left open by the script block itself, whose tagged call therefore cannot be delimited
		const SOURCE = '{a\n<script>console.log`a</script>` `';

		expectStripped({ source: SOURCE, expected: SOURCE, options: { fileKind: 'markup' }, isInvalidSource: true });
	});

	it('reads a front matter fence that never closes as text', () => {
		expectStripped({
			source: '---\nconsole.log(1);\n',
			expected: '---\nconsole.log(1);\n',
			options: { fileKind: 'astro' },
		});
	});

	it('reads the rest of a document after a markup comment or a style block that never closes as text', () => {
		expectStripped({
			source: '<!-- {console.log(1)}',
			expected: '<!-- {console.log(1)}',
			options: { fileKind: 'markup' },
		});

		expectStripped({ source: '<style>{console.log(1)}', expected: '<style>{void 0}', options: { fileKind: 'markup' } });
	});

	it('reads a < opening no tag as text', () => {
		expectStripped({
			source: '<p>1 < 2 {console.log(1)}</p>',
			expected: '<p>1 < 2 {void 0}</p>',
			options: { fileKind: 'markup' },
		});
	});

	it('leaves a slot call alone when a value ends the line above it and its result is used', () => {
		expectStripped({
			source: '<p>{a\nconsole.log(1).b}</p>',
			expected: '<p>{a\nconsole.log(1).b}</p>',
			options: { fileKind: 'markup' },
		});
	});
});

describe('stripConsole directive matrix', () => {
	it('closes a start block on its first end directive, nested starts included', () => {
		expectStripped({
			source:
				'// console-stripper-ignore-start\n// console-stripper-ignore-start\nconsole.log(1);\n// console-stripper-ignore-end\nconsole.log(2);\n// console-stripper-ignore-end\nconsole.log(3);\n',
			expected:
				'// console-stripper-ignore-start\n// console-stripper-ignore-start\nconsole.log(1);\n// console-stripper-ignore-end\n// console-stripper-ignore-end\n',
		});
	});

	it('ignores a start or a file-level directive written inside a string or a template', () => {
		expectStripped({
			source:
				"const s = '// console-stripper-ignore-start';\nconsole.log(1);\nconst t = `/* console-stripper-ignore */`;\nconsole.log(2);\n",
			expected: "const s = '// console-stripper-ignore-start';\nconst t = `/* console-stripper-ignore */`;\n",
		});
	});

	it('protects a tagged template the protected line only mentions inside a string', () => {
		expectStripped({
			source: "// console-stripper-ignore-next-line\nconst a = 'console.log`';\nconsole.log(2);\nconst b = `x`;\n",
			expected: "// console-stripper-ignore-next-line\nconst a = 'console.log`';\nconst b = `x`;\n",
		});
	});

	it('honorsstart and end directives written in the markup comments of a page', () => {
		expectStripped({
			source:
				'<!-- console-stripper-ignore-start -->\n<script>console.log(1);</script>\n<!-- console-stripper-ignore-end -->\n<script>console.log(2);</script>\n',
			expected:
				'<!-- console-stripper-ignore-start -->\n<script>console.log(1);</script>\n<!-- console-stripper-ignore-end -->\n<script></script>\n',
			options: { fileKind: 'html' },
		});
	});

	it('honorsa file-level directive written in a markup comment', () => {
		const PAGE = '<!-- console-stripper-ignore -->\n<script>console.log(1);</script>\n';
		const COMPONENT = `${PAGE}<p>{console.log(2)}</p>\n`;

		expectStripped({ source: PAGE, expected: PAGE, options: { fileKind: 'html' } });
		expectStripped({ source: COMPONENT, expected: COMPONENT, options: { fileKind: 'markup' } });
	});

	it('bounds a start block written in a component script to that block', () => {
		expectStripped({
			source:
				'<script>\n\t// console-stripper-ignore-start\n\tconsole.log(1);\n\t// console-stripper-ignore-end\n\tconsole.log(2);\n</script>\n<p>{console.log(3)}</p>\n',
			expected:
				'<script>\n\t// console-stripper-ignore-start\n\tconsole.log(1);\n\t// console-stripper-ignore-end\n</script>\n<p>{void 0}</p>\n',
			options: { fileKind: 'markup' },
		});
	});
});

describe('stripConsole markup fallbacks', () => {
	it('leaves the front matter of a Markdown-based component byte-identical', () => {
		const SOURCE =
			'---\ntitle: console.log(1)\n---\n<script>\n\tconsole.log(2);\n</script>\n\n# console.log(3) {console.log(4)}\n';

		for (const ID of ['/repo/src/Post.svx', '/repo/src/Post.mdx', '/repo/src/Post.md']) {
			expectStripped({
				source: SOURCE,
				expected: '---\ntitle: console.log(1)\n---\n<script>\n</script>\n\n# console.log(3) {void 0}\n',
				options: { fileKind: getFileKind(ID) },
			});
		}
	});

	it('leaves every fenced code block of a Markdown-based template byte-identical', () => {
		const FENCED = [
			'```js\nconst f = () => { console.log(1) };\n```',
			'~~~ts title="a.ts"\n{console.log(2)}\n~~~',
			'   ````\n<script>console.log(3);</script>\n```\n````',
			'```\r\n{console.log(4)}\r\n```',
		].join('\n\n');
		const SOURCE = `# Title\n\n${FENCED}\n\n{console.log(5)}\n`;

		for (const ID of ['/repo/src/Post.svx', '/repo/src/Post.mdx', '/repo/src/Post.md']) {
			expectStripped({
				source: SOURCE,
				expected: `# Title\n\n${FENCED}\n\n{void 0}\n`,
				options: { fileKind: getFileKind(ID) },
			});
		}
	});

	it('runs a fence left open to the end of the document, and reads what only looks like a fence as the text it is', () => {
		const OPEN = '{console.log(1)}\n```\n{console.log(2)}\n';

		expectStripped({ source: OPEN, expected: '{void 0}\n```\n{console.log(2)}\n', options: { fileKind: 'markdown' } });
		// Four spaces make an indented code block, and a backtick in the info string of a backtick run makes a code span
		expectStripped({
			source: '    ```\n{console.log(1)}\n``` a`b\n{console.log(2)}\n',
			expected: '    ```\n{void 0}\n``` a`b\n{void 0}\n',
			options: { fileKind: 'markdown' },
		});

		// A closing fence must repeat the opening character, at least as many times, followed by nothing but blanks
		expectStripped({
			source: '````\n```\n~~~~\n```` x\n{console.log(1)}\n````  \n{console.log(2)}\n',
			expected: '````\n```\n~~~~\n```` x\n{console.log(1)}\n````  \n{void 0}\n',
			options: { fileKind: 'markdown' },
		});

		expectStripped({
			source: '```\n{console.log(1)}',
			expected: '```\n{console.log(1)}',
			options: { fileKind: 'markdown' },
		});
	});

	it('reads no fence in a document that is not Markdown-based', () => {
		expectStripped({
			source: '```\n{console.log(1)}\n```\n',
			expected: '```\n{void 0}\n```\n',
			options: { fileKind: 'markup' },
		});
	});
});

describe('scanCompiledAstroComponent', () => {
	// Captured from `astro build` (Astro 7.3.4) of `tests/fixtures/astro-compiled/index.astro`, with the temporary
	// project root renamed to `/project`; the inline source map carries that `.astro` file as its `sourcesContent`
	const COMPILED = readFileSync(new URL('../tests/fixtures/astro-compiled/index.compiled.js', import.meta.url), 'utf8');
	const CONTEXT = createScanContext(getOptions(), 'script');

	/**
	 * Rewrites the source map comment of the compiled fixture.
	 *
	 * @param rewrite - Turns the decoded map into the JSON text to encode back.
	 *
	 * @returns The fixture carrying the rewritten map.
	 */
	function withSourceMap(rewrite: (map: { sourcesContent: string[] }) => string): string {
		const PAYLOAD = /base64,([\w+/=]+)/.exec(COMPILED)?.[1] ?? '';
		const MAP = JSON.parse(Buffer.from(PAYLOAD, 'base64').toString('utf8')) as { sourcesContent: string[] };

		return COMPILED.replace(PAYLOAD, Buffer.from(rewrite(MAP)).toString('base64'));
	}

	/**
	 * Lists every edit of a scan as the text it replaces and its replacement.
	 *
	 * @param input - The scanned source.
	 * @param edits - The edits of the scan.
	 *
	 * @returns One `[replaced, replacement]` pair per edit.
	 */
	function describeEdits(
		input: string,
		edits: readonly { start: number; end: number; replacement: string }[],
	): string[][] {
		return edits.map((edit) => [input.slice(edit.start, edit.end), edit.replacement]);
	}

	it('honors the directives the compiler dropped and strips the inline scripts, escapes included', () => {
		const SCAN = scanCompiledAstroComponent(COMPILED, CONTEXT);
		const OUTPUT = applyEdits(COMPILED, SCAN.edits);

		expect(describeEdits(COMPILED, SCAN.edits)).toEqual([
			['\tconsole.log("stripped frontmatter");\n', ''],
			['console.log("stripped template")', 'void 0'],
			[`\t${String.raw`console.log(\`inline \${tag}\\\\\`);`}\n`, ''],
			["console.log('nested')", ''],
		]);
		expect(SCAN).toMatchObject({ isFileIgnored: false, sourceMapError: null });
		expect(parseSync('index.js', OUTPUT, { sourceType: 'module' }).errors).toEqual([]);
	});

	it('leaves the `define:vars` script, a JSON block and a template the frontmatter builds as written', () => {
		const OUTPUT = applyEdits(COMPILED, scanCompiledAstroComponent(COMPILED, CONTEXT).edits);

		expect(OUTPUT).toContain("\tconsole.log('define:vars', tag);\n");
		expect(OUTPUT).toContain('{"console.log(1)": 1}');
		expect(OUTPUT).toContain("const tag = `<script>console.log('frontmatter template')<\\/script>`;");
	});

	it('strips every call, protected ones included, when the directives are disabled', () => {
		const SCAN = scanCompiledAstroComponent(
			COMPILED,
			createScanContext(getOptions({ ignoreComments: false }), 'script'),
		);

		expect(SCAN.edits).toHaveLength(8);
		expect(applyEdits(COMPILED, SCAN.edits)).not.toContain('protected');
	});

	it('keeps the whole module for a file-level directive of the original source', () => {
		const FILE_IGNORED = withSourceMap((map) =>
			JSON.stringify({
				...map,
				sourcesContent: [
					map.sourcesContent[0]?.replace('console-stripper-ignore-next-line', 'console-stripper-ignore'),
				],
			}),
		);

		expect(scanCompiledAstroComponent(FILE_IGNORED, CONTEXT)).toEqual({
			edits: [],
			skipped: [],
			isFileIgnored: true,
			sourceMapError: null,
		});
	});

	it('reports a source map it cannot read and strips the component without its directives', () => {
		const NOT_JSON = withSourceMap(() => 'not json');
		const NO_ORIGINAL = withSourceMap((map) => JSON.stringify({ ...map, sourcesContent: [null] }));
		const NO_CONTENT = withSourceMap((map) => JSON.stringify({ ...map, sourcesContent: undefined }));
		const BAD_MAPPINGS = withSourceMap((map) => JSON.stringify({ ...map, mappings: 'AA!A' }));
		const SCAN = scanCompiledAstroComponent(BAD_MAPPINGS, CONTEXT);

		expect(SCAN.sourceMapError).toBe('Error: decodeMappings found an invalid VLQ digit at index 2');
		expect(applyEdits(BAD_MAPPINGS, SCAN.edits)).not.toContain('console.log("protected frontmatter")');
		expect(scanCompiledAstroComponent(NOT_JSON, CONTEXT).sourceMapError).toMatch(/^SyntaxError: /);
		expect(scanCompiledAstroComponent(NO_ORIGINAL, CONTEXT).sourceMapError).toBe(
			'Error: the source map carries no original source',
		);
		expect(scanCompiledAstroComponent(NO_CONTENT, CONTEXT).sourceMapError).toBe(
			'Error: the source map carries no mappings or no sources content',
		);
		expect(
			scanCompiledAstroComponent(
				'console.log(1);\n//# sourceMappingURL=data:application/json;charset=latin1;base64,e30=\n',
				CONTEXT,
			).sourceMapError,
		).toBe('Error: the source map comment holds no base64 payload');
	});

	it('protects nothing when the original source names no directive in a comment', () => {
		const NO_TOKEN = withSourceMap((map) =>
			JSON.stringify({
				...map,
				sourcesContent: [map.sourcesContent[0]?.replaceAll('console-stripper-ignore', 'note')],
			}),
		);
		const TOKEN_IN_STRING = withSourceMap((map) =>
			JSON.stringify({ ...map, sourcesContent: ["---\nconst NOTE = 'console-stripper-ignore-start';\n---\n"] }),
		);

		[NO_TOKEN, TOKEN_IN_STRING].forEach((compiled) => {
			const OUTPUT = applyEdits(compiled, scanCompiledAstroComponent(compiled, CONTEXT).edits);

			expect(OUTPUT).not.toContain('console.log("protected frontmatter")');
			expect(OUTPUT).not.toContain('console.debug("protected block")');
			expect(OUTPUT).not.toContain('console.log("protected template")');
			// The directive of the inline script is template text of the compiled module, not part of the map
			expect(OUTPUT).toContain("console.log('protected inline')");
		});
	});

	it('protects only the characters mapped into the first source of the map', () => {
		const MAP = {
			version: 3,
			sources: ['index.astro', 'other.ts'],
			sourcesContent: ['---\n// console-stripper-ignore-next-line\nx\n---\n', ''],
			names: [],
			// Line 1 maps to line 3 of `index.astro`, which the directive protects; line 2 maps into `other.ts`
			mappings: 'AAEA;ACFA',
		};

		const COMMENT = `//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(MAP)).toString('base64')}`;
		const SOURCE = `console.log(1);\nconsole.log(2);\n${COMMENT}\n`;

		expect(applyEdits(SOURCE, scanCompiledAstroComponent(SOURCE, CONTEXT).edits)).toBe(`console.log(1);\n${COMMENT}\n`);
	});

	it('reads a module carrying no source map on its own directives', () => {
		const SOURCE = [
			'const $$Index = $$createComponent(() => {',
			'\t// console-stripper-ignore-next-line',
			'\tconsole.log("kept");',
			'\tconsole.log("stripped");',
			'\treturn $$render`<p></p>`;',
			'});',
			'',
		].join('\n');

		expect(scanCompiledAstroComponent('// console-stripper-ignore\nconsole.log(1);\n', CONTEXT)).toEqual({
			edits: [],
			skipped: [],
			isFileIgnored: true,
			sourceMapError: null,
		});

		expect(applyEdits(SOURCE, scanCompiledAstroComponent(SOURCE, CONTEXT).edits)).toBe(
			[
				'const $$Index = $$createComponent(() => {',
				'\t// console-stripper-ignore-next-line',
				'\tconsole.log("kept");',
				'\treturn $$render`<p></p>`;',
				'});',
				'',
			].join('\n'),
		);
	});

	it('maps a removed line of an inline script back over its raw CRLF or CR line ending', () => {
		const CRLF = 'const a = $$render`<script>\r\n\tconsole.log(1);\r\n</script>`;\n';
		const CR = 'const a = $$render`<script>\r\tconsole.log(1);\r</script>`;\n';

		expect(applyEdits(CRLF, scanCompiledAstroComponent(CRLF, CONTEXT).edits)).toBe(
			'const a = $$render`<script>\r\n</script>`;\n',
		);
		expect(applyEdits(CR, scanCompiledAstroComponent(CR, CONTEXT).edits)).toBe(
			'const a = $$render`<script>\r</script>`;\n',
		);
	});

	it('leaves a template chunk holding an escape that does not stand for one character', () => {
		expect(
			scanCompiledAstroComponent('const a = $$render`<script>console.log(1); "\\u0041";</script>`;', CONTEXT).edits,
		).toEqual([]);
		expect(
			scanCompiledAstroComponent('const a = $$render`<script>console.log(1); "\\x41";</script>`;', CONTEXT).edits,
		).toEqual([]);
	});

	it('ignores a template that is not tagged `$$render` in code position or never closes', () => {
		expect(scanCompiledAstroComponent('const a = x$$render`<script>console.log(1)</script>`;', CONTEXT).edits).toEqual(
			[],
		);
		expect(scanCompiledAstroComponent('const a = $$render`<script>console.log(1)</script>', CONTEXT).edits).toEqual([]);
	});

	it('lets a stripped call take the template written in its arguments with it', () => {
		const SOURCE = 'console.log($$render`<script>console.log(1)</script>`);\n';

		expect(applyEdits(SOURCE, scanCompiledAstroComponent(SOURCE, CONTEXT).edits)).toBe('');
	});

	it('reports the calls of the code and of the inline scripts left in place, in source order', () => {
		const SOURCE = 'const a = $$render`<script>console.log(2</script>`;\nconsole.log(3);\nconsole.log(1;\n';
		const SCAN = scanCompiledAstroComponent(SOURCE, CONTEXT);

		expect(SCAN.skipped).toEqual([27, 68]);
		expect(applyEdits(SOURCE, SCAN.edits)).toBe(
			'const a = $$render`<script>console.log(2</script>`;\nconsole.log(1;\n',
		);
	});

	it('does not report an inline script call a stripped call of the code takes with it', () => {
		const SOURCE =
			'console.log($$render`<script>console.log(1</script>`);\nconst b = $$render`<script>console.log(2</script>`;\n';
		const SCAN = scanCompiledAstroComponent(SOURCE, CONTEXT);

		expect(SCAN.skipped).toEqual([82]);
		expect(applyEdits(SOURCE, SCAN.edits)).toBe('const b = $$render`<script>console.log(2</script>`;\n');
	});

	it('does not honor a file-level directive written inside an inline script', () => {
		const SOURCE = 'const a = $$render`<script>\n\t// console-stripper-ignore\n\tconsole.log(1);\n</script>`;\n';

		expect(applyEdits(SOURCE, scanCompiledAstroComponent(SOURCE, CONTEXT).edits)).toBe(
			'const a = $$render`<script>\n\t// console-stripper-ignore\n</script>`;\n',
		);
	});

	it('finds nothing to edit when no method is stripped', () => {
		const NO_METHODS = createScanContext(getOptions({ methods: [] }), 'script');

		expect(scanCompiledAstroComponent(COMPILED, NO_METHODS)).toEqual({
			edits: [],
			skipped: [],
			isFileIgnored: false,
			sourceMapError: null,
		});
	});

	it('keeps an inline script a directive range of the original source protects across a template expression', () => {
		// Captured from `astro build` (Astro 7.3.4) of `tests/fixtures/astro-compiled/ignore-range.astro`, root renamed
		// to `/project`: the range opens in the template chunk before the `${a}` placeholder, and the first inline
		// script sits in the chunk after it, which holds the closing directive but not the opening one
		const RANGE = readFileSync(
			new URL('../tests/fixtures/astro-compiled/ignore-range.compiled.js', import.meta.url),
			'utf8',
		);
		const ORIGINAL = readFileSync(
			new URL('../tests/fixtures/astro-compiled/ignore-range.astro', import.meta.url),
			'utf8',
		);

		expect(describeEdits(RANGE, scanCompiledAstroComponent(RANGE, CONTEXT).edits)).toEqual([['console.log(2)', '']]);
		// The raw component, read before any compiler, keeps the same call
		expect(stripConsole(ORIGINAL, { fileKind: 'astro' })).toBe(
			ORIGINAL.replace('<script is:inline>console.log(2)</script>', '<script is:inline></script>'),
		);
	});
});

describe('scan cost', () => {
	/**
	 * Measures how long a function takes to run.
	 *
	 * @param run - The function to time.
	 *
	 * @returns The duration, in milliseconds.
	 */
	function measureDurationInMs(run: () => unknown): number {
		const START = performance.now();

		run();

		return performance.now() - START;
	}

	// Each bound sits far above the linear cost (a few milliseconds) and far below the quadratic cost measured before
	// the fix, noted next to each case

	it('delimits every tagged call from the template ends the scan recorded, without rescanning the file', () => {
		// 8,000 tagged calls left open (112 KB) took 7.3 s when each call rescanned the rest of the file
		expect(measureDurationInMs(() => stripConsole('console.log`${'.repeat(8000)))).toBeLessThan(1000);
	});

	it('searches a JSX closer once per document, not once per slot', () => {
		// 32,000 slots opening a fragment (352 KB) took 5 s when each slot searched the rest of the document again
		const SOURCE = `${'{x && <>a}\n'.repeat(32_000)}{console.log(1)}`;

		expect(measureDurationInMs(() => stripConsole(SOURCE, { fileKind: 'markup' }))).toBeLessThan(1000);
	});

	it('merges the code and inline script edits of a compiled component in one walk', () => {
		// 16,000 edits of each kind took 1.2 s when each inline edit was compared with every code edit
		const COUNT = 16_000;
		const SOURCE = `const $$C = $$createComponent(() => {\n${'\tconsole.log(1);\n'.repeat(COUNT)}\treturn $$render\`${'<script>console.log(2)</script>'.repeat(COUNT)}\`;\n});\n`;

		let editCount = 0;

		expect(
			measureDurationInMs(() => {
				editCount = scanCompiledAstroComponent(SOURCE, createScanContext(getOptions(), 'script')).edits.length;
			}),
		).toBeLessThan(600);
		expect(editCount).toBe(2 * COUNT);
	});
});
