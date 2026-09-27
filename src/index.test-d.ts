import type { ConsoleMethod, Options } from './index';
import type { Plugin, PluginOption, UserConfig } from 'vite';

import { describe, expectTypeOf, it } from 'vitest';

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

describe('Options presets', () => {
	it('accepts every readonly preset and DEFAULT_METHODS directly, without spreading them', () => {
		expectTypeOf(DEFAULT_METHODS).toExtend<Options['methods']>();
		expectTypeOf(DEFAULT_EXTENSIONS).toExtend<Options['extensions']>();
		expectTypeOf(JAVASCRIPT_EXTENSIONS).toExtend<Options['extensions']>();
		expectTypeOf(TYPESCRIPT_EXTENSIONS).toExtend<Options['extensions']>();
		expectTypeOf(JSX_EXTENSIONS).toExtend<Options['extensions']>();
		expectTypeOf(SCRIPT_EXTENSIONS).toExtend<Options['extensions']>();
		expectTypeOf(SVELTE_EXTENSIONS).toExtend<Options['extensions']>();
		expectTypeOf(VUE_EXTENSIONS).toExtend<Options['extensions']>();
		expectTypeOf(ASTRO_EXTENSIONS).toExtend<Options['extensions']>();
		expectTypeOf(HTML_EXTENSIONS).toExtend<Options['extensions']>();

		consoleStripper({ extensions: DEFAULT_EXTENSIONS, methods: DEFAULT_METHODS });
	});

	it('are readonly, so mutating one is a type error', () => {
		// @ts-expect-error -- `JSX_EXTENSIONS` is a readonly array
		// eslint-disable-next-line @typescript-eslint/no-unsafe-call -- the call is a deliberate type error, so its type is unresolved
		JSX_EXTENSIONS.push('foo');

		// @ts-expect-error -- `DEFAULT_METHODS` is a readonly array
		// eslint-disable-next-line @typescript-eslint/no-unsafe-call -- the call is a deliberate type error, so its type is unresolved
		DEFAULT_METHODS.push('log');
	});
});

describe('Options readonly lists', () => {
	it('accepts `as const` arrays for every list option', () => {
		const METHODS = ['log', 'debug'] as const;
		const EXTENSIONS = ['ts', 'svelte'] as const;
		const IGNORE_FOLDERS = ['src/tests', 'fixtures'] as const;
		const IGNORE_FILES = ['Header.svelte'] as const;
		const IGNORE_DEPENDENCIES = ['some-logger', '@scope/pkg'] as const;

		expectTypeOf(METHODS).toExtend<NonNullable<Options['methods']>>();
		expectTypeOf(EXTENSIONS).toExtend<NonNullable<Options['extensions']>>();
		expectTypeOf(IGNORE_FOLDERS).toExtend<NonNullable<Options['ignoreFolders']>>();
		expectTypeOf(IGNORE_FILES).toExtend<NonNullable<Options['ignoreFiles']>>();
		expectTypeOf(IGNORE_DEPENDENCIES).toExtend<NonNullable<Options['ignoreDependencies']>>();

		consoleStripper({
			methods: METHODS,
			extensions: EXTENSIONS,
			ignoreFolders: IGNORE_FOLDERS,
			ignoreFiles: IGNORE_FILES,
			ignoreDependencies: IGNORE_DEPENDENCIES,
		});
	});

	it('still accepts ordinary mutable arrays', () => {
		const METHODS: ConsoleMethod[] = ['log'];
		const EXTENSIONS: string[] = ['ts'];

		expectTypeOf(METHODS).toExtend<Options['methods']>();
		expectTypeOf(EXTENSIONS).toExtend<Options['extensions']>();
	});

	it('still rejects a list holding something other than strings', () => {
		// @ts-expect-error -- `methods` holds console method names only
		consoleStripper({ methods: [42] });

		// @ts-expect-error -- `extensions` holds extension strings only
		consoleStripper({ extensions: [42] });

		// @ts-expect-error -- `ignoreFolders` holds path tokens only
		consoleStripper({ ignoreFolders: [null] });

		// @ts-expect-error -- `ignoreDependencies` holds package names only
		consoleStripper({ ignoreDependencies: [{}] });
	});

	it('rejects a method name the console does not have', () => {
		// @ts-expect-error -- `logs` is not a console method
		consoleStripper({ methods: ['logs'] });
	});
});

describe('ConsoleMethod', () => {
	it('names the console methods as string literals', () => {
		expectTypeOf<'log'>().toExtend<ConsoleMethod>();
		expectTypeOf<'exception'>().toExtend<ConsoleMethod>();
		expectTypeOf<'timeStamp'>().toExtend<ConsoleMethod>();
		expectTypeOf<'logs'>().not.toExtend<ConsoleMethod>();
		expectTypeOf<string>().not.toExtend<ConsoleMethod>();
	});
});

describe('consoleStripper', () => {
	it('returns the source pass and the Angular pass as two Vite plugins, with or without options', () => {
		expectTypeOf(consoleStripper()).toEqualTypeOf<[Plugin, Plugin]>();
		expectTypeOf(consoleStripper({ methods: ['log'] })).toEqualTypeOf<[Plugin, Plugin]>();
	});

	it('fits a Vite `plugins` list as is', () => {
		expectTypeOf(consoleStripper()).toExtend<PluginOption>();
		expectTypeOf([consoleStripper()]).toExtend<NonNullable<UserConfig['plugins']>>();
	});
});
