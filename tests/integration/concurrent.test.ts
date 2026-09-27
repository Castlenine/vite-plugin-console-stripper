import type { BuildOutput } from './build-fixture';
import type { Plugin } from 'vite';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildFixture, createCallPattern, createRecordingLogger, getAllChunkCode } from './build-fixture';
import consoleStripper from '../../src/index.ts';

const PLUGIN_PREFIX = '[console-stripper]';

describe('Two concurrent builds sharing one plugin instance', () => {
	let htmlOutput: BuildOutput;
	let libraryOutput: BuildOutput;
	let infos: string[] = [];

	beforeAll(async () => {
		vi.stubEnv('NODE_ENV', 'production');

		// Both builds run a `client` environment of their own, so only the environment object tells them apart
		const PLUGIN = consoleStripper({ verbose: true });
		const RECORDING = createRecordingLogger();

		[htmlOutput, libraryOutput] = await Promise.all([
			buildFixture({ fixture: 'html', input: ['index.html'], plugins: [PLUGIN], logger: RECORDING.logger }),
			buildFixture({ fixture: 'environments', entry: 'entry.js', plugins: [PLUGIN], logger: RECORDING.logger }),
		]);
		infos = RECORDING.infos.filter((message) => message.startsWith(PLUGIN_PREFIX));
	}, 30_000);

	afterAll(() => {
		vi.unstubAllEnvs();
	});

	it('summarizes each build on its own counters', () => {
		expect([...infos].sort()).toEqual([
			'[console-stripper] [client] stripped 2 console calls in 1 project file and 0 console calls in 0 dependency files',
			'[console-stripper] [client] stripped 3 console calls in 2 project files and 0 console calls in 0 dependency files',
		]);
	});

	it('keeps the calls the HTML page protects once Vite extracts its inline module scripts', () => {
		const CODE = getAllChunkCode(htmlOutput);

		expect(CODE).toMatch(createCallPattern('log', 'PROTECTED_HTML_MODULE_NEXT_LINE'));
		expect(CODE).toMatch(createCallPattern('log', 'PROTECTED_HTML_MODULE_BLOCK'));
		expect(CODE).not.toMatch(/STRIP_HTML/);
	});

	it('strips the library build', () => {
		expect(getAllChunkCode(libraryOutput)).not.toMatch(/STRIP_ENVIRONMENT/);
	});
});

/**
 * Creates a plugin announcing that the configuration of the build it belongs to was resolved.
 *
 * @returns The plugin, and the promise it settles once `configResolved` ran.
 */
function createResolvedSignal(): { plugin: Plugin; resolved: Promise<void> } {
	let announce: () => void = () => undefined;

	const RESOLVED = new Promise<void>((resolve) => {
		announce = resolve;
	});

	return {
		plugin: {
			name: 'resolved-signal',
			enforce: 'post',
			configResolved() {
				announce();
			},
		},
		resolved: RESOLVED,
	};
}

describe('Two concurrent builds with different roots sharing one plugin instance', () => {
	let htmlOutput: BuildOutput;
	let libraryOutput: BuildOutput;
	let htmlInfos: string[] = [];
	let libraryInfos: string[] = [];

	beforeAll(async () => {
		vi.stubEnv('NODE_ENV', 'production');

		// Relative to the root of the other build, the modules of each build sit under a folder named after its fixture,
		// which these tokens ignore; relative to its own root, none of them does
		const PLUGIN = consoleStripper({ verbose: true, ignoreFolders: ['environments', 'html'] });
		const HTML_RECORDING = createRecordingLogger();
		const LIBRARY_RECORDING = createRecordingLogger();
		const HTML_RESOLVED = createResolvedSignal();
		const LIBRARY_RESOLVED = createResolvedSignal();

		// The library build resolves its configuration first, and only transforms once the HTML build resolved its own
		const LIBRARY_BUILD = buildFixture({
			fixture: 'environments',
			entry: 'entry.js',
			plugins: [
				PLUGIN,
				LIBRARY_RESOLVED.plugin,
				{ name: 'wait-for-html-build', buildStart: () => HTML_RESOLVED.resolved },
			],
			logger: LIBRARY_RECORDING.logger,
		});

		await LIBRARY_RESOLVED.resolved;

		const HTML_BUILD = buildFixture({
			fixture: 'html',
			input: ['index.html'],
			plugins: [PLUGIN, HTML_RESOLVED.plugin],
			logger: HTML_RECORDING.logger,
		});

		[htmlOutput, libraryOutput] = await Promise.all([HTML_BUILD, LIBRARY_BUILD]);
		htmlInfos = HTML_RECORDING.infos.filter((message) => message.startsWith(PLUGIN_PREFIX));
		libraryInfos = LIBRARY_RECORDING.infos.filter((message) => message.startsWith(PLUGIN_PREFIX));
	}, 30_000);

	afterAll(() => {
		vi.unstubAllEnvs();
	});

	it('matches the ignore tokens of each build against its own root', () => {
		expect(getAllChunkCode(libraryOutput)).not.toMatch(/STRIP_ENVIRONMENT/);
		expect(getAllChunkCode(htmlOutput)).not.toMatch(/STRIP_HTML/);
	});

	it('prints the summary of each build through its own logger', () => {
		expect(libraryInfos).toEqual([
			'[console-stripper] [client] stripped 2 console calls in 1 project file and 0 console calls in 0 dependency files',
		]);
		expect(htmlInfos).toEqual([
			'[console-stripper] [client] stripped 3 console calls in 2 project files and 0 console calls in 0 dependency files',
		]);
	});
});
