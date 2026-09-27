import type { PluginOption } from 'vite';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';

import { buildFixture, createCallPattern, getAllChunkCode, getParseErrors } from './build-fixture';
import consoleStripper from '../../src/index.ts';

// A configured preprocessor turns on `vite-plugin-svelte:preprocess`, which is `enforce: 'pre'` like the stripper, so
// the plugin order decides which of the two reads the raw source. `script: true` makes the stripper, when listed
// second, receive the oxc-transpiled `<script lang="ts">`; oxc keeps the line comments above runtime code.
const SCRIPT_PREPROCESSOR_FIRST_ORDER_NAME =
	'[svelte({ preprocess: vitePreprocess({ script: true }) }), consoleStripper()]';

const PLUGIN_ORDERS: readonly { name: string; createPlugins: () => PluginOption[] }[] = [
	{
		name: '[consoleStripper(), svelte({ preprocess: vitePreprocess() })]',
		createPlugins: () => [consoleStripper(), svelte({ configFile: false, preprocess: vitePreprocess() })],
	},
	{
		name: '[svelte({ preprocess: vitePreprocess() }), consoleStripper()]',
		createPlugins: () => [svelte({ configFile: false, preprocess: vitePreprocess() }), consoleStripper()],
	},
	{
		name: '[consoleStripper(), svelte({ preprocess: vitePreprocess({ script: true }) })]',
		createPlugins: () => [
			consoleStripper(),
			svelte({ configFile: false, preprocess: vitePreprocess({ script: true }) }),
		],
	},
	{
		name: SCRIPT_PREPROCESSOR_FIRST_ORDER_NAME,
		createPlugins: () => [
			svelte({ configFile: false, preprocess: vitePreprocess({ script: true }) }),
			consoleStripper(),
		],
	},
];

describe.each(PLUGIN_ORDERS)('Svelte 5 build with a preprocessor and $name', ({ createPlugins }) => {
	let code = '';

	beforeAll(async () => {
		vi.stubEnv('NODE_ENV', 'production');

		code = getAllChunkCode(
			await buildFixture({ fixture: 'svelte-preprocess', entry: 'main.js', plugins: createPlugins() }),
		);
	}, 30_000);

	afterAll(() => {
		vi.unstubAllEnvs();
	});

	it('strips the stripped method from the TypeScript instance script', () => {
		expect(code).not.toMatch(/STRIP_SVELTE_PREPROCESS/);
	});

	it('keeps the kept method', () => {
		expect(code).toMatch(createCallPattern('warn', 'KEEP_SVELTE_PREPROCESS_WARN'));
	});

	it('keeps the calls protected by the next-line and the start/end ignore directives', () => {
		expect(code).toMatch(createCallPattern('log', 'PROTECTED_SVELTE_PREPROCESS_NEXT_LINE'));
		expect(code).toMatch(createCallPattern('log', 'PROTECTED_SVELTE_PREPROCESS_RANGE'));
	});

	it('emits chunks that parse', () => {
		expect(getParseErrors(code)).toEqual([]);
	});
});

// oxc erases a comment attached to type-only code along with it, so a file-level directive sitting above an
// `import type` reaches the stripper only when the stripper reads the source before the script preprocessor
const FILE_DIRECTIVE_KEEPING_ORDERS = PLUGIN_ORDERS.filter(({ name }) => name !== SCRIPT_PREPROCESSOR_FIRST_ORDER_NAME);

describe.each(FILE_DIRECTIVE_KEEPING_ORDERS)(
	'Svelte 5 build of a file-ignored component whose directive precedes an `import type`, with $name',
	({ createPlugins }) => {
		let code = '';

		beforeAll(async () => {
			vi.stubEnv('NODE_ENV', 'production');

			code = getAllChunkCode(
				await buildFixture({ fixture: 'svelte-preprocess', entry: 'file-ignored.js', plugins: createPlugins() }),
			);
		}, 30_000);

		afterAll(() => {
			vi.unstubAllEnvs();
		});

		it('keeps every call of the file-ignored component', () => {
			expect(code).toMatch(createCallPattern('log', 'FILE_IGNORED_SVELTE_PREPROCESS'));
		});

		it('emits chunks that parse', () => {
			expect(getParseErrors(code)).toEqual([]);
		});
	},
);

describe(`Svelte 5 build of a file-ignored component whose directive precedes an \`import type\`, with ${SCRIPT_PREPROCESSOR_FIRST_ORDER_NAME}`, () => {
	let code = '';

	beforeAll(async () => {
		vi.stubEnv('NODE_ENV', 'production');

		code = getAllChunkCode(
			await buildFixture({
				fixture: 'svelte-preprocess',
				entry: 'file-ignored.js',
				plugins: [svelte({ configFile: false, preprocess: vitePreprocess({ script: true }) }), consoleStripper()],
			}),
		);
	}, 30_000);

	afterAll(() => {
		vi.unstubAllEnvs();
	});

	it('drops the file-level directive erased with the `import type` by the script preprocessor, so the call is stripped', () => {
		expect(code).not.toMatch(/FILE_IGNORED_SVELTE_PREPROCESS/);
	});

	it('emits chunks that parse', () => {
		expect(getParseErrors(code)).toEqual([]);
	});
});
