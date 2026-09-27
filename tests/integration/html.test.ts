import type { BuildOutput } from './build-fixture';

import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
	buildFixture,
	createCallPattern,
	createRecordingLogger,
	getFixtureRoot,
	getParseErrors,
} from './build-fixture';
import consoleStripper from '../../src/index.ts';

/**
 * Returns the code of the entry chunk Vite built from an HTML page's module scripts.
 *
 * @param output - The build output.
 * @param page - The page file name.
 *
 * @returns The chunk code.
 */
function getPageChunkCode(output: BuildOutput, page: string): string {
	const CHUNK = [...output.chunks.values()].find((chunk) => chunk.facadeModuleId?.endsWith(`/${page}`) === true);

	if (CHUNK == null) {
		throw new Error(`getPageChunkCode: no entry chunk for ${page}`);
	}

	return CHUNK.code;
}

/**
 * Cuts one `<script>` block out of a page, from its opening tag to its closing tag.
 *
 * @param page - The page source.
 * @param openingTag - The exact opening tag of the block.
 *
 * @returns The whole block.
 */
function getScriptBlock(page: string, openingTag: string): string {
	const START = page.indexOf(openingTag);

	if (START === -1) {
		throw new Error(`getScriptBlock: ${openingTag} not found`);
	}

	return page.slice(START, page.indexOf('</script>', START) + '</script>'.length);
}

describe('HTML entry build', () => {
	let output: BuildOutput;
	let indexHtml = '';
	let ignoredHtml = '';

	beforeAll(async () => {
		vi.stubEnv('NODE_ENV', 'production');

		output = await buildFixture({
			fixture: 'html',
			input: ['index.html', 'ignored.html'],
			plugins: [consoleStripper()],
		});

		indexHtml = output.assets.get('index.html') ?? '';
		ignoredHtml = output.assets.get('ignored.html') ?? '';
	}, 30_000);

	afterAll(() => {
		vi.unstubAllEnvs();
	});

	describe('page text and non-JavaScript blocks', () => {
		it('leaves the page text, the attribute handler and the title byte-identical', () => {
			expect(indexHtml).toContain('<p>Use console.log(debugValue) to debug</p>');
			expect(indexHtml).toContain(`<button onclick="console.log('ATTRIBUTE_HANDLER')">Click</button>`);
			expect(indexHtml).toContain('<title>console.log(title) stays</title>');
		});

		it.each([
			'<script type="importmap">',
			'<script type="application/ld+json">',
			'<script type="text/template" id="row">',
		])('leaves the %s block byte-identical', (openingTag) => {
			const SOURCE = readFileSync(`${getFixtureRoot('html')}index.html`, 'utf8');

			expect(getScriptBlock(indexHtml, openingTag)).toBe(getScriptBlock(SOURCE, openingTag));
			expect(getScriptBlock(indexHtml, openingTag)).toContain('console.log(');
		});
	});

	describe('classic inline script (kept in the page)', () => {
		it('strips the stripped method and keeps the kept method and the protected call', () => {
			expect(indexHtml).not.toMatch(/STRIP_HTML_CLASSIC/);
			expect(indexHtml).toMatch(createCallPattern('error', 'KEEP_HTML_CLASSIC_ERROR'));
			expect(indexHtml).toMatch(createCallPattern('log', 'PROTECTED_HTML_CLASSIC'));
		});
	});

	describe('module scripts (bundled through html-proxy)', () => {
		it('strips the inline module script and the `src` entry', () => {
			const CODE = getPageChunkCode(output, 'index.html');

			expect(CODE).not.toMatch(/STRIP_HTML/);
			expect(CODE).toMatch(createCallPattern('warn', 'KEEP_HTML_MODULE_WARN'));
			expect(CODE).toMatch(createCallPattern('info', 'KEEP_HTML_ENTRY_INFO'));
			expect(CODE).toContain('window.moduleReady = true');
			expect(CODE).toContain('window.entryReady = true');
		});

		it('keeps the calls the page protected with a JavaScript comment and an HTML-comment range', () => {
			const CODE = getPageChunkCode(output, 'index.html');

			expect(CODE).toMatch(createCallPattern('log', 'PROTECTED_HTML_MODULE_NEXT_LINE'));
			expect(CODE).toMatch(createCallPattern('log', 'PROTECTED_HTML_MODULE_BLOCK'));
		});

		it('emits a chunk that parses', () => {
			expect(getParseErrors(getPageChunkCode(output, 'index.html'))).toEqual([]);
		});
	});

	describe('file-level `<!-- console-stripper-ignore -->` page', () => {
		it('keeps the classic script in the page and the module script through html-proxy', () => {
			expect(ignoredHtml).toMatch(createCallPattern('log', 'PROTECTED_IGNORED_CLASSIC'));
			expect(getPageChunkCode(output, 'ignored.html')).toMatch(createCallPattern('log', 'PROTECTED_IGNORED_MODULE'));
		});
	});
});

describe('HTML entry holding a call that never closes within its script block', () => {
	let page = '';
	let warnings: string[] = [];

	beforeAll(async () => {
		vi.stubEnv('NODE_ENV', 'production');

		const RECORDING = createRecordingLogger();
		const OUTPUT = await buildFixture({
			fixture: 'undelimited',
			input: ['index.html'],
			plugins: [consoleStripper()],
			logger: RECORDING.logger,
		});

		page = OUTPUT.assets.get('index.html') ?? '';
		warnings = RECORDING.warnings.filter((message) => message.includes('console-stripper'));
	}, 30_000);

	afterAll(() => {
		vi.unstubAllEnvs();
	});

	it('keeps the call, strips its neighbor and leaves the page text byte-identical', () => {
		expect(page).toContain("console.log('KEEP_UNDELIMITED_CALL'\n");
		expect(page).not.toMatch(/STRIP_UNDELIMITED_NEIGHBOR/);
		expect(page).toContain('<p>closed here)</p>');
	});

	it('reports the call once through the warnings of the bundler, which names the plugin itself', () => {
		expect(warnings).toEqual([
			'[plugin console-stripper] left 1 console call in place in index.html because its end could not be found',
		]);
	});
});
