import type { Logger, PluginOption, Rolldown } from 'vite';

import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

import { build, parseSync } from 'vite';

/**
 * What one in-memory build emitted, keyed by output file name
 */
interface BuildOutput {
	chunks: Map<string, Rolldown.OutputChunk>;
	/** Every text asset (HTML pages included) */
	assets: Map<string, string>;
}

interface BuildFixtureOptions {
	/** The fixture folder under `tests/fixtures/` */
	fixture: string;
	plugins: PluginOption[];
	/** Library entry, relative to the fixture folder; mutually exclusive with `input` */
	entry?: string;
	/** Application inputs (HTML pages), relative to the fixture folder */
	input?: readonly string[];
	isSourcemapWanted?: boolean;
	/** The logger the build reports through. Default: Vite's own, silenced */
	logger?: Logger;
}

// The framework runtimes are not installed (React) or would only bloat the chunk under test, so they stay external
const FRAMEWORK_RUNTIME_REGEX = /^(react|react-dom|preact|solid-js|svelte|vue|rxjs|@angular\/[\w-]+)(\/|$)/;

/**
 * Resolves the absolute path of a fixture folder.
 *
 * @param fixture - The folder name under `tests/fixtures/`.
 *
 * @returns The absolute folder path, with a trailing separator.
 */
function getFixtureRoot(fixture: string): string {
	return fileURLToPath(new URL(`../fixtures/${fixture}/`, import.meta.url));
}

/**
 * Runs a real in-memory `vite build` over a fixture folder.
 *
 * @param options - The fixture, its plugins and its entry.
 *
 * @returns The emitted chunks and text assets.
 */
async function buildFixture(options: BuildFixtureOptions): Promise<BuildOutput> {
	const ROOT = getFixtureRoot(options.fixture);
	const INPUT = options.input?.map((page) => `${ROOT}${page}`);

	const RESULT = await build({
		root: ROOT,
		configFile: false,
		envDir: false,
		logLevel: 'silent',
		...(options.logger == null ? {} : { customLogger: options.logger }),
		plugins: options.plugins,
		build: {
			write: false,
			minify: false,
			sourcemap: options.isSourcemapWanted ?? false,
			emptyOutDir: false,
			...(options.entry == null ? {} : { lib: { entry: `${ROOT}${options.entry}`, formats: ['es'] } }),
			rolldownOptions: {
				external: FRAMEWORK_RUNTIME_REGEX,
				...(INPUT == null ? {} : { input: INPUT }),
			},
		},
	});

	const OUTPUTS = Array.isArray(RESULT) ? RESULT : [RESULT];
	const CHUNKS = new Map<string, Rolldown.OutputChunk>();
	const ASSETS = new Map<string, string>();

	OUTPUTS.forEach((output) => {
		if (!('output' in output)) {
			throw new Error('buildFixture: a watcher was returned instead of a build output');
		}

		output.output.forEach((file) => {
			if (file.type === 'chunk') {
				CHUNKS.set(file.fileName, file);
			} else if (typeof file.source === 'string') {
				ASSETS.set(file.fileName, file.source);
			}
		});
	});

	return { chunks: CHUNKS, assets: ASSETS };
}

/**
 * Concatenates the code of every emitted chunk.
 *
 * @param output - The build output.
 *
 * @returns The joined chunk code.
 */
function getAllChunkCode(output: BuildOutput): string {
	return [...output.chunks.values()].map((chunk) => chunk.code).join('\n');
}

/**
 * Builds the pattern of a console call with a single string argument, whatever quotes the bundler printed.
 *
 * @param method - The console method.
 * @param marker - The string argument.
 *
 * @returns The pattern matching `console.<method>("<marker>")`.
 */
function createCallPattern(method: string, marker: string): RegExp {
	// eslint-disable-next-line security/detect-non-literal-regexp -- both parts are literal identifiers written by the tests
	return new RegExp(String.raw`console\.${method}\(["'\x60]${marker}["'\x60]\)`);
}

/**
 * Lists the parse errors of a JavaScript module.
 *
 * @param code - The module source.
 * @param fileName - The name the parser infers the language from.
 *
 * @returns The error messages, empty when the module parses.
 */
function getParseErrors(code: string, fileName = 'output.js'): string[] {
	return parseSync(fileName, code, { sourceType: 'module' }).errors.map((error) => error.message);
}

/**
 * Creates a logger recording every message it receives, without the ANSI color codes Vite adds when the terminal
 * (or `CI`) enables colors.
 *
 * @returns The logger and the recorded `info` and `warn` messages.
 */
function createRecordingLogger(): { logger: Logger; infos: string[]; warnings: string[] } {
	const INFOS: string[] = [];
	const WARNINGS: string[] = [];

	const LOGGER: Logger = {
		info: (message) => {
			INFOS.push(stripVTControlCharacters(message));
		},
		warn: (message) => {
			WARNINGS.push(stripVTControlCharacters(message));
		},
		warnOnce: (message) => {
			WARNINGS.push(stripVTControlCharacters(message));
		},
		error: () => undefined,
		clearScreen: () => undefined,
		hasErrorLogged: () => false,
		hasWarned: false,
	};

	return { logger: LOGGER, infos: INFOS, warnings: WARNINGS };
}

export type { BuildOutput };

export {
	buildFixture,
	createCallPattern,
	createRecordingLogger,
	FRAMEWORK_RUNTIME_REGEX,
	getAllChunkCode,
	getFixtureRoot,
	getParseErrors,
};
