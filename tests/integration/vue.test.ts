import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import vue from '@vitejs/plugin-vue';

import { buildFixture, createCallPattern, getAllChunkCode, getParseErrors } from './build-fixture';
import consoleStripper from '../../src/index.ts';

describe('Vue build', () => {
	let code = '';
	const TRANSFORMED_IDS: string[] = [];

	beforeAll(async () => {
		vi.stubEnv('NODE_ENV', 'production');

		const OUTPUT = await buildFixture({
			fixture: 'vue',
			entry: 'main.js',
			plugins: [
				vue(),
				consoleStripper(),
				{
					name: 'record-vue-ids',
					transform(_code, id) {
						if (id.includes('.vue')) {
							TRANSFORMED_IDS.push(id.slice(id.lastIndexOf('/') + 1));
						}
					},
				},
			],
		});

		code = getAllChunkCode(OUTPUT);
	}, 30_000);

	afterAll(() => {
		vi.unstubAllEnvs();
	});

	it('compiles `<script setup lang="ts">` through the extracted script sub-request', () => {
		expect(TRANSFORMED_IDS).toContain('SetupTs.vue?vue&type=script&setup=true&lang.ts');
	});

	it('strips the stripped methods from both script blocks, the plain SFC and the event handlers', () => {
		expect(code).not.toMatch(/STRIP_VUE/);
	});

	it('keeps the kept methods and the protected calls', () => {
		expect(code).toMatch(createCallPattern('warn', 'KEEP_VUE_SETUP_WARN'));
		expect(code).toMatch(createCallPattern('info', 'KEEP_VUE_TEMPLATE_INFO'));
		expect(code).toMatch(createCallPattern('error', 'KEEP_VUE_PLAIN_ERROR'));
		expect(code).toMatch(createCallPattern('log', 'PROTECTED_VUE_SETUP'));
		expect(code).toMatch(createCallPattern('debug', 'PROTECTED_VUE_PLAIN'));
	});

	it('leaves the template text byte-identical, backticks included', () => {
		expect(code).toContain('Type `console.log(value)` in a');
		expect(code).toContain('Plain console.log(text) stays');
	});

	it('emits chunks that parse', () => {
		expect(getParseErrors(code)).toEqual([]);
	});
});
