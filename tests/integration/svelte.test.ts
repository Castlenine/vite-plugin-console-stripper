import type { BuildOutput } from './build-fixture';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { svelte } from '@sveltejs/vite-plugin-svelte';

import { buildFixture, createCallPattern, getAllChunkCode, getParseErrors } from './build-fixture';
import consoleStripper from '../../src/index.ts';

describe('Svelte 5 build', () => {
	let code = '';
	let output: BuildOutput;

	beforeAll(async () => {
		vi.stubEnv('NODE_ENV', 'production');

		output = await buildFixture({
			fixture: 'svelte',
			entry: 'main.js',
			plugins: [svelte({ configFile: false }), consoleStripper()],
		});

		code = getAllChunkCode(output);
	}, 30_000);

	afterAll(() => {
		vi.unstubAllEnvs();
	});

	it('strips every stripped method from the module script, the instance script and the template', () => {
		expect(code).not.toMatch(/STRIP_SVELTE/);
	});

	it('keeps the kept methods and the protected call', () => {
		expect(code).toMatch(createCallPattern('warn', 'KEEP_SVELTE_MODULE_WARN'));
		expect(code).toMatch(createCallPattern('error', 'KEEP_SVELTE_INSTANCE_ERROR'));
		expect(code).toMatch(createCallPattern('info', 'KEEP_SVELTE_TEMPLATE_INFO'));
		expect(code).toMatch(createCallPattern('log', 'PROTECTED_SVELTE_INSTANCE'));
	});

	it('leaves the template text and the `{@html}` string byte-identical', () => {
		expect(code).toContain('<p>Use console.log(debugValue) to debug</p>');
		expect(code).toContain('<b>bold console.log(markup)</b>');
	});

	it('emits a single chunk that parses', () => {
		expect(output.chunks.size).toBe(1);
		expect(getParseErrors(code)).toEqual([]);
	});
});
