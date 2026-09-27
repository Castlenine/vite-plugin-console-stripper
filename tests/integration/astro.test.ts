import type { MockInstance } from 'vitest';

import { join } from 'node:path';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'astro';

import consoleStripper from '../../src/index.ts';
import { createCallPattern, getFixtureRoot, getParseErrors } from './build-fixture';

/**
 * The markers the fixture's own console calls log
 */
const FIXTURE_MARKER_REGEX = /^(KEEP|STRIP|PROTECTED)_/;

/**
 * Lists the first arguments a console spy was called with.
 *
 * @param spy - The console spy.
 *
 * @returns The first argument of every call.
 */
function getLoggedMarkers(spy: MockInstance): unknown[] {
	return spy.mock.calls.map((call) => call[0] as unknown);
}

describe('Astro build', () => {
	// Astro compares module ids with real paths: a `/tmp` → `/private/tmp` symlink breaks the build on macOS
	const ROOT = realpathSync(getFixtureRoot('astro'));
	const OUT_DIRECTORY = realpathSync(mkdtempSync(join(tmpdir(), 'console-stripper-astro-')));
	let html = '';
	let script = '';
	let loggedMarkers: unknown[] = [];
	let warnedMarkers: unknown[] = [];

	beforeAll(async () => {
		vi.stubEnv('NODE_ENV', 'production');
		vi.stubEnv('ASTRO_TELEMETRY_DISABLED', '1');

		// The frontmatter and the template expressions run in this process while Astro prerenders the page. The calls
		// are copied right after the build, before the spy state can change between hooks and tests
		const LOG_SPY = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const WARN_SPY = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		// A static build writes its prerender chunks to `.astro/` under the working directory whenever `outDir` lies
		// outside it: pointing the working directory at the temporary folder keeps them out of the repository root
		const CWD_SPY = vi.spyOn(process, 'cwd').mockReturnValue(OUT_DIRECTORY);

		try {
			await build({
				root: ROOT,
				configFile: false,
				logLevel: 'silent',
				outDir: join(OUT_DIRECTORY, 'dist'),
				// Keeps Astro's and Vite's caches out of the fixture folder
				cacheDir: join(OUT_DIRECTORY, 'astro-cache'),
				vite: {
					plugins: [consoleStripper()],
					cacheDir: join(OUT_DIRECTORY, 'vite-cache'),
					// Astro inlines a processed `<script>` below the inline limit into the page; `0` keeps it in `_astro/`
					build: { assetsInlineLimit: 0 },
				},
			});
		} finally {
			loggedMarkers = getLoggedMarkers(LOG_SPY);
			warnedMarkers = getLoggedMarkers(WARN_SPY);
			LOG_SPY.mockRestore();
			WARN_SPY.mockRestore();
			CWD_SPY.mockRestore();
		}

		html = readFileSync(join(OUT_DIRECTORY, 'dist', 'index.html'), 'utf8');

		const ASSETS_DIRECTORY = join(OUT_DIRECTORY, 'dist', '_astro');

		script = readdirSync(ASSETS_DIRECTORY)
			.filter((fileName) => fileName.endsWith('.js'))
			.map((fileName) => readFileSync(join(ASSETS_DIRECTORY, fileName), 'utf8'))
			.join('\n');
	}, 60_000);

	afterAll(() => {
		vi.unstubAllEnvs();
		rmSync(OUT_DIRECTORY, { recursive: true, force: true });
	});

	describe('frontmatter and template (run at prerender)', () => {
		it('removes the stripped frontmatter call and turns the template call into `void 0`', () => {
			expect(loggedMarkers).not.toContain('STRIP_ASTRO_FRONTMATTER');
			expect(loggedMarkers).not.toContain('STRIP_ASTRO_TEMPLATE');
			expect(html).toContain('<p data-strip-template></p>');
		});

		it('keeps the kept frontmatter method running', () => {
			// Astro and Vite may warn through the same console while building: only the fixture's own markers count
			expect(warnedMarkers.filter((marker) => typeof marker === 'string' && FIXTURE_MARKER_REGEX.test(marker))).toEqual(
				['KEEP_ASTRO_FRONTMATTER_WARN'],
			);
		});

		// `astro:build` compiles the component before this plugin reads it and drops every frontmatter and template
		// expression comment, so these directives are only found in the original source its source map carries
		it('keeps the frontmatter calls protected by `console-stripper-ignore-next-line` and `-start` / `-end`', () => {
			expect(loggedMarkers).toContain('PROTECTED_ASTRO_FRONTMATTER');
			expect(loggedMarkers).toContain('PROTECTED_ASTRO_FRONTMATTER_BLOCK');
		});

		it('keeps the template call protected by a `{/* console-stripper-ignore-next-line */}` expression', () => {
			expect(loggedMarkers).toContain('PROTECTED_ASTRO_TEMPLATE');
		});
	});

	describe('bundled `<script>` (the `?astro&type=script` sub-request)', () => {
		it('strips the stripped methods, keeps the kept method and emits a chunk that parses', () => {
			expect(script).not.toMatch(/STRIP_ASTRO/);
			expect(script).toMatch(createCallPattern('error', 'KEEP_ASTRO_SCRIPT_ERROR'));
			expect(getParseErrors(script)).toEqual([]);
		});
	});

	describe('page HTML', () => {
		it('leaves the page text byte-identical', () => {
			expect(html).toContain('<p>Use console.log(text) to debug</p>');
		});

		it('keeps the kept method of the `is:inline` script', () => {
			expect(html).toMatch(createCallPattern('info', 'KEEP_ASTRO_INLINE_INFO'));
		});

		// Once compiled, an `is:inline` script is text of a `$$render` template literal, escapes included (`\``, `\${`,
		// `\\`); its stripped lines go, and every other character of the block stays as written
		it('strips the `is:inline` script left in the page, honoring its own directive', () => {
			const INLINE_SCRIPT = [
				'<script>',
				"\t\t\tconsole.info('KEEP_ASTRO_INLINE_INFO');",
				String.raw`			const INLINE_PATH = 'C:\\inline';`,
				'\t\t\t// console-stripper-ignore-next-line',
				"\t\t\tconsole.log('PROTECTED_ASTRO_INLINE');",
				'\t\t</script>',
			].join('\n');

			expect(html).not.toMatch(/STRIP_ASTRO_INLINE/);
			expect(html).toContain(INLINE_SCRIPT);
		});

		// The directive range opens before the `{title}` expression, which the compiler turns into a placeholder, so the
		// inline script it protects sits in a later template chunk than the directive opening it
		it('keeps the `is:inline` script a directive range spanning a template expression protects', () => {
			expect(html).toContain("<script>console.log('PROTECTED_ASTRO_INLINE_RANGE');</script>");
			expect(html).toContain('<script></script>');
		});
	});
});
