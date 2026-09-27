import type { BuildOutput } from './build-fixture';
import type { PluginOption } from 'vite';
import type { PluginOptions } from '@analogjs/vite-plugin-angular';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import angular from '@analogjs/vite-plugin-angular';
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';

import {
	buildFixture,
	createCallPattern,
	createRecordingLogger,
	getAllChunkCode,
	getFixtureRoot,
	getParseErrors,
} from './build-fixture';
import consoleStripper from '../../src/index.ts';

interface AngularBuild {
	output: BuildOutput;
	/** The joined chunk code */
	code: string;
	/** The `[console-stripper]` lines the build logged */
	summaries: string[];
	/** The warnings the build logged about this plugin */
	warnings: string[];
}

const TSCONFIG = `${getFixtureRoot('angular')}tsconfig.json`;
const REMOVE_COMMENTS_TSCONFIG = `${getFixtureRoot('angular')}tsconfig.remove-comments.json`;

const PLUGIN_ORDERS = [
	{ name: '[consoleStripper(), angular()]', isStripperFirst: true },
	{ name: '[angular(), consoleStripper()]', isStripperFirst: false },
] as const;

const COMPILER_MODES = [
	{ mode: 'fastCompile', angularOptions: { fastCompile: true } },
	{ mode: 'AOT', angularOptions: {} },
	{ mode: 'JIT', angularOptions: { jit: true } },
] as const;

const BUILD_CASES = COMPILER_MODES.flatMap((compiler) =>
	PLUGIN_ORDERS.map((order) => ({
		...compiler,
		...order,
		// Listed after `fastCompile`, the source pass reads its emit, which drops the file-level directive together with
		// the `import type` it is attached to
		isFileDirectiveKept: compiler.mode !== 'fastCompile' || order.isStripperFirst,
	})),
);

const KEPT_CALLS = [
	['warn', 'KEEP_ANGULAR_ON_INIT_WARN'],
	['error', 'KEEP_ANGULAR_PANEL_ERROR'],
	// `console-stripper-ignore-next-line`, then `-start` / `-end`
	['log', 'PROTECTED_ANGULAR_ON_INIT'],
	['log', 'PROTECTED_ANGULAR_PANEL_RANGE'],
] as const;

const FILE_PROTECTED_CALL = createCallPattern('log', 'PROTECTED_ANGULAR_FILE');

const FAST_COMPILE_ORDER_WARNING =
	'[console-stripper] @analogjs/vite-plugin-angular-fast-compile runs before console-stripper, which then reads its emit: a file-level ignore directive written above a type-only import is dropped with it. List consoleStripper() before angular() in the plugins';

const TEMPLATE_TEXTS = [
	'Type console.log(inline) to debug',
	'Run console.log(external) in the panel',
	'Keep console.log(ignored) as text',
] as const;

/**
 * Builds the Angular fixture through `@analogjs/vite-plugin-angular`, with the stripper's `verbose` summary on.
 *
 * @param options - Whether the stripper is listed first, the options passed to `angular()` on top of the fixture
 *   `tsconfig`, the `tsconfig` itself (the base one by default), and whether the build emits source maps.
 *
 * @returns The build output, its joined chunk code, the summary lines and the plugin warnings.
 */
async function buildAngularFixture(options: {
	isStripperFirst: boolean;
	angularOptions: PluginOptions;
	tsconfig?: string;
	isSourcemapWanted?: boolean;
}): Promise<AngularBuild> {
	const { logger, infos, warnings } = createRecordingLogger();
	const STRIPPER: PluginOption = consoleStripper({ verbose: true });
	const ANGULAR = angular({ tsconfig: options.tsconfig ?? TSCONFIG, ...options.angularOptions });

	const OUTPUT = await buildFixture({
		fixture: 'angular',
		entry: 'main.ts',
		plugins: options.isStripperFirst ? [STRIPPER, ANGULAR] : [ANGULAR, STRIPPER],
		logger,
		isSourcemapWanted: options.isSourcemapWanted ?? false,
	});

	return {
		output: OUTPUT,
		code: getAllChunkCode(OUTPUT),
		summaries: infos.filter((message) => message.startsWith('[console-stripper]')),
		warnings: warnings.filter((message) => message.includes('console-stripper')),
	};
}

// `angular()` reads `VITEST` / `NODE_ENV` when it is created and switches to its Vitest mode (JIT, no AOT emit during
// `vite.build()`); a consumer's `vite build` runs with neither
beforeAll(() => {
	vi.stubEnv('VITEST', '');
	vi.stubEnv('NODE_ENV', 'production');
});

afterAll(() => {
	vi.unstubAllEnvs();
});

// The AOT and JIT compilers replace each module with what they compiled from disk in `buildStart`, so those modules
// are stripped by the plugin's `enforce: 'post'` pass; `fastCompile` compiles the code it receives, so its modules are
// stripped by the source pass, before or after it depending on the order
describe.each(BUILD_CASES)(
	'Angular (Analog) build with the $mode compiler and $name',
	({ angularOptions, isStripperFirst, isFileDirectiveKept }) => {
		let build: AngularBuild = {
			output: { chunks: new Map(), assets: new Map() },
			code: '',
			summaries: [],
			warnings: [],
		};

		beforeAll(async () => {
			build = await buildAngularFixture({ isStripperFirst, angularOptions });
		}, 120_000);

		it('strips the stripped methods from the constructor, the lifecycle hooks and the methods', () => {
			expect(build.code).not.toMatch(/STRIP_ANGULAR/);
		});

		it('keeps the kept methods and the calls a next-line or range directive protects', () => {
			KEPT_CALLS.forEach(([method, marker]) => {
				expect(build.code).toMatch(createCallPattern(method, marker));
			});
		});

		it(`${isFileDirectiveKept ? 'keeps' : 'strips'} the call of the component a file-level directive protects`, () => {
			expect(FILE_PROTECTED_CALL.test(build.code)).toBe(isFileDirectiveKept);
		});

		it('leaves the inline and external template text byte-identical', () => {
			TEMPLATE_TEXTS.forEach((text) => {
				expect(build.code).toContain(text);
			});
		});

		it('emits chunks that parse', () => {
			expect(getParseErrors(build.code)).toEqual([]);
		});

		it('counts each stripped call once', () => {
			const SUMMARY = isFileDirectiveKept ? '6 console calls in 3 project files' : '7 console calls in 4 project files';

			expect(build.summaries).toEqual([
				`[console-stripper] [client] stripped ${SUMMARY} and 0 console calls in 0 dependency files`,
			]);
		});

		it(`${isFileDirectiveKept ? 'does not warn' : 'warns once'} about the plugin order`, () => {
			expect(build.warnings).toEqual(isFileDirectiveKept ? [] : [FAST_COMPILE_ORDER_WARNING]);
		});
	},
);

// The compiler emits no comment at all, so the next-line and range directives of the authored source are gone from the
// code the compiled pass reads
describe.each(COMPILER_MODES.filter((compiler) => compiler.mode !== 'fastCompile'))(
	'Angular (Analog) build with the $mode compiler and "removeComments": true',
	({ angularOptions }) => {
		let build: AngularBuild = {
			output: { chunks: new Map(), assets: new Map() },
			code: '',
			summaries: [],
			warnings: [],
		};

		beforeAll(async () => {
			build = await buildAngularFixture({ isStripperFirst: true, angularOptions, tsconfig: REMOVE_COMMENTS_TSCONFIG });
		}, 120_000);

		it('leaves every call of a module whose line directives the compiler removed in place', () => {
			[
				['log', 'PROTECTED_ANGULAR_ON_INIT'],
				['log', 'PROTECTED_ANGULAR_PANEL_RANGE'],
				['log', 'STRIP_ANGULAR_CONSTRUCTOR'],
				['trace', 'STRIP_ANGULAR_PANEL_CLICK'],
			].forEach(([method = '', marker = '']) => {
				expect(build.code).toMatch(createCallPattern(method, marker));
			});
		});

		it('warns once about each module left unstripped', () => {
			expect([...build.warnings].sort()).toEqual(
				['app.component.ts', 'panel.component.ts'].map(
					(file) =>
						`[plugin console-stripper:angular] the Angular compiler removed the ignore comments of ${file} (e.g. "removeComments": true in its tsconfig), so the file was left unstripped`,
				),
			);
		});

		it('still strips the modules holding no directive', () => {
			expect(build.code).not.toMatch(/STRIP_ANGULAR_STATUS/);
			expect(build.summaries).toEqual([
				'[console-stripper] [client] stripped 1 console call in 1 project file and 0 console calls in 0 dependency files',
			]);
		});

		it('emits chunks that parse', () => {
			expect(getParseErrors(build.code)).toEqual([]);
		});
	},
);

describe('Angular (Analog) AOT build with source maps', () => {
	it('maps a line below a stripped call back to the authored component', async () => {
		const { output } = await buildAngularFixture({
			isStripperFirst: true,
			angularOptions: {},
			isSourcemapWanted: true,
		});

		const [CHUNK] = [...output.chunks.values()];

		if (CHUNK?.map == null) {
			throw new Error('the build emitted no chunk with a source map');
		}

		const LINES = CHUNK.code.split('\n');
		const LINE_INDEX = LINES.findIndex((line) => line.includes('KEEP_ANGULAR_PANEL_ERROR'));
		const ORIGINAL = originalPositionFor(new TraceMap(CHUNK.map.toString()), {
			line: LINE_INDEX + 1,
			column: (LINES[LINE_INDEX] ?? '').indexOf('console'),
		});

		// `panel.component.ts`: the call sits on line 16, column 2, right below the stripped `console.trace` of line 15
		expect(ORIGINAL.source).toMatch(/panel\.component\.ts$/);
		expect({ line: ORIGINAL.line, column: ORIGINAL.column }).toEqual({ line: 16, column: 2 });
	}, 120_000);
});
