import type { Rolldown } from 'vite';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';

import { buildFixture } from './build-fixture';
import consoleStripper from '../../src/index.ts';

/**
 * Finds the generated position of the first occurrence of a token in a chunk.
 *
 * @param code - The chunk code.
 * @param token - The token to find.
 *
 * @returns The 1-based line and 0-based column the source map is queried with.
 */
function findGeneratedPosition(code: string, token: string): { line: number; column: number } {
	const LINES = code.split('\n');
	const LINE_INDEX = LINES.findIndex((line) => line.includes(token));

	if (LINE_INDEX === -1) {
		throw new Error(`findGeneratedPosition: ${token} not found`);
	}

	return { line: LINE_INDEX + 1, column: (LINES[LINE_INDEX] ?? '').indexOf(token) };
}

describe('Source map through a real build (`build.sourcemap: true`)', () => {
	let chunk: Rolldown.OutputChunk;
	let traceMap: TraceMap;

	beforeAll(async () => {
		vi.stubEnv('NODE_ENV', 'production');

		const OUTPUT = await buildFixture({
			fixture: 'sourcemap',
			entry: 'mapped.js',
			plugins: [consoleStripper()],
			isSourcemapWanted: true,
		});

		const [FIRST_CHUNK] = [...OUTPUT.chunks.values()];

		if (FIRST_CHUNK?.map == null) {
			throw new Error('the build emitted no chunk with a source map');
		}

		chunk = FIRST_CHUNK;
		traceMap = new TraceMap(FIRST_CHUNK.map.toString());
	}, 30_000);

	afterAll(() => {
		vi.unstubAllEnvs();
	});

	it('strips both calls from the emitted chunk', () => {
		expect(chunk.code).not.toMatch(/STRIP_MAPPED/);
	});

	// `mapped.js`: line 1 and line 3 are removed, so line 4 and line 7 shift up in the stripper's output
	it.each([
		{ token: 'reduce', line: 4, column: 15 },
		{ token: 'TAX_RATE_MULTIPLIER = 1.2', line: 7, column: 6 },
	])('maps `$token` on an untouched line back to line $line, column $column', ({ token, line, column }) => {
		const ORIGINAL = originalPositionFor(traceMap, findGeneratedPosition(chunk.code, token));

		// Rolldown writes the source relative to the output directory, `dist/` inside the fixture folder
		expect(ORIGINAL.source).toBe('../mapped.js');
		expect({ line: ORIGINAL.line, column: ORIGINAL.column }).toEqual({ line, column });
	});
});
