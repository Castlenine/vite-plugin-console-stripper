import type { PluginOption } from 'vite';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import react from '@vitejs/plugin-react';

import { buildFixture, createCallPattern, getAllChunkCode, getParseErrors } from './build-fixture';
import consoleStripper from '../../src/index.ts';

// Both plugins may read the raw source first, so their registration order must not change the outcome
const PLUGIN_ORDERS: readonly { name: string; createPlugins: () => PluginOption[] }[] = [
	{ name: '[react(), consoleStripper()]', createPlugins: () => [react(), consoleStripper()] },
	{ name: '[consoleStripper(), react()]', createPlugins: () => [consoleStripper(), react()] },
];

describe.each(PLUGIN_ORDERS)('React build (`.jsx` + `.tsx`) with $name', ({ createPlugins }) => {
	let code = '';

	beforeAll(async () => {
		vi.stubEnv('NODE_ENV', 'production');

		code = getAllChunkCode(await buildFixture({ fixture: 'react', entry: 'main.js', plugins: createPlugins() }));
	}, 30_000);

	afterAll(() => {
		vi.unstubAllEnvs();
	});

	it('strips the stripped methods from effects, attribute handlers and generic arrows', () => {
		expect(code).not.toMatch(/STRIP_(REACT|TSX)/);
	});

	it('keeps the kept methods, including one rendered as a JSX child, and the protected call', () => {
		expect(code).toMatch(createCallPattern('warn', 'KEEP_REACT_EFFECT_WARN'));
		expect(code).toMatch(createCallPattern('info', 'KEEP_TSX_INFO'));
		expect(code).toMatch(/console\.clear\(\)/);
		expect(code).toMatch(createCallPattern('log', 'PROTECTED_REACT_EFFECT'));
	});

	it('leaves the JSX text byte-identical', () => {
		expect(code).toContain('Use console.log(debugValue) to debug');
		expect(code).toContain('Call console.log(label) here: ');
	});

	it('emits chunks that parse', () => {
		expect(getParseErrors(code)).toEqual([]);
	});
});
