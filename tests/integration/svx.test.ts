import type { Plugin } from 'vite';

import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildFixture, createCallPattern, getAllChunkCode, getFixtureRoot, getParseErrors } from './build-fixture';
import consoleStripper, { DEFAULT_EXTENSIONS } from '../../src/index.ts';

const FRONT_MATTER_REGEX = /^---\n[\s\S]*?\n---\n/;
const SCRIPT_BLOCK_REGEX = /<script>([\s\S]*?)<\/script>/;

/**
 * Creates a minimal `.svx` loader: a normal-order plugin, so it receives the page after the `enforce: 'pre'` stripper,
 * turning the front matter and the Markdown body into string exports and the `<script>` body into module code.
 *
 * @param received - Collects the source the loader was handed.
 *
 * @returns The loader plugin.
 */
function createSvxLoader(received: string[]): Plugin {
	return {
		name: 'test-svx-loader',
		transform(code, id) {
			if (!id.endsWith('.svx')) {
				return null;
			}

			received.push(code);

			const FRONT_MATTER = FRONT_MATTER_REGEX.exec(code)?.[0] ?? '';
			const SCRIPT = SCRIPT_BLOCK_REGEX.exec(code);
			const BODY = code.slice((SCRIPT?.index ?? 0) + (SCRIPT?.[0].length ?? 0));

			return `export const frontMatter = ${JSON.stringify(FRONT_MATTER)};\n${SCRIPT?.[1] ?? ''}\nexport const body = ${JSON.stringify(BODY)};\n`;
		},
	};
}

describe('Markup fallback: `.svx` added to `extensions`', () => {
	const RECEIVED: string[] = [];
	const SOURCE = readFileSync(`${getFixtureRoot('svx')}page.svx`, 'utf8');
	let code = '';

	beforeAll(async () => {
		vi.stubEnv('NODE_ENV', 'production');

		code = getAllChunkCode(
			await buildFixture({
				fixture: 'svx',
				entry: 'main.js',
				plugins: [consoleStripper({ extensions: [...DEFAULT_EXTENSIONS, 'svx'] }), createSvxLoader(RECEIVED)],
			}),
		);
	}, 30_000);

	afterAll(() => {
		vi.unstubAllEnvs();
	});

	it('hands the next plugin the page with only the `<script>` statement removed', () => {
		expect(RECEIVED).toEqual([SOURCE.replace("\tconsole.log('STRIP_SVX_SCRIPT');\n", '')]);
	});

	it('leaves the front matter and the Markdown text byte-identical', () => {
		expect(FRONT_MATTER_REGEX.exec(RECEIVED[0] ?? '')?.[0]).toBe("---\ntitle: console.log('FRONT_MATTER_TEXT')\n---\n");
		expect(RECEIVED[0]).toContain('# Call console.log(text) to debug\n');
	});

	it('bundles the stripped script into a chunk that parses', () => {
		expect(code).not.toMatch(/STRIP_SVX/);
		expect(code).toMatch(createCallPattern('warn', 'KEEP_SVX_SCRIPT_WARN'));
		expect(getParseErrors(code)).toEqual([]);
	});
});
