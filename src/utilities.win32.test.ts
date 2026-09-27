import type { Logger, ResolvedConfig } from 'vite';
import type * as NodePath from 'node:path';
import type { Options } from './types';

import { describe, expect, it, vi } from 'vitest';

// `utilities.ts` imports `{ relative, sep }` from `node:path`; the mock serves the `win32` implementation under every
// name, so each path operation behaves as it would on Windows whatever platform the suite runs on
vi.mock('node:path', async (importOriginal) => {
	const ACTUAL = await importOriginal<typeof NodePath>();

	return { ...ACTUAL.win32, default: ACTUAL.win32 };
});

const { createIgnoreMatcher, getOptions, getOwningPackage, getProjectIgnoredPaths, isDependencyPath, toRelativePath } =
	await import('./utilities');
const { default: consoleStripper } = await import('./index');

type TransformHook = (this: unknown, code: string, id: string) => null | { code: string };

const SOURCE = "console.log('drop');\nconsole.error('keep');\n";

const STRIPPED = "console.error('keep');\n";

/**
 * Builds the project-file ignore matcher of a plugin configured with the given options.
 *
 * @param options - The ignore-related plugin options under test.
 *
 * @returns A matcher reporting whether a path relative to the Vite root is ignored.
 */
function createProjectIgnoreMatcher(options: Options = {}) {
	return createIgnoreMatcher(getProjectIgnoredPaths(getOptions(options)));
}

/**
 * Creates the plugin with a resolved Windows root and returns the `transform` hook of its source pass.
 *
 * @param options - Plugin options.
 * @param root - The Windows-style Vite root.
 *
 * @returns A function running the transform hook on a source and a module id.
 */
function createWindowsTransform(options: Options, root: string): (code: string, id: string) => null | { code: string } {
	const PLUGINS = [consoleStripper(options)].flat();
	const PLUGIN = PLUGINS.find((plugin) => plugin.name === 'console-stripper');

	if (!PLUGIN) {
		throw new Error('the plugin factory returned no `console-stripper` plugin');
	}

	const LOGGER = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
	const CONFIG_RESOLVED = PLUGIN.configResolved as (config: ResolvedConfig) => void;
	const TRANSFORM = PLUGIN.transform as TransformHook;

	CONFIG_RESOLVED({ root, logger: LOGGER, plugins: PLUGINS } as unknown as ResolvedConfig);

	return (code, id) => TRANSFORM.call(undefined, code, id);
}

describe('toRelativePath on Windows', () => {
	it('converts a module under a drive-letter root to a POSIX-separated relative path', () => {
		expect(toRelativePath('C:\\r\\src\\a.ts', 'C:\\r')).toBe('src/a.ts');
	});

	it('compares drive letters case-insensitively', () => {
		expect(toRelativePath('c:\\r\\src\\a.ts', 'C:\\r')).toBe('src/a.ts');
	});

	it('strips the query and hash suffixes before computing the relative path', () => {
		expect(toRelativePath('C:\\r\\src\\App.vue?vue&type=script&lang.ts', 'C:\\r')).toBe('src/App.vue');
		expect(toRelativePath('C:\\r\\src\\a.ts#hash', 'C:\\r')).toBe('src/a.ts');
	});

	it('keeps an absolute, POSIX-separated path when the drive letters differ', () => {
		// `path.win32.relative` cannot express a cross-drive path as a relative one, so it returns the target unchanged
		expect(toRelativePath('D:\\x\\a.ts', 'C:\\r')).toBe('D:/x/a.ts');
	});

	it('resolves a module under a UNC root', () => {
		expect(toRelativePath('\\\\server\\share\\r\\src\\a.ts', '\\\\server\\share\\r')).toBe('src/a.ts');
	});

	it('climbs out of the root with POSIX-separated parent segments', () => {
		expect(toRelativePath('C:\\node_modules\\x\\a.js', 'C:\\r')).toBe('../node_modules/x/a.js');
	});
});

describe('ignore matching on Windows paths', () => {
	it('does not ignore a cross-drive module with the default tokens', () => {
		expect(createProjectIgnoreMatcher()(toRelativePath('D:\\x\\a.ts', 'C:\\r'))).toBe(false);
	});

	it('matches a default token under a Windows root', () => {
		expect(createProjectIgnoreMatcher()(toRelativePath('C:\\r\\node_modules\\x\\a.js', 'C:\\r'))).toBe(true);
	});

	it('matches a configured folder token written with backslashes', () => {
		const IS_IGNORED = createProjectIgnoreMatcher({ ignoreFolders: ['.\\src\\tests\\'] });

		expect(IS_IGNORED(toRelativePath('C:\\r\\src\\tests\\a.ts', 'C:\\r'))).toBe(true);
		expect(IS_IGNORED(toRelativePath('C:\\r\\src\\app.ts', 'C:\\r'))).toBe(false);
	});

	it('matches a configured file token written with backslashes under a UNC root', () => {
		const IS_IGNORED = createProjectIgnoreMatcher({ ignoreFiles: ['src\\debug.ts'] });

		expect(IS_IGNORED(toRelativePath('\\\\server\\share\\r\\src\\debug.ts', '\\\\server\\share\\r'))).toBe(true);
	});
});

describe('dependency detection on Windows paths', () => {
	it.each([
		['C:\\r\\node_modules\\pkg\\index.js', 'pkg'],
		['C:\\r\\node_modules\\@scope\\pkg\\dist\\index.js', '@scope/pkg'],
		['C:\\r\\node_modules\\.pnpm\\a@1.0.0\\node_modules\\a\\index.js', 'a'],
		['\\\\server\\share\\r\\node_modules\\pkg\\index.js?v=1', 'pkg'],
		['D:\\store\\node_modules\\b\\node_modules\\c\\x.js', 'c'],
	])('resolves the package owning %s', (id, expected) => {
		expect(isDependencyPath(id)).toBe(true);
		expect(getOwningPackage(id)).toBe(expected);
	});

	it('reports no owner for a project module', () => {
		expect(isDependencyPath('C:\\r\\src\\a.ts')).toBe(false);
		expect(getOwningPackage('C:\\r\\src\\a.ts')).toBeNull();
	});
});

describe('consoleStripper on a Windows root and id', () => {
	it('strips a module named with a drive letter', () => {
		expect(createWindowsTransform({}, 'C:\\r')(SOURCE, 'C:\\r\\src\\app.ts')?.code).toBe(STRIPPED);
	});

	it('strips a module under a UNC root', () => {
		const TRANSFORM = createWindowsTransform({}, '\\\\server\\share\\r');

		expect(TRANSFORM(SOURCE, '\\\\server\\share\\r\\src\\app.ts')?.code).toBe(STRIPPED);
	});

	it('strips a cross-drive module, which no default token names', () => {
		expect(createWindowsTransform({}, 'C:\\r')(SOURCE, 'D:\\shared\\app.ts')?.code).toBe(STRIPPED);
	});

	it('skips a module under an ignored folder written with backslashes', () => {
		const TRANSFORM = createWindowsTransform({ ignoreFolders: ['src\\tests'] }, 'C:\\r');

		expect(TRANSFORM(SOURCE, 'C:\\r\\src\\tests\\a.ts')).toBeNull();
		expect(TRANSFORM(SOURCE, 'C:\\r\\src\\app.ts')?.code).toBe(STRIPPED);
	});

	it('strips a dependency and skips one ignored by name', () => {
		const TRANSFORM = createWindowsTransform({ ignoreDependencies: ['kept'] }, 'C:\\r');

		expect(TRANSFORM(SOURCE, 'C:\\r\\node_modules\\pkg\\index.js')?.code).toBe(STRIPPED);
		expect(TRANSFORM(SOURCE, 'C:\\r\\node_modules\\kept\\index.js')).toBeNull();
	});
});
