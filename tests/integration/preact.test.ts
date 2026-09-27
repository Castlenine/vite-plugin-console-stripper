import type { PluginOption } from 'vite';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import preact from '@preact/preset-vite';

import { buildFixture, createCallPattern, getAllChunkCode, getParseErrors } from './build-fixture';
import consoleStripper from '../../src/index.ts';

// Both plugins may read the raw source first, so their registration order must not change the outcome
const PLUGIN_ORDERS: readonly { name: string; createPlugins: () => PluginOption[] }[] = [
	{ name: '[preact(), consoleStripper()]', createPlugins: () => [preact(), consoleStripper()] },
	{ name: '[consoleStripper(), preact()]', createPlugins: () => [consoleStripper(), preact()] },
];

describe.each(PLUGIN_ORDERS)('Preact build with $name', ({ createPlugins }) => {
	let code = '';

	beforeAll(async () => {
		vi.stubEnv('NODE_ENV', 'production');

		code = getAllChunkCode(await buildFixture({ fixture: 'preact', entry: 'main.js', plugins: createPlugins() }));
	}, 30_000);

	afterAll(() => {
		vi.unstubAllEnvs();
	});

	it('strips the stripped methods from the effect and the attribute handler', () => {
		expect(code).not.toMatch(/STRIP_PREACT/);
	});

	it('keeps the kept method and the protected call', () => {
		expect(code).toMatch(createCallPattern('error', 'KEEP_PREACT_EFFECT_ERROR'));
		expect(code).toMatch(createCallPattern('log', 'PROTECTED_PREACT_EFFECT'));
	});

	it('leaves the JSX text byte-identical', () => {
		expect(code).toContain('Use console.log(debugValue) to debug');
	});

	it('emits chunks that parse', () => {
		expect(getParseErrors(code)).toEqual([]);
	});
});
