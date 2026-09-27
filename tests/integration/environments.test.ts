import type { Options } from '../../src/index.ts';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBuilder } from 'vite';

import consoleStripper from '../../src/index.ts';
import { createRecordingLogger, getFixtureRoot } from './build-fixture';

const PLUGIN_PREFIX = '[console-stripper]';

/**
 * Runs `buildApp()` over a client and an SSR environment sharing one plugin instance.
 *
 * @param options - The plugin options.
 *
 * @returns The `[console-stripper]` info and warning messages the build logged.
 */
async function buildApp(options: Options): Promise<{ infos: string[]; warnings: string[] }> {
	const ROOT = getFixtureRoot('environments');
	const ENTRY = `${ROOT}entry.js`;
	const { logger, infos, warnings } = createRecordingLogger();

	const BUILDER = await createBuilder({
		root: ROOT,
		configFile: false,
		envDir: false,
		logLevel: 'silent',
		customLogger: logger,
		plugins: [consoleStripper(options)],
		build: { write: false, minify: false, emptyOutDir: false },
		builder: {},
		environments: {
			client: { build: { rolldownOptions: { input: ENTRY } } },
			ssr: { build: { ssr: ENTRY } },
		},
	});

	await BUILDER.buildApp();

	return {
		infos: infos.filter((message) => message.startsWith(PLUGIN_PREFIX)),
		warnings: warnings.filter((message) => message.startsWith(PLUGIN_PREFIX)),
	};
}

describe('Multi-environment app build (`createBuilder` + `buildApp`)', () => {
	beforeAll(() => {
		vi.stubEnv('NODE_ENV', 'production');
	});

	afterAll(() => {
		vi.unstubAllEnvs();
	});

	it('logs one `verbose` summary per environment', async () => {
		const { infos, warnings } = await buildApp({ verbose: true });

		expect(infos).toEqual([
			'[console-stripper] [client] stripped 2 console calls in 1 project file and 0 console calls in 0 dependency files',
			'[console-stripper] [ssr] stripped 2 console calls in 1 project file and 0 console calls in 0 dependency files',
		]);
		expect(warnings).toEqual([]);
	}, 30_000);

	it('warns exactly once about an empty `extensions` list', async () => {
		const { infos, warnings } = await buildApp({ extensions: [] });

		expect(warnings).toEqual([
			'[console-stripper] the "extensions" option resolved to an empty list, so the plugin will not strip anything',
		]);
		expect(infos).toEqual([]);
	}, 30_000);
});
