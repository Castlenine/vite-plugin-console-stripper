/**
 * Every method of the global `console` object this plugin recognizes.
 *
 * @remarks
 * `exception` is a non-standard alias of `error`. It is part of the union so that legacy code bases can name it
 * explicitly, but it is never stripped by default.
 */
type ConsoleMethod =
	| 'assert'
	| 'clear'
	| 'count'
	| 'countReset'
	| 'debug'
	| 'dir'
	| 'dirxml'
	| 'error'
	| 'exception'
	| 'group'
	| 'groupCollapsed'
	| 'groupEnd'
	| 'info'
	| 'log'
	| 'profile'
	| 'profileEnd'
	| 'table'
	| 'time'
	| 'timeEnd'
	| 'timeLog'
	| 'timeStamp'
	| 'trace'
	| 'warn';

interface Options {
	/**
	 * Console methods to strip, replacing the built-in list (e.g. `['log', 'debug']`)
	 *
	 * Default: every method except `clear`, `error`, `exception`, `info` and `warn`. Unknown names are dropped.
	 */
	methods?: readonly ConsoleMethod[];
	/**
	 * File extensions to process, without the leading dot (e.g. `['ts', 'svelte']`)
	 *
	 * Default: `DEFAULT_EXTENSIONS`. Compose the exported presets instead of listing extensions by hand, for example
	 * `[...SCRIPT_EXTENSIONS, ...SVELTE_EXTENSIONS]`. An extension no preset names is scanned in markup mode, where
	 * only a `<script>` block is emptied.
	 */
	extensions?: readonly string[];
	/**
	 * Honor the `console-stripper-ignore*` comment directives. Default: `true`
	 */
	ignoreComments?: boolean;
	/**
	 * Folders to skip, relative to the Vite root (e.g. `['src/tests', 'fixtures']`)
	 *
	 * A token matches on path-segment boundaries only: `build` matches `build/app.js` but not `buildhome/app.js`.
	 * `*` matches any characters within a single segment (e.g. `*.stories`).
	 */
	ignoreFolders?: readonly string[];
	/**
	 * Files to skip, relative to the Vite root (e.g. `['Header.svelte', 'src/components/Modal.svelte']`)
	 *
	 * Same matching rules as `ignoreFolders`.
	 */
	ignoreFiles?: readonly string[];
	/**
	 * Apply the built-in ignore list (`.git`, `build`, `dist`, `public`, `.svelte-kit`, …) on top of `ignoreFolders` /
	 * `ignoreFiles`. Default: `true`
	 *
	 * The built-in list only ever applies to the project's own files. Dependencies are governed by
	 * `stripDependencies` and `ignoreDependencies`.
	 */
	ignoreDefaults?: boolean;
	/**
	 * Also strip the console calls of the files installed under `node_modules`. Default: `true`
	 *
	 * Set to `false` to leave every dependency untouched.
	 */
	stripDependencies?: boolean;
	/**
	 * Package names whose files are left untouched (e.g. `['some-logger', '@scope/pkg']`). Default: `[]`
	 *
	 * A name is compared for exact equality against the package owning the file, which is the one named by the last
	 * `node_modules/` segment of its path. Listing a package does not cover the packages nested inside it.
	 */
	ignoreDependencies?: readonly string[];
	/**
	 * Print one summary line when the build ends. Default: `false`
	 */
	verbose?: boolean;
}

/**
 * A single replacement in the original source: the half-open `[start, end)` character range is replaced by
 * `replacement` (the empty string when the statement is removed outright)
 */
interface Edit {
	start: number;
	end: number;
	replacement: string;
}

type ResolvedOptions = Required<Options>;

export type { ConsoleMethod, Edit, Options, ResolvedOptions };
