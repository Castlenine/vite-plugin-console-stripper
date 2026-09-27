import type { ConsoleScan, DirectiveScope, ExtensionMatcher, FileKind, IgnoreMatcher, ScanContext } from './utilities';
import type { Logger, Plugin } from 'vite';
import type { Options, ResolvedOptions } from './types';
import type { SourceMap } from './sourcemap';

import {
	applyEdits,
	ASTRO_EXTENSIONS,
	createExtensionMatcher,
	createIgnoreMatcher,
	createScanContext,
	createSourceLayout,
	DEFAULT_EXTENSIONS,
	DEFAULT_METHODS,
	getDirectiveScope,
	getFileKind,
	getOptions,
	getOwningPackage,
	getProjectIgnoredPaths,
	getUserIgnoredPaths,
	hasConsoleToken,
	hasIgnoreDirectiveToken,
	HTML_EXTENSIONS,
	HTML_PROXY_REGEX,
	isDependencyPath,
	JAVASCRIPT_EXTENSIONS,
	JSX_EXTENSIONS,
	scanCompiledAstroComponent,
	scanConsoleCalls,
	SCRIPT_EXTENSIONS,
	stripQuery,
	SVELTE_EXTENSIONS,
	toRelativePath,
	TYPESCRIPT_EXTENSIONS,
	VUE_EXTENSIONS,
} from './utilities';
import { generateEditSourceMap } from './sourcemap';

/**
 * Counts how many files were changed, how many calls were stripped and how many were left in place because their end
 * could not be found, for one class of files
 */
interface StripTally {
	fileCount: number;
	callCount: number;
	skippedCallCount: number;
}

/**
 * Everything one environment's build accumulates between `buildStart` and `buildEnd`
 */
interface BuildState {
	projectTally: StripTally;
	dependencyTally: StripTally;
	/**
	 * The HTML pages transformed so far, keyed by file path: the body of every JavaScript `<script>` block of each page
	 * as its own pass left it, with `\n` line endings
	 */
	htmlPages: Map<string, ReadonlySet<string>>;
	/**
	 * What the directives of the authored source protect, for every TypeScript module the Angular compiler recompiles
	 * whose source holds one, keyed by module id: recorded by the source pass for the compiled pass, which may no
	 * longer find the directives
	 */
	angularInputScopes: Map<string, Exclude<DirectiveScope, 'none'>>;
}

/**
 * The part of a resolved Vite configuration this plugin reads, with the build options declared optional so that a
 * plugin driven outside a build is handled too
 */
interface SourcemapAwareConfig {
	build?: { sourcemap?: unknown };
}

/**
 * The plugin context of a hook. On Vite 6 or later it carries the environment the hook runs in, together with that
 * environment's own configuration; the older Vite versions the peer range allows build it without one.
 */
interface EnvironmentAwareContext {
	environment?: BuildEnvironment;
}

/**
 * The environment a Vite 6+ hook runs in, which is one object per environment of one build: two builds running at
 * once each hold their own, even when both name it `client`
 */
interface BuildEnvironment {
	name?: string;
	config?: EnvironmentConfig;
}

/**
 * The part of an environment's resolved configuration this plugin reads. Two builds sharing one plugin instance each
 * resolve their own, so it is read from the running hook rather than kept from `configResolved`, which the second
 * build would overwrite.
 */
interface EnvironmentConfig extends SourcemapAwareConfig {
	root?: string;
	logger?: Logger;
	plugins?: readonly { name: string }[];
}

/**
 * The part of the bundler's plugin context this plugin uses to report a warning about the module being transformed.
 *
 * @remarks
 * Declared structurally rather than imported from one bundler's type package: Vite has run on Rollup 2, 3 and 4 and
 * now also on Rolldown, and every one of them gives the `transform` hook the same `warn` — a message and an optional
 * character offset, which the bundler resolves into the line, the column and a code frame of the module.
 */
interface WarningContext {
	warn: (message: string, position?: number) => void;
}

/**
 * The module one `transform` call reads
 */
interface ModuleSource {
	code: string;
	id: string;
	/** The kind the id resolves to */
	fileKind: FileKind;
}

/**
 * A module the scan runs on, once every rule leaving it untouched was checked
 */
interface StrippableModule extends ModuleSource {
	/** Whether the module is installed under `node_modules` */
	isDependency: boolean;
}

/**
 * What the `transform` hook of either pass returns for a changed module
 */
interface StrippedModule {
	code: string;
	map: SourceMap | null;
}

/**
 * A warning about one module
 */
interface ModuleWarning {
	/** The `this` value the `transform` hook received, `undefined` when it is called without one */
	context: EnvironmentAwareContext | undefined;
	/** The module identifier */
	id: string;
	message: string;
	/** The character offset in the transformed code the warning points at */
	position?: number;
}

/**
 * Reads and forgets the state of the environment a hook builds
 */
interface BuildStateStore {
	getBuildState: (context: EnvironmentAwareContext | undefined) => BuildState;
	clearBuildState: (context: EnvironmentAwareContext | undefined) => void;
}

/**
 * The values of the last configuration resolved, which a Vite 6+ hook only falls back on when its environment carries
 * no configuration of its own
 */
interface FallbackConfig {
	/** Ignore tokens are matched against paths relative to the Vite root, not to the process working directory */
	root: string;
	logger: Logger | null;
	plugins: readonly { name: string }[];
	/** `null` until a configuration is resolved, which never happens when the plugin is driven directly */
	resolved: SourcemapAwareConfig | null;
}

/**
 * Everything the two passes of one plugin instance share
 */
interface StripperInstance {
	options: ResolvedOptions;
	/**
	 * Owned by this plugin instance, so two instances configured with the same methods never share the `lastIndex` of
	 * its stateful pattern; each scan hands it the kind of the file it reads
	 */
	scanContext: ScanContext;
	callProbe: RegExp | null;
	isIgnoredProjectPath: IgnoreMatcher;
	/**
	 * Dependencies are matched against the consumer's own tokens only: the built-in list holds `dist`, `build` and
	 * `public`, which nearly every published package uses for its own output
	 */
	isIgnoredUserPath: IgnoreMatcher;
	hasProcessedExtension: ExtensionMatcher;
	ignoredDependencies: ReadonlySet<string>;
	buildStates: BuildStateStore;
	/** The module id and message of every module warning reported, so that each environment building it does not repeat it */
	reportedWarnings: Set<string>;
	fallback: FallbackConfig;
	hasWarnedAboutFastCompile: boolean;
}

const PLUGIN_NAME = 'console-stripper';
const ANGULAR_PASS_PLUGIN_NAME = 'console-stripper:angular';
const ASTRO_COMPILER_PLUGIN_NAME = 'astro:build';
const ANGULAR_COMPILER_PLUGIN_NAME = '@analogjs/vite-plugin-angular';
const FAST_COMPILE_PLUGIN_NAME = '@analogjs/vite-plugin-angular-fast-compile';
const LINE_ENDING_REGEX = /\r\n?/g;
const NOT_FOUND = -1;

/**
 * Formats a count with a singular or plural noun.
 *
 * @param count - The number to format.
 * @param noun - The singular form of the noun.
 *
 * @returns The count followed by the correctly inflected noun.
 */
function formatCount(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Builds the probe reporting whether a source holds a call the scan would edit.
 *
 * @remarks
 * Every edit candidate comes from the scan pattern, so a source that pattern does not match cannot produce an edit:
 * the probe is exact rather than heuristic, and it rejects a file using only kept methods (`console.error`,
 * `console.warn`) before the scan masks the whole source. The copy is not global, which leaves the `lastIndex` of the
 * scan pattern alone and gives the probe no state of its own.
 *
 * @param pattern - The scan pattern of the plugin instance.
 *
 * @returns The probe, or `null` when the resolved method list is empty and nothing can ever match.
 */
function createConsoleCallProbe(pattern: RegExp | null): RegExp | null {
	// eslint-disable-next-line security/detect-non-literal-regexp -- the source is the scan pattern's own, built from the method names validated by getOptions
	return pattern == null ? null : new RegExp(pattern.source);
}

/**
 * Names the environment a hook runs in.
 *
 * @param context - The plugin context of the running hook, `undefined` when the hook is called without one.
 *
 * @returns The environment name, or the empty string before Vite 6, which builds a single unnamed environment.
 */
function getEnvironmentName(context: EnvironmentAwareContext | undefined): string {
	return context?.environment?.name ?? '';
}

function getSourcemapSetting(config: SourcemapAwareConfig | null | undefined): unknown {
	return config?.build?.sourcemap;
}

/**
 * Reports whether the build wants a source map for the module the running transform changed.
 *
 * @remarks
 * The environment's own setting wins over the one of the resolved configuration. A Vite build always resolves the
 * setting, so an absent one means no configuration was ever resolved — the plugin is driven directly, as in a unit
 * test — and the map is generated. Every truthy setting (`true`, `'inline'`, `'hidden'`) wants one.
 *
 * @param context - The plugin context of the running hook, `undefined` when the hook is called without one.
 * @param config - The configuration Vite resolved, or `null` before any was.
 *
 * @returns `true` when the map must be generated.
 */
function isSourcemapWanted(context: EnvironmentAwareContext | undefined, config: SourcemapAwareConfig | null): boolean {
	const SETTING = getSourcemapSetting(context?.environment?.config) ?? getSourcemapSetting(config);

	return SETTING == null || Boolean(SETTING);
}

/**
 * Reports whether a plugin runs before the source pass of this plugin.
 *
 * @param plugins - The resolved plugins, in the order they run.
 * @param name - The name of the plugin to look for.
 *
 * @returns `true` when the plugin is registered ahead of the source pass.
 */
function isListedBeforeSourcePass(plugins: readonly { name: string }[], name: string): boolean {
	const NAMES = plugins.map((plugin) => plugin.name);
	const INDEX = NAMES.indexOf(name);

	return INDEX !== NOT_FOUND && INDEX < NAMES.indexOf(PLUGIN_NAME);
}

/**
 * Reports whether Astro compiles its components before this plugin reads them.
 *
 * @remarks
 * `astro:build` is an `enforce: 'pre'` plugin Astro registers ahead of every user plugin, so the `.astro` main module
 * reaches this plugin as the TypeScript Astro compiled it, under the unchanged id of the component.
 *
 * @param plugins - The resolved plugins, in the order they run.
 *
 * @returns `true` when the Astro compiler runs first.
 */
function isCompiledByAstroFirst(plugins: readonly { name: string }[]): boolean {
	return isListedBeforeSourcePass(plugins, ASTRO_COMPILER_PLUGIN_NAME);
}

/**
 * Reports whether Analog's `fastCompile` mode compiles the project TypeScript modules before this plugin reads them.
 *
 * @remarks
 * The `fastCompile` plugin is `enforce: 'pre'` like the source pass, so the order the consumer lists `angular()` and
 * this plugin in decides which one reads the authored source.
 *
 * @param plugins - The resolved plugins, in the order they run.
 *
 * @returns `true` when the `fastCompile` plugin runs first.
 */
function isFastCompiledFirst(plugins: readonly { name: string }[]): boolean {
	return isListedBeforeSourcePass(plugins, FAST_COMPILE_PLUGIN_NAME);
}

/**
 * Reports whether Analog's Angular compiler replaces the TypeScript modules of the project.
 *
 * @remarks
 * `@analogjs/vite-plugin-angular` compiles the whole program from the files on disk in `buildStart`, and its
 * `transform` returns that emit in place of the code it receives, which discards whatever an earlier transform did to
 * a module. Its `fastCompile` mode registers under another name and compiles the code it receives instead.
 *
 * @param plugins - The resolved plugins.
 *
 * @returns `true` when the Angular compiler is registered.
 */
function isCompiledByAngular(plugins: readonly { name: string }[]): boolean {
	return plugins.some((plugin) => plugin.name === ANGULAR_COMPILER_PLUGIN_NAME);
}

/**
 * Formats the entries of an option list that resolved to nothing, every one of which was therefore rejected.
 *
 * @remarks
 * An entry is only printed when it is a string: anything else is named by its type, since converting an arbitrary
 * value to a string can throw (`Object.create(null)` has no `toString`) and a warning must never fail the build.
 *
 * @param entries - The entries the consumer passed, which are not guaranteed to be strings.
 *
 * @returns The rejected entries, formatted for a log line.
 */
function getRejectedEntries(entries: readonly unknown[]): string[] {
	return entries.map((entry) => (typeof entry === 'string' ? `"${entry}"` : `<${typeof entry}>`));
}

/**
 * Tells whether the value a hook was called with can report build warnings.
 *
 * @remarks
 * Vite always calls `transform` with a plugin context, but the hook is a plain function that anything may call — a
 * unit test invoking `plugin.transform` directly gets no context at all, and a warning must never be what breaks such
 * a call.
 *
 * @param context - The `this` value the hook received.
 *
 * @returns `true` when `warn` can be called on it.
 */
function hasWarningContext(context: unknown): context is WarningContext {
	return typeof context === 'object' && context != null && 'warn' in context && typeof context.warn === 'function';
}

function normalizeLineEndings(code: string): string {
	return code.replace(LINE_ENDING_REGEX, '\n');
}

function createBuildState(): BuildState {
	return {
		projectTally: { fileCount: 0, callCount: 0, skippedCallCount: 0 },
		dependencyTally: { fileCount: 0, callCount: 0, skippedCallCount: 0 },
		htmlPages: new Map(),
		angularInputScopes: new Map(),
	};
}

/**
 * Creates the store holding the state of every environment one plugin instance builds.
 *
 * @returns The functions reading and forgetting the state of the environment a hook builds.
 */
function createBuildStateStore(): BuildStateStore {
	// Keyed by the environment object rather than by its name, so that neither the environments of one app build nor
	// two builds running at once while sharing this instance ever reset or read each other's state
	const BUILD_STATES = new WeakMap<BuildEnvironment, BuildState>();

	// The state of the single unnamed environment Vite builds before version 6, whose hooks carry no environment
	let unnamedBuildState = createBuildState();

	/**
	 * Returns the state of the environment the running hook builds, creating it on first use.
	 *
	 * @param context - The plugin context of the running hook, `undefined` when the hook is called without one.
	 *
	 * @returns The state of the environment.
	 */
	function getBuildState(context: EnvironmentAwareContext | undefined): BuildState {
		const ENVIRONMENT = context?.environment;

		if (ENVIRONMENT == null) {
			return unnamedBuildState;
		}

		const STATE = BUILD_STATES.get(ENVIRONMENT);

		if (STATE) {
			return STATE;
		}

		const CREATED = createBuildState();

		BUILD_STATES.set(ENVIRONMENT, CREATED);

		return CREATED;
	}

	/**
	 * Forgets the state of the environment the running hook builds, so that its next build starts from a fresh one.
	 *
	 * @param context - The plugin context of the running hook, `undefined` when the hook is called without one.
	 */
	function clearBuildState(context: EnvironmentAwareContext | undefined): void {
		const ENVIRONMENT = context?.environment;

		if (ENVIRONMENT == null) {
			unnamedBuildState = createBuildState();
		} else {
			BUILD_STATES.delete(ENVIRONMENT);
		}
	}

	return { getBuildState, clearBuildState };
}

/**
 * Warns about every option list that resolved to nothing, which silently turns the plugin into a no-op.
 *
 * @remarks
 * `getOptions` drops each entry it does not recognize, so a typo in `methods` disables the plugin as surely as an
 * empty `extensions` array does. The build is never failed over it: a misconfigured optional plugin must not stop
 * a release.
 *
 * @param options - The options the consumer passed.
 * @param resolvedOptions - The options `getOptions` resolved from them.
 * @param logger - The logger of the resolved configuration.
 */
function warnAboutEmptyLists(options: Options | undefined, resolvedOptions: ResolvedOptions, logger: Logger): void {
	const REQUESTED_METHODS = options?.methods;

	// Only an array resolves to no method at all: anything else falls back to the default list
	if (Array.isArray(REQUESTED_METHODS) && resolvedOptions.methods.length === 0) {
		const REJECTED = getRejectedEntries(REQUESTED_METHODS);
		const DETAIL = REJECTED.length > 0 ? ` (no console method is named ${REJECTED.join(', ')})` : '';

		logger.warn(
			`[console-stripper] the "methods" option resolved to an empty list${DETAIL}, so the plugin will not strip anything`,
		);
	}

	if (resolvedOptions.extensions.length === 0) {
		logger.warn(
			'[console-stripper] the "extensions" option resolved to an empty list, so the plugin will not strip anything',
		);
	}
}

/**
 * Formats the summary line `verbose` prints once an environment's build ended.
 *
 * @param environmentName - The name of the environment, the empty string before Vite 6.
 * @param state - The state the environment's build accumulated.
 *
 * @returns The summary line.
 */
function formatBuildSummary(environmentName: string, state: BuildState): string {
	const { projectTally, dependencyTally } = state;
	const PREFIX = environmentName === '' ? '[console-stripper]' : `[console-stripper] [${environmentName}]`;
	const PROJECT = `${formatCount(projectTally.callCount, 'console call')} in ${formatCount(projectTally.fileCount, 'project file')}`;
	const DEPENDENCIES = `${formatCount(dependencyTally.callCount, 'console call')} in ${formatCount(dependencyTally.fileCount, 'dependency file')}`;
	const SKIPPED_COUNT = projectTally.skippedCallCount + dependencyTally.skippedCallCount;
	const SKIPPED =
		SKIPPED_COUNT > 0
			? `; left ${formatCount(SKIPPED_COUNT, 'undelimitable call')} in place (${projectTally.skippedCallCount} project, ${dependencyTally.skippedCallCount} dependency)`
			: '';

	return `${PREFIX} stripped ${PROJECT} and ${DEPENDENCIES}${SKIPPED}`;
}

/**
 * Formats the warning about the stripped-method calls a module kept because their end could not be found.
 *
 * @remarks
 * One warning per module rather than one per call: a file holding thousands of unbalanced calls would otherwise flood
 * the build log.
 *
 * @param count - How many calls were left in place.
 * @param file - The module path, relative to the Vite root.
 *
 * @returns The warning message, without the plugin prefix.
 */
function formatSkippedCallsWarning(count: number, file: string): string {
	return `left ${formatCount(count, 'console call')} in place in ${file} because ${count === 1 ? 'its' : 'their'} end could not be found`;
}

/**
 * Records what the HTML pass of a page kept, for the pass over the inline scripts Vite extracts from it.
 *
 * @param strippedPage - The page once stripped, or exactly as written when a file-level directive kept it whole.
 *
 * @returns The body of every JavaScript `<script>` block of the page, with `\n` line endings.
 */
function readHtmlPageScripts(strippedPage: string): ReadonlySet<string> {
	return new Set(
		createSourceLayout(strippedPage, 'html').regions.map((region) =>
			normalizeLineEndings(strippedPage.slice(region.start, region.end)),
		),
	);
}

/**
 * Reports whether an inline script Vite extracted from an HTML page must be left as the page's own pass left it.
 *
 * @remarks
 * Vite hands each inline module script of a page back under an `html-proxy` id, after the page itself went through
 * this plugin. The directives protecting that script are HTML comments of the page, which the extracted script no
 * longer holds, so the page's pass is the one that decides: a script it left as it is now is not scanned again. A
 * page a file-level directive ignores is recorded unchanged, so each of its own scripts is kept that way. A script
 * the page never held — one another plugin's `transformIndexHtml` injected — is stripped like any other, whether or
 * not the page holds a call of its own. Vite's HTML parser turns every line ending into `\n`, so the bodies are
 * compared on normalized line endings.
 *
 * @param htmlPages - The pages transformed so far in the running environment.
 * @param code - The extracted script.
 * @param id - The `html-proxy` id of the script.
 *
 * @returns `true` when the script must not be transformed.
 */
function isKeptByHtmlPage(htmlPages: ReadonlyMap<string, ReadonlySet<string>>, code: string, id: string): boolean {
	return htmlPages.get(stripQuery(id))?.has(normalizeLineEndings(code)) === true;
}

/**
 * Creates what the two passes of one plugin instance share, from the options the consumer passed.
 *
 * @param options - Plugin configuration. Every field is optional.
 *
 * @returns The resolved options, the matchers and scan context built from them, and empty per-build records.
 */
function createStripperInstance(options: Options | undefined): StripperInstance {
	const OPTIONS = getOptions(options);
	const SCAN_CONTEXT = createScanContext(OPTIONS, 'script');

	return {
		options: OPTIONS,
		scanContext: SCAN_CONTEXT,
		callProbe: createConsoleCallProbe(SCAN_CONTEXT.pattern),
		isIgnoredProjectPath: createIgnoreMatcher(getProjectIgnoredPaths(OPTIONS)),
		isIgnoredUserPath: createIgnoreMatcher({ anyDepth: getUserIgnoredPaths(OPTIONS), rootAnchored: [] }),
		hasProcessedExtension: createExtensionMatcher(OPTIONS.extensions),
		ignoredDependencies: new Set<string>(OPTIONS.ignoreDependencies),
		buildStates: createBuildStateStore(),
		reportedWarnings: new Set(),
		fallback: { root: process.cwd(), logger: null, plugins: [], resolved: null },
		hasWarnedAboutFastCompile: false,
	};
}

/**
 * Returns the Vite root of the build a hook runs in.
 *
 * @param instance - The plugin instance.
 * @param context - The plugin context of the running hook, `undefined` when the hook is called without one.
 *
 * @returns The root of the hook's environment, or the one of the last configuration resolved.
 */
function getRoot(instance: StripperInstance, context: EnvironmentAwareContext | undefined): string {
	return context?.environment?.config?.root ?? instance.fallback.root;
}

/**
 * Returns the logger of the build a hook runs in.
 *
 * @param instance - The plugin instance.
 * @param context - The plugin context of the running hook, `undefined` when the hook is called without one.
 *
 * @returns The logger of the hook's environment, the one of the last configuration resolved, or `null` before any
 *   was.
 */
function getLogger(instance: StripperInstance, context: EnvironmentAwareContext | undefined): Logger | null {
	return context?.environment?.config?.logger ?? instance.fallback.logger;
}

/**
 * Returns the plugins of the build a hook runs in.
 *
 * @param instance - The plugin instance.
 * @param context - The plugin context of the running hook, `undefined` when the hook is called without one.
 *
 * @returns The plugins of the hook's environment, or the ones of the last configuration resolved, in the order they
 *   run.
 */
function getPlugins(
	instance: StripperInstance,
	context: EnvironmentAwareContext | undefined,
): readonly { name: string }[] {
	return context?.environment?.config?.plugins ?? instance.fallback.plugins;
}

/**
 * Reports a warning about the module the running `transform` reads, once per plugin instance.
 *
 * @remarks
 * The plugin context's `warn` goes through the build's `onwarn` / `onLog` handling and names the module and the
 * position itself, so it is preferred; the logger only stands in when the hook was called without such a context.
 * Every environment of a build transforms a module it shares on its own — the client and the SSR build both read a
 * shared component — so a warning already reported for the module is not repeated.
 *
 * @param instance - The plugin instance.
 * @param warning - The context, the module identifier, the message and the position it points at.
 */
function reportModuleWarning(instance: StripperInstance, warning: ModuleWarning): void {
	const { context, id, message, position } = warning;
	const KEY = `${id}\n${message}`;

	if (instance.reportedWarnings.has(KEY)) {
		return;
	}

	instance.reportedWarnings.add(KEY);

	if (hasWarningContext(context)) {
		context.warn(message, position);

		return;
	}

	getLogger(instance, context)?.warn(`[console-stripper] ${message}`);
}

/**
 * Warns once per plugin instance when Analog's `fastCompile` mode reads the authored source before this plugin.
 *
 * @param instance - The plugin instance.
 * @param context - The plugin context of the running hook, `undefined` when the hook is called without one.
 */
function warnAboutFastCompileOrder(instance: StripperInstance, context: EnvironmentAwareContext | undefined): void {
	if (instance.hasWarnedAboutFastCompile || !isFastCompiledFirst(getPlugins(instance, context))) {
		return;
	}

	instance.hasWarnedAboutFastCompile = true;

	getLogger(instance, context)?.warn(
		`[console-stripper] ${FAST_COMPILE_PLUGIN_NAME} runs before console-stripper, which then reads its emit: a file-level ignore directive written above a type-only import is dropped with it. List consoleStripper() before angular() in the plugins`,
	);
}

/**
 * Reports whether the Angular compiler replaces a module in the build a hook runs in, which leaves the module to the
 * compiled pass.
 *
 * @remarks
 * Both passes decide through this one test, so a module is always scanned by exactly one of them. The compiler never
 * reads a dependency, and a `.ts` module it does not compile reaches the compiled pass unchanged, where it is stripped
 * all the same.
 *
 * @param instance - The plugin instance.
 * @param id - The module identifier.
 * @param context - The plugin context of the running hook, `undefined` when the hook is called without one.
 *
 * @returns `true` when the module is a project TypeScript module and the Angular compiler is registered.
 */
function isAngularCompilerInput(
	instance: StripperInstance,
	id: string,
	context: EnvironmentAwareContext | undefined,
): boolean {
	if (id.startsWith('\0') || getFileKind(id) !== 'ts' || isDependencyPath(id)) {
		return false;
	}

	return isCompiledByAngular(getPlugins(instance, context));
}

/**
 * Scans a module, reading a component Astro compiled first as the script it has become.
 *
 * @remarks
 * Once compiled, the template text lives in template literals, which the script scan never edits, and the frontmatter
 * statements in a function body, where they are removed. Only the main module is compiled: a query names one of its
 * sub-requests, whose kind the id already tells. The directives the compiler dropped are read from the source map it
 * attached; a map that cannot be read is reported for a project component, and the component is then stripped without
 * them. A dependency is not the consumer's to fix, so its map is never reported.
 *
 * @param instance - The plugin instance.
 * @param module - The module source, its identifier, the kind the id resolves to and whether it is a dependency.
 * @param context - The plugin context of the running `transform` hook, `undefined` when it is called without one.
 *
 * @returns The edits, the calls left in place and whether a file-level directive kept the whole module.
 */
function scanModule(
	instance: StripperInstance,
	module: StrippableModule,
	context: EnvironmentAwareContext | undefined,
): ConsoleScan {
	const { code, id, fileKind, isDependency } = module;

	if (fileKind !== 'astro' || id.includes('?') || !isCompiledByAstroFirst(getPlugins(instance, context))) {
		return scanConsoleCalls(code, { ...instance.scanContext, fileKind });
	}

	const SCAN = scanCompiledAstroComponent(code, instance.scanContext);

	if (SCAN.sourceMapError != null && !isDependency) {
		reportModuleWarning(instance, {
			context,
			id,
			message: `the source map Astro attached to ${toRelativePath(id, getRoot(instance, context))} could not be read (${SCAN.sourceMapError}), so its ignore directives were not applied`,
		});
	}

	return SCAN;
}

/**
 * Decides whether the module must be left untouched, applying the project rules or the dependency rules.
 *
 * @param instance - The plugin instance.
 * @param module - The module identifier and whether it is installed under `node_modules`.
 * @param context - The plugin context of the running `transform` hook, `undefined` when it is called without one.
 *
 * @returns `true` when the module must not be transformed.
 */
function isIgnoredModule(
	instance: StripperInstance,
	module: { id: string; isDependency: boolean },
	context: EnvironmentAwareContext | undefined,
): boolean {
	const { id, isDependency } = module;
	const ROOT = getRoot(instance, context);

	if (!isDependency) {
		return instance.isIgnoredProjectPath(toRelativePath(id, ROOT));
	}

	if (!instance.options.stripDependencies) {
		return true;
	}

	if (instance.ignoredDependencies.size > 0) {
		const OWNING_PACKAGE = getOwningPackage(id);

		if (OWNING_PACKAGE != null && instance.ignoredDependencies.has(OWNING_PACKAGE)) {
			return true;
		}
	}

	return instance.isIgnoredUserPath(toRelativePath(id, ROOT));
}

/**
 * Strips a module no rule leaves untouched, counting what was stripped and what was left in place.
 *
 * @param instance - The plugin instance.
 * @param module - The module source, its identifier, the kind the id resolves to and whether it is a dependency.
 * @param context - The plugin context of the running `transform` hook, `undefined` when it is called without one.
 *
 * @returns The stripped code and its source map, or `null` when nothing changed.
 */
function stripModule(
	instance: StripperInstance,
	module: StrippableModule,
	context: EnvironmentAwareContext | undefined,
): StrippedModule | null {
	const { code, id, fileKind, isDependency } = module;
	const STATE = instance.buildStates.getBuildState(context);
	const IS_HTML_PROXY = HTML_PROXY_REGEX.test(id);

	if (IS_HTML_PROXY && isKeptByHtmlPage(STATE.htmlPages, code, id)) {
		return null;
	}

	const SCAN = scanModule(instance, module, context);
	const TRANSFORMED_CODE = applyEdits(code, SCAN.edits);
	const [FIRST_SKIPPED_INDEX] = SCAN.skipped;
	const TALLY = isDependency ? STATE.dependencyTally : STATE.projectTally;

	TALLY.skippedCallCount += SCAN.skipped.length;

	// Pointing at the first call left in place lets the bundler print its line, its column and a code frame. A
	// dependency is not the consumer's to fix, so its calls only reach the `verbose` summary
	if (FIRST_SKIPPED_INDEX != null && !isDependency) {
		reportModuleWarning(instance, {
			context,
			id,
			message: formatSkippedCallsWarning(SCAN.skipped.length, toRelativePath(id, getRoot(instance, context))),
			position: FIRST_SKIPPED_INDEX,
		});
	}

	// Recorded even when nothing changed: the page may only hold protected calls, or be ignored by a file-level
	// directive, and its inline scripts must stay that way once Vite extracts them. The `html-proxy` ids of the page's
	// inline styles share its extension
	if (fileKind === 'html' && !IS_HTML_PROXY) {
		STATE.htmlPages.set(stripQuery(id), readHtmlPageScripts(TRANSFORMED_CODE));
	}

	if (SCAN.edits.length === 0) {
		return null;
	}

	TALLY.fileCount++;
	TALLY.callCount += SCAN.edits.length;

	// An edit shifts every later column, so the map keeps the consumer's sourcemaps pointing at the original positions;
	// a build wanting no source map would only discard it, so it is not even generated
	if (!isSourcemapWanted(context, instance.fallback.resolved)) {
		return { code: TRANSFORMED_CODE, map: null };
	}

	return {
		code: TRANSFORMED_CODE,
		map: generateEditSourceMap({
			source: code,
			edits: SCAN.edits,
			// The inline script of an HTML page is a module of its own, which Vite names by its `html-proxy` id in the
			// maps it emits: naming the page would pair the page's path with the script's columns
			file: IS_HTML_PROXY ? id : stripQuery(id),
		}),
	};
}

/**
 * Runs the source pass over one module: strips it, or records the directives of a module the Angular compiler
 * replaces for the compiled pass.
 *
 * @param instance - The plugin instance.
 * @param source - The module source and its identifier.
 * @param context - The plugin context of the running `transform` hook, `undefined` when it is called without one.
 *
 * @returns The stripped code and its source map, or `null` when the module is left as it is.
 */
function transformSource(
	instance: StripperInstance,
	source: { code: string; id: string },
	context: EnvironmentAwareContext | undefined,
): StrippedModule | null {
	const { code, id } = source;

	// Cheapest first: virtual modules (`\0…`) never belong to the consumer's sources, and both the extension test and
	// the `console` scan reject a file without inspecting its path, which matters once every dependency is scanned too
	if (id.startsWith('\0') || !instance.hasProcessedExtension(id) || !hasConsoleToken(code)) {
		return null;
	}

	// The compiler discards this code for the JavaScript it emits, which drops a directive attached to a declaration it
	// erases, such as a leading `import type`, and every directive when its tsconfig sets `removeComments`: what the
	// directives protect is read here, for the compiled pass
	if (isAngularCompilerInput(instance, id, context)) {
		const SCOPE = getDirectiveScope(code, { ...instance.scanContext, fileKind: 'ts' });

		if (SCOPE !== 'none') {
			instance.buildStates.getBuildState(context).angularInputScopes.set(id, SCOPE);
		}

		return null;
	}

	const IS_DEPENDENCY = isDependencyPath(id);

	// A file naming `console` without calling any stripped method has no edit to find, and the probe rejects it before
	// the scan walks the source
	if (isIgnoredModule(instance, { id, isDependency: IS_DEPENDENCY }, context) || !instance.callProbe?.test(code)) {
		return null;
	}

	return stripModule(instance, { code, id, fileKind: getFileKind(id), isDependency: IS_DEPENDENCY }, context);
}

/**
 * Runs the compiled pass over one module the Angular compiler emitted.
 *
 * @remarks
 * The emit keeps the comments of the code the compiler did not erase, so the next-line and range directives are
 * normally still there. When the authored source held one and the emit holds no directive token at all, the compiler
 * removed the comments, and stripping the emit would drop the very calls they protect: the module is left whole and
 * the consumer is told why.
 *
 * @param instance - The plugin instance.
 * @param source - The emitted code and the module identifier.
 * @param context - The plugin context of the running `transform` hook, `undefined` when it is called without one.
 *
 * @returns The stripped code and its source map, or `null` when the module is left as it is.
 */
function transformAngularEmit(
	instance: StripperInstance,
	source: { code: string; id: string },
	context: EnvironmentAwareContext | undefined,
): StrippedModule | null {
	const { code, id } = source;

	if (!isAngularCompilerInput(instance, id, context) || !instance.hasProcessedExtension(id) || !hasConsoleToken(code)) {
		return null;
	}

	if (isIgnoredModule(instance, { id, isDependency: false }, context) || !instance.callProbe?.test(code)) {
		return null;
	}

	const SCOPE = instance.buildStates.getBuildState(context).angularInputScopes.get(id);

	if (SCOPE === 'file') {
		return null;
	}

	if (SCOPE === 'lines' && !hasIgnoreDirectiveToken(code)) {
		reportModuleWarning(instance, {
			context,
			id,
			message: `the Angular compiler removed the ignore comments of ${toRelativePath(id, getRoot(instance, context))} (e.g. "removeComments": true in its tsconfig), so the file was left unstripped`,
		});

		return null;
	}

	return stripModule(instance, { code, id, fileKind: 'ts', isDependency: false }, context);
}

/**
 * Vite plugin that strips `console.*` calls from the production build.
 *
 * The plugin runs during `vite build` only, before any other transform, so that it still sees the comments carrying
 * its ignore directives. A call forming a statement of its own is removed together with its trailing semicolon, and
 * with the whole line when the statement was alone on it; a call used inside a larger expression is replaced by
 * `void 0`, which keeps the surrounding code parsing exactly as it did. A source map is produced for every changed
 * file whenever the build asks for one, so that the original line and column numbers survive the edit.
 *
 * Project files can be skipped by extension, by path token, and by the `console-stripper-ignore`,
 * `console-stripper-ignore-next-line` and `console-stripper-ignore-start` / `console-stripper-ignore-end` comment
 * directives. Dependencies installed under `node_modules` are stripped as well, unless `stripDependencies` is
 * `false` or their package is listed in `ignoreDependencies`; the built-in ignore list never applies to them.
 *
 * How much of a file may be edited follows from its extension: a script is editable throughout, an HTML document
 * only inside its `<script>` blocks, and every other extension — the component formats and anything the presets do
 * not name — is treated as markup, where a statement is only removed inside a `<script>` block; a `.vue` template
 * reads only its `{{ … }}` interpolations and directive values as expressions, a Markdown-based template leaves its
 * fenced code blocks as text, and a `.ts` script never reads a `<` as the start of a JSX element. An Astro component
 * adds its `---` frontmatter to those blocks; no other extension reads the fence, where three dashes open a data
 * block instead. An Astro component Astro's own compiler already turned into TypeScript is read as a script, with
 * the directives the compiler dropped read back from its source map and its `is:inline` scripts stripped as page
 * scripts, and an inline script Vite extracts from an HTML page keeps whatever the page's own directives protected.
 *
 * When Analog's Angular compiler (`@analogjs/vite-plugin-angular`, outside its `fastCompile` mode) is registered, it
 * replaces every project TypeScript module with the JavaScript it compiled from disk, so those modules are left to a
 * second plugin, which runs with `enforce: 'post'` and strips that JavaScript instead. The directives of the authored
 * source still apply: a file-level one keeps its module even when the compiler dropped it, and a module whose
 * next-line or range directives the compiler removed (`removeComments`) is left unstripped, with a warning.
 *
 * @param options - Plugin configuration. Every field is optional.
 *
 * @returns The Vite plugins stripping console calls during the build: the source pass, then the pass over the
 *   modules the Angular compiler emits.
 */
function consoleStripper(options?: Options): [Plugin, Plugin] {
	const INSTANCE = createStripperInstance(options);

	// Vite resolves the configuration once per environment, and the lists never change after the factory ran
	let hasCheckedLists = false;

	const SOURCE_PASS: Plugin = {
		name: PLUGIN_NAME,
		apply: 'build',
		// esbuild drops comments, so the ignore directives must be read before any other transform runs
		enforce: 'pre',
		configResolved(config) {
			INSTANCE.fallback = { root: config.root, logger: config.logger, plugins: config.plugins, resolved: config };

			if (!hasCheckedLists) {
				hasCheckedLists = true;
				warnAboutEmptyLists(options, INSTANCE.options, config.logger);
			}
		},
		buildStart() {
			INSTANCE.buildStates.clearBuildState(this);
			warnAboutFastCompileOrder(INSTANCE, this);
		},
		transform(code, id) {
			return transformSource(INSTANCE, { code, id }, this);
		},
		buildEnd(error) {
			const NAME = getEnvironmentName(this);
			const STATE = INSTANCE.buildStates.getBuildState(this);

			INSTANCE.buildStates.clearBuildState(this);

			// A failed build has nothing to summarize: the counters only cover the files transformed before it broke
			if (error != null || !INSTANCE.options.verbose) {
				return;
			}

			getLogger(INSTANCE, this)?.info(formatBuildSummary(NAME, STATE));
		},
	};

	const ANGULAR_PASS: Plugin = {
		name: ANGULAR_PASS_PLUGIN_NAME,
		apply: 'build',
		// After every normal-order plugin, so it reads what the Angular compiler emitted, whatever order the consumer
		// listed the plugins in
		enforce: 'post',
		transform(code, id) {
			return transformAngularEmit(INSTANCE, { code, id }, this);
		},
	};

	return [SOURCE_PASS, ANGULAR_PASS];
}

export type { ConsoleMethod, Options } from './types';

export default consoleStripper;

export {
	ASTRO_EXTENSIONS,
	DEFAULT_EXTENSIONS,
	DEFAULT_METHODS,
	HTML_EXTENSIONS,
	JAVASCRIPT_EXTENSIONS,
	JSX_EXTENSIONS,
	SCRIPT_EXTENSIONS,
	SVELTE_EXTENSIONS,
	TYPESCRIPT_EXTENSIONS,
	VUE_EXTENSIONS,
};
