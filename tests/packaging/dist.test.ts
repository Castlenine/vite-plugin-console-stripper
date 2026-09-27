import type { Plugin } from 'vite';

import { cp, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';

import {
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
} from '../../src/utilities';

type PluginFactory = (options?: { methods?: string[] }) => Plugin | Plugin[];

type TransformHook = (this: unknown, code: string, id: string) => { code: string } | null;

const BUILD_TIMEOUT_IN_MS = 120_000;

const REPOSITORY_ROOT = join(import.meta.dirname, '..', '..');

// Every named value the package exports, paired with the reference values from `src/utilities.ts`, so the ESM and
// CJS assertions check the exact same list
const NAMED_EXPORTS = {
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
} as const;

const RELATIVE_IMPORT_SPECIFIER_REGEX = /(?:from\s+|import\(\s*)['"](\.\.?\/[^'"]+)['"]/g;

const JSDOC_OPENER_REGEX = /\/\*\*(?!\s*@__PURE__|\s*#__PURE__)/;

const SOURCE = "console.log('drop');\nconsole.error('keep');\n";

const STRIPPED = "console.error('keep');\n";

/**
 * Collects every relative import specifier (`from './foo'` or `import('./foo')`) of a declaration file.
 *
 * @param content - The `.d.ts` or `.d.cts` file content to scan.
 *
 * @returns The relative specifiers found, in file order.
 */
function collectRelativeImportSpecifiers(content: string): string[] {
	return [...content.matchAll(RELATIVE_IMPORT_SPECIFIER_REGEX)].map((match) => match[1] ?? '');
}

/**
 * Picks the source pass, named `console-stripper`, out of what the plugin factory returns.
 *
 * @param factory - The plugin factory loaded from a bundle.
 *
 * @returns The source pass.
 */
function getSourcePass(factory: PluginFactory): Plugin {
	const PLUGIN = [factory()].flat().find((plugin) => plugin.name === 'console-stripper');

	if (!PLUGIN) {
		throw new Error('the plugin factory returned no `console-stripper` plugin');
	}

	return PLUGIN;
}

/**
 * Runs the source pass's `transform` hook on a project script.
 *
 * @param factory - The plugin factory loaded from a bundle.
 *
 * @returns The transform result.
 */
function transformWith(factory: PluginFactory): { code: string } | null {
	const TRANSFORM = getSourcePass(factory).transform as TransformHook;

	return TRANSFORM.call(undefined, SOURCE, '/repo/src/app.ts');
}

describe('dist/ shape', () => {
	// `vite-plugin-dts` writes the declarations into `<root>/dist` whatever `build.outDir` says, so the build runs on a
	// copy of the package inside a temp directory, keeping the repository's own `dist/` untouched
	let buildRoot = '';
	let outDir = '';

	beforeAll(async () => {
		buildRoot = await mkdtemp(join(tmpdir(), 'vite-plugin-console-stripper-dist-'));
		outDir = join(buildRoot, 'dist');

		await Promise.all(
			['src', 'vite.config.ts', 'tsconfig.json', 'package.json'].map((entry) =>
				cp(join(REPOSITORY_ROOT, entry), join(buildRoot, entry), { recursive: true }),
			),
		);
		await symlink(join(REPOSITORY_ROOT, 'node_modules'), join(buildRoot, 'node_modules'), 'dir');

		await build({
			root: buildRoot,
			configFile: join(buildRoot, 'vite.config.ts'),
			logLevel: 'silent',
		});
	}, BUILD_TIMEOUT_IN_MS);

	afterAll(async () => {
		if (buildRoot !== '') {
			await rm(buildRoot, { recursive: true, force: true });
		}
	});

	it('exports a working ESM entry with every named export, the presets frozen', async () => {
		const MODULE = (await import(pathToFileURL(join(outDir, 'index.js')).href)) as Record<string, unknown> & {
			default: PluginFactory;
		};

		expect(typeof MODULE.default).toBe('function');

		for (const [name, value] of Object.entries(NAMED_EXPORTS)) {
			expect(MODULE[name]).toStrictEqual(value);
			expect(Object.isFrozen(MODULE[name])).toBe(true);
		}

		expect(getSourcePass(MODULE.default)).toMatchObject({ name: 'console-stripper', apply: 'build', enforce: 'pre' });
		expect(transformWith(MODULE.default)?.code).toBe(STRIPPED);
	});

	it('exports a CJS entry whose require() is the plugin itself, carrying every named export', () => {
		const REQUIRE_FROM_TEST = createRequire(import.meta.url);
		const MODULE = REQUIRE_FROM_TEST(join(outDir, 'index.cjs')) as PluginFactory & Record<string, unknown>;

		expect(typeof MODULE).toBe('function');
		expect(MODULE.default).toBe(MODULE);

		for (const [name, value] of Object.entries(NAMED_EXPORTS)) {
			expect(MODULE[name]).toStrictEqual(value);
		}

		expect(transformWith(MODULE)?.code).toBe(STRIPPED);
	});

	it('emits the two bundles and the declarations only: no sourcemap, no type-test declaration', async () => {
		const FILES = (await readdir(outDir)).sort();

		expect(FILES).toStrictEqual([
			'index.cjs',
			'index.d.cts',
			'index.d.ts',
			'index.js',
			'sourcemap.d.cts',
			'sourcemap.d.ts',
			'types.d.cts',
			'types.d.ts',
			'utilities.d.cts',
			'utilities.d.ts',
		]);
		expect(FILES.filter((file) => file.endsWith('.map') || file.includes('.test-d.'))).toStrictEqual([]);
	});

	it('drops JSDoc from the bundles while keeping the pure annotations and the declarations JSDoc', async () => {
		const DECLARATION = await readFile(join(outDir, 'index.d.ts'), 'utf8');

		for (const bundle of ['index.js', 'index.cjs']) {
			const CONTENT = await readFile(join(outDir, bundle), 'utf8');

			expect(CONTENT).not.toMatch(JSDOC_OPENER_REGEX);
			expect(CONTENT).not.toContain('@param');
			expect(CONTENT).toContain('/* @__PURE__ */');
		}

		expect(DECLARATION).toContain('@param');
	});

	it('emits an ESM declaration exporting the default plugin, the types and every named export', async () => {
		const CONTENT = await readFile(join(outDir, 'index.d.ts'), 'utf8');

		expect(CONTENT).toContain('export default consoleStripper;');
		expect(CONTENT).toMatch(/export type \{ ConsoleMethod, Options \} from '\.\/types\.js';/);

		for (const name of Object.keys(NAMED_EXPORTS)) {
			expect(CONTENT).toContain(name);
		}
	});

	it('emits the CJS declaration with the export = namespace-merge shape', async () => {
		const CONTENT = await readFile(join(outDir, 'index.d.cts'), 'utf8');

		expect(CONTENT).toContain('export = consoleStripper;');
		expect(CONTENT).toContain('readonly default: ConsoleStripper;');
		expect(CONTENT).toContain('declare namespace consoleStripper');
		expect(CONTENT).toContain('export type ConsoleMethod = PluginConsoleMethod;');
		expect(CONTENT).toContain('export type Options = PluginOptions;');
		expect(CONTENT).toMatch(/from\s+['"]\.\/types\.cjs['"]/);
	});

	it.each([
		['.d.ts', '.js'],
		['.d.cts', '.cjs'],
	])('rewrites every relative import of the %s declarations to %s', async (declarationExtension, extension) => {
		const FILES = (await readdir(outDir)).filter((file) => file.endsWith(declarationExtension));
		const SPECIFIERS = await Promise.all(
			FILES.map(async (file) => collectRelativeImportSpecifiers(await readFile(join(outDir, file), 'utf8'))),
		);
		const ALL_SPECIFIERS = SPECIFIERS.flat();

		expect(ALL_SPECIFIERS.length).toBeGreaterThan(0);
		expect(ALL_SPECIFIERS.filter((specifier) => !specifier.endsWith(extension))).toStrictEqual([]);
	});
});
