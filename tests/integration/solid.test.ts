import type { PluginOption } from 'vite';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import solid from 'vite-plugin-solid';

import { buildFixture, createCallPattern, getAllChunkCode, getParseErrors } from './build-fixture';
import consoleStripper from '../../src/index.ts';

// Both plugins are `enforce: 'pre'`, so their registration order decides which one reads the raw source
const PLUGIN_ORDERS: readonly { name: string; createPlugins: () => PluginOption[] }[] = [
	{ name: '[solid(), consoleStripper()]', createPlugins: () => [solid(), consoleStripper()] },
	{ name: '[consoleStripper(), solid()]', createPlugins: () => [consoleStripper(), solid()] },
];

describe.each(PLUGIN_ORDERS)('Solid build with $name', ({ createPlugins }) => {
	let code = '';

	beforeAll(async () => {
		vi.stubEnv('NODE_ENV', 'production');

		code = getAllChunkCode(await buildFixture({ fixture: 'solid', entry: 'main.js', plugins: createPlugins() }));
	}, 30_000);

	afterAll(() => {
		vi.unstubAllEnvs();
	});

	it('strips the stripped methods from the lifecycle hook, the attribute handler and the generic arrow', () => {
		expect(code).not.toMatch(/STRIP_SOLID/);
	});

	it('keeps the kept methods and the protected call', () => {
		expect(code).toMatch(createCallPattern('warn', 'KEEP_SOLID_MOUNT_WARN'));
		expect(code).toMatch(createCallPattern('info', 'KEEP_SOLID_TEMPLATE_INFO'));
		expect(code).toMatch(createCallPattern('log', 'PROTECTED_SOLID_MOUNT'));
	});

	it('leaves the JSX text byte-identical', () => {
		expect(code).toContain('Use console.log(debugValue) to debug');
	});

	it('emits chunks that parse', () => {
		expect(getParseErrors(code)).toEqual([]);
	});
});
