import type { ConsoleMethod, Options } from './types';
import type { Logger, Plugin, ResolvedConfig } from 'vite';
import type { SourceMap } from './sourcemap';

import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';
import { eachMapping, originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';

import consoleStripper, {
	ASTRO_EXTENSIONS,
	DEFAULT_EXTENSIONS,
	DEFAULT_METHODS,
	HTML_EXTENSIONS,
	JAVASCRIPT_EXTENSIONS,
	JSX_EXTENSIONS,
	SCRIPT_EXTENSIONS,
	SVELTE_EXTENSIONS,
	TYPESCRIPT_EXTENSIONS,
	VUE_EXTENSIONS,
} from './index';

type TransformResult = null | { code: string; map: SourceMap | null };

type TransformHook = (this: unknown, code: string, id: string) => TransformResult;

type BuildHook = (this: unknown, error?: Error) => void;

/**
 * The resolved configuration of a Vite 6+ environment, reduced to what the plugin reads
 */
interface EnvironmentConfig {
	build?: { sourcemap: unknown };
	root?: string;
	logger?: Logger;
	plugins?: readonly { name: string }[];
}

/**
 * The plugin context a hook runs with, reduced to what the plugin reads: the Vite 6+ environment, and the bundler's
 * `warn`
 */
interface HookContext {
	environment?: { name: string; config?: EnvironmentConfig };
	warn?: (message: string, position?: number) => void;
}

interface Harness {
	plugin: Plugin;
	logger: Logger;
	/** Resolves the configuration again, with the named plugins registered around this one, in that order */
	resolveConfig: (pluginNames: readonly string[]) => void;
	transform: (code: string, id: string, context?: HookContext) => TransformResult;
	/** The `transform` hook of the pass over the modules the Angular compiler emits */
	transformCompiled: (code: string, id: string, context?: HookContext) => TransformResult;
	buildStart: (context?: HookContext) => void;
	buildEnd: (error?: Error, context?: HookContext) => void;
}

/**
 * Creates a test harness driving the plugin hooks the way Vite does.
 *
 * @param options - Plugin options.
 * @param root - The resolved Vite root the ignore tokens are matched against.
 *
 * @returns The plugin, a stub logger and callable `transform` / `buildStart` / `buildEnd` hooks.
 */
function createHarness(options: Options, root: string): Harness {
	const [PLUGIN, ANGULAR_PASS] = consoleStripper(options);
	const LOGGER = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
	const CONFIG_RESOLVED = PLUGIN.configResolved as (config: ResolvedConfig) => void;
	const BUILD_START = PLUGIN.buildStart as unknown as BuildHook;
	const BUILD_END = PLUGIN.buildEnd as unknown as BuildHook;
	const TRANSFORM = PLUGIN.transform as TransformHook;
	const TRANSFORM_COMPILED = ANGULAR_PASS.transform as TransformHook;

	/**
	 * Resolves a configuration registering the named plugins, where `console-stripper` stands for the plugin itself.
	 *
	 * @param pluginNames - The plugin names, in the order they run.
	 */
	function resolveConfig(pluginNames: readonly string[]): void {
		const PLUGINS = pluginNames.map((name) => (name === PLUGIN.name ? PLUGIN : { name }));

		CONFIG_RESOLVED({ root, logger: LOGGER, plugins: PLUGINS } as unknown as ResolvedConfig);
	}

	resolveConfig([PLUGIN.name]);
	BUILD_START();

	return {
		plugin: PLUGIN,
		logger: LOGGER,
		resolveConfig,
		transform: (code, id, context) => TRANSFORM.call(context, code, id),
		transformCompiled: (code, id, context) => TRANSFORM_COMPILED.call(context, code, id),
		buildStart: (context) => BUILD_START.call(context),
		buildEnd: (error, context) => BUILD_END.call(context, error),
	};
}

/**
 * Builds the context of a hook running in a named Vite 6+ environment.
 *
 * @param name - The environment name.
 *
 * @returns The hook context.
 */
function inEnvironment(name: string): HookContext {
	return { environment: { name } };
}

/**
 * Text an edit inserts, whose mapping points at the start of the range it replaced rather than at the same character
 */
const REPLACEMENT_TEXTS = ['(void 0)', 'void 0', ';'] as const;

/**
 * Asserts that the result of a plugin transform matches the expected output code and carries a source map whose every
 * mapping points at the character it maps, in the original source the map embeds.
 *
 * @param result - The output of the transform, either `null` or an object containing the transformed code and source map.
 * @param code - The expected transformed code string.
 *
 * @throws If the transformed code does not match `code`, if no source map is present, or if a mapping is wrong.
 */
function expectTransformed(result: TransformResult, code: string): void {
	expect(result?.code).toBe(code);

	const MAP = result?.map;

	if (MAP == null) {
		throw new Error('the transform returned no source map');
	}

	const ORIGINAL_LINES = (MAP.sourcesContent[0] ?? '').split('\n');
	const GENERATED_LINES = code.split('\n');

	let mappingCount = 0;

	eachMapping(new TraceMap(MAP), (mapping) => {
		const GENERATED_LINE = GENERATED_LINES[mapping.generatedLine - 1] ?? '';
		const IS_REPLACEMENT = REPLACEMENT_TEXTS.some((text) => GENERATED_LINE.startsWith(text, mapping.generatedColumn));

		mappingCount++;

		if (mapping.originalLine == null || IS_REPLACEMENT) {
			return;
		}

		expect(ORIGINAL_LINES[mapping.originalLine - 1]?.charAt(mapping.originalColumn)).toBe(
			GENERATED_LINE.charAt(mapping.generatedColumn),
		);
	});

	expect(mappingCount).toBeGreaterThan(0);
}

const OPTIONS: Options = { extensions: ['ts'] };
const SOURCE = 'const a = 1;\nconsole.log(a);\n';
const STRIPPED = 'const a = 1;\n';

describe('consoleStripper', () => {
	it('exposes the plugin identity', () => {
		const { plugin } = createHarness(OPTIONS, '/repo');

		expect(plugin.name).toBe('console-stripper');
		expect(plugin.apply).toBe('build');
		expect(plugin.enforce).toBe('pre');
	});

	it('exposes the pass over the Angular compiler emit second, after every normal-order plugin', () => {
		const [, ANGULAR_PASS] = consoleStripper();

		expect(ANGULAR_PASS).toMatchObject({ name: 'console-stripper:angular', apply: 'build', enforce: 'post' });
	});

	it('exports the default method list', () => {
		expect(DEFAULT_METHODS).toEqual([
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
		]);
	});

	it('runs without options', () => {
		const [PLUGIN] = consoleStripper();
		const TRANSFORM = PLUGIN.transform as TransformHook;

		expectTransformed(TRANSFORM(SOURCE, `${process.cwd()}/src/app.ts`), STRIPPED);
	});

	it('transforms a file whose absolute path contains an ignore token outside the root', () => {
		const { transform } = createHarness(OPTIONS, '/opt/buildhome/repo');

		expectTransformed(transform(SOURCE, '/opt/buildhome/repo/src/app.ts'), STRIPPED);
	});

	it('skips files under a default ignored folder', () => {
		const { transform } = createHarness(OPTIONS, '/repo');

		expect(transform(SOURCE, '/repo/public/app.ts')).toBeNull();
	});

	it('transforms a source file whose folder only shares a name with a root-anchored default', () => {
		const { transform } = createHarness(OPTIONS, '/repo');

		expectTransformed(transform(SOURCE, '/repo/src/routes/public/+page.ts'), STRIPPED);
		expectTransformed(transform(SOURCE, '/repo/src/lib/build/step.ts'), STRIPPED);
		expectTransformed(transform(SOURCE, '/repo/src/e2e/foo.ts'), STRIPPED);
	});

	it('transforms files under a default ignored folder when ignoreDefaults is false', () => {
		const { transform } = createHarness({ ...OPTIONS, ignoreDefaults: false }, '/repo');

		expectTransformed(transform(SOURCE, '/repo/public/app.ts'), STRIPPED);
	});

	it('transforms a dependency by default', () => {
		const { transform } = createHarness(OPTIONS, '/repo');

		expectTransformed(transform(SOURCE, '/repo/node_modules/pkg/app.ts'), STRIPPED);
	});

	it('skips configured folders and files', () => {
		const { transform } = createHarness(
			{ ...OPTIONS, ignoreFolders: ['src/tests'], ignoreFiles: ['legacy.ts'] },
			'/repo',
		);

		expect(transform(SOURCE, '/repo/src/tests/app.ts')).toBeNull();
		expect(transform(SOURCE, '/repo/src/lib/legacy.ts')).toBeNull();
		expectTransformed(transform(SOURCE, '/repo/src/lib/current.ts'), STRIPPED);
	});

	it('skips non-matching extensions and virtual modules', () => {
		const { transform } = createHarness(OPTIONS, '/repo');

		expect(transform(SOURCE, '/repo/src/app.css')).toBeNull();
		expect(transform(SOURCE, '\0virtual:module.ts')).toBeNull();
	});

	it('ignores the query suffix of the id', () => {
		const { transform } = createHarness(OPTIONS, '/repo');

		expectTransformed(transform(SOURCE, '/repo/src/app.ts?used&lang.ts'), STRIPPED);
	});

	it('returns null when nothing changed', () => {
		const { transform } = createHarness(OPTIONS, '/repo');

		expect(transform('const a = 1;\nconsole.error(a);\n', '/repo/src/app.ts')).toBeNull();
	});

	it('rejects a file naming console without calling a stripped method', () => {
		const { transform } = createHarness(OPTIONS, '/repo');

		expect(transform('const console = { log: noop };\n', '/repo/src/app.ts')).toBeNull();
		expect(transform('console.error(1);\nconsole.warn(2);\n', '/repo/src/app.ts')).toBeNull();
		// The probe only pre-selects the file: the scan still decides that a call written in a comment stays
		expectTransformed(transform('// console.log(0)\nconsole.log(1);\n', '/repo/src/app.ts'), '// console.log(0)\n');
	});

	it('strips nothing when the method list resolves to empty', () => {
		const { transform } = createHarness({ ...OPTIONS, methods: [] }, '/repo');

		expect(transform(SOURCE, '/repo/src/app.ts')).toBeNull();
		expect(transform('console.error(1);\n', '/repo/src/app.ts')).toBeNull();
	});

	it('names the module in the sourcemap', () => {
		const { transform } = createHarness(OPTIONS, '/repo');
		const RESULT = transform(SOURCE, '/repo/src/app.ts?used');

		expect(RESULT?.map?.sources).toEqual(['/repo/src/app.ts']);
		expect(RESULT?.map?.sourcesContent).toEqual([SOURCE]);
		expect(RESULT?.map?.mappings.split(';')).toHaveLength(2);
	});

	it('maps the tokens a removal shifted back to their original line and column', () => {
		const { transform } = createHarness(OPTIONS, '/repo');
		const RESULT = transform('const a = 1; console.log(a); const b = 2;\n', '/repo/src/app.ts');

		expectTransformed(RESULT, 'const a = 1;  const b = 2;\n');

		const TRACER = new TraceMap(RESULT?.map ?? '');

		// `b` moved from the column 35 to the column 20
		expect(originalPositionFor(TRACER, { line: 1, column: 20 })).toMatchObject({ line: 1, column: 35 });
		expect(originalPositionFor(TRACER, { line: 1, column: 6 })).toMatchObject({ line: 1, column: 6 });
	});

	it('honorsa custom method list', () => {
		const { transform } = createHarness({ ...OPTIONS, methods: ['error'] }, '/repo');

		expect(transform(SOURCE, '/repo/src/app.ts')).toBeNull();
		expectTransformed(transform('const a = 1;\nconsole.error(a);\n', '/repo/src/app.ts'), STRIPPED);
	});

	it('stays silent by default and prints one summary line when verbose', () => {
		const QUIET = createHarness(OPTIONS, '/repo');

		QUIET.transform(SOURCE, '/repo/src/app.ts');
		QUIET.buildEnd();

		expect(QUIET.logger.info).not.toHaveBeenCalled();

		const VERBOSE = createHarness({ ...OPTIONS, verbose: true }, '/repo');

		VERBOSE.transform(SOURCE, '/repo/src/app.ts');
		VERBOSE.transform('console.log(1);console.log(2);\n', '/repo/src/other.ts');
		VERBOSE.buildEnd();

		expect(VERBOSE.logger.info).toHaveBeenCalledTimes(1);
		expect(VERBOSE.logger.info).toHaveBeenCalledWith(
			'[console-stripper] stripped 3 console calls in 2 project files and 0 console calls in 0 dependency files',
		);
	});

	it('counts project files and dependencies separately', () => {
		const VERBOSE = createHarness({ ...OPTIONS, verbose: true }, '/repo');

		VERBOSE.transform(SOURCE, '/repo/src/app.ts');
		VERBOSE.transform('console.log(1);console.log(2);\n', '/repo/node_modules/pkg/index.ts');
		VERBOSE.buildEnd();

		expect(VERBOSE.logger.info).toHaveBeenCalledWith(
			'[console-stripper] stripped 1 console call in 1 project file and 2 console calls in 1 dependency file',
		);
	});

	it('summarizes each build cycle on its own counters', () => {
		const VERBOSE = createHarness({ ...OPTIONS, verbose: true }, '/repo');

		VERBOSE.transform(SOURCE, '/repo/src/app.ts');
		VERBOSE.buildEnd();
		VERBOSE.buildStart();
		VERBOSE.transform('console.log(1);console.log(2);\n', '/repo/src/other.ts');
		VERBOSE.buildEnd();

		expect(VERBOSE.logger.info).toHaveBeenCalledTimes(2);
		expect(VERBOSE.logger.info).toHaveBeenNthCalledWith(
			1,
			'[console-stripper] stripped 1 console call in 1 project file and 0 console calls in 0 dependency files',
		);
		expect(VERBOSE.logger.info).toHaveBeenNthCalledWith(
			2,
			'[console-stripper] stripped 2 console calls in 1 project file and 0 console calls in 0 dependency files',
		);
	});

	it('prints no summary when the build failed', () => {
		const VERBOSE = createHarness({ ...OPTIONS, verbose: true }, '/repo');

		VERBOSE.transform(SOURCE, '/repo/src/app.ts');
		VERBOSE.buildEnd(new Error('rollup failed'));

		expect(VERBOSE.logger.info).not.toHaveBeenCalled();
	});

	it('treats a markup module as markup and a script module as a script', () => {
		const { transform } = createHarness({ extensions: ['svelte', 'ts'] }, '/repo');

		expectTransformed(transform('<p>{console.log(1)}</p>\n', '/repo/src/App.svelte'), '<p>{void 0}</p>\n');
		expectTransformed(transform('{ console.log(1) }\n', '/repo/src/app.ts'), '{  }\n');
	});

	it('exposes every extension preset as a named export', () => {
		expect(JAVASCRIPT_EXTENSIONS).toEqual(['js', 'mjs', 'cjs']);
		expect(TYPESCRIPT_EXTENSIONS).toEqual(['ts', 'mts', 'cts']);
		expect(JSX_EXTENSIONS).toEqual(['jsx', 'tsx']);
		expect(SCRIPT_EXTENSIONS).toEqual(['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx']);
		expect(SVELTE_EXTENSIONS).toEqual(['svelte']);
		expect(VUE_EXTENSIONS).toEqual(['vue']);
		expect(ASTRO_EXTENSIONS).toEqual(['astro']);
		expect(HTML_EXTENSIONS).toEqual(['html', 'htm']);
		expect(DEFAULT_EXTENSIONS).toEqual([
			'js',
			'mjs',
			'cjs',
			'ts',
			'mts',
			'cts',
			'jsx',
			'tsx',
			'svelte',
			'vue',
			'astro',
			'html',
			'htm',
		]);
	});

	it('processes an html entry by default and changes only its script content', () => {
		const [PLUGIN] = consoleStripper();
		const TRANSFORM = PLUGIN.transform as TransformHook;
		const PAGE = '<p><code>console.log(x)</code></p>\n<script>\n\tconsole.log(1);\n</script>\n';

		expectTransformed(
			TRANSFORM(PAGE, `${process.cwd()}/index.html`),
			'<p><code>console.log(x)</code></p>\n<script>\n</script>\n',
		);
	});

	it('treats the html-proxy module of an html entry as a script', () => {
		const [PLUGIN] = consoleStripper();
		const TRANSFORM = PLUGIN.transform as TransformHook;

		expectTransformed(TRANSFORM(SOURCE, `${process.cwd()}/index.html?html-proxy&index=0.js`), STRIPPED);
	});

	it('names the inline script extracted from an html entry by its own id in the source map', () => {
		const [PLUGIN] = consoleStripper();
		const TRANSFORM = PLUGIN.transform as TransformHook;
		const PAGE_ID = `${process.cwd()}/index.html`;
		const FRAGMENT_ID = `${PAGE_ID}?html-proxy&index=0.js`;
		const FRAGMENT = TRANSFORM(SOURCE, FRAGMENT_ID);
		const PAGE = TRANSFORM(`<script>\n${SOURCE}</script>\n`, PAGE_ID);

		// Vite names the extracted script by its `html-proxy` id, with the script as the content of that source
		expect(FRAGMENT?.map?.sources).toEqual([FRAGMENT_ID]);
		expect(FRAGMENT?.map?.sourcesContent).toEqual([SOURCE]);
		expect(PAGE?.map?.sources).toEqual([PAGE_ID]);
		expect(PAGE?.map?.sourcesContent).toEqual([`<script>\n${SOURCE}</script>\n`]);
	});

	it('reads the frontmatter of an astro component only', () => {
		const { transform } = createHarness({ extensions: ['astro', 'svelte'] }, '/repo');
		const PAGE = '---\nconsole.log(1);\n---\n<p>hello</p>\n';

		expectTransformed(transform(PAGE, '/repo/src/Page.astro'), '---\n---\n<p>hello</p>\n');
		expect(transform(PAGE, '/repo/src/Page.svelte')).toBeNull();
	});

	it('skips a component file when only the script presets are configured', () => {
		const { transform } = createHarness({ extensions: [...SCRIPT_EXTENSIONS] }, '/repo');

		expect(transform('<p>{console.log(1)}</p>\n', '/repo/src/App.svelte')).toBeNull();
		expect(transform('<script>console.log(1);</script>\n', '/repo/index.html')).toBeNull();
		expectTransformed(transform(SOURCE, '/repo/src/app.ts'), STRIPPED);
	});

	it('transforms a custom unknown extension in markup mode', () => {
		const { transform } = createHarness({ extensions: ['whatever'] }, '/repo');

		expectTransformed(
			transform('<script>\n\tconsole.log(1);\n</script>\n<p>{console.log(2)}</p>\n', '/repo/src/App.whatever'),
			'<script>\n</script>\n<p>{void 0}</p>\n',
		);
	});

	it('keeps two instances configured alike independent', () => {
		const FIRST = createHarness(OPTIONS, '/repo');
		const SECOND = createHarness(OPTIONS, '/repo');
		const MANY = 'const a = 1;\nconsole.log(1);\nconsole.log(2);\nconsole.log(3);\n';

		expectTransformed(FIRST.transform(MANY, '/repo/src/a.ts'), STRIPPED);
		expectTransformed(SECOND.transform(MANY, '/repo/src/b.ts'), STRIPPED);
		expectTransformed(FIRST.transform(MANY, '/repo/src/c.ts'), STRIPPED);
		expectTransformed(SECOND.transform(MANY, '/repo/src/d.ts'), STRIPPED);
	});
});

describe('consoleStripper dependencies', () => {
	it('ignores the built-in list inside a dependency', () => {
		const { transform } = createHarness(OPTIONS, '/repo');

		expectTransformed(transform(SOURCE, '/repo/node_modules/pkg/dist/index.ts'), STRIPPED);
		expectTransformed(transform(SOURCE, '/repo/node_modules/pkg/build/index.ts'), STRIPPED);
		expectTransformed(transform(SOURCE, '/repo/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/dist/index.ts'), STRIPPED);
	});

	it('still applies the built-in list to a project file', () => {
		const { transform } = createHarness(OPTIONS, '/repo');

		expect(transform(SOURCE, '/repo/dist/app.ts')).toBeNull();
	});

	it('skips every dependency when stripDependencies is false', () => {
		const { transform } = createHarness({ ...OPTIONS, stripDependencies: false }, '/repo');
		const LENIENT = createHarness({ ...OPTIONS, stripDependencies: false, ignoreDefaults: false }, '/repo');

		expect(transform(SOURCE, '/repo/node_modules/pkg/index.ts')).toBeNull();
		expect(LENIENT.transform(SOURCE, '/repo/node_modules/pkg/index.ts')).toBeNull();
		expectTransformed(LENIENT.transform(SOURCE, '/repo/src/app.ts'), STRIPPED);
	});

	it('skips the packages listed in ignoreDependencies', () => {
		const { transform } = createHarness({ ...OPTIONS, ignoreDependencies: ['pkg', '@scope/kept'] }, '/repo');

		expect(transform(SOURCE, '/repo/node_modules/pkg/index.ts')).toBeNull();
		expect(transform(SOURCE, '/repo/node_modules/@scope/kept/index.ts')).toBeNull();
		expectTransformed(transform(SOURCE, '/repo/node_modules/other/index.ts'), STRIPPED);
		expectTransformed(transform(SOURCE, '/repo/node_modules/@scope/other/index.ts'), STRIPPED);
	});

	it('resolves a nested dependency to the innermost package', () => {
		const { transform } = createHarness({ ...OPTIONS, ignoreDependencies: ['outer'] }, '/repo');
		const INNER = createHarness({ ...OPTIONS, ignoreDependencies: ['inner'] }, '/repo');
		const ID = '/repo/node_modules/outer/node_modules/inner/index.ts';

		expectTransformed(transform(SOURCE, ID), STRIPPED);
		expect(INNER.transform(SOURCE, ID)).toBeNull();
	});

	it('strips a dependency whose owning package cannot be named when no package is ignored', () => {
		const { transform } = createHarness(OPTIONS, '/repo');

		expectTransformed(transform(SOURCE, '/repo/node_modules/.vite/deps/chunk.ts'), STRIPPED);
	});

	it('resolves a package inside the pnpm store', () => {
		const { transform } = createHarness({ ...OPTIONS, ignoreDependencies: ['@scope/pkg'] }, '/repo');

		expect(transform(SOURCE, '/repo/node_modules/.pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg/index.ts')).toBeNull();
	});

	it('honorsthe user ignore tokens inside a dependency', () => {
		const { transform } = createHarness({ ...OPTIONS, ignoreFolders: ['node_modules/pkg'] }, '/repo');

		expect(transform(SOURCE, '/repo/node_modules/pkg/index.ts')).toBeNull();
		expectTransformed(transform(SOURCE, '/repo/node_modules/other/index.ts'), STRIPPED);
	});

	it('honorsan ignore directive written in a dependency', () => {
		const { transform } = createHarness(OPTIONS, '/repo');
		const KEPT = '// console-stripper-ignore\nconsole.log(1);\n';

		expect(transform(KEPT, '/repo/node_modules/pkg/index.ts')).toBeNull();
	});

	it('recognizes a dependency hoisted above the Vite root', () => {
		const { transform } = createHarness(OPTIONS, '/repo/apps/web');

		expectTransformed(transform(SOURCE, '/repo/node_modules/pkg/dist/index.ts'), STRIPPED);
	});
});

describe('consoleStripper option matrix', () => {
	const STRIPPED_METHODS_SOURCE = 'console.table(a);\nconsole.debug(b);\nconsole.trace();\nconsole.log(c);\n';

	it('strips exactly the custom methods listed, dropping an unknown one', () => {
		const { transform, logger } = createHarness(
			{ ...OPTIONS, methods: ['table', 'debug', 'trace', 'nope' as ConsoleMethod] },
			'/repo',
		);

		expectTransformed(transform(STRIPPED_METHODS_SOURCE, '/repo/src/app.ts'), 'console.log(c);\n');
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('strips a method listed twice once', () => {
		const { transform, logger, buildEnd } = createHarness(
			{ ...OPTIONS, methods: ['log', 'log'], verbose: true },
			'/repo',
		);

		expectTransformed(transform(SOURCE, '/repo/src/app.ts'), STRIPPED);
		buildEnd();

		expect(logger.info).toHaveBeenCalledWith(
			'[console-stripper] stripped 1 console call in 1 project file and 0 console calls in 0 dependency files',
		);
	});

	it('never trims a method name, and warns about the entry it rejected', () => {
		const { transform, logger } = createHarness({ ...OPTIONS, methods: [' log ' as ConsoleMethod] }, '/repo');

		expect(transform(SOURCE, '/repo/src/app.ts')).toBeNull();
		expect(logger.warn).toHaveBeenCalledWith(
			'[console-stripper] the "methods" option resolved to an empty list (no console method is named " log "), so the plugin will not strip anything',
		);
	});

	it('falls back to the default lists for non-array values', () => {
		const MALFORMED = {
			methods: 'log',
			extensions: 'ts',
			ignoreFolders: 'src',
			ignoreDependencies: 'pkg',
		} as unknown as Options;
		const { transform, logger } = createHarness(MALFORMED, '/repo');

		expectTransformed(transform('<p>{console.log(1)}</p>\n', '/repo/src/App.svelte'), '<p>{void 0}</p>\n');
		expectTransformed(transform(SOURCE, '/repo/src/app.ts'), STRIPPED);
		expectTransformed(transform(SOURCE, '/repo/node_modules/pkg/index.ts'), STRIPPED);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('normalizes every spelling of an ignore token', () => {
		const TOKENS = ['/src/tests', './src/tests', '../src/tests', 'src/tests/', 'src\\tests', '.\\src\\tests\\'];

		for (const TOKEN of TOKENS) {
			const { transform } = createHarness({ ...OPTIONS, ignoreFolders: [TOKEN] }, '/repo');

			expect(transform(SOURCE, '/repo/src/tests/app.ts')).toBeNull();
			expectTransformed(transform(SOURCE, '/repo/src/testsuite/app.ts'), STRIPPED);
		}
	});

	it('matches a token against a Windows id relative to a Windows root', () => {
		const { transform } = createHarness({ ...OPTIONS, ignoreFolders: ['src\\tests'] }, 'C:/repo');

		expect(transform(SOURCE, 'C:/repo/src/tests/app.ts')).toBeNull();
		expectTransformed(transform(SOURCE, 'C:/repo/src/app.ts'), STRIPPED);
	});

	it('matches a * token within one segment of a file name', () => {
		const { transform } = createHarness({ ...OPTIONS, ignoreFiles: ['*.spec.ts'] }, '/repo');

		expect(transform(SOURCE, '/repo/src/app.spec.ts')).toBeNull();
		expectTransformed(transform(SOURCE, '/repo/src/spec/app.ts'), STRIPPED);
	});

	it('resolves a scoped package nested inside a scoped package of the pnpm store', () => {
		const ID =
			'/repo/node_modules/.pnpm/@scope+outer@1.0.0/node_modules/@scope/outer/node_modules/@scope/inner/index.ts';
		const INNER = createHarness({ ...OPTIONS, ignoreDependencies: ['@scope/inner'] }, '/repo');
		const OUTER = createHarness({ ...OPTIONS, ignoreDependencies: ['@scope/outer'] }, '/repo');

		expect(INNER.transform(SOURCE, ID)).toBeNull();
		expectTransformed(OUTER.transform(SOURCE, ID), STRIPPED);
	});

	it('prints a zero summary when verbose and nothing was stripped', () => {
		const { transform, logger, buildEnd } = createHarness({ ...OPTIONS, verbose: true }, '/repo');

		expect(transform('const a = 1;\n', '/repo/src/app.ts')).toBeNull();
		buildEnd();

		expect(logger.info).toHaveBeenCalledOnce();
		expect(logger.info).toHaveBeenCalledWith(
			'[console-stripper] stripped 0 console calls in 0 project files and 0 console calls in 0 dependency files',
		);
	});

	it('reads a # written in a folder name as part of the path', () => {
		const { transform } = createHarness(OPTIONS, '/repo');

		expectTransformed(transform(SOURCE, '/repo/src/#internal/app.ts'), STRIPPED);
	});

	it('strips a module whose id carries a #hash suffix, alone or after a query', () => {
		const { transform } = createHarness(OPTIONS, '/repo');

		expectTransformed(transform(SOURCE, '/repo/src/app.ts#hash'), STRIPPED);
		expectTransformed(transform(SOURCE, '/repo/src/app.ts?used#hash'), STRIPPED);
	});
});

describe('consoleStripper source maps', () => {
	/**
	 * Drives one transform with a given `build.sourcemap` setting on the resolved configuration, on the environment
	 * running the hook, or on both.
	 */
	interface SourcemapScenario {
		/** The setting of the resolved configuration. `undefined` resolves a configuration without build options */
		configured?: unknown;
		/** The setting of the environment. `undefined` runs the hook on a context carrying no environment */
		environment?: unknown;
	}

	/**
	 * Transforms a file holding one stripped call under the given scenario.
	 *
	 * @param scenario - The settings the configuration and the environment carry.
	 *
	 * @returns The result of the transform.
	 */
	function transformUnder(scenario: SourcemapScenario): TransformResult {
		const [PLUGIN] = consoleStripper(OPTIONS);
		const LOGGER = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
		const CONFIG_RESOLVED = PLUGIN.configResolved as (config: ResolvedConfig) => void;
		const TRANSFORM = PLUGIN.transform as TransformHook;
		const BUILD = scenario.configured == null ? {} : { build: { sourcemap: scenario.configured } };
		const CONTEXT =
			scenario.environment == null
				? {}
				: { environment: { name: 'client', config: { build: { sourcemap: scenario.environment } } } };

		CONFIG_RESOLVED({ root: '/repo', logger: LOGGER, plugins: [PLUGIN], ...BUILD } as unknown as ResolvedConfig);

		return TRANSFORM.call(CONTEXT, SOURCE, '/repo/src/app.ts');
	}

	it('generates a map for every setting asking for one', () => {
		expectTransformed(transformUnder({ configured: true }), STRIPPED);
		expectTransformed(transformUnder({ configured: 'inline' }), STRIPPED);
		expectTransformed(transformUnder({ configured: 'hidden' }), STRIPPED);
	});

	it('generates no map when the build wants none', () => {
		const RESULT = transformUnder({ configured: false });

		expect(RESULT?.code).toBe(STRIPPED);
		expect(RESULT?.map).toBeNull();
	});

	it('keeps generating a map when no configuration was resolved', () => {
		const [PLUGIN] = consoleStripper(OPTIONS);
		const TRANSFORM = PLUGIN.transform as TransformHook;

		expectTransformed(TRANSFORM(SOURCE, '/repo/src/app.ts'), STRIPPED);
		expectTransformed(transformUnder({}), STRIPPED);
	});

	it('prefers the setting of the environment over the one of the resolved configuration', () => {
		expectTransformed(transformUnder({ configured: false, environment: true }), STRIPPED);
		expect(transformUnder({ configured: true, environment: false })?.map).toBeNull();
		expectTransformed(transformUnder({ configured: false, environment: 'inline' }), STRIPPED);
		expectTransformed(transformUnder({ configured: false, environment: 'hidden' }), STRIPPED);
	});

	it('falls back on the resolved configuration for an environment without build options', () => {
		const [PLUGIN] = consoleStripper(OPTIONS);
		const LOGGER = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
		const CONFIG_RESOLVED = PLUGIN.configResolved as (config: ResolvedConfig) => void;
		const TRANSFORM = PLUGIN.transform as TransformHook;

		CONFIG_RESOLVED({
			root: '/repo',
			logger: LOGGER,
			plugins: [PLUGIN],
			build: { sourcemap: false },
		} as unknown as ResolvedConfig);

		expect(TRANSFORM.call(inEnvironment('client'), SOURCE, '/repo/src/app.ts')?.map).toBeNull();
	});
});

describe('consoleStripper option warnings', () => {
	it('warns when the method list resolves to nothing, naming the rejected entries', () => {
		const { logger } = createHarness({ ...OPTIONS, methods: ['logs'] as unknown as ConsoleMethod[] }, '/repo');

		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(
			'[console-stripper] the "methods" option resolved to an empty list (no console method is named "logs"), so the plugin will not strip anything',
		);
	});

	it('names a rejected entry that is not a string by its type, even one that cannot be converted to a string', () => {
		const { logger, transform } = createHarness({ ...OPTIONS, methods: [Object.create(null), 42, 'logs'] }, '/repo');

		expect(logger.warn).toHaveBeenCalledWith(
			'[console-stripper] the "methods" option resolved to an empty list (no console method is named <object>, <number>, "logs"), so the plugin will not strip anything',
		);
		expect(transform(SOURCE, '/repo/src/app.ts')).toBeNull();
	});

	it('warns for an empty method list without naming any entry', () => {
		const { logger } = createHarness({ ...OPTIONS, methods: [] }, '/repo');

		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(
			'[console-stripper] the "methods" option resolved to an empty list, so the plugin will not strip anything',
		);
	});

	it('warns when the extension list resolves to nothing', () => {
		const { logger } = createHarness({ extensions: [] }, '/repo');

		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(
			'[console-stripper] the "extensions" option resolved to an empty list, so the plugin will not strip anything',
		);
	});

	it('warns once per emptied list and never throws', () => {
		const { logger, transform } = createHarness({ methods: [], extensions: [' ', 42] as unknown as string[] }, '/repo');

		expect(logger.warn).toHaveBeenCalledTimes(2);
		expect(transform(SOURCE, '/repo/src/app.ts')).toBeNull();
	});

	it('stays silent when both lists resolve to something', () => {
		const { logger } = createHarness({ ...OPTIONS, methods: ['log', 'debug'] }, '/repo');

		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('warns only once when the configuration is resolved once per environment', () => {
		const { logger, resolveConfig } = createHarness({ methods: [], extensions: [] }, '/repo');

		resolveConfig(['console-stripper']);
		resolveConfig(['console-stripper']);

		expect(logger.warn).toHaveBeenCalledTimes(2);
	});
});

describe('consoleStripper environments', () => {
	it('prefixes the summary with the name of the environment it covers', () => {
		const { buildEnd, buildStart, logger, transform } = createHarness({ ...OPTIONS, verbose: true }, '/repo');
		const CLIENT = inEnvironment('client');

		buildStart(CLIENT);
		transform(SOURCE, '/repo/src/app.ts', CLIENT);
		buildEnd(undefined, CLIENT);

		expect(logger.info).toHaveBeenCalledWith(
			'[console-stripper] [client] stripped 1 console call in 1 project file and 0 console calls in 0 dependency files',
		);
	});

	it('keeps the counters of two environments sharing the plugin apart', () => {
		const { buildEnd, buildStart, logger, transform } = createHarness({ ...OPTIONS, verbose: true }, '/repo');
		const CLIENT = inEnvironment('client');
		const SSR = inEnvironment('ssr');

		buildStart(CLIENT);
		transform(SOURCE, '/repo/src/app.ts', CLIENT);
		// The second environment starts while the first is still building, which must not reset its counters
		buildStart(SSR);
		transform('console.log(1);console.log(2);\n', '/repo/src/server.ts', SSR);
		transform(SOURCE, '/repo/node_modules/pkg/index.ts', SSR);
		buildEnd(undefined, CLIENT);
		buildEnd(undefined, SSR);

		expect(logger.info).toHaveBeenNthCalledWith(
			1,
			'[console-stripper] [client] stripped 1 console call in 1 project file and 0 console calls in 0 dependency files',
		);
		expect(logger.info).toHaveBeenNthCalledWith(
			2,
			'[console-stripper] [ssr] stripped 2 console calls in 1 project file and 1 console call in 1 dependency file',
		);
	});

	it('keeps the counters of two builds apart when both name their environment alike', () => {
		const { buildEnd, buildStart, logger, transform } = createHarness({ ...OPTIONS, verbose: true }, '/repo');
		const FIRST = inEnvironment('client');
		const SECOND = inEnvironment('client');

		buildStart(FIRST);
		transform(SOURCE, '/repo/src/app.ts', FIRST);
		buildStart(SECOND);
		transform('console.log(1);console.log(2);\n', '/repo/src/other.ts', SECOND);
		buildEnd(undefined, FIRST);
		buildEnd(undefined, SECOND);

		expect(logger.info).toHaveBeenNthCalledWith(
			1,
			'[console-stripper] [client] stripped 1 console call in 1 project file and 0 console calls in 0 dependency files',
		);
		expect(logger.info).toHaveBeenNthCalledWith(
			2,
			'[console-stripper] [client] stripped 2 console calls in 1 project file and 0 console calls in 0 dependency files',
		);
	});

	it('starts the next build of an environment from fresh counters', () => {
		const { buildEnd, buildStart, logger, transform } = createHarness({ ...OPTIONS, verbose: true }, '/repo');
		const CLIENT = inEnvironment('client');

		buildStart(CLIENT);
		transform(SOURCE, '/repo/src/app.ts', CLIENT);
		buildEnd(undefined, CLIENT);
		buildStart(CLIENT);
		buildEnd(undefined, CLIENT);

		expect(logger.info).toHaveBeenLastCalledWith(
			'[console-stripper] [client] stripped 0 console calls in 0 project files and 0 console calls in 0 dependency files',
		);
	});

	it('matches the ignore tokens against the root of the environment the hook runs in', () => {
		const { transform } = createHarness({ ...OPTIONS, ignoreFolders: ['web'] }, '/repo');
		const WEB_ROOT = { environment: { name: 'client', config: { root: '/repo/web' } } };

		// Relative to `/repo`, the configuration resolved last, the module sits under the ignored `web` folder
		expect(transform(SOURCE, '/repo/web/src/app.ts')).toBeNull();
		expectTransformed(transform(SOURCE, '/repo/web/src/app.ts', WEB_ROOT), STRIPPED);
	});

	it('summarizes each environment on the logger of its own configuration', () => {
		const { buildEnd, buildStart, logger, transform } = createHarness({ ...OPTIONS, verbose: true }, '/repo');
		const OWN_LOGGER = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
		const CLIENT = { environment: { name: 'client', config: { logger: OWN_LOGGER } } };

		buildStart(CLIENT);
		transform(SOURCE, '/repo/src/app.ts', CLIENT);
		buildEnd(undefined, CLIENT);

		expect(OWN_LOGGER.info).toHaveBeenCalledExactlyOnceWith(
			'[console-stripper] [client] stripped 1 console call in 1 project file and 0 console calls in 0 dependency files',
		);
		expect(logger.info).not.toHaveBeenCalled();
	});
});

describe('consoleStripper undelimited calls', () => {
	const UNBALANCED = 'console.log(1);\nconsole.debug(2;\nconsole.trace(3;\n';

	it('warns once through the plugin context, pointing at the first call left in place', () => {
		const { logger, transform } = createHarness(OPTIONS, '/repo');
		const WARN = vi.fn();

		expect(transform(UNBALANCED, '/repo/src/app.ts', { warn: WARN })?.code).toBe(
			'console.debug(2;\nconsole.trace(3;\n',
		);
		expect(WARN).toHaveBeenCalledExactlyOnceWith(
			'left 2 console calls in place in src/app.ts because their end could not be found',
			16,
		);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('warns through the logger when the hook is called without a plugin context', () => {
		const { logger, transform } = createHarness(OPTIONS, '/repo');

		expect(transform('a();\nconsole.log(1;\n', '/repo/src/app.ts')).toBeNull();
		expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
			'[console-stripper] left 1 console call in place in src/app.ts because its end could not be found',
		);
	});

	it('names the module relative to the root of the environment the hook runs in', () => {
		const { transform } = createHarness(OPTIONS, '/repo');
		const WARN = vi.fn();

		transform('console.log(1;\n', '/repo/web/src/app.ts', {
			environment: { name: 'client', config: { root: '/repo/web' } },
			warn: WARN,
		});

		expect(WARN).toHaveBeenCalledExactlyOnceWith(
			'left 1 console call in place in src/app.ts because its end could not be found',
			0,
		);
	});

	it('does not warn about a module whose calls are all delimited', () => {
		const { transform } = createHarness(OPTIONS, '/repo');
		const WARN = vi.fn();

		expectTransformed(transform(SOURCE, '/repo/src/app.ts', { warn: WARN }), STRIPPED);
		expect(transform('// console.log(1\n', '/repo/src/app.ts', { warn: WARN })).toBeNull();
		expect(WARN).not.toHaveBeenCalled();
	});

	it('falls back on the logger for a context that cannot warn', () => {
		const { logger, plugin } = createHarness(OPTIONS, '/repo');
		const TRANSFORM = plugin.transform as TransformHook;
		const CONTEXTS: unknown[] = [null, inEnvironment('client'), { warn: 'nope' }];

		CONTEXTS.forEach((context, index) => TRANSFORM.call(context, 'console.log(1;\n', `/repo/src/app-${index}.ts`));

		expect(logger.warn).toHaveBeenCalledTimes(3);
	});

	it('warns once about a module every environment of the build transforms', () => {
		const { transform } = createHarness(OPTIONS, '/repo');
		const WARN = vi.fn();

		transform('console.log(1;\n', '/repo/src/shared.ts', { ...inEnvironment('client'), warn: WARN });
		transform('console.log(1;\n', '/repo/src/shared.ts', { ...inEnvironment('ssr'), warn: WARN });
		transform('console.log(1;\n', '/repo/src/other.ts', { ...inEnvironment('ssr'), warn: WARN });

		expect(WARN.mock.calls).toStrictEqual([
			['left 1 console call in place in src/shared.ts because its end could not be found', 0],
			['left 1 console call in place in src/other.ts because its end could not be found', 0],
		]);
	});

	it('does not warn about a dependency whose calls are left in place', () => {
		const { logger, transform } = createHarness(OPTIONS, '/repo');
		const WARN = vi.fn();

		expect(transform(UNBALANCED, '/repo/node_modules/pkg/index.ts', { warn: WARN })?.code).toBe(
			'console.debug(2;\nconsole.trace(3;\n',
		);
		expect(transform('console.log(1;\n', '/repo/node_modules/pkg/other.ts')).toBeNull();
		expect(WARN).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('reports the calls left in place in the verbose summary, split by class of files', () => {
		const { buildEnd, logger, transform } = createHarness({ ...OPTIONS, verbose: true }, '/repo');

		transform('console.log(1;\n', '/repo/src/app.ts', { warn: vi.fn() });
		transform(UNBALANCED, '/repo/node_modules/pkg/index.ts');
		buildEnd();

		expect(logger.info).toHaveBeenCalledExactlyOnceWith(
			'[console-stripper] stripped 0 console calls in 0 project files and 1 console call in 1 dependency file; left 3 undelimitable calls in place (1 project, 2 dependency)',
		);
	});

	it('names a single call left in place in the singular', () => {
		const { buildEnd, logger, transform } = createHarness({ ...OPTIONS, verbose: true }, '/repo');

		transform('console.log(1;\n', '/repo/node_modules/pkg/index.ts');
		buildEnd();

		expect(logger.info).toHaveBeenCalledExactlyOnceWith(
			'[console-stripper] stripped 0 console calls in 0 project files and 0 console calls in 0 dependency files; left 1 undelimitable call in place (0 project, 1 dependency)',
		);
	});
});

describe('consoleStripper html inline scripts', () => {
	const PAGE_ID = '/repo/index.html';
	const PROTECTED_BODY = "\n\tconsole.log('kept');\n\twindow.a = 1;\n";
	const PROTECTED_PAGE = [
		'<!-- console-stripper-ignore-start -->',
		`<script type="module">${PROTECTED_BODY}</script>`,
		'<!-- console-stripper-ignore-end -->',
		'<script type="module">\n\tconsole.log(\'dropped\');\n\twindow.b = 2;\n</script>',
		'',
	].join('\n');
	const INJECTED = "console.log('injected');\nwindow.c = 3;\n";

	/**
	 * Builds the id Vite gives the inline module script of a page.
	 *
	 * @param index - The position of the script among the page's inline module scripts.
	 *
	 * @returns The `html-proxy` id.
	 */
	function toProxyId(index: number): string {
		return `${PAGE_ID}?html-proxy&index=${index}.js`;
	}

	it('keeps the calls the page protects once Vite extracts its inline script', () => {
		const { transform } = createHarness({}, '/repo');

		expectTransformed(transform(PROTECTED_PAGE, PAGE_ID), PROTECTED_PAGE.replace("\tconsole.log('dropped');\n", ''));
		expect(transform(PROTECTED_BODY, toProxyId(0))).toBeNull();
	});

	it('strips an inline script the page never held', () => {
		const { transform } = createHarness({}, '/repo');

		transform(PROTECTED_PAGE, PAGE_ID);

		expectTransformed(transform(INJECTED, toProxyId(2)), 'window.c = 3;\n');
	});

	it('keeps the own inline scripts of a page a file-level directive ignores, and strips an injected one', () => {
		const { transform } = createHarness({}, '/repo');
		const IGNORED_PAGE = `<!-- console-stripper-ignore -->\n<script type="module">\n\tconsole.log(1);\n</script>\n`;

		expect(transform(IGNORED_PAGE, PAGE_ID)).toBeNull();
		expect(transform('\n\tconsole.log(1);\n', toProxyId(0))).toBeNull();
		expectTransformed(transform(INJECTED, toProxyId(1)), 'window.c = 3;\n');
	});

	it('strips an injected script whether or not the ignored page holds a stripped call of its own', () => {
		const { transform } = createHarness({}, '/repo');
		const IGNORED_PAGE = `<!-- console-stripper-ignore -->\n<script type="module">\n\tconsole.error(1);\n</script>\n`;

		expect(transform(IGNORED_PAGE, PAGE_ID)).toBeNull();
		expectTransformed(transform(INJECTED, toProxyId(1)), 'window.c = 3;\n');
	});

	it('matches a script whose line endings the HTML parser normalized', () => {
		const { transform } = createHarness({}, '/repo');

		transform(PROTECTED_PAGE.replaceAll('\n', '\r\n'), PAGE_ID);

		expect(transform(PROTECTED_BODY, toProxyId(0))).toBeNull();
	});

	it('forgets the pages of the previous build', () => {
		const { buildStart, transform } = createHarness({}, '/repo');

		transform(PROTECTED_PAGE, PAGE_ID);
		buildStart();

		expectTransformed(transform(PROTECTED_BODY, toProxyId(0)), '\n\twindow.a = 1;\n');
	});

	it('reads the pages of the environment the script is built in only', () => {
		const { transform } = createHarness({}, '/repo');

		const CLIENT = inEnvironment('client');

		transform(PROTECTED_PAGE, PAGE_ID, CLIENT);

		expect(transform(PROTECTED_BODY, toProxyId(0), CLIENT)).toBeNull();
		expectTransformed(transform(PROTECTED_BODY, toProxyId(0), inEnvironment('ssr')), '\n\twindow.a = 1;\n');
	});

	it('keeps the record of a page when Vite extracts one of its inline styles', () => {
		const { transform } = createHarness({}, '/repo');

		transform(PROTECTED_PAGE, PAGE_ID);

		expect(transform('/* console.log(1) */\na {}\n', `${PAGE_ID}?html-proxy&inline-css&index=0.css`)).toBeNull();
		expect(transform(PROTECTED_BODY, toProxyId(0))).toBeNull();
	});
});

describe('consoleStripper astro components', () => {
	const COMPILED_ID = '/repo/src/pages/index.astro';
	// The shape Astro's compiler gives a page holding a frontmatter call, a template call and a call written as text
	const COMPILED = [
		'const $$Index = $$createComponent(($$result) => {',
		'\tconsole.log("frontmatter");',
		'\treturn $$render`<p>console.log(text)</p><p>${console.log("t")}</p>`;',
		'});',
		'export default $$Index;',
		'',
	].join('\n');
	const STRIPPED_COMPILED = [
		'const $$Index = $$createComponent(($$result) => {',
		'\treturn $$render`<p>console.log(text)</p><p>${void 0}</p>`;',
		'});',
		'export default $$Index;',
		'',
	].join('\n');

	it('reads a component Astro compiled first as a script', () => {
		const { resolveConfig, transform } = createHarness({}, '/repo');

		resolveConfig(['astro:build', 'console-stripper']);

		expectTransformed(transform(COMPILED, COMPILED_ID), STRIPPED_COMPILED);
	});

	it('honors the directives the source map of a compiled component carries', () => {
		const { logger, resolveConfig, transform } = createHarness({}, '/project');
		const CAPTURED = readFileSync(
			new URL('../tests/fixtures/astro-compiled/index.compiled.js', import.meta.url),
			'utf8',
		);

		resolveConfig(['astro:build', 'console-stripper']);

		const CODE = transform(CAPTURED, '/project/src/pages/index.astro')?.code ?? '';

		expect(CODE).toContain('\tconsole.log("protected frontmatter");\n');
		expect(CODE).toContain('${console.log("protected template")}');
		expect(CODE).not.toContain('stripped frontmatter');
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('warns about a compiled component whose source map cannot be read and strips it without its directives', () => {
		const { logger, resolveConfig, transform } = createHarness({}, '/project');
		const UNREADABLE = [
			'const $$Index = $$createComponent(() => {',
			'\tconsole.log("frontmatter");',
			'});',
			'//# sourceMappingURL=data:application/json;charset=utf-8;base64,bm90IGpzb24=',
			'',
		].join('\n');

		resolveConfig(['astro:build', 'console-stripper']);

		expect(transform(UNREADABLE, '/project/src/pages/index.astro')?.code).toBe(
			[
				'const $$Index = $$createComponent(() => {',
				'});',
				'//# sourceMappingURL=data:application/json;charset=utf-8;base64,bm90IGpzb24=',
				'',
			].join('\n'),
		);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringMatching(
				/^\[console-stripper\] the source map Astro attached to src\/pages\/index\.astro could not be read \(.+\), so its ignore directives were not applied$/,
			),
		);
	});

	it('reports an unreadable source map through the plugin context when the hook has one', () => {
		const { logger, resolveConfig, transform } = createHarness({}, '/project');
		const WARN = vi.fn();
		const UNREADABLE = 'console.log(1);\n//# sourceMappingURL=data:application/json;base64,bm90IGpzb24=\n';

		resolveConfig(['astro:build', 'console-stripper']);
		transform(UNREADABLE, '/project/src/pages/index.astro', { warn: WARN });

		expect(WARN).toHaveBeenCalledTimes(1);
		expect(WARN).toHaveBeenCalledWith(
			expect.stringMatching(
				/^the source map Astro attached to src\/pages\/index\.astro could not be read \(.+\), so its ignore directives were not applied$/,
			),
			undefined,
		);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('never warns about the unreadable source map of a dependency component', () => {
		const { logger, resolveConfig, transform } = createHarness({}, '/project');
		const WARN = vi.fn();
		const UNREADABLE = 'console.log(1);\n//# sourceMappingURL=data:application/json;base64,bm90IGpzb24=\n';

		resolveConfig(['astro:build', 'console-stripper']);

		expect(transform(UNREADABLE, '/project/node_modules/pkg/Card.astro', { warn: WARN })?.code).toBe(
			'//# sourceMappingURL=data:application/json;base64,bm90IGpzb24=\n',
		);
		expect(WARN).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('reads the Astro compiler order of the environment the hook runs in', () => {
		const { resolveConfig, transform } = createHarness({}, '/repo');
		const PLUGIN = { name: 'console-stripper' };
		const ASTRO_FIRST = { environment: { name: 'client', config: { plugins: [{ name: 'astro:build' }, PLUGIN] } } };
		const ASTRO_LAST = { environment: { name: 'client', config: { plugins: [PLUGIN, { name: 'astro:build' }] } } };

		expectTransformed(transform(COMPILED, COMPILED_ID, ASTRO_FIRST), STRIPPED_COMPILED);

		resolveConfig(['astro:build', 'console-stripper']);

		expectTransformed(
			transform("---\nconsole.log('frontmatter');\n---\n<p>console.log(text)</p>\n", COMPILED_ID, ASTRO_LAST),
			'---\n---\n<p>console.log(text)</p>\n',
		);
	});

	it('keeps reading a raw component as markup', () => {
		const { resolveConfig, transform } = createHarness({}, '/repo');
		const RAW = "---\nconsole.log('frontmatter');\n---\n<p>console.log(text)</p>\n";

		resolveConfig(['console-stripper', 'astro:build']);

		expectTransformed(transform(RAW, COMPILED_ID), '---\n---\n<p>console.log(text)</p>\n');
	});

	it('leaves the kind of a component sub-request to its query', () => {
		const { resolveConfig, transform } = createHarness({}, '/repo');

		resolveConfig(['astro:build', 'console-stripper']);

		expectTransformed(transform('<p>{console.log(1)}</p>\n', `${COMPILED_ID}?raw-like`), '<p>{void 0}</p>\n');
	});
});

describe('consoleStripper angular compiler', () => {
	const ANGULAR_COMPILER = '@analogjs/vite-plugin-angular';
	const COMPONENT_ID = '/repo/src/app/app.component.ts';
	const AUTHORED =
		"@Component({ selector: 'app-root' })\nclass AppComponent {\n\tlog(): void {\n\t\tconsole.log(1);\n\t}\n}\n";
	const EMITTED = 'class AppComponent {\n    log() {\n        console.log(1);\n    }\n}\n';
	const STRIPPED_EMIT = 'class AppComponent {\n    log() {\n    }\n}\n';

	it('leaves a project TypeScript module to the compiled pass when the Angular compiler is registered', () => {
		const { resolveConfig, transform, transformCompiled } = createHarness({}, '/repo');

		resolveConfig(['console-stripper', ANGULAR_COMPILER]);

		expect(transform(AUTHORED, COMPONENT_ID)).toBeNull();
		expectTransformed(transformCompiled(EMITTED, COMPONENT_ID), STRIPPED_EMIT);
	});

	it('leaves every module to the source pass without the Angular compiler', () => {
		const { resolveConfig, transform, transformCompiled } = createHarness({}, '/repo');

		expectTransformed(transform(SOURCE, COMPONENT_ID), STRIPPED);
		expect(transformCompiled(EMITTED, COMPONENT_ID)).toBeNull();

		resolveConfig(['console-stripper', '@analogjs/vite-plugin-angular-fast-compile']);

		expectTransformed(transform(SOURCE, COMPONENT_ID), STRIPPED);
		expect(transformCompiled(EMITTED, COMPONENT_ID)).toBeNull();
	});

	it('keeps dependencies, other script kinds and virtual modules on the source pass', () => {
		const { resolveConfig, transform, transformCompiled } = createHarness({}, '/repo');

		resolveConfig([ANGULAR_COMPILER, 'console-stripper']);

		['/repo/node_modules/pkg/index.ts', '/repo/src/main.js', '/repo/src/App.tsx'].forEach((id) => {
			expectTransformed(transform(SOURCE, id), STRIPPED);
			expect(transformCompiled(SOURCE, id)).toBeNull();
		});

		expect(transformCompiled(SOURCE, '\0virtual.ts')).toBeNull();
	});

	it('keeps the emit of a module whose authored source a file-level directive protects', () => {
		const { resolveConfig, transform, transformCompiled } = createHarness({}, '/repo');
		const IGNORED_ID = '/repo/src/app/ignored.component.ts';

		resolveConfig([ANGULAR_COMPILER, 'console-stripper']);

		// The compiler drops the directive together with the `import type` it is attached to
		expect(transform(`// console-stripper-ignore\nimport type { A } from 'a';\n${AUTHORED}`, IGNORED_ID)).toBeNull();
		expect(transformCompiled(EMITTED, IGNORED_ID)).toBeNull();
		expectTransformed(transformCompiled(EMITTED, COMPONENT_ID), STRIPPED_EMIT);
	});

	it('reads no file-level directive from the authored source when ignore comments are off', () => {
		const { resolveConfig, transform, transformCompiled } = createHarness({ ignoreComments: false }, '/repo');

		resolveConfig([ANGULAR_COMPILER, 'console-stripper']);

		expect(transform(`// console-stripper-ignore\n${AUTHORED}`, COMPONENT_ID)).toBeNull();
		expectTransformed(transformCompiled(EMITTED, COMPONENT_ID), STRIPPED_EMIT);
	});

	it('applies the extension and path rules and the call probe to the compiled pass', () => {
		const SCRIPTS_ONLY = createHarness({ extensions: ['js'] }, '/repo');
		const IGNORED_FOLDER = createHarness({ ignoreFolders: ['src/app'] }, '/repo');
		const DEFAULTS = createHarness({}, '/repo');

		[SCRIPTS_ONLY, IGNORED_FOLDER, DEFAULTS].forEach(({ resolveConfig }) => {
			resolveConfig([ANGULAR_COMPILER, 'console-stripper']);
		});

		expect(SCRIPTS_ONLY.transformCompiled(EMITTED, COMPONENT_ID)).toBeNull();
		expect(IGNORED_FOLDER.transformCompiled(EMITTED, COMPONENT_ID)).toBeNull();
		expect(DEFAULTS.transformCompiled('class AppComponent {}\n', COMPONENT_ID)).toBeNull();
		expect(DEFAULTS.transformCompiled('console.error(1);\n', COMPONENT_ID)).toBeNull();
	});

	it('reads the Angular compiler of the environment the hook runs in', () => {
		const { transform, transformCompiled } = createHarness({}, '/repo');
		const WITH_ANGULAR = { environment: { name: 'client', config: { plugins: [{ name: ANGULAR_COMPILER }] } } };
		const WITHOUT_ANGULAR = { environment: { name: 'ssr', config: { plugins: [{ name: 'console-stripper' }] } } };

		expect(transform(AUTHORED, COMPONENT_ID, WITH_ANGULAR)).toBeNull();
		expectTransformed(transformCompiled(EMITTED, COMPONENT_ID, WITH_ANGULAR), STRIPPED_EMIT);
		expectTransformed(transform(SOURCE, COMPONENT_ID, WITHOUT_ANGULAR), STRIPPED);
		expect(transformCompiled(EMITTED, COMPONENT_ID, WITHOUT_ANGULAR)).toBeNull();
	});

	it('counts a module the compiled pass strips once in the summary', () => {
		const { buildEnd, logger, resolveConfig, transform, transformCompiled } = createHarness({ verbose: true }, '/repo');

		resolveConfig([ANGULAR_COMPILER, 'console-stripper']);
		transform(AUTHORED, COMPONENT_ID);
		transformCompiled(EMITTED, COMPONENT_ID);
		buildEnd();

		expect(logger.info).toHaveBeenCalledWith(
			'[console-stripper] stripped 1 console call in 1 project file and 0 console calls in 0 dependency files',
		);
	});

	describe('line directives', () => {
		const PROTECTED_AUTHORED =
			"@Component({ selector: 'app-root' })\nclass AppComponent {\n\tlog(): void {\n\t\t// console-stripper-ignore-next-line\n\t\tconsole.log(1);\n\t\tconsole.log(2);\n\t}\n}\n";
		const EMIT_WITHOUT_COMMENTS =
			'class AppComponent {\n    log() {\n        console.log(1);\n        console.log(2);\n    }\n}\n';
		const EMIT_WITH_COMMENTS =
			'class AppComponent {\n    log() {\n        // console-stripper-ignore-next-line\n        console.log(1);\n        console.log(2);\n    }\n}\n';
		const REMOVED_COMMENTS_WARNING =
			'the Angular compiler removed the ignore comments of src/app/app.component.ts (e.g. "removeComments": true in its tsconfig), so the file was left unstripped';

		it('leaves a module whose line directives the compiler removed unstripped, and warns once about it', () => {
			const { buildStart, resolveConfig, transform, transformCompiled } = createHarness({}, '/repo');
			const WARN = vi.fn();

			resolveConfig([ANGULAR_COMPILER, 'console-stripper']);

			[inEnvironment('client'), inEnvironment('ssr')].forEach((environment) => {
				const CONTEXT = { ...environment, warn: WARN };

				buildStart(CONTEXT);

				expect(transform(PROTECTED_AUTHORED, COMPONENT_ID, CONTEXT)).toBeNull();
				expect(transformCompiled(EMIT_WITHOUT_COMMENTS, COMPONENT_ID, CONTEXT)).toBeNull();
			});

			expect(WARN).toHaveBeenCalledExactlyOnceWith(REMOVED_COMMENTS_WARNING, undefined);
		});

		it('warns through the logger when the hook is called without a plugin context', () => {
			const { logger, resolveConfig, transform, transformCompiled } = createHarness({}, '/repo');

			resolveConfig([ANGULAR_COMPILER, 'console-stripper']);
			transform(PROTECTED_AUTHORED, COMPONENT_ID);

			expect(transformCompiled(EMIT_WITHOUT_COMMENTS, COMPONENT_ID)).toBeNull();
			expect(logger.warn).toHaveBeenCalledExactlyOnceWith(`[console-stripper] ${REMOVED_COMMENTS_WARNING}`);
		});

		it('strips the emit around the directives the compiler kept', () => {
			const { logger, resolveConfig, transform, transformCompiled } = createHarness({}, '/repo');

			resolveConfig([ANGULAR_COMPILER, 'console-stripper']);
			transform(PROTECTED_AUTHORED, COMPONENT_ID);

			expectTransformed(
				transformCompiled(EMIT_WITH_COMMENTS, COMPONENT_ID),
				'class AppComponent {\n    log() {\n        // console-stripper-ignore-next-line\n        console.log(1);\n    }\n}\n',
			);
			expect(logger.warn).not.toHaveBeenCalled();
		});

		it('strips an emit whose authored source held no line directive, or whose directives are not honored', () => {
			const DEFAULTS = createHarness({}, '/repo');
			const WITHOUT_COMMENTS = createHarness({ ignoreComments: false }, '/repo');

			DEFAULTS.resolveConfig([ANGULAR_COMPILER, 'console-stripper']);
			WITHOUT_COMMENTS.resolveConfig([ANGULAR_COMPILER, 'console-stripper']);
			DEFAULTS.transform(AUTHORED, COMPONENT_ID);
			WITHOUT_COMMENTS.transform(PROTECTED_AUTHORED, COMPONENT_ID);

			expectTransformed(DEFAULTS.transformCompiled(EMITTED, COMPONENT_ID), STRIPPED_EMIT);
			expectTransformed(
				WITHOUT_COMMENTS.transformCompiled(EMIT_WITHOUT_COMMENTS, COMPONENT_ID),
				'class AppComponent {\n    log() {\n    }\n}\n',
			);
			expect(DEFAULTS.logger.warn).not.toHaveBeenCalled();
			expect(WITHOUT_COMMENTS.logger.warn).not.toHaveBeenCalled();
		});
	});

	describe('fastCompile order', () => {
		const FAST_COMPILE = '@analogjs/vite-plugin-angular-fast-compile';
		const ORDER_WARNING =
			'[console-stripper] @analogjs/vite-plugin-angular-fast-compile runs before console-stripper, which then reads its emit: a file-level ignore directive written above a type-only import is dropped with it. List consoleStripper() before angular() in the plugins';

		it('warns once per plugin instance when the fastCompile plugin runs first', () => {
			const { buildStart, logger, resolveConfig } = createHarness({}, '/repo');

			resolveConfig([FAST_COMPILE, 'console-stripper']);
			buildStart();
			buildStart(inEnvironment('ssr'));

			expect(logger.warn).toHaveBeenCalledExactlyOnceWith(ORDER_WARNING);
		});

		it('stays silent when the plugin runs before the fastCompile plugin', () => {
			const { buildStart, logger, resolveConfig } = createHarness({}, '/repo');

			resolveConfig(['console-stripper', FAST_COMPILE]);
			buildStart();

			expect(logger.warn).not.toHaveBeenCalled();
		});

		it('reads the order of the environment the hook runs in, on its own logger', () => {
			const { buildStart, logger } = createHarness({}, '/repo');
			const OWN_LOGGER = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
			const PLUGIN = { name: 'console-stripper' };

			buildStart({ environment: { name: 'client', config: { plugins: [PLUGIN, { name: FAST_COMPILE }] } } });
			buildStart({
				environment: { name: 'ssr', config: { logger: OWN_LOGGER, plugins: [{ name: FAST_COMPILE }, PLUGIN] } },
			});

			expect(OWN_LOGGER.warn).toHaveBeenCalledExactlyOnceWith(ORDER_WARNING);
			expect(logger.warn).not.toHaveBeenCalled();
		});
	});
});
