import type { ConsoleMethod, Edit, Options, ResolvedOptions } from './types';
import type { MappedSegment } from './sourcemap';

import { Buffer } from 'node:buffer';
import { relative, sep } from 'node:path';

import { decodeMappings } from './sourcemap';

/**
 * Built-in ignore tokens matched on every path segment, at any depth
 *
 * @remarks
 * Dependencies are nested by design (workspace packages, the pnpm store), so anchoring these two to the Vite
 * root would let a dependency's markup through.
 */
const ANY_DEPTH_DEFAULT_IGNORE_PATHS: readonly string[] = Object.freeze([
	// Node modules
	'node_modules',

	// Git
	'.git',
] as const);

/**
 * Built-in ignore tokens matched only as the first segment under the Vite root
 *
 * @remarks
 * Every token here names a generated or tooling entry that lives at the root of a project. Matching them on
 * any segment silently skipped ordinary source files — `src/routes/public/+page.svelte`,
 * `src/lib/build/Step.svelte`, `src/e2e/Foo.tsx` — and shipped the console calls the plugin was asked to strip.
 */
const ROOT_ANCHORED_DEFAULT_IGNORE_PATHS: readonly string[] = Object.freeze([
	// IDE configurations
	'.idea', // JetBrains IDEs (e.g., WebStorm)
	'.vscode', // Visual Studio Code

	// OS generated files
	'.DS_Store', // macOS
	'Thumbs.db', // Windows

	// Environment variables
	'.env',
	'.env.*', // .env.development, .env.production, etc.

	// Logs
	'logs',
	'*.log',

	// Svelte
	'public', // Svelte.js public folder
	'build', // Svelte.js build folder

	// SvelteKit
	'.svelte-kit', // SvelteKit generates this folder

	// Dist
	'dist', // Distribution folder

	// Vue.js
	'.nuxt', // Nuxt.js generates this folder

	// Nitro (Nuxt, SolidStart, TanStack Start)
	'.output', // Nitro production output
	'.nitro', // Nitro development folder
	'.data', // Nitro local data (e.g., the Nuxt development database)

	// React.js
	'.next', // Next.js generates this folder
	'out', // Next.js static export folder

	// Remix / React Router
	'.react-router', // React Router v7 generates its types here

	// Astro
	'.astro', // Astro generates its types and its content cache here

	// SolidStart
	'.solid', // SolidStart build folder
	'.vinxi', // Vinxi cache, used by SolidStart 1.x

	// TanStack Start
	'.tanstack', // TanStack Start generates this folder

	// Angular
	'.angular', // Angular CLI cache
	'e2e', // End-to-end tests in Angular
	'angular.json', // Angular CLI configuration
	'browserslist', // Browser compatibility list for Angular

	// Deploy adapters
	'.vercel', // Vercel build output
	'.netlify', // Netlify build output
	'.wrangler', // Cloudflare Workers and Pages local state

	'.cache', // Cache files for various tools
] as const);

/**
 * Every built-in ignore token, any-depth ones first
 */
const DEFAULT_IGNORE_PATHS: readonly string[] = Object.freeze([
	...ANY_DEPTH_DEFAULT_IGNORE_PATHS,
	...ROOT_ANCHORED_DEFAULT_IGNORE_PATHS,
] as const);

/**
 * Console methods stripped when `Options.methods` is not provided. `clear`, `error`, `exception`, `info` and `warn`
 * are deliberately absent: they carry information a production build still needs.
 */
const DEFAULT_METHODS: readonly ConsoleMethod[] = Object.freeze([
	'assert',
	'count',
	'countReset',
	'debug',
	'dir',
	'dirxml',
	'group',
	'groupCollapsed',
	'groupEnd',
	'log',
	'profile',
	'profileEnd',
	'table',
	'time',
	'timeEnd',
	'timeLog',
	'timeStamp',
	'trace',
] as const);

/**
 * Every name accepted in `Options.methods`. A consumer string that is not in this set never reaches `new RegExp`.
 */
const KNOWN_METHODS = new Set<string>([
	'assert',
	'clear',
	'count',
	'countReset',
	'debug',
	'dir',
	'dirxml',
	'error',
	'exception',
	'group',
	'groupCollapsed',
	'groupEnd',
	'info',
	'log',
	'profile',
	'profileEnd',
	'table',
	'time',
	'timeEnd',
	'timeLog',
	'timeStamp',
	'trace',
	'warn',
]);

/**
 * JavaScript source extensions
 */
const JAVASCRIPT_EXTENSIONS: readonly string[] = Object.freeze(['js', 'mjs', 'cjs'] as const);

/**
 * TypeScript source extensions
 */
const TYPESCRIPT_EXTENSIONS: readonly string[] = Object.freeze(['ts', 'mts', 'cts'] as const);

/**
 * JSX and TSX source extensions, used by React, Preact, Solid, Qwik and Vue JSX
 */
const JSX_EXTENSIONS: readonly string[] = Object.freeze(['jsx', 'tsx'] as const);

/**
 * Every extension whose file is plain script: JavaScript, TypeScript and JSX
 */
const SCRIPT_EXTENSIONS: readonly string[] = Object.freeze([
	...JAVASCRIPT_EXTENSIONS,
	...TYPESCRIPT_EXTENSIONS,
	...JSX_EXTENSIONS,
] as const);

/**
 * Svelte single-file component extension (`.svelte.js` and `.svelte.ts` rune modules are already plain script)
 */
const SVELTE_EXTENSIONS: readonly string[] = Object.freeze(['svelte'] as const);

/**
 * Vue single-file component extension
 */
const VUE_EXTENSIONS: readonly string[] = Object.freeze(['vue'] as const);

/**
 * Astro component extension
 */
const ASTRO_EXTENSIONS: readonly string[] = Object.freeze(['astro'] as const);

/**
 * HTML document extensions, whose inline `<script>` blocks really execute
 */
const HTML_EXTENSIONS: readonly string[] = Object.freeze(['html', 'htm'] as const);

/**
 * Every extension processed when `Options.extensions` is not provided
 */
const DEFAULT_EXTENSIONS: readonly string[] = Object.freeze([
	...SCRIPT_EXTENSIONS,
	...SVELTE_EXTENSIONS,
	...VUE_EXTENSIONS,
	...ASTRO_EXTENSIONS,
	...HTML_EXTENSIONS,
] as const);

const SCRIPT_EXTENSION_SET = new Set<string>(SCRIPT_EXTENSIONS);
const TYPESCRIPT_EXTENSION_SET = new Set<string>(TYPESCRIPT_EXTENSIONS);
const HTML_EXTENSION_SET = new Set<string>(HTML_EXTENSIONS);
const ASTRO_EXTENSION_SET = new Set<string>(ASTRO_EXTENSIONS);
const VUE_EXTENSION_SET = new Set<string>(VUE_EXTENSIONS);

/**
 * Markdown-based template extensions (Markdown, MDX, mdsvex), whose fenced code blocks are text no framework runs
 */
const MARKDOWN_EXTENSION_SET = new Set<string>(['md', 'mdx', 'svx']);

/**
 * `type` attribute values that make a `<script>` tag hold JavaScript. Anything else (`application/json`,
 * `importmap`, `text/template`, …) is a data block whose content never executes.
 */
const JAVASCRIPT_SCRIPT_TYPES = new Set<string>([
	'application/ecmascript',
	'application/javascript',
	'application/x-ecmascript',
	'application/x-javascript',
	'module',
	'text/babel',
	'text/ecmascript',
	'text/javascript',
	'text/jscript',
	'text/jsx',
	'text/livescript',
	'text/x-ecmascript',
	'text/x-javascript',
]);

/**
 * Object names whose `console` member is the global console, and which are therefore part of the edited range
 */
const QUALIFIER_NAMES = new Set<string>(['global', 'globalThis', 'self', 'window']);

/**
 * Characters after which a `/` opens a regular expression literal rather than a division. `<` and `>` are absent on
 * purpose: `</tag>` must never open one. The `=>` of an arrow function, the `)` of a control header and a postfix
 * `++` / `--` are handled separately.
 */
const REGEX_ALLOWED_AFTER_CHARACTERS = '(,=:[!&|?{};+-*%~^';

/**
 * Keywords after which a `/` opens a regular expression literal
 */
const REGEX_ALLOWED_AFTER_KEYWORDS = new Set<string>([
	'await',
	'case',
	'default',
	'delete',
	'do',
	'else',
	'in',
	'instanceof',
	'new',
	'of',
	'return',
	'throw',
	'typeof',
	'void',
	'yield',
]);

/**
 * Keywords whose parenthesized header is followed by a statement rather than by an operator: the `)` closing that
 * header neither ends a value nor forbids a regular expression literal right after it
 */
const CONTROL_KEYWORDS = new Set<string>(['for', 'if', 'while', 'with']);

/**
 * Words after which a line break never ends a statement, because the word still expects what follows it: an operand,
 * a declaration, a body or a type. Any other identifier ends a value, which automatic semicolon insertion terminates
 * at the line break.
 */
const OPERAND_KEYWORDS = new Set<string>([
	...REGEX_ALLOWED_AFTER_KEYWORDS,
	'abstract',
	'as',
	'async',
	'catch',
	'class',
	'const',
	'declare',
	'export',
	'extends',
	'finally',
	'for',
	'from',
	'function',
	'get',
	'if',
	'import',
	'keyof',
	'let',
	'readonly',
	'satisfies',
	'set',
	'static',
	'switch',
	'try',
	'type',
	'var',
	'while',
	'with',
]);

/**
 * Characters that would bind to the previous line when a statement removed without its semicolon lets automatic
 * semicolon insertion fuse the two neighbors
 */
const ASI_HAZARD_CHARACTERS = '([`+-/*';

/**
 * Characters that can only continue the expression written on the line above them.
 *
 * @remarks
 * A call followed on the next line by one of them was never terminated by automatic semicolon insertion, so it never
 * formed a statement of its own: removing it would leave the operator without its left operand.
 */
const CONTINUATION_CHARACTERS = '.,?%<>=&|^*/';

/**
 * Inequality operator, which can only continue the expression written on the line above it. Written as a whole
 * token, since a lone `!` opens a new statement.
 */
const INEQUALITY_OPERATOR = '!=';

/**
 * Keywords that can only continue the expression written on the line above them
 */
const CONTINUATION_KEYWORDS = new Set<string>(['in', 'instanceof']);

/**
 * Characters that would apply to the value `void 0` produces, and therefore require it to be parenthesized
 */
const MEMBER_ACCESS_CHARACTERS = '.[(`';

/**
 * Optional chain operator, which binds tighter than the `void` of the replacement: `void 0?.(x)` reads as
 * `void (0?.(x))`. Written as a whole token, since neither of its two characters alone implies the operator.
 */
const OPTIONAL_CHAIN_OPERATOR = '?.';

/**
 * Exponentiation operator, whose left operand may not be a unary expression: `void 0 ** 2` is a syntax error while
 * the `void 0 * 2` of an ordinary multiplication is not
 */
const EXPONENTIATION_OPERATOR = '**';

/**
 * Literal characters that end a value: the closing quote of a string, the closing backtick of a template literal and
 * the closing slash of a regular expression literal
 */
const LITERAL_VALUE_ENDING_CHARACTERS = '`\'"/';

/**
 * Characters after which a `{` opens a block of statements rather than an object literal or a JSX expression
 * container. `=>` is handled separately, since a bare `>` closes a markup tag.
 */
const BLOCK_BRACE_CHARACTERS = ';{}):';

/**
 * Keywords after which a `{` opens a block of statements
 */
const BLOCK_KEYWORDS = new Set<string>(['catch', 'do', 'else', 'finally', 'static', 'try']);

/**
 * Punctuation a TypeScript return type annotation may hold between the `:` opening it and the `{` of the function
 * body, besides identifiers, whitespace and string literal types
 */
const TYPE_ANNOTATION_CHARACTERS = '.<>[]|&,?';

/**
 * How many characters the walk back over a return type annotation may read. A type holding braces or parentheses is
 * never recognized anyway, so a longer walk would only spend time proving nothing.
 */
const RETURN_TYPE_LOOKBACK_LIMIT = 256;

/**
 * Modifiers a TypeScript type parameter may open with (`<const T,>`), which no JSX tag name is followed by
 */
const TYPE_PARAMETER_MODIFIERS = new Set<string>(['const', 'in', 'out']);

const EXTENDS_KEYWORD = 'extends';

/**
 * Sigils opening a Svelte block tag (`{#if …}`, `{:else}`, `{@html …}`), each followed by the name of the block
 */
const SVELTE_BLOCK_SIGILS = '#:@';

/**
 * Attribute name prefixes whose quoted value a Vue template evaluates as an expression: `@click`, `:prop`, `#slot`
 * and every `v-` directive
 */
const EXPRESSION_ATTRIBUTE_PREFIXES: readonly string[] = Object.freeze(['@', ':', '#', 'v-'] as const);

const REGEX_SPECIAL_CHARACTERS_REGEX = /[.*+?^${}()|[\]\\]/g;
const LEADING_RELATIVE_PREFIX_REGEX = /^(?:\/|\.\/|\.\.\/)+/;
const TRAILING_SLASHES_REGEX = /\/+$/;
const LEADING_PARENT_SEGMENTS_REGEX = /^(?:\.\.\/)+/;
const LEADING_DOTS_REGEX = /^\.+/;
const IDENTIFIER_CHARACTER_REGEX = /[\w$]/;
const WHITESPACE_REGEX = /\s/;
const ASCII_LETTER_REGEX = /[A-Za-z]/;
const JSX_NAME_START_REGEX = /[A-Za-z_$]/;

/**
 * Text starting on a character an identifier may continue with, which would fuse with a `void 0` written right
 * before it
 */
const IDENTIFIER_START_REGEX = /^[\p{ID_Continue}$]/u;

/**
 * Text ending on a character an identifier may hold. `$` and `#` are part of the class because the `\b` opening the
 * call pattern only knows the ASCII word characters, so `$console`, `#console` and `éconsole` all look like a fresh
 * `console` token to it.
 */
const IDENTIFIER_END_REGEX = /[\p{ID_Continue}$#]$/u;

/**
 * Sticky patterns reading one token at the position their `lastIndex` is set to right before each call, so the
 * position an earlier file left behind is never read
 */
const JSX_TAG_NAME_REGEX = /[A-Za-z_$][\w$.:-]*/y;

/**
 * Sticky patterns continuing a token whose first character the caller already checked. Each one matches the empty
 * string, so the match never fails and only where it ends is read, with {@link findStickyMatchEnd}.
 */
const MARKUP_TAG_NAME_REST_REGEX = /[^\s/>]*/y;
const ATTRIBUTE_NAME_REST_REGEX = /[^\s/>=]*/y;
const UNQUOTED_ATTRIBUTE_VALUE_REGEX = /[^\s>]*/y;
// eslint-disable-next-line security/detect-unsafe-regex -- linear: the letters, the whitespace run and `if` are disjoint classes, so each character has one possible owner
const SVELTE_BLOCK_NAME_REGEX = /[A-Za-z]*(?:\s+if(?![\w$]))?/y;

/**
 * Leading `---` fence of a front matter block, optionally preceded by a byte order mark, and the line break and
 * `---` closing it, searched from the line break ending the opening fence
 */
const FRONTMATTER_OPENER_REGEX = /^\uFEFF?---[^\S\n]*\r?\n/;
const FRONTMATTER_CLOSER_REGEX = /\n---/g;

/**
 * Opening fence of a Markdown fenced code block, read at the start of a line: up to three spaces of indentation, a run
 * of at least three backticks or tildes, and the info string that follows it
 */
const CODE_FENCE_OPENER_REGEX = /[ ]{0,3}(`{3,}|~{3,})([^\n]*)/y;
/**
 * Closing fence of a Markdown fenced code block, read at the start of a line: nothing but blanks may follow the run
 */
const CODE_FENCE_CLOSER_REGEX = /[ ]{0,3}(`{3,}|~{3,})[ \t]*(?=\r?\n|$)/y;
const BYTE_ORDER_MARK = '\uFEFF';
const SCRIPT_TAG_NAME = 'script';
const STYLE_TAG_NAME = 'style';
const SCRIPT_OPENER = '<script';
const SCRIPT_CLOSER = '</script';
const STYLE_CLOSER = '</style';
const JSX_FRAGMENT_CLOSER = '</>';

/**
 * Query token Vite appends to the inline `<script>` blocks it extracts from an HTML entry, matching the
 * `isHtmlProxyRE` of `vite/dist/node/chunks/node.js`. The `.js` suffix separates a script proxy from a style one.
 */
const HTML_PROXY_REGEX = /[?&]html-proxy\b/;
const HTML_PROXY_SCRIPT_SUFFIX = '.js';

/**
 * Query parameters naming the framework that split a component file into sub-requests. `@vitejs/plugin-vue` emits
 * `Foo.vue?vue&type=script…` and the Astro plugin `Foo.astro?astro&type=script…`; the Svelte plugin has no script
 * form, and emits `?svelte&type=style` only.
 */
const FRAMEWORK_SCRIPT_MARKERS = new Set<string>(['astro', 'vue']);

/**
 * The whole `type` parameter naming the part of the component a sub-request holds, name and value: only `script` is
 * plain JavaScript, where `type=template` and `type=style` are markup and CSS.
 */
const SCRIPT_TYPE_PARAMETER = 'type=script';

/**
 * Directive tokens, matched wherever they appear inside a comment so that every comment syntax works, including the
 * `<!-- … -->` comments of a Svelte, Vue or Astro template. The negative lookahead keeps the file-level form from
 * matching the three scoped forms, and an unknown suffix (`…-ignore-foo`) from matching at all.
 */
const DIRECTIVE_REGEX_SOURCE = 'console-stripper-ignore(-next-line|-start|-end)?(?![-\\w])';

const IGNORE_DIRECTIVE_TOKEN = 'console-stripper-ignore';
const CONSOLE_IDENTIFIER = 'console';
const NEW_KEYWORD = 'new';
const DEPENDENCY_SEGMENT = '/node_modules/';
const DEPENDENCY_PREFIX = 'node_modules/';
const SCOPE_PREFIX = '@';
const VOID_EXPRESSION = 'void 0';
const PARENTHESIZED_VOID_EXPRESSION = '(void 0)';
const SEMICOLON = ';';
const MARKUP_COMMENT_OPEN = '<!--';
const MARKUP_COMMENT_CLOSE = '-->';
const FILE_DIRECTIVE_LINE_LIMIT = 10;
/**
 * The tag of the template literals Astro compiles a component's markup into (`render as $$render`, imported from
 * `astro/compiler-runtime`), backtick included
 */
const RENDER_TEMPLATE_TAG = '$$render`';
/**
 * The start of the source map comment Astro's compiler appends to its output (`sourcemap: 'both'`)
 */
const INLINE_SOURCE_MAP_PREFIX = '//# sourceMappingURL=data:application/json;';
/**
 * The whole source map comment, read at the index its prefix was found at, with its base64 payload captured
 */
const INLINE_SOURCE_MAP_REGEX = /\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([\w+/=]+)/y;
/**
 * The characters after a `\` that start a template-literal escape not read as one character standing for one other:
 * a digit (`\0`, or an octal escape the specification rejects), a hexadecimal or Unicode escape, and a line
 * continuation, which stands for nothing at all
 */
const MULTI_CHARACTER_ESCAPE_REGEX = /[\dux\n\r\u2028\u2029]/;
/**
 * The value of each single-character template-literal escape that does not stand for the character it names
 */
const SINGLE_CHARACTER_ESCAPES: ReadonlyMap<string, string> = new Map([
	['b', '\b'],
	['f', '\f'],
	['n', '\n'],
	['r', '\r'],
	['t', '\t'],
	['v', '\v'],
]);

const MASK_CODE = 0;
const MASK_LITERAL = 1;
const MASK_COMMENT = 2;
const MASK_TEXT = 3;
const PROTECTED_FLAG = 1;
const NOT_FOUND = -1;
// What `createConsoleEdit` returns for a call it leaves in place because the end of the call could not be found
const UNDELIMITED_CALL = Symbol('undelimited console call');

const CHARACTER_CLASS_WHITESPACE = 1;
const CHARACTER_CLASS_IDENTIFIER = 2;
const CHARACTER_CODE_LIMIT = 0x10000;

/**
 * Byte-per-character map of a source file: `0` marks executable code (including the contents of a `${…}`
 * placeholder), `1` a string literal, template-literal text chunk or regular expression literal, `2` a comment, and
 * `3` text that never executes (markup, a JSX child, a data block)
 */
type CodeMask = Uint8Array;

/**
 * Source kind, which decides how much of a file may be edited.
 *
 * @remarks
 * - `script`: the whole file is executable code, except the text children of a JSX element.
 * - `ts`: a `.ts`, `.mts` or `.cts` script, which cannot hold JSX: a `<` is never read as the start of an element,
 *   so a type assertion (`<T>value`) can never turn the strings that follow it into JSX text.
 * - `markup`: a component document (`.svelte`, and every unrecognized extension). Statements are only removed inside
 *   a `<script>` block. Outside it only template expressions are code — `{…}` slots, Vue `{{ … }}` interpolations
 *   and the value of a Vue directive attribute — and a call there becomes `void 0`; every other character is text
 *   and is left exactly as written.
 * - `vue`: a `.vue` component, read as `markup` except that a single `{` opens nothing: only a `{{ … }}`
 *   interpolation and the value of a directive attribute are template expressions.
 * - `markdown`: a Markdown-based template (`.md`, `.mdx`, `.svx`), read as `markup` except that a fenced code block
 *   is text, whatever it holds.
 * - `astro`: a markup document whose leading `---` fence delimits executable frontmatter. Only this kind reads the
 *   fence: the same three dashes open a YAML front matter block in a Markdown-like template, where they hold data.
 * - `html`: a document whose `<script>` blocks execute and whose remaining text does not. A call outside every
 *   script block is left exactly as written, since page text and `<code>` samples never run.
 */
type FileKind = 'astro' | 'html' | 'markdown' | 'markup' | 'script' | 'ts' | 'vue';

/**
 * Half-open `[start, end)` character range of a source file
 */
interface Region {
	start: number;
	end: number;
}

/**
 * A range of a file holding executable code
 */
interface CodeRegion extends Region {
	/**
	 * `true` for a whole script, a `<script>` block or Astro frontmatter, where a call may form a statement of its
	 * own; `false` for a template expression, where it is always part of a larger expression
	 */
	allowsStatements: boolean;
}

/**
 * Everything the scan of one file reads: the code mask, the regions holding executable code in source order, and the
 * index of the backtick closing each template literal written in code, keyed by the index of its opening backtick
 */
interface SourceLayout {
	mask: CodeMask;
	regions: CodeRegion[];
	templateEnds: Map<number, number>;
}

/**
 * The call being measured and the region of the file its statement may span
 */
interface StatementBounds {
	start: number;
	callEnd: number;
	regionStart: number;
	regionEnd: number;
}

/**
 * Everything one scan of one file needs. The `pattern` is owned by a single plugin instance, so its `lastIndex`
 * is never shared across instances or files scanned concurrently.
 */
interface ScanContext {
	/** `null` when the resolved method list is empty, which makes the scan a no-op */
	pattern: RegExp | null;
	ignoreComments: boolean;
	fileKind: FileKind;
}

/**
 * The edits found in one source, and the calls left in place because they could not be delimited
 */
interface EditScan {
	/** The edits to apply, in source order and non-overlapping */
	edits: Edit[];
	/**
	 * The match index of every stripped-method call left in place because the end of the call could not be found
	 * within its region, in source order
	 */
	skipped: number[];
}

/**
 * The outcome of scanning one source
 */
interface ConsoleScan extends EditScan {
	/** `true` when a file-level `console-stripper-ignore` directive keeps the whole source untouched */
	isFileIgnored: boolean;
}

interface StripConsoleOptions extends Options {
	/**
	 * Source kind of the input: `'script'`, `'ts'`, `'markup'`, `'vue'`, `'markdown'`, `'astro'` or `'html'`.
	 * Default: `'script'`
	 *
	 * The plugin derives it from the module id with {@link getFileKind}; pass it explicitly when calling
	 * {@link stripConsole} directly.
	 */
	fileKind?: FileKind;
}

type DirectiveKind = 'end' | 'file' | 'next-line' | 'start';

/**
 * What the honored directives of a source protect: the whole file, some of its lines, or nothing
 */
type DirectiveScope = 'file' | 'lines' | 'none';

interface Directive {
	kind: DirectiveKind;
	lineIndex: number;
}

function escapeRegExp(value: string): string {
	return value.replace(REGEX_SPECIAL_CHARACTERS_REGEX, '\\$&');
}

function isConsoleMethod(value: unknown): value is ConsoleMethod {
	return typeof value === 'string' && KNOWN_METHODS.has(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim() !== '';
}

/**
 * Trims, drops every non-string or blank entry, and de-duplicates a list of names (package names, extensions).
 *
 * @param names - The consumer-supplied entries, which are not guaranteed to be strings.
 *
 * @returns The cleaned names, in the order they were first seen.
 */
function cleanNames(names: readonly unknown[]): string[] {
	return [...new Set(names.filter(isNonEmptyString).map((name) => name.trim()))];
}

/**
 * Resolves the consumer-supplied options into a fully populated object.
 *
 * @remarks
 * This is the plugin's trust boundary: the argument comes from a hand-written Vite configuration and is not
 * guaranteed to match {@link Options}. Anything that is not an array falls back to the built-in list, every array is
 * filtered element by element (method names against the known `console` members, paths, extensions and package
 * names against non-empty strings, the last two also trimmed and de-duplicated), and every flag is read with an explicit comparison so that a missing or malformed value
 * resolves to the documented default.
 *
 * @param options - The options passed to the plugin factory, possibly `undefined` or malformed.
 *
 * @returns The resolved options, with every field populated.
 */
function getOptions(options?: Options): ResolvedOptions {
	const SOURCE = options ?? {};

	return {
		methods: Array.isArray(SOURCE.methods) ? SOURCE.methods.filter(isConsoleMethod) : [...DEFAULT_METHODS],
		extensions: Array.isArray(SOURCE.extensions) ? cleanNames(SOURCE.extensions) : [...DEFAULT_EXTENSIONS],
		ignoreComments: SOURCE.ignoreComments !== false,
		ignoreFolders: Array.isArray(SOURCE.ignoreFolders) ? SOURCE.ignoreFolders.filter(isNonEmptyString) : [],
		ignoreFiles: Array.isArray(SOURCE.ignoreFiles) ? SOURCE.ignoreFiles.filter(isNonEmptyString) : [],
		ignoreDefaults: SOURCE.ignoreDefaults !== false,
		stripDependencies: SOURCE.stripDependencies !== false,
		ignoreDependencies: Array.isArray(SOURCE.ignoreDependencies) ? cleanNames(SOURCE.ignoreDependencies) : [],
		verbose: SOURCE.verbose === true,
	};
}

/**
 * Normalizes a user-supplied ignore token by trimming whitespace, turning Windows separators into `/`, removing
 * leading './', '../' or '/', and stripping trailing '/' characters.
 *
 * @remarks
 * The matcher compares tokens against paths relative to the Vite root with their leading `../` segments stripped, so
 * a token keeping one of those segments, or a `\` separator, could never match anything.
 *
 * @param path - The ignore token to normalize.
 *
 * @returns The normalized ignore token.
 */
function cleanIgnoredPath(path: string): string {
	return path
		.trim()
		.replaceAll('\\', '/')
		.replace(LEADING_RELATIVE_PREFIX_REGEX, '')
		.replace(TRAILING_SLASHES_REGEX, '');
}

/**
 * Normalizes and de-duplicates ignore tokens by:
 * - Trimming whitespace from each path
 * - Turning Windows separators into `/`
 * - Removing leading './', '../' or '/', and trailing '/' characters
 * - Dropping empty and root-only entries (such as `''`, `.`, `..`, `/`, and `./`)
 * - Removing duplicate entries in the result
 *
 * @remarks
 * The non-string guard is kept because this function is part of the module's surface and is called directly, not
 * only through {@link getOptions}, which already filters the consumer's arrays.
 *
 * @param paths - An array of ignore path tokens to be cleaned and de-duplicated.
 *
 * @returns A new array containing unique, cleaned ignore tokens, with all empty or root-only entries omitted.
 */
function cleanIgnoredPaths(paths: string[]): string[] {
	const CLEANED = paths
		.filter((path): path is string => typeof path === 'string')
		.map(cleanIgnoredPath)
		.filter((path) => path !== '' && path !== '.' && path !== '..');

	return [...new Set(CLEANED)];
}

/**
 * Returns the cleaned ignore tokens the consumer configured, without any built-in entry.
 *
 * @remarks
 * These are the only path tokens that apply to a dependency file. The built-in list holds entries such as `dist`,
 * `build` and `public`, which nearly every published package uses for its own output, so applying it to
 * dependencies would silently disable {@link ResolvedOptions.stripDependencies}.
 *
 * @param options - The resolved options containing `ignoreFolders` and `ignoreFiles`.
 *
 * @returns An array of unique, cleaned ignore path tokens.
 */
function getUserIgnoredPaths(options: ResolvedOptions): string[] {
	return cleanIgnoredPaths([...options.ignoreFolders, ...options.ignoreFiles]);
}

/**
 * Ignore tokens of one plugin instance, split by how deep in the tree they may match
 */
interface IgnoreTokens {
	anyDepth: readonly string[];
	rootAnchored: readonly string[];
}

/**
 * Returns the ignore tokens that apply to the project's own files, split by matching depth.
 *
 * @remarks
 * The consumer's tokens always match on any path segment. The built-in defaults are added unless `ignoreDefaults`
 * is `false`, and they are split: {@link ANY_DEPTH_DEFAULT_IGNORE_PATHS} join the any-depth group, while
 * {@link ROOT_ANCHORED_DEFAULT_IGNORE_PATHS} only match as the first segment under the Vite root.
 *
 * @param options - The resolved options containing `ignoreFolders`, `ignoreFiles` and the `ignoreDefaults` flag.
 *
 * @returns The unique, cleaned ignore tokens of each group.
 */
function getProjectIgnoredPaths(options: ResolvedOptions): IgnoreTokens {
	const CONFIGURED = getUserIgnoredPaths(options);

	if (!options.ignoreDefaults) {
		return { anyDepth: CONFIGURED, rootAnchored: [] };
	}

	return {
		anyDepth: [...new Set<string>([...CONFIGURED, ...ANY_DEPTH_DEFAULT_IGNORE_PATHS])],
		rootAnchored: [...ROOT_ANCHORED_DEFAULT_IGNORE_PATHS],
	};
}

/**
 * Removes the `?query` and `#hash` suffixes that Vite keeps on module IDs.
 *
 * For example, given `/src/App.svelte?svelte&type=style&lang.css`, this function will return `/src/App.svelte`, and
 * given `/src/app.ts#hash` or `/src/app.ts?raw#hash`, it will return `/src/app.ts`.
 *
 * @remarks
 * A `#` is only read as the start of a hash when no `/` follows it, so a `#` written in a folder name, as in
 * `/src/#internal/app.ts`, stays part of the path.
 *
 * @param id - The module ID which may include a `?query` and/or `#hash` suffix.
 *
 * @returns The module ID without any `?query` or `#hash` part.
 */
function stripQuery(id: string): string {
	const QUERY_INDEX = id.indexOf('?');
	const PATH = QUERY_INDEX === NOT_FOUND ? id : id.slice(0, QUERY_INDEX);
	const HASH_INDEX = PATH.lastIndexOf('#');
	const IS_HASH_SUFFIX = HASH_INDEX !== NOT_FOUND && !PATH.includes('/', HASH_INDEX);

	return IS_HASH_SUFFIX ? PATH.slice(0, HASH_INDEX) : PATH;
}

/**
 * Returns the path of a module ID relative to the Vite root directory, using POSIX separators.
 *
 * @param id - The module ID to be converted to a relative path.
 * @param root - The root directory to which the path will be made relative.
 *
 * @returns The relative path from the root to the module ID, using '/' as the separator.
 */
function toRelativePath(id: string, root: string): string {
	return relative(root, stripQuery(id)).split(sep).join('/');
}

/**
 * Normalizes a module ID for path inspection: the `?query` suffix is dropped and Windows separators become `/`.
 *
 * @param id - The module identifier.
 *
 * @returns The normalized path.
 */
function toPosixPath(id: string): string {
	return stripQuery(id).replaceAll('\\', '/');
}

/**
 * Reports whether the module is installed under a `node_modules` folder.
 *
 * @remarks
 * The absolute identifier is inspected rather than the path relative to the Vite root, so that dependencies hoisted
 * above the root (a monorepo package, a pnpm store) are recognized too.
 *
 * @param id - The module identifier, possibly including a query suffix.
 *
 * @returns `true` when the module belongs to a dependency.
 */
function isDependencyPath(id: string): boolean {
	const PATH = toPosixPath(id);

	return PATH.includes(DEPENDENCY_SEGMENT) || PATH.startsWith(DEPENDENCY_PREFIX);
}

/**
 * Locates where the owning package name starts in a normalized dependency path.
 *
 * @param path - The normalized path to inspect.
 *
 * @returns The index just after the last `node_modules/` segment, or `-1` when the path holds none.
 */
function findPackageNameStart(path: string): number {
	const LAST_SEGMENT_INDEX = path.lastIndexOf(DEPENDENCY_SEGMENT);

	if (LAST_SEGMENT_INDEX !== NOT_FOUND) {
		return LAST_SEGMENT_INDEX + DEPENDENCY_SEGMENT.length;
	}

	return path.startsWith(DEPENDENCY_PREFIX) ? DEPENDENCY_PREFIX.length : NOT_FOUND;
}

/**
 * Returns the first segment of a `/`-separated path.
 *
 * @param path - The normalized path to read.
 *
 * @returns The text before the first `/`, or the whole path when it holds none.
 */
function readFirstSegment(path: string): string {
	const SEPARATOR_INDEX = path.indexOf('/');

	return SEPARATOR_INDEX === NOT_FOUND ? path : path.slice(0, SEPARATOR_INDEX);
}

/**
 * Resolves the package that owns a dependency file.
 *
 * @remarks
 * The owner is the package named right after the *last* `node_modules/` segment, which resolves nested
 * installs (`…/node_modules/a/node_modules/b/x.js` belongs to `b`) and the pnpm store
 * (`…/node_modules/.pnpm/a@1.0.0/node_modules/a/dist/x.js` belongs to `a`). A scope is part of the name.
 *
 * A published package name can never begin with a dot, so a dot-directory sitting directly under `node_modules`
 * (`.pnpm`, `.vite`, `.cache`, `.bin`) is a store or a cache rather than a package. The file it holds belongs to a
 * package its path does not name, which is reported as an unknown owner.
 *
 * @param id - The module identifier, possibly including a query suffix.
 *
 * @returns The package name, or `null` when the module is not a dependency, its path has no name after the
 *   `node_modules` segment, or that name is a dot-directory.
 */
function getOwningPackage(id: string): string | null {
	const PATH = toPosixPath(id);
	const NAME_START = findPackageNameStart(PATH);

	if (NAME_START === NOT_FOUND) {
		return null;
	}

	const REST = PATH.slice(NAME_START);
	const NAME = readFirstSegment(REST);

	if (NAME === '' || NAME.startsWith('.')) {
		return null;
	}

	if (!NAME.startsWith(SCOPE_PREFIX)) {
		return NAME;
	}

	const SCOPED_NAME = readFirstSegment(REST.slice(NAME.length + 1));

	return SCOPED_NAME === '' ? null : `${NAME}/${SCOPED_NAME}`;
}

/**
 * Returns the lower-cased extension of a module ID, without its leading dot or query suffix.
 *
 * @param id - The module identifier, possibly including a query suffix.
 *
 * @returns The extension, or the empty string when the path has none.
 */
function getExtension(id: string): string {
	const PATH = stripQuery(id);
	const DOT_INDEX = PATH.lastIndexOf('.');

	return DOT_INDEX === NOT_FOUND ? '' : PATH.slice(DOT_INDEX + 1).toLowerCase();
}

/**
 * Reports whether the module is the script part a framework plugin split out of a component file.
 *
 * @remarks
 * `Foo.vue?vue&type=script&setup=true&lang.ts` and `Foo.astro?astro&type=script&index=0&lang.ts` keep the extension
 * of the component they come from, but hold the plain JavaScript or TypeScript of its `<script>` block: reading them
 * as markup would replace a call by `void 0` instead of removing its statement.
 *
 * The query is split into parameters before being read, so that a file really named `mytype=script` or a parameter
 * spelled `type=scripts` cannot pass for one of them.
 *
 * @param id - The module identifier, possibly including a query suffix.
 *
 * @returns `true` when the module holds the code of a component's `<script>` block.
 */
function isFrameworkScriptRequest(id: string): boolean {
	const QUERY_INDEX = id.indexOf('?');

	if (QUERY_INDEX === NOT_FOUND) {
		return false;
	}

	const PARAMETERS = id.slice(QUERY_INDEX + 1).split('&');

	return (
		PARAMETERS.some((parameter) => parameter === SCRIPT_TYPE_PARAMETER) &&
		PARAMETERS.some((parameter) => FRAMEWORK_SCRIPT_MARKERS.has(parameter))
	);
}

/**
 * Classifies a module ID as one of the {@link FileKind} values.
 *
 * @remarks
 * Vite hands the inline `<script>` blocks of an HTML entry back through `transform` under the id of the HTML file
 * plus an `html-proxy` query, and a framework plugin hands the `<script>` block of a component back under the id of
 * that component plus a `type=script` query; both hold plain JavaScript, so they resolve as `script`. A TypeScript
 * extension that cannot hold JSX resolves as `ts`, `.vue` as `vue`, and a Markdown-based template as `markdown`.
 * Everything else the presets do not name resolves as `markup`, the safest document kind: only a `<script>` block is
 * emptied there. A compound name resolves on its final extension, so `Counter.svelte.ts` is a `ts` script.
 *
 * @param id - The module identifier, possibly including a query suffix.
 *
 * @returns The kind of source the module holds.
 */
function getFileKind(id: string): FileKind {
	if (HTML_PROXY_REGEX.test(id) && id.endsWith(HTML_PROXY_SCRIPT_SUFFIX)) {
		return 'script';
	}

	if (isFrameworkScriptRequest(id)) {
		return 'script';
	}

	const EXTENSION = getExtension(id);

	if (SCRIPT_EXTENSION_SET.has(EXTENSION)) {
		return TYPESCRIPT_EXTENSION_SET.has(EXTENSION) ? 'ts' : 'script';
	}

	if (HTML_EXTENSION_SET.has(EXTENSION)) {
		return 'html';
	}

	if (ASTRO_EXTENSION_SET.has(EXTENSION)) {
		return 'astro';
	}

	if (VUE_EXTENSION_SET.has(EXTENSION)) {
		return 'vue';
	}

	return MARKDOWN_EXTENSION_SET.has(EXTENSION) ? 'markdown' : 'markup';
}

/**
 * Reports whether a file kind is a script, which is executable code throughout.
 *
 * @param fileKind - The kind of source.
 *
 * @returns `true` for `script` and `ts`.
 */
function isScriptKind(fileKind: FileKind): boolean {
	return fileKind === 'script' || fileKind === 'ts';
}

/**
 * Builds the regex body matching one ignore token, where `*` matches any run of characters inside a single
 * path segment and every other character is literal.
 *
 * @param token - The ignore token, possibly containing `*` wildcards.
 *
 * @returns The regex source for the token, without segment boundaries.
 */
function toSegmentPattern(token: string): string {
	return token.split('*').map(escapeRegExp).join('[^/]*');
}

/**
 * Tells whether a module, given by its path relative to the Vite root, must be skipped
 */
type IgnoreMatcher = (relativePath: string) => boolean;

/**
 * Compiles the ignore tokens of one plugin instance into a single matcher, comparing on path-segment
 * boundaries.
 *
 * @remarks
 * The `anyDepth` tokens match on every path segment, while the `rootAnchored` ones only match as the first
 * segment under the Vite root.
 *
 * Absolute IDs are never tested, which avoids false positives from folder names that coincidentally contain
 * an ignore token. For example, in environments like Cloudflare where a repo may be cloned to a directory
 * such as `/opt/buildhome/repo`, a token like `build` must not match just because it is part of the parent
 * path. Only the path relative to the Vite root is considered.
 *
 * Leading `../` segments are stripped from the path so that modules resolved outside the root
 * (e.g. `../../.pnpm/x/node_modules/y/index.js`) still have the opportunity to match ignore tokens like
 * `node_modules` against their segments.
 *
 * @param tokens - The ignore tokens of each matching depth.
 *
 * @returns A matcher reporting whether a relative path is ignored.
 */
function createIgnoreMatcher(tokens: IgnoreTokens): IgnoreMatcher {
	const ALTERNATIVES: string[] = [];

	if (tokens.anyDepth.length > 0) {
		ALTERNATIVES.push(`(?:^|/)(?:${tokens.anyDepth.map(toSegmentPattern).join('|')})(?:/|$)`);
	}

	if (tokens.rootAnchored.length > 0) {
		ALTERNATIVES.push(`^(?:${tokens.rootAnchored.map(toSegmentPattern).join('|')})(?:/|$)`);
	}

	// An empty alternation would match every path, so a plugin without any ignore token keeps every file
	if (ALTERNATIVES.length === 0) {
		return () => false;
	}

	// eslint-disable-next-line security/detect-non-literal-regexp -- every token is regex-escaped by `toSegmentPattern`
	const PATTERN = new RegExp(ALTERNATIVES.join('|'));

	return (relativePath) => PATTERN.test(relativePath.replace(LEADING_PARENT_SEGMENTS_REGEX, ''));
}

/**
 * Tells whether a module id, once its query suffix is stripped (e.g. `file.js?raw`), ends with one of the configured
 * extensions
 */
type ExtensionMatcher = (id: string) => boolean;

/**
 * Compiles the extensions of one plugin instance into a single matcher.
 *
 * @remarks
 * The extensions are matched case-insensitively and can be provided with or without leading dots. Each one is
 * regex-escaped on its own, so that an entry holding a separator (`'a|b'`) never matches `a` or `b`.
 *
 * @param extensions - The file extensions to match (with or without leading dots).
 *
 * @returns A matcher reporting whether a module id ends with one of the extensions.
 */
function createExtensionMatcher(extensions: readonly string[]): ExtensionMatcher {
	if (extensions.length === 0) {
		return () => false;
	}

	const PATTERN = extensions.map((extension) => escapeRegExp(extension.replace(LEADING_DOTS_REGEX, ''))).join('|');
	// eslint-disable-next-line security/detect-non-literal-regexp -- the extensions are regex-escaped above
	const REGEX = new RegExp(`\\.(?:${PATTERN})$`, 'i');

	return (id) => REGEX.test(stripQuery(id));
}

/**
 * Builds the source of the pattern matching the opener of a call on the global console.
 *
 * @remarks
 * The member is read through a dot, an optional chain or a quoted computed key (`console.log`, `console?.log`,
 * `console['log']`), and the call may be an optional one (`console.log?.(`), carry TypeScript type arguments or a
 * non-null assertion written right against the member (`console.log<T>(`, `console.log!(`), or be a tagged template
 * (`` console.log`…` ``). A member read without a call (`console.log.bind(…)`, `const log = console.log`) never
 * matches. Whitespace is tolerated around the accessors and before the opener, matching what a formatter may leave
 * behind; the lookahead after the member keeps `time` from matching the start of `timeEnd`.
 *
 * @param methodPattern - The regex source matching one method name, already validated or escaped.
 *
 * @returns The pattern source, whose match ends on the call's `(` or on the tagged template's opening backtick.
 */
function buildConsoleCallPatternSource(methodPattern: string): string {
	const MEMBER = `(?:\\??\\.\\s*(?:${methodPattern})(?![\\w$])|(?:\\?\\.\\s*)?\\[\\s*(['"])(?:${methodPattern})\\1\\s*\\])`;
	const CALL = '(?:<[^;(){}\\n]*?>)?!?\\s*(?:\\?\\.\\s*)?[(`]';

	return `\\b${CONSOLE_IDENTIFIER}\\s*${MEMBER}${CALL}`;
}

/**
 * Source of the pattern matching a call to any member of the console, stripped or kept
 */
const ANY_CONSOLE_CALL_PATTERN_SOURCE = buildConsoleCallPatternSource('[A-Za-z_$][\\w$]*');

/**
 * Builds the regular expression matching the opener of a stripped console call.
 *
 * @remarks
 * The accepted call forms are listed on {@link buildConsoleCallPatternSource}. A fresh instance is returned on every
 * call: the regex is stateful (`lastIndex`) and must never be shared between plugin instances.
 *
 * @param methods - The validated console method names to match.
 *
 * @returns A global RegExp whose match ends on the call's `(` or on the tagged template's opening backtick, or `null`
 *   for an empty list.
 */
function createConsoleCallRegex(methods: readonly ConsoleMethod[]): RegExp | null {
	if (methods.length === 0) {
		return null;
	}

	// eslint-disable-next-line security/detect-non-literal-regexp -- every method name is validated against KNOWN_METHODS
	return new RegExp(buildConsoleCallPatternSource(methods.join('|')), 'g');
}

/**
 * Builds the per-file scan context of a single plugin instance.
 *
 * @param options - The resolved plugin options.
 * @param fileKind - The kind of source the context will scan.
 *
 * @returns The context to hand to {@link scanConsoleCalls}.
 */
function createScanContext(options: ResolvedOptions, fileKind: FileKind): ScanContext {
	return {
		pattern: createConsoleCallRegex(options.methods),
		ignoreComments: options.ignoreComments,
		fileKind,
	};
}

type CommentKind = '' | 'block' | 'line';

type ScanStep = 'code' | 'comment' | 'comment-pair' | 'literal' | 'literal-pair' | 'text' | 'text-pair';

/**
 * Builds the class of every code unit out of the two regular expressions that define them.
 *
 * @remarks
 * Deriving the table from {@link WHITESPACE_REGEX} and {@link IDENTIFIER_CHARACTER_REGEX} is what makes it answer
 * exactly what they answer, one array read instead of two regular expression tests per character of every file
 * scanned. A code unit of a surrogate pair belongs to neither class, which is what testing either regular expression
 * on that single unit reports too.
 *
 * @returns One byte per code unit: `1` whitespace, `2` identifier character, `0` anything else.
 */
function buildCharacterClasses(): Uint8Array {
	const CLASSES = new Uint8Array(CHARACTER_CODE_LIMIT);

	for (let code = 0; code < CHARACTER_CODE_LIMIT; code++) {
		const CHARACTER = String.fromCharCode(code);

		if (WHITESPACE_REGEX.test(CHARACTER)) {
			CLASSES[code] = CHARACTER_CLASS_WHITESPACE;
		} else if (IDENTIFIER_CHARACTER_REGEX.test(CHARACTER)) {
			CLASSES[code] = CHARACTER_CLASS_IDENTIFIER;
		}
	}

	return CLASSES;
}

const CHARACTER_CLASSES = buildCharacterClasses();

/**
 * Reports whether a single character is whitespace, reading the class table instead of testing a regular expression.
 *
 * @param character - The character to classify, possibly the empty string past the end of the source.
 *
 * @returns `true` for a whitespace character.
 */
function isWhitespace(character: string): boolean {
	return CHARACTER_CLASSES[character.charCodeAt(0)] === CHARACTER_CLASS_WHITESPACE;
}

/**
 * Reports whether a single character can belong to an ASCII identifier, reading the class table instead of testing a
 * regular expression.
 *
 * @param character - The character to classify, possibly the empty string past the end of the source.
 *
 * @returns `true` for a `[\w$]` character.
 */
function isIdentifierCharacter(character: string): boolean {
	return CHARACTER_CLASSES[character.charCodeAt(0)] === CHARACTER_CLASS_IDENTIFIER;
}

/**
 * Walks forwardover whitespace.
 *
 * @param input - The source to walk.
 * @param fromIndex - The index to start from, inclusive.
 * @param end - The exclusive index the walk stops at.
 *
 * @returns The index of the first character that is not whitespace, or `end` when none is found before it.
 */
function skipWhitespace(input: string, fromIndex: number, end: number): number {
	let index = fromIndex;

	while (index < end && isWhitespace(input.charAt(index))) {
		index++;
	}

	return index;
}

/**
 * Returns where a sticky pattern that matches the empty string stops matching.
 *
 * @remarks
 * Such a pattern never fails, and a successful `test` leaves `lastIndex` just after the match: reading that index
 * spares allocating the match itself.
 *
 * @param regex - A sticky pattern that matches the empty string.
 * @param input - The text to read.
 * @param index - The index the match starts at.
 *
 * @returns The index just after the match.
 */
function findStickyMatchEnd(regex: RegExp, input: string, index: number): number {
	regex.lastIndex = index;
	regex.test(input);

	return regex.lastIndex;
}

/**
 * Executable code: the bottom of the stack, a `${…}` placeholder or a JSX expression container
 */
interface CodeFrame {
	kind: 'code';
	braceDepth: number;
	/** What the `}` balancing nothing in this frame closes; the bottom frame is closed by nothing */
	opener: 'jsx' | 'none' | 'template';
}

interface TemplateFrame {
	kind: 'template';
	/** The index of the template's opening backtick */
	openIndex: number;
}

/**
 * The inside of a JSX tag, from its `<` to its `>`
 */
interface JsxTagFrame {
	kind: 'jsx-tag';
	isClosing: boolean;
}

/**
 * The children of a JSX element, between the `>` of its opening tag and the `<` of its closing one
 */
interface JsxChildrenFrame {
	kind: 'jsx-children';
}

type ScanFrame = CodeFrame | JsxChildrenFrame | JsxTagFrame | TemplateFrame;

/**
 * The closest JSX closing tag of one name a search found
 */
interface JsxCloserSearch {
	/** The index the search started at */
	from: number;
	/** The index of the first closer at or after `from` anywhere in the file, or `-1` when the file holds none */
	index: number;
}

/**
 * What the scanners of one file learn along the way, shared by every region of that file
 */
interface ScanRecords {
	/** The index of the backtick closing each template literal, keyed by the index of its opening backtick */
	templateEnds: Map<number, number>;
	/** The last search for each JSX closing tag, keyed by the closer, from its `<` to the end of its name */
	jsxClosers: Map<string, JsxCloserSearch>;
}

interface ScannerOptions {
	/** Exclusive end of the region being scanned, which bounds every lookahead */
	end: number;
	/** Read `<!--` as a single-line comment, as a browser does inside a `<script>` block */
	hasHtmlComments: boolean;
	/** Read a `<` in expression position as the start of a JSX element when it looks like one */
	hasJsx: boolean;
	records: ScanRecords;
}

function createScanRecords(): ScanRecords {
	return { templateEnds: new Map(), jsxClosers: new Map() };
}

/**
 * Character-by-character scanner telling executable code apart from string literals, template-literal text, regular
 * expression literals, comments and the text of JSX elements.
 *
 * @remarks
 * A template literal pushes a frame so that its `${…}` placeholders are reported as code again, and so do a JSX
 * element and each of its `{…}` expression containers. Telling a regular expression literal from a division needs the
 * previous significant token, which the scanner tracks as it goes, together with the keyword each open parenthesis
 * follows; a regular expression is also bounded to its own line, so that a token misread as one can never mask the
 * rest of the file.
 */
class SourceScanner {
	readonly #input: string;
	readonly #end: number;
	readonly #hasHtmlComments: boolean;
	readonly #hasJsx: boolean;
	readonly #records: ScanRecords;
	readonly #bottomFrame: CodeFrame = { kind: 'code', braceDepth: 0, opener: 'none' };
	readonly #frames: ScanFrame[] = [this.#bottomFrame];
	/** One flag per open parenthesis, `true` when it opens the header of a control keyword */
	readonly #parenthesisFlags: boolean[] = [];
	#quote = '';
	#jsxQuote = '';
	#comment: CommentKind = '';
	#isEscaped = false;
	#isInRegex = false;
	#isInCharacterClass = false;
	#isAfterControlHeader = false;
	#previousCharacter = '';
	#secondPreviousCharacter = '';
	#wordStart = NOT_FOUND;
	#wordEnd = NOT_FOUND;
	#isWordAfterDot = false;

	constructor(input: string, options: ScannerOptions) {
		this.#input = input;
		this.#end = options.end;
		this.#hasHtmlComments = options.hasHtmlComments;
		this.#hasJsx = options.hasJsx;
		this.#records = options.records;
	}

	/**
	 * Reports whether the scanner sits in the executable code of the bottom frame, outside every brace, literal and
	 * comment.
	 *
	 * @returns `true` when a `}` read now would balance nothing, which is what closes a template expression slot.
	 */
	isAtTopLevel(): boolean {
		return (
			this.#frames.length === 1 &&
			this.#bottomFrame.braceDepth === 0 &&
			this.#quote === '' &&
			this.#jsxQuote === '' &&
			this.#comment === '' &&
			!this.#isInRegex
		);
	}

	/**
	 * Counts the frames open: `1` in the bottom frame, and one more for each template literal, `${…}` placeholder,
	 * JSX element and JSX expression container entered and not yet left.
	 *
	 * @returns The depth of the frame stack.
	 */
	getFrameDepth(): number {
		return this.#frames.length;
	}

	step(character: string, next: string, index: number): ScanStep {
		const STEP = this.#dispatch(character, next, index);

		if (STEP === 'code') {
			this.#trackCode(character, index);
		}

		return STEP;
	}

	/**
	 * @throws When the frame stack is empty, which the scanner never allows: the bottom frame is created with the
	 *   scanner and is the only one no step ever pops.
	 */
	#dispatch(character: string, next: string, index: number): ScanStep {
		if (this.#comment !== '') {
			return this.#stepComment(character, next);
		}

		if (this.#jsxQuote !== '') {
			return this.#stepJsxString(character);
		}

		if (this.#quote !== '') {
			return this.#stepString(character, next);
		}

		if (this.#isInRegex) {
			return this.#stepRegex(character);
		}

		const FRAME = this.#frames.at(-1);

		/* v8 ignore next -- offensive invariant: the bottom code frame is never popped */
		if (!FRAME) {
			throw new Error('SourceScanner requires a non-empty frame stack');
		}

		switch (FRAME.kind) {
			case 'template':
				return this.#stepTemplate(FRAME, character, next, index);

			case 'jsx-tag':
				return this.#stepJsxTag(FRAME, character, next);

			case 'jsx-children':
				return this.#stepJsxChildren(character, next);

			case 'code':
				return this.#stepCode(FRAME, character, next, index);
		}
	}

	/**
	 * Remembers the token that just closed, so that the next `/` is read as a division rather than as a regular
	 * expression literal.
	 *
	 * @param character - The character standing for the token that closed.
	 */
	#setPreviousToken(character: string): void {
		this.#secondPreviousCharacter = this.#previousCharacter;
		this.#previousCharacter = character;
		this.#resetWord();
		this.#isWordAfterDot = false;
		this.#isAfterControlHeader = false;
	}

	#resetWord(): void {
		this.#wordStart = NOT_FOUND;
		this.#wordEnd = NOT_FOUND;
	}

	/**
	 * Adds one character to the word being read, which is the token a `/` is classified against.
	 *
	 * @remarks
	 * The word is a slice of the source, so reading it costs two indexes and no allocation at all. Only a character
	 * written right against the previous one extends that slice: anything the scanner steps over without ending the
	 * word — whitespace, a comment, a literal — still separates two identifiers, so a character arriving after such a
	 * gap opens a fresh word instead, exactly as the first character of a word does.
	 *
	 * @param index - The index the identifier character sits at.
	 */
	#appendToWord(index: number): void {
		if (this.#wordStart !== NOT_FOUND && index === this.#wordEnd) {
			this.#wordEnd = index + 1;

			return;
		}

		this.#isWordAfterDot = this.#previousCharacter === '.';
		this.#wordStart = index;
		this.#wordEnd = index + 1;
	}

	/**
	 * Returns the word being read.
	 *
	 * @returns The characters accumulated since the last token, or the empty string when no word is open.
	 */
	#getWord(): string {
		return this.#wordStart === NOT_FOUND ? '' : this.#input.slice(this.#wordStart, this.#wordEnd);
	}

	#isControlKeyword(): boolean {
		return !this.#isWordAfterDot && CONTROL_KEYWORDS.has(this.#getWord());
	}

	#trackCode(character: string, index: number): void {
		const CHARACTER_CLASS = CHARACTER_CLASSES[character.charCodeAt(0)];

		if (CHARACTER_CLASS === CHARACTER_CLASS_WHITESPACE) {
			return;
		}

		const CLOSES_CONTROL_HEADER = character === ')' && this.#parenthesisFlags.pop() === true;

		// Read before the word is reset: the keyword a parenthesis follows is the word still open when it is reached
		if (character === '(') {
			this.#parenthesisFlags.push(this.#isControlKeyword());
		}

		if (CHARACTER_CLASS === CHARACTER_CLASS_IDENTIFIER) {
			this.#appendToWord(index);
		} else {
			this.#resetWord();
			this.#isWordAfterDot = false;
		}

		this.#secondPreviousCharacter = this.#previousCharacter;
		this.#previousCharacter = character;
		this.#isAfterControlHeader = CLOSES_CONTROL_HEADER;
	}

	#allowsRegex(): boolean {
		const PREVIOUS = this.#previousCharacter;

		if (PREVIOUS === '') {
			return true;
		}

		// `=>` opens an expression position; a bare `>` closes a comparison operand or a type argument list
		if (PREVIOUS === '>') {
			return this.#secondPreviousCharacter === '=';
		}

		// `if (x) /a/.test(y)`: the header of a control keyword is followed by a statement, not by an operator
		if (PREVIOUS === ')') {
			return this.#isAfterControlHeader;
		}

		// `a++ / 2` and `a-- / 2` divide the value the postfix operator left behind
		if ((PREVIOUS === '+' || PREVIOUS === '-') && this.#secondPreviousCharacter === PREVIOUS) {
			return false;
		}

		if (REGEX_ALLOWED_AFTER_CHARACTERS.includes(PREVIOUS)) {
			return true;
		}

		return !this.#isWordAfterDot && REGEX_ALLOWED_AFTER_KEYWORDS.has(this.#getWord());
	}

	#stepComment(character: string, next: string): ScanStep {
		if (this.#comment === 'line') {
			if (character !== '\n') {
				return 'comment';
			}

			this.#comment = '';

			// The newline closing a line comment is code: it still terminates the statement that precedes the comment
			return 'code';
		}

		if (character === '*' && next === '/') {
			this.#comment = '';

			return 'comment-pair';
		}

		return 'comment';
	}

	#stepString(character: string, next: string): ScanStep {
		if (this.#isEscaped) {
			// A backslash followed by `\r\n` continues the string on the next line: both characters belong to the escape
			this.#isEscaped = character === '\r' && next === '\n';

			return 'literal';
		}

		if (character === '\\') {
			this.#isEscaped = true;

			return 'literal';
		}

		// A quoted string cannot span a raw newline, so an apostrophe in markup text cannot swallow the rest of the file
		if (character === '\n') {
			this.#quote = '';
			this.#setPreviousToken("'");

			return 'code';
		}

		if (character === this.#quote) {
			this.#setPreviousToken(this.#quote);
			this.#quote = '';
		}

		return 'literal';
	}

	#stepJsxString(character: string): ScanStep {
		// A JSX attribute string knows no escape and may span lines: only its own quote closes it
		if (character === this.#jsxQuote) {
			this.#jsxQuote = '';
		}

		return 'literal';
	}

	#stepRegex(character: string): ScanStep {
		if (this.#isEscaped) {
			this.#isEscaped = false;

			return 'literal';
		}

		if (character === '\\') {
			this.#isEscaped = true;

			return 'literal';
		}

		// A regular expression literal cannot span a line: bounding it here keeps a `/` read as one by mistake from
		// masking anything beyond its own line
		if (character === '\n') {
			this.#isInRegex = false;
			this.#isInCharacterClass = false;

			return 'code';
		}

		if (this.#isInCharacterClass) {
			this.#isInCharacterClass = character !== ']';

			return 'literal';
		}

		if (character === '[') {
			this.#isInCharacterClass = true;

			return 'literal';
		}

		if (character === '/') {
			this.#isInRegex = false;
			this.#setPreviousToken('/');
		}

		return 'literal';
	}

	#stepTemplate(frame: TemplateFrame, character: string, next: string, index: number): ScanStep {
		if (this.#isEscaped) {
			this.#isEscaped = false;

			return 'literal';
		}

		if (character === '\\') {
			this.#isEscaped = true;

			return 'literal';
		}

		if (character === '`') {
			this.#frames.pop();
			this.#records.templateEnds.set(frame.openIndex, index);
			this.#setPreviousToken('`');

			return 'literal';
		}

		if (character === '$' && next === '{') {
			this.#frames.push({ kind: 'code', braceDepth: 0, opener: 'template' });
			this.#setPreviousToken('{');

			return 'literal-pair';
		}

		return 'literal';
	}

	#stepCode(frame: CodeFrame, character: string, next: string, index: number): ScanStep {
		if (character === "'" || character === '"') {
			this.#quote = character;

			return 'literal';
		}

		if (character === '`') {
			this.#frames.push({ kind: 'template', openIndex: index });

			return 'literal';
		}

		if (character === '/') {
			return this.#openSlash(next);
		}

		if (character === '<') {
			return this.#openAngleBracket(index);
		}

		if (character === '{') {
			frame.braceDepth++;

			return 'code';
		}

		return character === '}' ? this.#closeBrace(frame) : 'code';
	}

	#openSlash(next: string): ScanStep {
		if (next === '/' || next === '*') {
			this.#comment = next === '/' ? 'line' : 'block';

			return 'comment-pair';
		}

		if (this.#allowsRegex()) {
			this.#isInRegex = true;
			this.#isInCharacterClass = false;

			return 'literal';
		}

		// A division: the slash is ordinary code
		return 'code';
	}

	#openAngleBracket(index: number): ScanStep {
		// Inside a `<script>` block, `<!--` opens a single-line comment exactly like `//` does
		if (this.#hasHtmlComments && this.#input.startsWith(MARKUP_COMMENT_OPEN, index)) {
			this.#comment = 'line';

			return 'comment';
		}

		if (!this.#hasJsx || !this.#allowsRegex() || !this.#isJsxElementStart(index)) {
			return 'code';
		}

		this.#frames.push({ kind: 'jsx-tag', isClosing: false });

		return 'text';
	}

	#closeBrace(frame: CodeFrame): ScanStep {
		if (frame.braceDepth > 0) {
			frame.braceDepth--;

			return 'code';
		}

		if (frame.opener === 'none') {
			return 'code';
		}

		this.#frames.pop();

		// The `}` closing a `${…}` placeholder is template syntax; the one closing a JSX expression container is code
		return frame.opener === 'template' ? 'literal' : 'code';
	}

	#stepJsxTag(frame: JsxTagFrame, character: string, next: string): ScanStep {
		if (character === '"' || character === "'") {
			this.#jsxQuote = character;

			return 'literal';
		}

		if (character === '{') {
			this.#enterJsxExpression();

			return 'code';
		}

		if (character === '/' && next === '>' && !frame.isClosing) {
			this.#frames.pop();
			this.#leaveJsxElement();

			return 'text-pair';
		}

		if (character !== '>') {
			return 'text';
		}

		this.#frames.pop();

		if (!frame.isClosing) {
			this.#frames.push({ kind: 'jsx-children' });

			return 'text';
		}

		// Only the children of an element open a closing tag, so the frame below this one is those children
		this.#frames.pop();
		this.#leaveJsxElement();

		return 'text';
	}

	#stepJsxChildren(character: string, next: string): ScanStep {
		if (character === '{') {
			this.#enterJsxExpression();

			return 'code';
		}

		const IS_TAG = character === '<' && (next === '/' || next === '>' || JSX_NAME_START_REGEX.test(next));

		if (IS_TAG) {
			this.#frames.push({ kind: 'jsx-tag', isClosing: next === '/' });
		}

		return 'text';
	}

	#enterJsxExpression(): void {
		this.#frames.push({ kind: 'code', braceDepth: 0, opener: 'jsx' });
		this.#setPreviousToken('{');
	}

	/**
	 * Returns to code once the root element of a JSX expression closed, which leaves a value behind: a `/` read next
	 * is a division.
	 */
	#leaveJsxElement(): void {
		if (this.#frames.at(-1)?.kind === 'code') {
			this.#setPreviousToken(')');
		}
	}

	/**
	 * Reports whether a `<` read in expression position opens the root element of a JSX expression.
	 *
	 * @remarks
	 * The same `<` opens a TypeScript type assertion (`<T>value`) and the type parameters of a generic arrow function
	 * (`<T,>(a) => a`, `<T extends U>(a) => a`, `<const T,>(a) => a`), none of which is ever followed by a `</T>` tag,
	 * while a JSX element holding children always is. The heuristic therefore enters an element when:
	 * - it is a fragment (`<>`) that the region closes later with `</>`;
	 * - its name is written right against a `/`, which only a self-closing tag (`<Foo/>`) does;
	 * - its name is not followed by the `,`, `=` or `extends` of a type parameter list, is not a type parameter
	 *   modifier followed by a name, and the region later holds a `</name` closing tag.
	 *
	 * Everything else is read as code. The heuristic can err in both directions. A self-closing element with
	 * attributes read as code has no child text to edit, its attributes being scanned as the expressions they are. Code
	 * misread as JSX is masked as text, which keeps the calls written there, except inside a `{…}` it then reads as an
	 * expression container: a `"{console.log(1)}"` string written after a `<T>value` type assertion and before a
	 * `"</T>"` string would be edited as code. That is why a `ts` script, which cannot hold JSX, never reads a `<` as
	 * an element at all.
	 *
	 * @param index - The index of the `<`.
	 *
	 * @returns `true` when the `<` opens a JSX element.
	 */
	#isJsxElementStart(index: number): boolean {
		const NAME_START = index + 1;

		if (this.#input.charAt(NAME_START) === '>') {
			return this.#hasJsxCloser(JSX_FRAGMENT_CLOSER, NAME_START);
		}

		JSX_TAG_NAME_REGEX.lastIndex = NAME_START;

		const NAME = JSX_TAG_NAME_REGEX.exec(this.#input)?.[0];

		if (NAME == null) {
			return false;
		}

		const NAME_END = NAME_START + NAME.length;

		if (this.#input.charAt(NAME_END) === '/') {
			return true;
		}

		const FOLLOWING_INDEX = skipWhitespace(this.#input, NAME_END, this.#end);
		const FOLLOWING = this.#input.charAt(FOLLOWING_INDEX);

		if (FOLLOWING === ',' || FOLLOWING === '=') {
			return false;
		}

		const IS_TYPE_PARAMETER =
			CHARACTER_CLASSES[FOLLOWING.charCodeAt(0)] === CHARACTER_CLASS_IDENTIFIER &&
			(TYPE_PARAMETER_MODIFIERS.has(NAME) || this.#isKeywordAt(EXTENDS_KEYWORD, FOLLOWING_INDEX));

		return !IS_TYPE_PARAMETER && this.#hasJsxCloser(`</${NAME}`, FOLLOWING_INDEX);
	}

	#isKeywordAt(keyword: string, index: number): boolean {
		return this.#input.startsWith(keyword, index) && !isIdentifierCharacter(this.#input.charAt(index + keyword.length));
	}

	/**
	 * Reports whether the region holds the given closing tag at or after an index.
	 *
	 * @remarks
	 * The search runs over the whole file rather than over the region, so that its outcome holds for every region of
	 * that file: the {@link ScanRecords} shared by all of them keep the last search per closer, which answers every
	 * later query starting between where that search started and the closer it found — or every later query at all when
	 * it found none. The queries arrive in source order, so a document holding thousands of `<T>` type assertions or
	 * of slots opening a JSX fragment costs one search per name, not one per occurrence.
	 *
	 * @param closer - The closing tag, from its `<` to the end of its name.
	 * @param fromIndex - The index the closer must not start before.
	 *
	 * @returns `true` when the closer occurs, followed by `>` or whitespace, before the end of the region.
	 */
	#hasJsxCloser(closer: string, fromIndex: number): boolean {
		const CACHED = this.#records.jsxClosers.get(closer);
		const IS_CACHED =
			CACHED != null && fromIndex >= CACHED.from && (CACHED.index === NOT_FOUND || CACHED.index >= fromIndex);
		const FOUND = IS_CACHED ? CACHED.index : this.#findJsxCloser(closer, fromIndex);

		if (!IS_CACHED) {
			this.#records.jsxClosers.set(closer, { from: fromIndex, index: FOUND });
		}

		return FOUND !== NOT_FOUND && FOUND < this.#end;
	}

	#findJsxCloser(closer: string, fromIndex: number): number {
		let index = this.#input.indexOf(closer, fromIndex);

		while (index !== NOT_FOUND) {
			const AFTER = this.#input.charAt(index + closer.length);

			if (closer === JSX_FRAGMENT_CLOSER || AFTER === '>' || isWhitespace(AFTER)) {
				return index;
			}

			index = this.#input.indexOf(closer, index + 1);
		}

		return NOT_FOUND;
	}
}

/**
 * How {@link scanCode} reads one region
 */
interface CodeScanOptions {
	/** Stop on the `}` balancing nothing, which closes a template expression slot */
	isSlot: boolean;
	/** Read `<!--` as a single-line comment, as a browser does inside a `<script>` block */
	hasHtmlComments: boolean;
	/** Read a `<` in expression position as the start of a JSX element when it looks like one */
	hasJsx: boolean;
	records: ScanRecords;
}

function getMaskValue(step: ScanStep): number {
	switch (step) {
		case 'code':
			return MASK_CODE;

		case 'comment':
		case 'comment-pair':
			return MASK_COMMENT;

		case 'literal':
		case 'literal-pair':
			return MASK_LITERAL;

		case 'text':
		case 'text-pair':
			return MASK_TEXT;
	}
}

/**
 * Scans one region of a file with a fresh {@link SourceScanner}, writing the class of every character into the mask.
 *
 * @remarks
 * Every region starts from a clean lexer state, so that a quote or a backtick written in the text between two regions
 * — a template, a data block — can never change how the next region is read.
 *
 * @param input - The source.
 * @param mask - The mask to write into.
 * @param region - The range to scan.
 * @param options - Whether the scan stops on the brace closing a slot, whether `<!--` opens a comment, whether JSX is
 *   read, and the records the scan adds what it learns to.
 *
 * @returns The index of the `}` closing the slot, or `-1` when the scan reached the end of the region, which a slot
 *   scan reports as a slot never closed.
 */
function scanCode(input: string, mask: CodeMask, region: Region, options: CodeScanOptions): number {
	const SCANNER = new SourceScanner(input, {
		end: region.end,
		hasHtmlComments: options.hasHtmlComments,
		hasJsx: options.hasJsx,
		records: options.records,
	});

	for (let index = region.start; index < region.end; index++) {
		const CHARACTER = input.charAt(index);

		if (options.isSlot && CHARACTER === '}' && SCANNER.isAtTopLevel()) {
			return index;
		}

		const STEP = SCANNER.step(CHARACTER, index + 1 < region.end ? input.charAt(index + 1) : '', index);
		const VALUE = getMaskValue(STEP);

		mask[index] = VALUE;

		if (STEP === 'comment-pair' || STEP === 'literal-pair' || STEP === 'text-pair') {
			mask[index + 1] = VALUE;
			index++;
		}
	}

	return NOT_FOUND;
}

/**
 * An attribute of a markup opening tag
 */
interface TagAttribute {
	/** Lower-cased name */
	name: string;
	value: string;
}

/**
 * A markup opening tag, from its `<` to its `>`
 */
interface OpeningTag {
	/** Lower-cased name */
	name: string;
	/** Exclusive end of the tag, just after its `>` */
	end: number;
	attributes: TagAttribute[];
	isSelfClosing: boolean;
}

/**
 * Reports whether a `<script>` block holds JavaScript its page or its framework runs.
 *
 * @remarks
 * `<script type="application/json">`, `<script type="importmap">` and `<script type="text/template">` hold data a
 * browser never executes; rewriting them would corrupt the page. A tag with no `type`, an empty one, `module`, or a
 * JavaScript MIME type is code; only the MIME essence classifies it, so `text/javascript; charset=utf-8` is still
 * JavaScript. `lang="ts"` and `setup` carry no `type` and stay code.
 *
 * A tag carrying `src` loads its code from elsewhere and its inline body is ignored, and a tag written self-closing
 * (`<script src="a.js" />`, which HTML does not support) leaves the real end of the block unknowable. In both cases
 * the block still runs to the `</script>` the search reaches, which holds page text rather than code, so the block is
 * treated as inert: whatever is caught inside it is then left exactly as written.
 *
 * Attributes are compared by name, so a `type=` or a `src` written inside the value of another attribute counts for
 * nothing, and only the first occurrence of a name counts, as in a browser.
 *
 * @param tag - The opening tag of the block.
 *
 * @returns `true` when the block's body is executable JavaScript.
 */
function isExecutableScriptTag(tag: OpeningTag): boolean {
	if (tag.isSelfClosing || tag.attributes.some((attribute) => attribute.name === 'src')) {
		return false;
	}

	const TYPE = tag.attributes.find((attribute) => attribute.name === 'type')?.value ?? '';
	const PARAMETERS_INDEX = TYPE.indexOf(';');
	const ESSENCE = (PARAMETERS_INDEX === NOT_FOUND ? TYPE : TYPE.slice(0, PARAMETERS_INDEX)).trim().toLowerCase();

	return ESSENCE === '' || JAVASCRIPT_SCRIPT_TYPES.has(ESSENCE);
}

/**
 * Reports whether a Vue template evaluates the quoted value of an attribute as an expression.
 *
 * @param name - The attribute name.
 *
 * @returns `true` for `@event`, `:prop`, `#slot` and every `v-` directive.
 */
function isExpressionAttribute(name: string): boolean {
	return EXPRESSION_ATTRIBUTE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Finds the next occurrence of a `<script` or `</script` tag name, matched case-insensitively.
 *
 * @remarks
 * The comparison runs over the original source rather than over a lower-cased copy of it: lower-casing can change how
 * many code units a character takes (`'İ'.toLowerCase()` is two), which would shift every offset the caller then
 * reads the source and its mask with. Only `<` positions are compared, which is what keeps a document holding
 * thousands of tags linear.
 *
 * @param input - The document source.
 * @param tagName - The lower-cased tag name to find, opening angle bracket included.
 * @param fromIndex - The index to start searching at.
 *
 * @returns The index of the tag's `<`, or `-1` when the source holds no further occurrence.
 */
function findTagNameIndex(input: string, tagName: string, fromIndex: number): number {
	let index = input.indexOf('<', fromIndex);

	while (index !== NOT_FOUND) {
		if (input.slice(index, index + tagName.length).toLowerCase() === tagName) {
			return index;
		}

		index = input.indexOf('<', index + 1);
	}

	return NOT_FOUND;
}

/**
 * Reports whether a tag name ends at the given character, which is what tells `<script>` apart from `<scripts>`.
 *
 * @param character - The character following the tag name, the empty string past the end of the source.
 *
 * @returns `true` when the character cannot continue a tag name.
 */
function isTagNameBoundary(character: string): boolean {
	return character === '' || character === '>' || character === '/' || isWhitespace(character);
}

/**
 * Reports whether a region contains a `<script` opener written in code position.
 *
 * @remarks
 * A second opener inside what looks like one block means the block's boundaries are not the real ones, so nothing
 * inside may be edited. The mask keeps a `"<script>"` written inside a JavaScript string from counting, and the
 * tag-name boundary keeps a `<scripts>` element from counting either.
 *
 * @param input - The document source.
 * @param region - The region to inspect.
 * @param mask - The code mask of `input`.
 *
 * @returns `true` when a nested opener was found.
 */
function hasNestedScriptOpener(input: string, region: Region, mask: CodeMask): boolean {
	let index = findTagNameIndex(input, SCRIPT_OPENER, region.start);

	while (index !== NOT_FOUND && index < region.end) {
		if (mask[index] === MASK_CODE && isTagNameBoundary(input.charAt(index + SCRIPT_OPENER.length))) {
			return true;
		}

		index = findTagNameIndex(input, SCRIPT_OPENER, index + 1);
	}

	return false;
}

/**
 * Returns the index just after the `>` ending a closing tag whose name stops at `fromIndex`.
 *
 * @remarks
 * HTML allows whitespace between the name of a closing tag and its `>`, and nothing else.
 *
 * @param input - The document source.
 * @param fromIndex - The index just after the tag name.
 *
 * @returns The exclusive end of the tag, or `-1` when the tag does not close there.
 */
function findClosingTagEnd(input: string, fromIndex: number): number {
	for (let index = fromIndex; index < input.length; index++) {
		const CHARACTER = input.charAt(index);

		if (CHARACTER === '>') {
			return index + 1;
		}

		if (!isWhitespace(CHARACTER)) {
			return NOT_FOUND;
		}
	}

	return NOT_FOUND;
}

/**
 * Finds the closing tag of a raw-text block (`</script>`, `</style>`).
 *
 * @param input - The document source.
 * @param closer - The lower-cased closing tag name, from its `<` to the end of its name.
 * @param fromIndex - The index the block's content starts at.
 *
 * @returns The range the closing tag occupies, or `null` when the block is never closed.
 */
function findTagCloser(input: string, closer: string, fromIndex: number): Region | null {
	let index = findTagNameIndex(input, closer, fromIndex);

	while (index !== NOT_FOUND) {
		const END = findClosingTagEnd(input, index + closer.length);

		if (END !== NOT_FOUND) {
			return { start: index, end: END };
		}

		index = findTagNameIndex(input, closer, index + 1);
	}

	return null;
}

/**
 * Single forward pass over a document (`markup`, `vue`, `markdown`, `astro` or `html`), finding the regions holding
 * executable code and scanning each of them with a fresh {@link SourceScanner}.
 *
 * @remarks
 * Every character the pass does not recognize as code stays text, which no edit ever touches. The code regions are:
 * - the leading `---` frontmatter of an Astro component, and the body of every `<script>` block holding JavaScript,
 *   where a call may form a statement of its own;
 * - in `markup`, `markdown` and `astro`, every `{…}` expression slot, in the text or in a tag; in `vue`, every
 *   `{{ … }}` interpolation of the text, read as one slot holding a braced expression; and in `markup`, `markdown`
 *   and `vue` the quoted value of every Vue expression attribute (`@click`, `:prop`, `#slot`, `v-…`). A call there is
 *   always part of a larger expression.
 *
 * Tags are read quote-aware, so neither a `<script>` nor a `{` written inside an attribute value opens anything, and
 * neither does one written in a `<!-- … -->` comment, in the front matter, inside a slot or, in `markdown`, inside a
 * fenced code block. The content of a `<style>` block is skipped as text. A Svelte block tag has its sigil and its
 * name skipped (`{#if …}`, `{:else}`, `{@html …}`), and a closing one (`{/if}`) holds no expression at all, so that it
 * never reads as a regular expression literal.
 *
 * The pass guards against the inputs that would make it quadratic. An opening tag, an attribute value or a slot
 * inside a tag that never closes proves that the rest of the document cannot be read reliably, and leaves it as
 * text; a slot left open in the text only disables the slots that follow it; a closing tag a first search proved
 * absent is never searched again; and the scanners of every region share one set of {@link ScanRecords}, so a JSX
 * closer is searched once per name for the whole document rather than once per slot.
 */
class DocumentScanner {
	readonly #input: string;
	readonly #mask: CodeMask;
	readonly #regions: CodeRegion[] = [];
	readonly #records = createScanRecords();
	readonly #fileKind: FileKind;
	readonly #hasExpressionAttributes: boolean;
	/** `false` in `vue`, where a `{` written in a tag opens nothing */
	readonly #hasTagSlots: boolean;
	/** What opens a slot in the text: `{{` in `vue`, `{` everywhere else */
	readonly #slotOpener: string;
	readonly #hasCodeFences: boolean;
	/** Smallest index the document is known to hold no closing tag from, per closing tag name */
	readonly #noCloserFrom = new Map<string, number>();
	#hasSlots: boolean;

	constructor(input: string, fileKind: FileKind) {
		this.#input = input;
		this.#mask = new Uint8Array(input.length).fill(MASK_TEXT);
		this.#fileKind = fileKind;
		this.#hasSlots = fileKind !== 'html';
		this.#hasTagSlots = fileKind !== 'vue';
		this.#slotOpener = fileKind === 'vue' ? '{{' : '{';
		this.#hasCodeFences = fileKind === 'markdown';
		this.#hasExpressionAttributes = fileKind === 'markup' || fileKind === 'markdown' || fileKind === 'vue';
	}

	scan(): SourceLayout {
		const INPUT = this.#input;
		const LENGTH = INPUT.length;

		let index = this.#scanFrontmatter();

		while (index < LENGTH) {
			const CHARACTER = INPUT.charAt(index);
			const FENCE_END =
				this.#hasCodeFences && (index === 0 || INPUT.charAt(index - 1) === '\n')
					? this.#skipCodeFence(index)
					: NOT_FOUND;

			if (FENCE_END !== NOT_FOUND) {
				index = FENCE_END;
			} else if (CHARACTER === '<') {
				index = this.#scanAngleBracket(index);
			} else if (CHARACTER === '{' && this.#hasSlots && INPUT.startsWith(this.#slotOpener, index)) {
				const CLOSE_INDEX = this.#scanSlot(index);

				index = CLOSE_INDEX === NOT_FOUND ? index + 1 : CLOSE_INDEX + 1;
			} else {
				index++;
			}
		}

		return { mask: this.#mask, regions: this.#regions, templateEnds: this.#records.templateEnds };
	}

	/**
	 * Skips a Markdown fenced code block opening on the line that starts at an index.
	 *
	 * @remarks
	 * The block runs to the first later line holding a closing fence of the same character, at least as long as the
	 * opening one, or to the end of the document when no line does. A backtick fence whose info string holds a
	 * backtick is no fence at all, as in CommonMark.
	 *
	 * @param lineStart - The index the line starts at.
	 *
	 * @returns The index just after the closing fence, or `-1` when the line opens no fenced code block.
	 */
	#skipCodeFence(lineStart: number): number {
		const INPUT = this.#input;

		CODE_FENCE_OPENER_REGEX.lastIndex = lineStart;

		const OPENER = CODE_FENCE_OPENER_REGEX.exec(INPUT);
		const FENCE = OPENER?.[1];

		if (OPENER == null || FENCE == null || (FENCE.startsWith('`') && OPENER[2]?.includes('`') === true)) {
			return NOT_FOUND;
		}

		for (
			let lineEnd = INPUT.indexOf('\n', lineStart);
			lineEnd !== NOT_FOUND;
			lineEnd = INPUT.indexOf('\n', lineEnd + 1)
		) {
			CODE_FENCE_CLOSER_REGEX.lastIndex = lineEnd + 1;

			const CLOSER = CODE_FENCE_CLOSER_REGEX.exec(INPUT);
			const IS_CLOSING_FENCE =
				CLOSER?.[1] != null && CLOSER[1].startsWith(FENCE.charAt(0)) && CLOSER[1].length >= FENCE.length;

			if (IS_CLOSING_FENCE) {
				return lineEnd + 1 + CLOSER[0].length;
			}
		}

		return INPUT.length;
	}

	/**
	 * Reads the leading `---` fence, which only an Astro component executes: the same three dashes open a YAML front
	 * matter block in every other template format, where the text they delimit is data and stays text.
	 *
	 * @remarks
	 * The region holds the line break ending its last line, so that removing the statement alone on that line takes
	 * the line with it instead of leaving it blank before the closing fence. The search for that fence starts on the
	 * line break of the opening one, which lets an empty block (`---\n---`) close right away.
	 *
	 * @returns The index the rest of the document starts at.
	 */
	#scanFrontmatter(): number {
		const OPENER = FRONTMATTER_OPENER_REGEX.exec(this.#input);

		if (!OPENER) {
			return 0;
		}

		const START = OPENER[0].length;

		FRONTMATTER_CLOSER_REGEX.lastIndex = START - 1;

		const CLOSER = FRONTMATTER_CLOSER_REGEX.exec(this.#input);

		if (!CLOSER) {
			return 0;
		}

		if (this.#fileKind === 'astro') {
			this.#addRegion({ start: START, end: CLOSER.index + 1 }, true);
		}

		return CLOSER.index + CLOSER[0].length;
	}

	#addRegion(region: Region, allowsStatements: boolean): void {
		this.#scanCode(region, { isSlot: false, hasHtmlComments: false });
		this.#regions.push({ ...region, allowsStatements });
	}

	#scanCode(region: Region, options: Pick<CodeScanOptions, 'hasHtmlComments' | 'isSlot'>): number {
		return scanCode(this.#input, this.#mask, region, { ...options, hasJsx: true, records: this.#records });
	}

	#scanAngleBracket(index: number): number {
		const INPUT = this.#input;

		if (INPUT.startsWith(MARKUP_COMMENT_OPEN, index)) {
			const CLOSE_INDEX = INPUT.indexOf(MARKUP_COMMENT_CLOSE, index + MARKUP_COMMENT_OPEN.length);
			const END = CLOSE_INDEX === NOT_FOUND ? INPUT.length : CLOSE_INDEX + MARKUP_COMMENT_CLOSE.length;

			this.#mask.fill(MASK_COMMENT, index, END);

			return END;
		}

		const NEXT = INPUT.charAt(index + 1);

		if (ASCII_LETTER_REGEX.test(NEXT)) {
			return this.#scanElement(index);
		}

		const IS_DECLARATION =
			NEXT === '!' || NEXT === '?' || (NEXT === '/' && ASCII_LETTER_REGEX.test(INPUT.charAt(index + 2)));

		if (!IS_DECLARATION) {
			return index + 1;
		}

		// A closing tag, a doctype or a processing instruction holds nothing to scan
		const CLOSE_INDEX = INPUT.indexOf('>', index);

		return CLOSE_INDEX === NOT_FOUND ? INPUT.length : CLOSE_INDEX + 1;
	}

	#scanElement(index: number): number {
		const TAG = this.#readOpeningTag(index);

		if (!TAG) {
			return this.#input.length;
		}

		if (TAG.name === SCRIPT_TAG_NAME) {
			return this.#scanScriptElement(TAG);
		}

		if (TAG.name !== STYLE_TAG_NAME) {
			return TAG.end;
		}

		return this.#findCloser(STYLE_CLOSER, TAG.end)?.end ?? TAG.end;
	}

	#scanScriptElement(tag: OpeningTag): number {
		const CLOSER = this.#findCloser(SCRIPT_CLOSER, tag.end);

		// An opener no closing tag follows is not a block: its content is read as the text it then is
		if (!CLOSER) {
			return tag.end;
		}

		if (!isExecutableScriptTag(tag)) {
			return CLOSER.end;
		}

		const CONTENT: Region = { start: tag.end, end: CLOSER.start };

		this.#scanCode(CONTENT, { isSlot: false, hasHtmlComments: true });

		if (hasNestedScriptOpener(this.#input, CONTENT, this.#mask)) {
			this.#mask.fill(MASK_TEXT, CONTENT.start, CONTENT.end);
		} else {
			this.#regions.push({ ...CONTENT, allowsStatements: true });
		}

		return CLOSER.end;
	}

	/**
	 * Finds the closing tag of a raw-text block, remembering where a search proved there is none left.
	 *
	 * @param closer - The lower-cased closing tag name.
	 * @param fromIndex - The index the block's content starts at.
	 *
	 * @returns The range of the closing tag, or `null` when the document holds none after `fromIndex`.
	 */
	#findCloser(closer: string, fromIndex: number): Region | null {
		if (fromIndex >= (this.#noCloserFrom.get(closer) ?? Number.POSITIVE_INFINITY)) {
			return null;
		}

		const CLOSER = findTagCloser(this.#input, closer, fromIndex);

		if (!CLOSER) {
			this.#noCloserFrom.set(closer, fromIndex);
		}

		return CLOSER;
	}

	/**
	 * Reads an opening tag and its attributes, scanning the slots and expression attributes it holds.
	 *
	 * @param index - The index of the tag's `<`.
	 *
	 * @returns The tag, or `null` when the tag, one of its quoted values or one of its slots never closes.
	 */
	#readOpeningTag(index: number): OpeningTag | null {
		const INPUT = this.#input;

		const NAME = INPUT.slice(index + 1, findStickyMatchEnd(MARKUP_TAG_NAME_REST_REGEX, INPUT, index + 1));
		const ATTRIBUTES: TagAttribute[] = [];

		let cursor = index + 1 + NAME.length;
		let hasTrailingSlash = false;

		while (cursor < INPUT.length) {
			const CHARACTER = INPUT.charAt(cursor);

			if (CHARACTER === '>') {
				return { name: NAME.toLowerCase(), end: cursor + 1, attributes: ATTRIBUTES, isSelfClosing: hasTrailingSlash };
			}

			// A `/` separates attributes like whitespace does (`<script/type="…">`), and closes the tag when it comes last
			if (CHARACTER === '/' || isWhitespace(CHARACTER)) {
				hasTrailingSlash = CHARACTER === '/' || hasTrailingSlash;
				cursor++;
				continue;
			}

			hasTrailingSlash = false;
			cursor =
				CHARACTER === '{' && this.#opensTagSlot() ? this.#skipSlot(cursor) : this.#readAttribute(cursor, ATTRIBUTES);

			if (cursor === NOT_FOUND) {
				return null;
			}
		}

		return null;
	}

	/**
	 * Reads one attribute of an opening tag.
	 *
	 * @param start - The index of the attribute name's first character.
	 * @param attributes - The attributes read so far, which the attribute is appended to.
	 *
	 * @returns The index just after the attribute, or `-1` when its value never closes.
	 */
	#readAttribute(start: number, attributes: TagAttribute[]): number {
		const INPUT = this.#input;

		const NAME_END = findStickyMatchEnd(ATTRIBUTE_NAME_REST_REGEX, INPUT, start + 1);
		const NAME = INPUT.slice(start, NAME_END).toLowerCase();
		const EQUALS_INDEX = skipWhitespace(INPUT, NAME_END, INPUT.length);

		if (INPUT.charAt(EQUALS_INDEX) !== '=') {
			attributes.push({ name: NAME, value: '' });

			return NAME_END;
		}

		const VALUE_START = skipWhitespace(INPUT, EQUALS_INDEX + 1, INPUT.length);
		const QUOTE = INPUT.charAt(VALUE_START);

		if (QUOTE === '"' || QUOTE === "'") {
			const CLOSE_INDEX = INPUT.indexOf(QUOTE, VALUE_START + 1);

			if (CLOSE_INDEX === NOT_FOUND) {
				return NOT_FOUND;
			}

			const VALUE: Region = { start: VALUE_START + 1, end: CLOSE_INDEX };

			if (this.#hasExpressionAttributes && isExpressionAttribute(NAME)) {
				this.#addRegion(VALUE, false);
			}

			attributes.push({ name: NAME, value: INPUT.slice(VALUE.start, VALUE.end) });

			return CLOSE_INDEX + 1;
		}

		if (QUOTE === '{' && this.#opensTagSlot()) {
			const END = this.#skipSlot(VALUE_START);

			if (END !== NOT_FOUND) {
				attributes.push({ name: NAME, value: INPUT.slice(VALUE_START, END) });
			}

			return END;
		}

		const VALUE_END = findStickyMatchEnd(UNQUOTED_ATTRIBUTE_VALUE_REGEX, INPUT, VALUE_START);

		attributes.push({ name: NAME, value: INPUT.slice(VALUE_START, VALUE_END) });

		return VALUE_END;
	}

	#opensTagSlot(): boolean {
		return this.#hasSlots && this.#hasTagSlots;
	}

	/**
	 * Scans a slot written inside a tag.
	 *
	 * @param openIndex - The index of the slot's `{`.
	 *
	 * @returns The index just after the slot's `}`, or `-1` when the slot never closes.
	 */
	#skipSlot(openIndex: number): number {
		const CLOSE_INDEX = this.#scanSlot(openIndex);

		return CLOSE_INDEX === NOT_FOUND ? NOT_FOUND : CLOSE_INDEX + 1;
	}

	/**
	 * Scans the expression slot opened by a `{`, as a region where a call is always part of a larger expression.
	 *
	 * @param openIndex - The index of the slot's `{`.
	 *
	 * @returns The index of the `}` closing the slot, or `-1` when it never closes, which also disables every later
	 *   slot: the rest of the document is then read as text.
	 */
	#scanSlot(openIndex: number): number {
		const INPUT = this.#input;
		const FIRST_INDEX = skipWhitespace(INPUT, openIndex + 1, INPUT.length);
		const FIRST = INPUT.charAt(FIRST_INDEX);
		const IS_BLOCK_TAG = ASCII_LETTER_REGEX.test(INPUT.charAt(FIRST_INDEX + 1));

		// `{/if}` closes a Svelte block and holds no expression
		if (FIRST === '/' && IS_BLOCK_TAG) {
			const CLOSE_INDEX = INPUT.indexOf('}', FIRST_INDEX);

			this.#hasSlots = CLOSE_INDEX !== NOT_FOUND;

			return CLOSE_INDEX;
		}

		const HAS_BLOCK_NAME = FIRST !== '' && SVELTE_BLOCK_SIGILS.includes(FIRST) && IS_BLOCK_TAG;
		const START = HAS_BLOCK_NAME ? this.#skipSvelteBlockName(FIRST_INDEX + 1) : openIndex + 1;
		const CLOSE_INDEX = this.#scanCode({ start: START, end: INPUT.length }, { isSlot: true, hasHtmlComments: false });

		if (CLOSE_INDEX === NOT_FOUND) {
			this.#mask.fill(MASK_TEXT, START, INPUT.length);
			this.#hasSlots = false;

			return NOT_FOUND;
		}

		this.#regions.push({ start: START, end: CLOSE_INDEX, allowsStatements: false });

		return CLOSE_INDEX;
	}

	/**
	 * Skips the name of a Svelte block tag, `else if` counting as one name.
	 *
	 * @param index - The index just after the sigil.
	 *
	 * @returns The index just after the name.
	 */
	#skipSvelteBlockName(index: number): number {
		return findStickyMatchEnd(SVELTE_BLOCK_NAME_REGEX, this.#input, index);
	}
}

/**
 * Maps a source file: the class of each of its characters, and the regions holding its executable code.
 *
 * @remarks
 * A regular expression cannot do this: quotes, backticks, `${…}` placeholders, regular expression literals, comments
 * and JSX nest into each other, and a parenthesis inside any of them is text rather than structure. Every later step
 * (locating the end of a call, reading the character before a statement, deciding whether a directive sits in a
 * comment, skipping a `console.log` written inside a string or a text node) reads this map instead of re-parsing the
 * file.
 *
 * A script is a single region spanning the whole file, where JSX is read unless the kind is `ts`. A document is
 * walked by a {@link DocumentScanner}, and every character outside its code regions is text.
 *
 * @param input - The source to map.
 * @param fileKind - The kind of source.
 *
 * @returns The mask, the code regions, in source order, and the end of every template literal written in code.
 */
function createSourceLayout(input: string, fileKind: FileKind): SourceLayout {
	if (!isScriptKind(fileKind)) {
		return new DocumentScanner(input, fileKind).scan();
	}

	const MASK = new Uint8Array(input.length);
	const REGION: Region = { start: 0, end: input.length };
	const RECORDS = createScanRecords();

	scanCode(input, MASK, REGION, {
		isSlot: false,
		hasHtmlComments: false,
		hasJsx: fileKind === 'script',
		records: RECORDS,
	});

	return { mask: MASK, regions: [{ ...REGION, allowsStatements: true }], templateEnds: RECORDS.templateEnds };
}

/**
 * Builds the {@link CodeMask} of a source file.
 *
 * @param input - The source to scan.
 * @param fileKind - The kind of source, which decides which parts of it are code at all.
 *
 * @returns One byte per character: `0` code, `1` literal content, `2` comment content, `3` text.
 *
 * @see createSourceLayout
 */
function createCodeMask(input: string, fileKind: FileKind): CodeMask {
	return createSourceLayout(input, fileKind).mask;
}

/**
 * Moving cursor reporting which code region of a file covers an index.
 *
 * @remarks
 * The matches of one file are located in source order, so a region the previous lookup already left behind can never
 * cover a later index: the cursor only moves forward, which is what keeps a document holding thousands of regions
 * linear instead of costing one search of the whole list per match. The regions are read in the order
 * {@link createSourceLayout} produced them, which is source order, and never overlap.
 */
class RegionCursor {
	readonly #regions: readonly CodeRegion[];
	#index = 0;

	constructor(regions: readonly CodeRegion[]) {
		this.#regions = regions;
	}

	/**
	 * Returns the region covering the given index.
	 *
	 * @param index - The index of a code character, never before the region the previous call returned.
	 *
	 * @returns The region containing the index.
	 *
	 * @throws When no region the cursor has not passed yet covers the index: either the indexes are not queried in
	 *   source order, or a character the mask reports as code belongs to no region, neither of which the layout
	 *   produces.
	 */
	find(index: number): CodeRegion {
		let region = this.#regions[this.#index];

		while (region != null && region.end <= index) {
			this.#index++;
			region = this.#regions[this.#index];
		}

		/* v8 ignore next -- offensive invariant: matches are located in source order, each inside a code region */
		if (region == null || index < region.start) {
			throw new Error('RegionCursor requires code indexes queried in source order, each inside a code region');
		}

		return region;
	}
}

/**
 * One `(` written in code position: where it opens, how many braces stood open at that point, whether the call it
 * opens can still be delimited, and which statement header it opens, if any
 */
interface ParenthesisFrame {
	/** The index of this `(` in the source */
	openerIndex: number;
	braceLevel: number;
	isDelimitable: boolean;
	/** `true` for the header of an `if`, `while`, `for` or `with` statement */
	isControlHeader: boolean;
	/** `true` for the header of a `for` statement, whose `;` separate clauses instead of terminating statements */
	isForHeader: boolean;
}

/**
 * Everything the single structural pass over a file records
 */
interface StructureTable {
	/**
	 * The index of the `)` closing each call that can be delimited, keyed by the index of its `(`: one entry per
	 * delimitable parenthesis rather than one per character
	 */
	callEnds: Map<number, number>;
	/** Every `;` separating the clauses of a `for` header */
	forHeaderSeparators: Set<number>;
	/** Every `)` closing the header of a control keyword */
	controlHeaderEnds: Set<number>;
}

/**
 * Gives up on every frame whose argument list the offending character sits directly in.
 *
 * @remarks
 * A `;` written at the top level of an argument list, and a `}` balancing nothing inside one, both mean the mask is
 * out of step with the real source. Those two characters invalidate exactly the frames opened at the brace level they
 * sit at: a frame opened deeper was already invalidated by the `}` that left its level, which is what keeps the
 * remaining frames ordered by brace level and the ones to drop on top of the stack.
 *
 * @param frames - The still-delimitable frames, ordered by the brace level they were opened at.
 * @param braceLevel - The brace level the offending character sits at.
 */
function discardFramesAtBraceLevel(frames: ParenthesisFrame[], braceLevel: number): void {
	let frame = frames.at(-1);

	while (frame?.braceLevel === braceLevel) {
		frame.isDelimitable = false;
		frames.pop();
		frame = frames.at(-1);
	}
}

/**
 * An identifier of the source and where it starts
 */
interface Word {
	text: string;
	start: number;
}

/**
 * Reads the identifier written right before an index, unless it is the name of a member (`a.if`).
 *
 * @param input - The source.
 * @param index - The index to read before.
 * @param mask - The code mask of `input`.
 *
 * @returns The identifier, or `null` when the closest significant token is anything else.
 */
function readWordBefore(input: string, index: number, mask: CodeMask): Word | null {
	const END = findPreviousSignificantIndex(input, index - 1, mask);

	if (END === NOT_FOUND || mask[END] !== MASK_CODE || !isIdentifierCharacter(input.charAt(END))) {
		return null;
	}

	const START = findIdentifierStart(input, END);
	const BEFORE = findPreviousSignificantIndex(input, START - 1, mask);

	return BEFORE !== NOT_FOUND && input.charAt(BEFORE) === '.'
		? null
		: { text: input.slice(START, END + 1), start: START };
}

/**
 * Returns the statement keyword a `(` opens the header of.
 *
 * @param input - The source.
 * @param parenthesisIndex - The index of the `(`.
 * @param mask - The code mask of `input`.
 *
 * @returns The keyword (`for` for a `for await` header too), or the empty string for any other parenthesis.
 */
function getHeaderKeyword(input: string, parenthesisIndex: number, mask: CodeMask): string {
	const WORD = readWordBefore(input, parenthesisIndex, mask);

	if (WORD?.text !== 'await') {
		return WORD?.text ?? '';
	}

	return readWordBefore(input, WORD.start, mask)?.text === 'for' ? 'for' : WORD.text;
}

/**
 * Matches every parenthesis of a file in a single forward pass, recording along the way which of them open a
 * statement header.
 *
 * @remarks
 * The pass doubles as a structural sanity check, applied to each call independently: a `}` that balances nothing, a
 * `;` written at the top level of an argument list, or a closing parenthesis reached while a brace opened inside the
 * call is still open all mean that the mask is out of step with the real source. Reporting "not found" then leaves
 * the call untouched, which is always safe.
 *
 * Walking the whole file once, rather than forward from each call, is what keeps a file holding thousands of calls
 * that never close linear instead of quadratic. A closing parenthesis resolves the innermost frame still open, which
 * is the top of the open stack and — when it is still delimitable — the top of the delimitable stack too. The same
 * stack tells a `;` written directly in a `for` header apart from one terminating a statement, whatever the length of
 * the code before it.
 *
 * @param input - The source to scan.
 * @param mask - The code mask of `input`.
 *
 * @returns The call ends, the `for` header separators and the ends of the control headers.
 */
function buildStructureTable(input: string, mask: CodeMask): StructureTable {
	const CALL_ENDS = new Map<number, number>();
	const FOR_HEADER_SEPARATORS = new Set<number>();
	const CONTROL_HEADER_ENDS = new Set<number>();
	const OPEN_FRAMES: ParenthesisFrame[] = [];
	const DELIMITABLE_FRAMES: ParenthesisFrame[] = [];

	let braceLevel = 0;

	for (let index = 0; index < input.length; index++) {
		if (mask[index] !== MASK_CODE) {
			continue;
		}

		switch (input.charAt(index)) {
			case '(': {
				const KEYWORD = getHeaderKeyword(input, index, mask);
				const FRAME: ParenthesisFrame = {
					openerIndex: index,
					braceLevel,
					isDelimitable: true,
					isControlHeader: CONTROL_KEYWORDS.has(KEYWORD),
					isForHeader: KEYWORD === 'for',
				};

				OPEN_FRAMES.push(FRAME);
				DELIMITABLE_FRAMES.push(FRAME);
				break;
			}

			case ')': {
				const FRAME = OPEN_FRAMES.pop();

				if (FRAME?.isControlHeader === true) {
					CONTROL_HEADER_ENDS.add(index);
				}

				if (FRAME?.isDelimitable === true) {
					DELIMITABLE_FRAMES.pop();

					if (FRAME.braceLevel === braceLevel) {
						CALL_ENDS.set(FRAME.openerIndex, index);
					}
				}

				break;
			}

			case '{':
				braceLevel++;
				break;

			case '}':
				discardFramesAtBraceLevel(DELIMITABLE_FRAMES, braceLevel);
				braceLevel--;
				break;

			case ';': {
				const INNERMOST = OPEN_FRAMES.at(-1);

				if (INNERMOST?.isForHeader === true && INNERMOST.braceLevel === braceLevel) {
					FOR_HEADER_SEPARATORS.add(index);
				}

				discardFramesAtBraceLevel(DELIMITABLE_FRAMES, braceLevel);
				break;
			}
		}
	}

	return {
		callEnds: CALL_ENDS,
		forHeaderSeparators: FOR_HEADER_SEPARATORS,
		controlHeaderEnds: CONTROL_HEADER_ENDS,
	};
}

/**
 * Walks backwardto the closest significant character, skipping whitespace and comments.
 *
 * @remarks
 * Literal content is significant: a quote or a backtick is a real token, and stepping over it would make the code
 * before the literal look adjacent to the call. Text is significant too, for the same reason.
 *
 * @param input - The source to walk.
 * @param fromIndex - The index to start from, inclusive.
 * @param mask - The code mask of `input`.
 *
 * @returns The index of the character found, or `-1` when the start of the file is reached.
 */
function findPreviousSignificantIndex(input: string, fromIndex: number, mask: CodeMask): number {
	for (let index = fromIndex; index >= 0; index--) {
		if (mask[index] !== MASK_COMMENT && CHARACTER_CLASSES[input.charCodeAt(index)] !== CHARACTER_CLASS_WHITESPACE) {
			return index;
		}
	}

	return NOT_FOUND;
}

/**
 * Walks forwardto the closest significant character, skipping whitespace and comments.
 *
 * @param input - The source to walk.
 * @param fromIndex - The index to start from, inclusive.
 * @param mask - The code mask of `input`.
 *
 * @returns The index of the character found, or `-1` when the end of the file is reached.
 */
function findNextSignificantIndex(input: string, fromIndex: number, mask: CodeMask): number {
	for (let index = fromIndex; index < input.length; index++) {
		if (mask[index] !== MASK_COMMENT && CHARACTER_CLASSES[input.charCodeAt(index)] !== CHARACTER_CLASS_WHITESPACE) {
			return index;
		}
	}

	return NOT_FOUND;
}

/**
 * Walks forwardto the character that could terminate the statement, skipping horizontal whitespace and comments.
 * Newlines are returned rather than skipped: they terminate a statement written without a semicolon.
 *
 * @param input - The source to walk.
 * @param fromIndex - The index to start from, inclusive.
 * @param mask - The code mask of `input`.
 *
 * @returns The index of the character found, or `-1` when the end of the file is reached.
 */
function findStatementTerminator(input: string, fromIndex: number, mask: CodeMask): number {
	for (let index = fromIndex; index < input.length; index++) {
		if (mask[index] === MASK_COMMENT) {
			continue;
		}

		const CHARACTER = input.charAt(index);

		if (CHARACTER !== ' ' && CHARACTER !== '\t' && CHARACTER !== '\r') {
			return index;
		}
	}

	return NOT_FOUND;
}

/**
 * Returns the index at which the identifier ending at `endIndex` starts.
 *
 * @param input - The source containing the identifier.
 * @param endIndex - The index of the identifier's last character.
 *
 * @returns The index of the identifier's first character.
 */
function findIdentifierStart(input: string, endIndex: number): number {
	for (let index = endIndex; index >= 0; index--) {
		if (CHARACTER_CLASSES[input.charCodeAt(index)] !== CHARACTER_CLASS_IDENTIFIER) {
			return index + 1;
		}
	}

	return 0;
}

/**
 * Returns the index just after the identifier starting at `startIndex`.
 *
 * @param input - The source containing the identifier.
 * @param startIndex - The index of the identifier's first character.
 *
 * @returns The exclusive end of the identifier, which is `startIndex` itself when no identifier starts there.
 */
function findIdentifierEnd(input: string, startIndex: number): number {
	for (let index = startIndex; index < input.length; index++) {
		if (CHARACTER_CLASSES[input.charCodeAt(index)] !== CHARACTER_CLASS_IDENTIFIER) {
			return index;
		}
	}

	return input.length;
}

/**
 * Reports whether the `[from, to)` range of the input holds a line break.
 *
 * @param input - The source.
 * @param from - The start index, inclusive.
 * @param to - The end index, exclusive.
 *
 * @returns `true` when a `\n` sits in the range.
 */
function hasLineBreak(input: string, from: number, to: number): boolean {
	for (let index = from; index < to; index++) {
		if (input.charAt(index) === '\n') {
			return true;
		}
	}

	return false;
}

/**
 * Reports whether an identifier character immediately precedes the match, which makes the match the tail of a longer
 * identifier rather than a `console` of its own.
 *
 * @remarks
 * The `\b` opening the call pattern only knows the ASCII word characters, so `$console.log(1)`,
 * `this.#console.log(1)` and `éconsole.log(1)` all look like a call on the global console to it. The two characters
 * before the match are read together, so that an identifier ending outside the Basic Multilingual Plane is seen
 * whole rather than as the lone surrogate its last code unit is.
 *
 * @param input - The source containing the match.
 * @param matchStart - The index of the `console` identifier.
 *
 * @returns `true` when an identifier character immediately precedes the match.
 */
function hasIdentifierCharacterBefore(input: string, matchStart: number): boolean {
	return IDENTIFIER_END_REGEX.test(input.slice(Math.max(0, matchStart - 2), matchStart));
}

/**
 * Resolves the first character of the expression to edit, taking an optional global qualifier into account.
 *
 * @remarks
 * `window.console.log(…)` and its `globalThis` / `self` / `global` siblings reference the global console, so the
 * qualifier belongs to the edited range, whatever call form follows it. Any other member access
 * (`logger.console.log(…)`, `a.window.console.log(…)`) or an optional chain (`window?.console.log(…)`) targets
 * something this plugin cannot reason about, and is skipped.
 *
 * @param input - The source containing the call.
 * @param matchStart - The index of the `console` identifier.
 * @param mask - The code mask of `input`.
 *
 * @returns The index the edit starts at, or `-1` when the call must be left untouched.
 */
function getEditStart(input: string, matchStart: number, mask: CodeMask): number {
	// `$console.log(1)` and `this.#console.log(1)` call something else entirely, and editing one would leave the
	// characters the pattern did not match behind
	if (hasIdentifierCharacterBefore(input, matchStart)) {
		return NOT_FOUND;
	}

	const DOT_INDEX = findPreviousSignificantIndex(input, matchStart - 1, mask);

	if (DOT_INDEX === NOT_FOUND || input.charAt(DOT_INDEX) !== '.' || mask[DOT_INDEX] !== MASK_CODE) {
		return matchStart;
	}

	const BEFORE_DOT = findPreviousSignificantIndex(input, DOT_INDEX - 1, mask);

	if (BEFORE_DOT === NOT_FOUND || mask[BEFORE_DOT] !== MASK_CODE || input.charAt(BEFORE_DOT) === '?') {
		return NOT_FOUND;
	}

	const NAME_START = findIdentifierStart(input, BEFORE_DOT);

	if (!QUALIFIER_NAMES.has(input.slice(NAME_START, BEFORE_DOT + 1))) {
		return NOT_FOUND;
	}

	const BEFORE_NAME = findPreviousSignificantIndex(input, NAME_START - 1, mask);
	const IS_MEMBER_ACCESS =
		BEFORE_NAME !== NOT_FOUND && (input.charAt(BEFORE_NAME) === '.' || input.charAt(BEFORE_NAME) === '?');

	return IS_MEMBER_ACCESS ? NOT_FOUND : NAME_START;
}

/**
 * Reports whether the code ending at an index is a TypeScript return type annotation (`): void`, `): Promise<T>`).
 *
 * @remarks
 * The walk goes back over identifiers, whitespace, string literal types and the punctuation of a simple type to the
 * `:` opening the annotation, and requires the `)` of a parameter list right before it. A type holding braces or
 * parentheses is not recognized, and neither is one longer than {@link RETURN_TYPE_LOOKBACK_LIMIT}: the brace is
 * then read as the object literal it could be, which only ever keeps a statement in place.
 *
 * @param input - The source.
 * @param endIndex - The index of the last character before the `{`.
 * @param mask - The code mask of `input`.
 *
 * @returns `true` when the `{` that follows opens the body of a function with a return type.
 */
function closesReturnTypeAnnotation(input: string, endIndex: number, mask: CodeMask): boolean {
	const LIMIT = Math.max(0, endIndex - RETURN_TYPE_LOOKBACK_LIMIT);

	for (let index = endIndex; index >= LIMIT; index--) {
		const KIND = mask[index];

		if (KIND === MASK_COMMENT || KIND === MASK_LITERAL) {
			continue;
		}

		const CHARACTER = input.charAt(index);

		if (KIND !== MASK_CODE) {
			return false;
		}

		if (CHARACTER === ':') {
			const BEFORE_COLON = findPreviousSignificantIndex(input, index - 1, mask);

			return BEFORE_COLON !== NOT_FOUND && mask[BEFORE_COLON] === MASK_CODE && input.charAt(BEFORE_COLON) === ')';
		}

		const IS_TYPE_CHARACTER =
			isWhitespace(CHARACTER) || isIdentifierCharacter(CHARACTER) || TYPE_ANNOTATION_CHARACTERS.includes(CHARACTER);

		if (!IS_TYPE_CHARACTER) {
			return false;
		}
	}

	return false;
}

/**
 * Reports whether the `{` at the given index opens a block of statements.
 *
 * @remarks
 * An object literal (`= {`), a JSX attribute value (`a={`) and a JSX child (`>{`) all read like a block otherwise,
 * and emptying them produces either invalid syntax or a different rendered tree. A function body is recognized after
 * the `)` of its parameters, after `=>`, after a block keyword and after a TypeScript return type annotation.
 *
 * @param input - The source containing the brace.
 * @param braceIndex - The index of the `{`.
 * @param mask - The code mask of `input`.
 *
 * @returns `true` when statements may be removed from the brace's body.
 */
function isBlockBrace(input: string, braceIndex: number, mask: CodeMask): boolean {
	const BEFORE = findPreviousSignificantIndex(input, braceIndex - 1, mask);

	if (BEFORE === NOT_FOUND) {
		return true;
	}

	// A literal can only end right before a block as the string literal type closing a return type (`): 'a' {`)
	if (mask[BEFORE] !== MASK_CODE) {
		return mask[BEFORE] === MASK_LITERAL && closesReturnTypeAnnotation(input, BEFORE, mask);
	}

	const CHARACTER = input.charAt(BEFORE);

	// `=> {` opens an arrow function body; any other `>` may close the type arguments of a return type
	if (CHARACTER === '>' && input.charAt(findPreviousSignificantIndex(input, BEFORE - 1, mask)) === '=') {
		return true;
	}

	if (BLOCK_BRACE_CHARACTERS.includes(CHARACTER)) {
		return true;
	}

	const IS_BLOCK_KEYWORD =
		isIdentifierCharacter(CHARACTER) && BLOCK_KEYWORDS.has(input.slice(findIdentifierStart(input, BEFORE), BEFORE + 1));

	return IS_BLOCK_KEYWORD || closesReturnTypeAnnotation(input, BEFORE, mask);
}

/**
 * Reports whether the expression continues on the line following a call.
 *
 * @remarks
 * A statement written without a semicolon is terminated by automatic semicolon insertion, which only applies when
 * the next line cannot continue the expression. `console.log(1)` followed by a line opening on `.x`, `&& y`, `!= z`
 * or `instanceof Z` was therefore never a statement of its own, and removing it would leave the operator without its
 * left operand; a lone `!` opens a new statement instead. The search stops at the end of the region, so that the
 * `</script>` closing a block is not read as a `<` continuing the last statement of that block.
 *
 * @param input - The source containing the call.
 * @param fromIndex - The index to start the search at, inclusive.
 * @param regionEnd - The exclusive end of the enclosing region.
 * @param mask - The code mask of `input`.
 *
 * @returns `true` when the next significant token can only continue the expression.
 */
function isFollowedByContinuation(input: string, fromIndex: number, regionEnd: number, mask: CodeMask): boolean {
	const NEXT = findNextSignificantIndex(input, fromIndex, mask);

	if (NEXT === NOT_FOUND || NEXT >= regionEnd) {
		return false;
	}

	if (CONTINUATION_CHARACTERS.includes(input.charAt(NEXT)) || input.startsWith(INEQUALITY_OPERATOR, NEXT)) {
		return true;
	}

	return CONTINUATION_KEYWORDS.has(input.slice(NEXT, findIdentifierEnd(input, NEXT)));
}

/**
 * Everything {@link createConsoleEdit} needs about the file being scanned
 */
interface EditContext {
	mask: CodeMask;
	/** The structural facts of the file, `null` until the first query that needs them (see {@link getStructure}) */
	structure: StructureTable | null;
	regions: RegionCursor;
	/** The index of the backtick closing each template literal written in code, keyed by its opening backtick */
	templateEnds: ReadonlyMap<number, number>;
}

/**
 * Returns the structural facts of the file being scanned, building them on the first query that needs them.
 *
 * @remarks
 * Most files hold no stripped call at all, and the table is the only structure of the scan that costs a pass of its
 * own, so it is never built before a match asks for it. Once built, a header lookup and a call end lookup are each a
 * single map or set read, which keeps the table proportional to the parentheses of the file rather than to its length.
 *
 * @param input - The source being scanned.
 * @param context - The edit context of the file, which keeps the table once built.
 *
 * @returns The call ends, the `for` header separators and the ends of the control headers.
 */
function getStructure(input: string, context: EditContext): StructureTable {
	context.structure ??= buildStructureTable(input, context.mask);

	return context.structure;
}

/**
 * Reports whether the token ending at an index ends a value, which a line break after it lets automatic semicolon
 * insertion terminate.
 *
 * @remarks
 * A value ends on the closing quote, backtick or slash of a literal, on the `>` closing a JSX element, on `)`, `]`
 * or `}`, on a postfix `++` / `--`, and on an identifier. A `)` closing the header of an `if`, `while`, `for` or
 * `with` statement is followed by that statement's body instead, and an identifier that is a keyword still expecting
 * what follows it (`return`, `else`, `typeof`, `const`, …) ends nothing, unless it is the name of a member (`a.if`).
 *
 * @param input - The source.
 * @param index - The index of the token's last character, a significant one and therefore never a comment.
 * @param context - The mask and the structure of the file.
 *
 * @returns `true` when the token ends a value.
 */
function endsValue(input: string, index: number, context: EditContext): boolean {
	const MASK = context.mask;
	const CHARACTER = input.charAt(index);
	const KIND = MASK[index];

	if (KIND === MASK_LITERAL) {
		return LITERAL_VALUE_ENDING_CHARACTERS.includes(CHARACTER);
	}

	if (KIND === MASK_TEXT) {
		return CHARACTER === '>';
	}

	if (CHARACTER === ')') {
		return !getStructure(input, context).controlHeaderEnds.has(index);
	}

	if (CHARACTER === ']' || CHARACTER === '}') {
		return true;
	}

	if (CHARACTER === '+' || CHARACTER === '-') {
		return input.charAt(index - 1) === CHARACTER;
	}

	if (!isIdentifierCharacter(CHARACTER)) {
		return false;
	}

	const START = findIdentifierStart(input, index);
	const BEFORE = findPreviousSignificantIndex(input, START - 1, MASK);
	const IS_MEMBER_NAME = BEFORE !== NOT_FOUND && input.charAt(BEFORE) === '.';

	return IS_MEMBER_NAME || !OPERAND_KEYWORDS.has(input.slice(START, index + 1));
}

/**
 * Reports whether the call starts a statement.
 *
 * @remarks
 * A statement starts at the beginning of its region, after a `;` terminating another one, after the `{` of a block,
 * after a `}`, and after a line break automatic semicolon insertion turns into a statement boundary: one following a
 * value, which `console` — an identifier — cannot continue. The `;` of a `for` header separates clauses instead, and
 * the `{` of an object literal, a JSX expression container or a `${…}` placeholder opens an expression.
 *
 * @param input - The source containing the call.
 * @param bounds - The edit start and the enclosing region.
 * @param context - The mask and the structure of the file.
 *
 * @returns `true` when the call is the first token of a statement.
 */
function isStatementStart(input: string, bounds: StatementBounds, context: EditContext): boolean {
	const MASK = context.mask;
	const PRECEDING = findPreviousSignificantIndex(input, bounds.start - 1, MASK);

	if (PRECEDING === NOT_FOUND || PRECEDING < bounds.regionStart) {
		return true;
	}

	const CHARACTER = input.charAt(PRECEDING);

	if (MASK[PRECEDING] === MASK_CODE) {
		if (CHARACTER === '}') {
			return true;
		}

		// `for (a; console.log(b); c)` opens no statement: removing the condition would leave a header of two clauses
		if (CHARACTER === ';') {
			return !getStructure(input, context).forHeaderSeparators.has(PRECEDING);
		}

		// `<div a={console.log(1)} />` and `<div>{console.log(1)}</div>` look like a one-statement block but are JSX
		// expression containers: emptying one is a syntax error in the first case and a semantic change in the second
		if (CHARACTER === '{') {
			return isBlockBrace(input, PRECEDING, MASK);
		}
	}

	return hasLineBreak(input, PRECEDING + 1, bounds.start) && endsValue(input, PRECEDING, context);
}

/**
 * Decides whether the call forms a statement of its own and, if so, where that statement ends.
 *
 * @remarks
 * A call is provably standalone when it starts a statement (see {@link isStatementStart}) and the closest significant
 * character after it terminates a statement (`;`, a newline, `}` or the end of the region). The terminator must be
 * executable code: the `}` closing a `${…}` placeholder looks like a statement delimiter but is template syntax.
 * Everything else (`if (x) console.log(1);`, `x && console.log(1)`, `() => console.log(x)`) is an expression whose
 * removal would change how the surrounding code parses. A newline followed by an operator was never turned into a
 * semicolon by automatic semicolon insertion, and does not terminate anything either.
 *
 * The region is the whole file for a script, and the body of the `<script>` block or of the Astro frontmatter for a
 * document, so that the first and last statements of such a block are recognized as statements rather than as text
 * glued to the surrounding tags.
 *
 * @param input - The source containing the call.
 * @param bounds - The edit start, the index of the call's last character, and the enclosing region.
 * @param context - The mask and the structure of the file.
 *
 * @returns The exclusive end of the statement (trailing `;` included), or `-1` when the call is not standalone.
 */
function getStatementEnd(input: string, bounds: StatementBounds, context: EditContext): number {
	if (!isStatementStart(input, bounds, context)) {
		return NOT_FOUND;
	}

	const MASK = context.mask;
	const TERMINATOR = findStatementTerminator(input, bounds.callEnd + 1, MASK);

	if (TERMINATOR === NOT_FOUND || TERMINATOR >= bounds.regionEnd) {
		return bounds.callEnd + 1;
	}

	if (MASK[TERMINATOR] !== MASK_CODE) {
		return NOT_FOUND;
	}

	const CHARACTER = input.charAt(TERMINATOR);

	if (CHARACTER === ';') {
		return TERMINATOR + 1;
	}

	if (CHARACTER === '}') {
		return bounds.callEnd + 1;
	}

	if (CHARACTER !== '\n') {
		return NOT_FOUND;
	}

	return isFollowedByContinuation(input, TERMINATOR + 1, bounds.regionEnd, MASK) ? NOT_FOUND : bounds.callEnd + 1;
}

/**
 * Chooses the expression that replaces a call kept in place.
 *
 * @remarks
 * `void 0.foo` is a syntax error and `void 0(x)` calls `undefined`, so the expression is parenthesized whenever the
 * value it produces is immediately used. An optional chain and an exponentiation need the same parentheses for
 * reasons of their own: `void 0?.(x)` binds as `void (0?.(x))`, which calls `0`, and `void 0 ** 2` is the syntax
 * error every unary left operand of `**` is. A ternary (`void 0 ? a : b`) and a `??` (`void 0 ?? a`) both parse as
 * written, so a lone `?` needs nothing. A word written right against the call (`console.log(1)in b`) is kept apart
 * from the `0` by a space.
 *
 * @param input - The source containing the call.
 * @param callEnd - The index of the call's last character.
 * @param mask - The code mask of `input`.
 *
 * @returns `'(void 0)'` when a member access, call, tagged template, optional chain or exponentiation follows;
 *   `'void 0'` otherwise, followed by a space when an identifier character comes right after the call.
 */
function getVoidReplacement(input: string, callEnd: number, mask: CodeMask): string {
	const NEXT = findNextSignificantIndex(input, callEnd + 1, mask);

	const IS_VALUE_USED =
		NEXT !== NOT_FOUND &&
		(MEMBER_ACCESS_CHARACTERS.includes(input.charAt(NEXT)) ||
			input.startsWith(OPTIONAL_CHAIN_OPERATOR, NEXT) ||
			input.startsWith(EXPONENTIATION_OPERATOR, NEXT));

	if (IS_VALUE_USED) {
		return PARENTHESIZED_VOID_EXPRESSION;
	}

	return IDENTIFIER_START_REGEX.test(input.slice(callEnd + 1, callEnd + 3)) ? `${VOID_EXPRESSION} ` : VOID_EXPRESSION;
}

/**
 * Reports whether the call is the operand of a `new` expression.
 *
 * @remarks
 * `new console.log(1)` constructs rather than calls, and `new void 0` is a syntax error; such an expression is left
 * exactly as written.
 *
 * @param input - The source containing the call.
 * @param start - The index the edit starts at.
 * @param mask - The code mask of `input`.
 *
 * @returns `true` when the `new` keyword immediately precedes the edit.
 */
function isPrecededByNew(input: string, start: number, mask: CodeMask): boolean {
	const PRECEDING = findPreviousSignificantIndex(input, start - 1, mask);

	if (PRECEDING === NOT_FOUND || mask[PRECEDING] !== MASK_CODE) {
		return false;
	}

	if (!isIdentifierCharacter(input.charAt(PRECEDING))) {
		return false;
	}

	return input.slice(findIdentifierStart(input, PRECEDING), PRECEDING + 1) === NEW_KEYWORD;
}

/**
 * Reports whether a value ends right before the call, inside its region.
 *
 * @remarks
 * `console` is an identifier, so a call written after a value is a statement of its own by automatic semicolon
 * insertion. A replacement opening on `(` would instead read as a call applied to that value, whether that value is
 * an identifier, a literal, the `}` of an object literal or a regular expression.
 *
 * @param input - The source containing the call.
 * @param start - The index the edit starts at.
 * @param region - The enclosing region.
 * @param context - The mask and the structure of the file.
 *
 * @returns `true` when a value-ending token immediately precedes the edit.
 */
function isPrecededByValue(input: string, start: number, region: Region, context: EditContext): boolean {
	const PRECEDING = findPreviousSignificantIndex(input, start - 1, context.mask);

	return PRECEDING !== NOT_FOUND && PRECEDING >= region.start && endsValue(input, PRECEDING, context);
}

/**
 * Reports whether a removed statement has to leave a `;` behind to keep its neighbors apart.
 *
 * @remarks
 * A statement written after a value — the `}` of a function expression or of an object literal, or a value
 * automatic semicolon insertion terminated at a line break — keeps that value apart from whatever follows it.
 * Removing it can make the two fuse into a single expression (`const f = function () {}` followed by `(c)()` becomes
 * a call of that function), which silently changes what the program does, whether or not the removed statement had
 * a semicolon of its own. A statement written after a `;`, a `{` or the start of its region has nothing to fuse with.
 *
 * @param input - The source containing the statement.
 * @param range - The range the removed statement occupies.
 * @param region - The enclosing region.
 * @param mask - The code mask of `input`.
 *
 * @returns `true` when the next token could continue the value written before the statement.
 */
function needsAsiGuard(input: string, range: Region, region: Region, mask: CodeMask): boolean {
	const PRECEDING = findPreviousSignificantIndex(input, range.start - 1, mask);

	if (PRECEDING === NOT_FOUND || PRECEDING < region.start) {
		return false;
	}

	const IS_STATEMENT_BOUNDARY =
		mask[PRECEDING] === MASK_CODE && (input.charAt(PRECEDING) === ';' || input.charAt(PRECEDING) === '{');

	if (IS_STATEMENT_BOUNDARY) {
		return false;
	}

	const NEXT = findNextSignificantIndex(input, range.end, mask);

	return NEXT !== NOT_FOUND && NEXT < region.end && ASI_HAZARD_CHARACTERS.includes(input.charAt(NEXT));
}

/**
 * Reports where the indentation of a removed statement starts, when no code precedes it on its line.
 *
 * @remarks
 * The walk stops on the first character that is neither a space nor a tab, so it never leaves the line it starts on.
 * Reaching the start of the enclosing region counts as reaching the start of a line: the first statement of a
 * `<script>` block opens the text of that block. A byte order mark opening the file is read as the start of the
 * first line, so it stays in place while the line it opens is removed.
 *
 * @param input - The source containing the statement.
 * @param start - The index the removal starts at.
 * @param regionStart - The first index of the enclosing region.
 *
 * @returns The index of the first indentation character, or `-1` when something else shares the line.
 */
function findIndentationStart(input: string, start: number, regionStart: number): number {
	for (let index = start - 1; index >= regionStart; index--) {
		const CHARACTER = input.charAt(index);

		if (CHARACTER === '\n' || (index === 0 && CHARACTER === BYTE_ORDER_MARK)) {
			return index + 1;
		}

		if (CHARACTER !== ' ' && CHARACTER !== '\t') {
			return NOT_FOUND;
		}
	}

	return regionStart;
}

/**
 * Reports where the line of a removed statement ends, when no code follows it on that line.
 *
 * @remarks
 * A trailing comment, like any other text, keeps the line alive and stops the walk. The `\r` of a `\r\n` break is
 * only read as part of the break when its `\n` is inside the region too, so that the walk never reports a position
 * past the region it was given.
 *
 * @param input - The source containing the statement.
 * @param end - The exclusive end of the removal.
 * @param regionEnd - The exclusive end of the enclosing region.
 *
 * @returns The index just after the line break, `end` itself when the region ends before any break, or `-1` when
 *   something else shares the line.
 */
function findLineEnd(input: string, end: number, regionEnd: number): number {
	for (let index = end; index < regionEnd; index++) {
		const CHARACTER = input.charAt(index);

		if (CHARACTER === '\n') {
			return index + 1;
		}

		if (CHARACTER === '\r' && index + 1 < regionEnd && input.charAt(index + 1) === '\n') {
			return index + 2;
		}

		if (CHARACTER !== ' ' && CHARACTER !== '\t') {
			return NOT_FOUND;
		}
	}

	return end;
}

/**
 * Widens a removal to the whole line when the statement was alone on it.
 *
 * @remarks
 * Removing the statement alone would leave its indentation and its line break behind, so every stripped line would
 * become a blank one. The widened range covers that indentation and exactly one line break (`\r\n` counts as one),
 * and only when nothing else shares the line: surrounding code, or a trailing comment, leaves the range untouched.
 * A blank line the source already held is not one this range covers, and therefore survives.
 *
 * The range never leaves the enclosing region, so the `<script>` tags of a document and the `---` fence of an Astro
 * frontmatter stay exactly where they are. The line break belongs to the line being removed, which keeps two
 * removals written on adjacent lines sorted and non-overlapping: the second one starts where the first one ends.
 *
 * @param input - The source containing the statement.
 * @param range - The range the statement occupies.
 * @param region - The enclosing region.
 *
 * @returns The range to remove, widened when the statement was alone on its line.
 */
function widenRemovalToLine(input: string, range: Region, region: Region): Region {
	const INDENTATION_START = findIndentationStart(input, range.start, region.start);

	if (INDENTATION_START === NOT_FOUND) {
		return range;
	}

	const LINE_END = findLineEnd(input, range.end, region.end);

	return LINE_END === NOT_FOUND ? range : { start: INDENTATION_START, end: LINE_END };
}

/**
 * An edit together with the region it was found in, which {@link widenLineRemovals} bounds its widening with
 */
interface RegionEdit extends Edit {
	region: CodeRegion;
}

/**
 * Finds the last character of a matched call: the `)` closing its arguments, or the backtick closing its tagged
 * template.
 *
 * @param input - The source containing the call.
 * @param match - The call match, ending on the call's `(` or opening backtick.
 * @param context - The mask and the structure of the file.
 * @param regionEnd - The exclusive end of the region a tagged template has to close within.
 *
 * @returns The index of the call's last character, or `-1` when the call cannot be delimited with confidence.
 */
function findCallExpressionEnd(input: string, match: RegExpExecArray, context: EditContext, regionEnd: number): number {
	const OPENER_INDEX = match.index + match[0].length - 1;

	if (input.charAt(OPENER_INDEX) !== '`') {
		return getStructure(input, context).callEnds.get(OPENER_INDEX) ?? NOT_FOUND;
	}

	const TEMPLATE_END = context.mask[match.index] === MASK_CODE ? context.templateEnds.get(OPENER_INDEX) : undefined;

	return TEMPLATE_END != null && TEMPLATE_END < regionEnd ? TEMPLATE_END : NOT_FOUND;
}

/**
 * Turns one regex match into the edit that neutralizes it.
 *
 * @remarks
 * A call forming a statement of its own is removed, which only a region holding statements allows: a whole script,
 * a `<script>` block or Astro frontmatter. Everywhere else — a template expression slot, a Vue directive value —
 * the call is replaced by `void 0`, which both Svelte and Vue render as an empty string. A call written anywhere the
 * layout reports as text (page text, a JSX child, a data block) is left exactly as it was written, and so is
 * `new console.log(…)`. A call whose end cannot be found within its region is left as written as well, and told
 * apart so that the scan can report it.
 *
 * @param input - The source containing the call.
 * @param match - The call match, ending on the call's `(` or opening backtick.
 * @param context - The mask, the structure and the code regions of the file.
 *
 * @returns The edit to apply, `null` when the match must be left untouched, or {@link UNDELIMITED_CALL} when it is a
 *   call whose end could not be found within its region.
 *
 * @throws When a character the mask reports as code belongs to no region, which the layout never produces (see
 *   {@link RegionCursor.find}).
 */
function createConsoleEdit(
	input: string,
	match: RegExpExecArray,
	context: EditContext,
): RegionEdit | typeof UNDELIMITED_CALL | null {
	const MASK = context.mask;

	// `console.log(…)` written inside a comment, a string or a text node is text, not a call
	if (MASK[match.index] !== MASK_CODE) {
		return null;
	}

	const REGION = context.regions.find(match.index);
	const START = getEditStart(input, match.index, MASK);

	if (START === NOT_FOUND || START < REGION.start) {
		return null;
	}

	const CALL_END = findCallExpressionEnd(input, match, context, REGION.end);

	if (isPrecededByNew(input, START, MASK)) {
		return null;
	}

	// `<script>console.log(1</script><p>a)</p>` closes its call outside the block the browser executes: every edit
	// derived from that call would reach past the closing tag and take the page's markup with it
	if (CALL_END === NOT_FOUND || CALL_END >= REGION.end) {
		return UNDELIMITED_CALL;
	}

	const BOUNDS: StatementBounds = { start: START, callEnd: CALL_END, regionStart: REGION.start, regionEnd: REGION.end };
	const STATEMENT_END = REGION.allowsStatements ? getStatementEnd(input, BOUNDS, context) : NOT_FOUND;

	if (STATEMENT_END !== NOT_FOUND) {
		const RANGE: Region = { start: START, end: STATEMENT_END };

		return { ...RANGE, replacement: needsAsiGuard(input, RANGE, REGION, MASK) ? SEMICOLON : '', region: REGION };
	}

	const REPLACEMENT = getVoidReplacement(input, CALL_END, MASK);
	const EDIT: RegionEdit = { start: START, end: CALL_END + 1, replacement: REPLACEMENT, region: REGION };

	if (REPLACEMENT !== PARENTHESIZED_VOID_EXPRESSION || !isPrecededByValue(input, START, REGION, context)) {
		return EDIT;
	}

	// `value\n(void 0).y` reads as a call applied to `value`, while the original `value\nconsole.log(1).y` was a
	// statement of its own: a leading `;` keeps them apart where statements may be written, and the call is left
	// alone anywhere else
	return REGION.allowsStatements ? { ...EDIT, replacement: `${SEMICOLON}${REPLACEMENT}` } : null;
}

function isStatementRemoval(edit: RegionEdit): boolean {
	return edit.replacement === '' || edit.replacement === SEMICOLON;
}

/**
 * Decides the ASI guard once for every chain of statement removals that nothing but blanks and comments separate.
 *
 * @remarks
 * {@link needsAsiGuard} reads the neighbors of a single statement, but inside a chain those neighbors are the other
 * removed statements: `a()\nconsole.log(1);\nconsole.log(2);\n[1]` sees `a()` before the first call and `console`
 * after it, then a `;` before the second, and neither leaves a guard, although `a()` ends up fused with `[1]`. The
 * code written before the chain's first statement and after its last one is what meets once the chain is gone, so
 * the guard is decided for that span and carried by the last removal alone.
 *
 * @param input - The source.
 * @param edits - The edits of the file, in source order and non-overlapping.
 * @param mask - The code mask of `input`.
 *
 * @returns The edits, with every chain carrying at most one guard, on its last removal.
 */
function guardRemovalChains(input: string, edits: readonly RegionEdit[], mask: CodeMask): RegionEdit[] {
	const CHAINS = edits.reduce<EditRun[]>((chains, edit) => {
		const LAST_CHAIN = chains.at(-1);
		const IS_CHAINED =
			LAST_CHAIN?.last.region === edit.region &&
			isStatementRemoval(LAST_CHAIN.last) &&
			isStatementRemoval(edit) &&
			findNextSignificantIndex(input, LAST_CHAIN.last.end, mask) === edit.start;

		if (IS_CHAINED) {
			LAST_CHAIN.edits.push(edit);
			LAST_CHAIN.last = edit;
		} else {
			chains.push({ first: edit, last: edit, edits: [edit] });
		}

		return chains;
	}, []);

	return CHAINS.flatMap(({ first, last, edits: chain }) => {
		if (first === last) {
			return chain;
		}

		const IS_GUARDED = needsAsiGuard(input, { start: first.start, end: last.end }, first.region, mask);

		return chain.map((edit) => ({ ...edit, replacement: IS_GUARDED && edit === last ? SEMICOLON : '' }));
	});
}

/**
 * Reports whether two consecutive edits are removals sharing a line with nothing but blanks between them.
 *
 * @param input - The source.
 * @param previous - The first edit.
 * @param next - The edit that follows it.
 *
 * @returns `true` when the first edit removes its statement outright, the second removes its own (possibly leaving
 *   the guard of its chain) and only spaces or tabs separate them.
 */
function isSameLineRemoval(input: string, previous: RegionEdit, next: RegionEdit): boolean {
	if (previous.replacement !== '' || !isStatementRemoval(next)) {
		return false;
	}

	for (let index = previous.end; index < next.start; index++) {
		const CHARACTER = input.charAt(index);

		if (CHARACTER !== ' ' && CHARACTER !== '\t') {
			return false;
		}
	}

	return true;
}

function toEdit(edit: RegionEdit): Edit {
	return { start: edit.start, end: edit.end, replacement: edit.replacement };
}

/**
 * A run of consecutive edits: removals sharing a line for {@link widenLineRemovals}, or removals separated by
 * nothing but blanks and comments for {@link guardRemovalChains}
 */
interface EditRun {
	first: RegionEdit;
	last: RegionEdit;
	edits: RegionEdit[];
}

/**
 * Widens a run of removals sharing one line to the whole line once nothing else is left on it.
 *
 * @param input - The source.
 * @param run - The edits, in source order: a single edit, or removals separated by nothing but blanks.
 *
 * @returns The edits, widened when the run was alone on its line. The blanks between two removals go to the second
 *   one, so that the edits stay sorted and non-overlapping. A run ending on its chain's guard keeps its line, which
 *   is left holding that `;` alone, like a single guarded removal.
 */
function widenRemovalRun(input: string, run: EditRun): Edit[] {
	const { first: FIRST, last: LAST, edits: EDITS } = run;

	if (FIRST.replacement !== '') {
		return EDITS.map(toEdit);
	}

	const WIDENED =
		LAST.replacement === SEMICOLON
			? { start: FIRST.start, end: LAST.end }
			: widenRemovalToLine(input, { start: FIRST.start, end: LAST.end }, FIRST.region);

	if (WIDENED.start === FIRST.start && WIDENED.end === LAST.end && LAST.replacement === '') {
		return EDITS.map(toEdit);
	}

	let start = WIDENED.start;

	return EDITS.map((edit) => {
		const REMOVAL: Edit = { start, end: edit === LAST ? WIDENED.end : edit.end, replacement: edit.replacement };

		start = edit.end;

		return REMOVAL;
	});
}

/**
 * Widens every removal, or run of removals sharing a line, to that whole line once nothing else is left on it.
 *
 * @remarks
 * A run of removals separated by nothing but blanks is widened as one, so that two statements sharing a line
 * (`console.log(1); console.log(2);`) take that line with them once both are gone instead of leaving a line of
 * blanks behind. Each removal keeps an edit of its own, so the number of edits still counts the calls stripped.
 *
 * @param input - The source.
 * @param edits - The edits of the file, in source order and non-overlapping.
 *
 * @returns The edits to apply, in source order and non-overlapping.
 */
function widenLineRemovals(input: string, edits: readonly RegionEdit[]): Edit[] {
	const RUNS = edits.reduce<EditRun[]>((runs, edit) => {
		const LAST_RUN = runs.at(-1);

		if (LAST_RUN != null && isSameLineRemoval(input, LAST_RUN.last, edit)) {
			LAST_RUN.edits.push(edit);
			LAST_RUN.last = edit;
		} else {
			runs.push({ first: edit, last: edit, edits: [edit] });
		}

		return runs;
	}, []);

	return RUNS.flatMap((run) => widenRemovalRun(input, run));
}

/**
 * Counts the newlines contained in the `[from, to)` range of the input.
 *
 * @param input - The source to count in.
 * @param from - The start index, inclusive.
 * @param to - The end index, exclusive.
 *
 * @returns The number of `\n` characters found.
 */
function countNewlines(input: string, from: number, to: number): number {
	let count = 0;

	for (let index = from; index < to; index++) {
		if (input.charAt(index) === '\n') {
			count++;
		}
	}

	return count;
}

/**
 * Reads the directive kind out of the suffix the directive regex captured.
 *
 * @param suffix - The captured suffix, `undefined` for the file-level form.
 *
 * @returns The directive kind.
 */
function toDirectiveKind(suffix: string | undefined): DirectiveKind {
	if (suffix === '-next-line') {
		return 'next-line';
	}

	if (suffix === '-start') {
		return 'start';
	}

	return suffix === '-end' ? 'end' : 'file';
}

/**
 * Collects every `console-stripper-ignore*` directive written in a comment.
 *
 * @remarks
 * The mask is what makes the token a directive: the same text inside a string literal
 * (`const TOKEN = 'console-stripper-ignore';`) is data and must not disable anything.
 *
 * @param input - The source to scan.
 * @param mask - The code mask of `input`.
 *
 * @returns The directives, in source order, each with the index of the line carrying it.
 */
function findDirectives(input: string, mask: CodeMask): Directive[] {
	const DIRECTIVES: Directive[] = [];

	const PATTERN = new RegExp(DIRECTIVE_REGEX_SOURCE, 'g');

	let lineIndex = 0;
	let cursor = 0;
	let match = PATTERN.exec(input);

	while (match != null) {
		lineIndex += countNewlines(input, cursor, match.index);
		cursor = match.index;

		if (mask[match.index] === MASK_COMMENT) {
			DIRECTIVES.push({ kind: toDirectiveKind(match[1]), lineIndex });
		}

		match = PATTERN.exec(input);
	}

	return DIRECTIVES;
}

/**
 * The lines a directive protects: the ones a directive names, and the line an unclosed block starts at
 */
interface IgnoredLines {
	/** One flag per named line; a line the array does not reach is not protected by a closed directive */
	flags: boolean[];
	/** First line of a block left unclosed, which protects the rest of the file, or `-1` when every block closed */
	openBlockStart: number;
}

/**
 * Marks every line protected by a `console-stripper-ignore-next-line` or `console-stripper-ignore-start` directive.
 *
 * @remarks
 * A block that is never closed by `console-stripper-ignore-end` protects the rest of the file. It is reported as the
 * line it opens at rather than as one flag per remaining line, so that resolving the directives of a file never
 * requires knowing how many lines that file holds.
 *
 * @param directives - The directives found in the file, in source order.
 *
 * @returns The protected lines.
 */
function getIgnoredLines(directives: readonly Directive[]): IgnoredLines {
	const FLAGS: boolean[] = [];

	let blockStart = NOT_FOUND;

	for (const DIRECTIVE of directives) {
		if (DIRECTIVE.kind === 'next-line') {
			FLAGS[DIRECTIVE.lineIndex + 1] = true;
		} else if (DIRECTIVE.kind === 'start' && blockStart === NOT_FOUND) {
			blockStart = DIRECTIVE.lineIndex;
		} else if (DIRECTIVE.kind === 'end' && blockStart !== NOT_FOUND) {
			for (let lineIndex = blockStart; lineIndex <= DIRECTIVE.lineIndex; lineIndex++) {
				FLAGS[lineIndex] = true;
			}

			blockStart = NOT_FOUND;
		}
	}

	return { flags: FLAGS, openBlockStart: blockStart };
}

/**
 * Reports whether a directive protects a line.
 *
 * @param ignoredLines - The protected lines, as returned by {@link getIgnoredLines}.
 * @param lineIndex - The zero-based index of the line.
 *
 * @returns `true` when a directive names the line or an unclosed block covers it.
 */
function isLineProtected(ignoredLines: IgnoredLines, lineIndex: number): boolean {
	const OPEN_BLOCK_START = ignoredLines.openBlockStart;

	return ignoredLines.flags[lineIndex] === true || (OPEN_BLOCK_START !== NOT_FOUND && lineIndex >= OPEN_BLOCK_START);
}

/**
 * Collects the `(` of every console call written in code, whatever its method, stripped or kept.
 *
 * @param input - The source being scanned.
 * @param mask - The code mask of `input`.
 *
 * @returns The indexes of the calls' opening parentheses.
 */
function findConsoleCallOpeners(input: string, mask: CodeMask): Set<number> {
	const OPENERS = new Set<number>();
	// eslint-disable-next-line security/detect-non-literal-regexp -- the source is a constant built from a fixed identifier pattern
	const PATTERN = new RegExp(ANY_CONSOLE_CALL_PATTERN_SOURCE, 'g');

	let match = PATTERN.exec(input);

	while (match != null) {
		const OPENER_INDEX = match.index + match[0].length - 1;

		if (mask[match.index] === MASK_CODE && input.charAt(OPENER_INDEX) === '(') {
			OPENERS.add(OPENER_INDEX);
		}

		match = PATTERN.exec(input);
	}

	return OPENERS;
}

/**
 * Marks every character a directive protects.
 *
 * @remarks
 * Protection starts as a line-based notion, but a directive placed above a console call written over several lines is
 * meant to protect the whole call. The `(` of a console call opened on a protected line — of any method, kept ones
 * included — therefore keeps the protection alive until it closes, so that a `console.*` nested in its arguments is
 * protected too. Any other parenthesis opens nothing: a directive above `run(() => {` protects that line only, not
 * every call of the callback.
 *
 * The walk counts the lines it crosses, which is why the file's line count is never computed ahead of it.
 *
 * @param input - The source being scanned.
 * @param ignoredLines - The protected lines, as returned by {@link getIgnoredLines}.
 * @param mask - The code mask of `input`.
 *
 * @returns One byte per character, `1` where a console call must be kept.
 */
function createProtectionMask(input: string, ignoredLines: IgnoredLines, mask: CodeMask): Uint8Array {
	const PROTECTED = new Uint8Array(input.length);
	const CONSOLE_CALL_OPENERS = findConsoleCallOpeners(input, mask);

	let lineIndex = 0;
	let openDepth = 0;

	for (let index = 0; index < input.length; index++) {
		const CHARACTER = input.charAt(index);
		const IS_LINE_PROTECTED = isLineProtected(ignoredLines, lineIndex);

		if (IS_LINE_PROTECTED || openDepth > 0) {
			PROTECTED[index] = PROTECTED_FLAG;
		}

		if (mask[index] === MASK_CODE && CHARACTER === '(') {
			if (openDepth > 0) {
				openDepth++;
			} else if (IS_LINE_PROTECTED && CONSOLE_CALL_OPENERS.has(index)) {
				openDepth = 1;
			}
		} else if (mask[index] === MASK_CODE && CHARACTER === ')' && openDepth > 0) {
			openDepth--;
		}

		if (CHARACTER === '\n') {
			lineIndex++;
		}
	}

	return PROTECTED;
}

/**
 * Reports whether a file-level directive sits within the first lines of the file.
 *
 * @param directives - The directives found in the file.
 *
 * @returns `true` when the whole file must be left untouched.
 */
function hasFileIgnoreDirective(directives: readonly Directive[]): boolean {
	return directives.some((directive) => directive.kind === 'file' && directive.lineIndex < FILE_DIRECTIVE_LINE_LIMIT);
}

/**
 * What {@link findConsoleEdits} reads about the source it scans
 */
interface EditSearch {
	/** The scan pattern of the plugin instance */
	pattern: RegExp;
	layout: SourceLayout;
	/** One byte per character, `1` where a directive protects a console call, or `null` when none is protected */
	protection: Uint8Array | null;
}

/**
 * Finds the directives of a source, when it can hold any.
 *
 * @param input - The source to scan.
 * @param mask - The code mask of `input`.
 * @param ignoreComments - Whether the directives are honored at all.
 *
 * @returns The directives, in source order, empty when the source holds no directive token.
 */
function findHonoredDirectives(input: string, mask: CodeMask, ignoreComments: boolean): Directive[] {
	return ignoreComments && input.includes(IGNORE_DIRECTIVE_TOKEN) ? findDirectives(input, mask) : [];
}

/**
 * Finds every edit neutralizing a stripped `console.*` call in a source whose layout and protection are known.
 *
 * @remarks
 * After each accepted or protected call the regex resumes past the call's last character, so a `console.*` nested in
 * the arguments of another one is neither edited twice nor edited despite the protection of its parent.
 *
 * @param input - The source to scan.
 * @param search - The scan pattern, the layout of `input` and the characters its directives protect.
 *
 * @returns The edits to apply, in source order and non-overlapping, and the match index of every call left in place
 *   because its end could not be found.
 */
function findConsoleEdits(input: string, search: EditSearch): EditScan {
	const PATTERN = search.pattern;
	const PROTECTED = search.protection;
	const MASK = search.layout.mask;
	const EDIT_CONTEXT: EditContext = {
		mask: MASK,
		structure: null,
		regions: new RegionCursor(search.layout.regions),
		templateEnds: search.layout.templateEnds,
	};

	const EDITS: RegionEdit[] = [];
	const SKIPPED: number[] = [];

	PATTERN.lastIndex = 0;

	let match = PATTERN.exec(input);

	while (match != null) {
		if (PROTECTED?.[match.index] === PROTECTED_FLAG) {
			// Resume past the protected call so that a nested `console.*` inherits the protection
			const PROTECTED_END = findCallExpressionEnd(input, match, EDIT_CONTEXT, input.length);

			if (PROTECTED_END !== NOT_FOUND) {
				PATTERN.lastIndex = PROTECTED_END + 1;
			}
		} else {
			const EDIT = createConsoleEdit(input, match, EDIT_CONTEXT);

			if (EDIT === UNDELIMITED_CALL) {
				SKIPPED.push(match.index);
			} else if (EDIT) {
				EDITS.push(EDIT);
				PATTERN.lastIndex = EDIT.end;
			}
		}

		match = PATTERN.exec(input);
	}

	return { edits: widenLineRemovals(input, guardRemovalChains(input, EDITS, MASK)), skipped: SKIPPED };
}

/**
 * Marks every character the directives of a source protect.
 *
 * @param input - The source being scanned.
 * @param mask - The code mask of `input`.
 * @param directives - The directives found in `input`, none of them file-level.
 *
 * @returns The protection mask, or `null` when there is no directive and nothing is protected.
 */
function createDirectiveProtection(input: string, mask: CodeMask, directives: readonly Directive[]): Uint8Array | null {
	return directives.length > 0 ? createProtectionMask(input, getIgnoredLines(directives), mask) : null;
}

/**
 * Finds every edit neutralizing a stripped `console.*` call in the given source.
 *
 * @remarks
 * The scan exits on the cheapest check first: an empty method list, then a file without the `console` identifier.
 * Comment directives are only resolved when the file actually contains the directive token.
 *
 * @param input - The source to scan.
 * @param context - The scan context of the plugin instance, as built by {@link createScanContext}.
 *
 * @returns The edits to apply, in source order and non-overlapping, the calls left in place because their end could
 *   not be found, and whether a file-level directive kept the whole source.
 */
function scanConsoleCalls(input: string, context: ScanContext): ConsoleScan {
	const PATTERN = context.pattern;

	if (!PATTERN || !input.includes(CONSOLE_IDENTIFIER)) {
		return { edits: [], skipped: [], isFileIgnored: false };
	}

	const LAYOUT = createSourceLayout(input, context.fileKind);
	const DIRECTIVES = findHonoredDirectives(input, LAYOUT.mask, context.ignoreComments);

	if (hasFileIgnoreDirective(DIRECTIVES)) {
		return { edits: [], skipped: [], isFileIgnored: true };
	}

	const PROTECTION = createDirectiveProtection(input, LAYOUT.mask, DIRECTIVES);

	return {
		...findConsoleEdits(input, { pattern: PATTERN, layout: LAYOUT, protection: PROTECTION }),
		isFileIgnored: false,
	};
}

/**
 * Reports what the honored directives of a source protect, without looking for its console calls.
 *
 * @param input - The source to read.
 * @param context - The scan context of the plugin instance, as built by {@link createScanContext}.
 *
 * @returns `'file'` when a file-level directive keeps the whole source, `'lines'` when a next-line, start or end
 *   directive is written in it, and `'none'` otherwise or when the directives are not honored.
 */
function getDirectiveScope(input: string, context: ScanContext): DirectiveScope {
	if (!context.ignoreComments || !input.includes(IGNORE_DIRECTIVE_TOKEN)) {
		return 'none';
	}

	const DIRECTIVES = findDirectives(input, createSourceLayout(input, context.fileKind).mask);

	if (hasFileIgnoreDirective(DIRECTIVES)) {
		return 'file';
	}

	return DIRECTIVES.some((directive) => directive.kind !== 'file') ? 'lines' : 'none';
}

/**
 * Reports whether a source still holds the ignore directive token, in a comment or anywhere else.
 *
 * @param input - The source to test.
 *
 * @returns `true` when the token appears in the source.
 */
function hasIgnoreDirectiveToken(input: string): boolean {
	return input.includes(IGNORE_DIRECTIVE_TOKEN);
}

/**
 * The source a component was compiled from, and where each line of the compiled module came from
 */
interface OriginalSource {
	text: string;
	/** The segments of each line of the compiled module */
	lines: MappedSegment[][];
}

/**
 * The characters of a compiled component its directives protect, once resolved
 */
interface CompiledProtection {
	/** `true` when a file-level directive keeps the whole module */
	isFileIgnored: boolean;
	/** One byte per character, `1` where a directive protects a console call, or `null` when none is protected */
	protection: Uint8Array | null;
	/** Why the source map that would have told the protection could not be read, or `null` when it was */
	error: string | null;
}

/**
 * The outcome of scanning a component Astro compiled first
 */
interface CompiledAstroScan extends ConsoleScan {
	/**
	 * Why the source map Astro attached to the module could not be read, which lost the directives of the component,
	 * or `null` when nothing was lost
	 */
	sourceMapError: string | null;
}

/**
 * The inputs of the scan of the inline scripts one template chunk holds
 */
interface InlineScriptSearch {
	/** The scan pattern of the plugin instance */
	pattern: RegExp;
	ignoreComments: boolean;
	/**
	 * The characters of the module its directives protect, read from its original source when its map carries one,
	 * or `null` when none is protected
	 */
	mappedProtection: Uint8Array | null;
}

/**
 * The characters a template-literal chunk stands for once its escape sequences are read
 */
interface CookedChunk {
	text: string;
	/** For each character of `text`, and once more for its end, the index of the raw source it was read from */
	rawIndexes: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value != null;
}

/**
 * Reads the original source of a compiled component out of the source map Astro's compiler appends to it as a comment.
 *
 * @remarks
 * Astro compiles with `sourcemap: 'both'`, so the module carries its map inline whatever the build asks for, with the
 * component's own text as its `sourcesContent`. Only the last map comment written in comment position counts: Astro
 * appends its exports after it, never another map. The mappings are only decoded when the original source names a
 * directive, since otherwise there is nothing to recover.
 *
 * @param input - The compiled module.
 * @param mask - The code mask of `input`.
 *
 * @returns The original source and the mapping of every compiled line, or `null` when the module carries no map or
 *   its original source holds no directive token.
 *
 * @throws When the comment is there but does not hold a source map carrying the original source and valid mappings.
 */
function readInlineSourceMap(input: string, mask: CodeMask): OriginalSource | null {
	const COMMENT_INDEX = input.lastIndexOf(INLINE_SOURCE_MAP_PREFIX);

	if (COMMENT_INDEX === NOT_FOUND || mask[COMMENT_INDEX] !== MASK_COMMENT) {
		return null;
	}

	INLINE_SOURCE_MAP_REGEX.lastIndex = COMMENT_INDEX;

	const PAYLOAD = INLINE_SOURCE_MAP_REGEX.exec(input)?.[1];

	if (PAYLOAD == null) {
		throw new Error('the source map comment holds no base64 payload');
	}

	const MAP: unknown = JSON.parse(Buffer.from(PAYLOAD, 'base64').toString('utf8'));

	if (!isRecord(MAP) || typeof MAP.mappings !== 'string' || !Array.isArray(MAP.sourcesContent)) {
		throw new Error('the source map carries no mappings or no sources content');
	}

	const CONTENTS: readonly unknown[] = MAP.sourcesContent;
	const TEXT = CONTENTS[0];

	if (typeof TEXT !== 'string') {
		throw new Error('the source map carries no original source');
	}

	return TEXT.includes(IGNORE_DIRECTIVE_TOKEN) ? { text: TEXT, lines: decodeMappings(MAP.mappings) } : null;
}

/**
 * Marks every character of a compiled module mapped to a line the directives of its original source protect.
 *
 * @remarks
 * A character belongs to the last segment met at or before it, on its own line or on an earlier one, which is how a
 * debugger resolves a position; a character met before every segment maps to nothing and is not protected, and so is
 * one mapped into any source but the first, the component itself. A protected console call needs no more than
 * its first character mapped: the scan resumes past a protected call, so the calls nested in its arguments are kept
 * with it.
 *
 * @param input - The compiled module.
 * @param lines - The segments of each line of `input`.
 * @param ignoredLines - The lines of the original source its directives protect.
 *
 * @returns One byte per character of `input`, `1` where a console call must be kept.
 */
function createMappedProtectionMask(
	input: string,
	lines: readonly (readonly MappedSegment[])[],
	ignoredLines: IgnoredLines,
): Uint8Array {
	const PROTECTED = new Uint8Array(input.length);
	const NO_SEGMENTS: readonly MappedSegment[] = [];

	let lineIndex = 0;
	let column = 0;
	let segmentIndex = 0;
	let isProtected = false;

	for (let index = 0; index < input.length; index++) {
		const SEGMENTS = lines[lineIndex] ?? NO_SEGMENTS;

		let segment = SEGMENTS[segmentIndex];

		while (segment != null && segment.generatedColumn <= column) {
			isProtected = segment.sourceIndex === 0 && isLineProtected(ignoredLines, segment.originalLine);
			segmentIndex++;
			segment = SEGMENTS[segmentIndex];
		}

		if (isProtected) {
			PROTECTED[index] = PROTECTED_FLAG;
		}

		if (input.charAt(index) === '\n') {
			lineIndex++;
			column = 0;
			segmentIndex = 0;
		} else {
			column++;
		}
	}

	return PROTECTED;
}

/**
 * Resolves which characters of a compiled component its directives protect.
 *
 * @remarks
 * Astro's compiler drops every comment of the frontmatter and of the template expressions, and the directives with
 * them, so they are read from the original source its map carries, exactly as they are in a raw component: a
 * file-level directive keeps the whole module, and a protected line of the original protects every compiled
 * character mapped to it. A module carrying no map is read on its own directives, as any script is.
 *
 * @param input - The compiled module.
 * @param mask - The code mask of `input`.
 * @param ignoreComments - Whether the directives are honored at all.
 *
 * @returns The protection, whether a file-level directive keeps the whole module, and why the map that would have
 *   told them could not be read, if it could not.
 */
function resolveCompiledProtection(input: string, mask: CodeMask, ignoreComments: boolean): CompiledProtection {
	if (!ignoreComments) {
		return { isFileIgnored: false, protection: null, error: null };
	}

	let original: OriginalSource | null;

	try {
		original = readInlineSourceMap(input, mask);
	} catch (error) {
		return { isFileIgnored: false, protection: null, error: String(error) };
	}

	if (original == null) {
		const DIRECTIVES = findHonoredDirectives(input, mask, ignoreComments);

		return hasFileIgnoreDirective(DIRECTIVES)
			? { isFileIgnored: true, protection: null, error: null }
			: { isFileIgnored: false, protection: createDirectiveProtection(input, mask, DIRECTIVES), error: null };
	}

	const DIRECTIVES = findDirectives(original.text, createCodeMask(original.text, 'astro'));

	if (hasFileIgnoreDirective(DIRECTIVES)) {
		return { isFileIgnored: true, protection: null, error: null };
	}

	return {
		isFileIgnored: false,
		protection:
			DIRECTIVES.length > 0 ? createMappedProtectionMask(input, original.lines, getIgnoredLines(DIRECTIVES)) : null,
		error: null,
	};
}

/**
 * Collects the text chunks of one template literal: the raw ranges between its backticks and its `${…}` placeholders.
 *
 * @remarks
 * A fresh {@link SourceScanner} walks the template from its opening backtick. The text of this template, rather than
 * that of a template nested in one of its placeholders, is read wherever the frame stack stands at the depth the
 * opening backtick left it at. A template that never closes yields no chunk at all.
 *
 * @param input - The source.
 * @param backtickIndex - The index of the template's opening backtick.
 *
 * @returns The chunks, in source order, each still holding its escape sequences.
 */
function findTemplateChunks(input: string, backtickIndex: number): Region[] {
	const SCANNER = new SourceScanner(input, {
		end: input.length,
		hasHtmlComments: false,
		hasJsx: true,
		records: createScanRecords(),
	});

	const CHUNKS: Region[] = [];

	SCANNER.step('`', input.charAt(backtickIndex + 1), backtickIndex);

	const TEMPLATE_DEPTH = SCANNER.getFrameDepth();

	let chunkStart = backtickIndex + 1;

	for (let index = chunkStart; index < input.length; index++) {
		const DEPTH_BEFORE = SCANNER.getFrameDepth();
		const STEP = SCANNER.step(input.charAt(index), input.charAt(index + 1), index);
		const DEPTH_AFTER = SCANNER.getFrameDepth();

		if (DEPTH_BEFORE === TEMPLATE_DEPTH && DEPTH_AFTER !== TEMPLATE_DEPTH) {
			CHUNKS.push({ start: chunkStart, end: index });

			// The closing backtick pops the template's own frame; a `${` pushes the frame of its placeholder
			if (DEPTH_AFTER < TEMPLATE_DEPTH) {
				return CHUNKS;
			}
		} else if (DEPTH_BEFORE > TEMPLATE_DEPTH && DEPTH_AFTER === TEMPLATE_DEPTH) {
			chunkStart = index + 1;
		}

		if (STEP === 'comment-pair' || STEP === 'literal-pair' || STEP === 'text-pair') {
			index++;
		}
	}

	return [];
}

/**
 * Collects the text chunks of every template literal Astro compiled the markup of a component into.
 *
 * @remarks
 * Only a template tagged `$$render` in code position counts, so a template literal the frontmatter builds is left
 * alone. A template nested in a placeholder of another one (`${cond && $$render`…`}`) is walked on its own.
 *
 * @param input - The compiled module.
 * @param mask - The code mask of `input`.
 *
 * @returns The chunks, which never overlap.
 */
function findRenderTemplateChunks(input: string, mask: CodeMask): Region[] {
	const CHUNKS: Region[] = [];

	for (
		let index = input.indexOf(RENDER_TEMPLATE_TAG);
		index !== NOT_FOUND;
		index = input.indexOf(RENDER_TEMPLATE_TAG, index + 1)
	) {
		if (mask[index] === MASK_CODE && !hasIdentifierCharacterBefore(input, index)) {
			CHUNKS.push(...findTemplateChunks(input, index + RENDER_TEMPLATE_TAG.length - 1));
		}
	}

	return CHUNKS;
}

/**
 * Reports whether a template chunk may hold an inline script calling the console, before any escape is read.
 *
 * @param input - The compiled module.
 * @param chunk - The raw range of the chunk.
 *
 * @returns `true` when the chunk names both a `<script` tag and the `console` identifier.
 */
function hasInlineScriptCall(input: string, chunk: Region): boolean {
	const TEXT = input.slice(chunk.start, chunk.end);

	return TEXT.includes(CONSOLE_IDENTIFIER) && findTagNameIndex(TEXT, SCRIPT_OPENER, 0) !== NOT_FOUND;
}

/**
 * Reads the escape sequences of a template-literal chunk, as the runtime does before it renders the chunk.
 *
 * @remarks
 * Every sequence accepted stands for exactly one character, so an edit bounded by characters of the cooked text is
 * bounded by whole sequences of the raw one, and its replacement, which never holds a backslash, a backtick or a `$`,
 * can be written back into the template as it is. A chunk holding any other escape — a digit, a hexadecimal or
 * Unicode escape, a line continuation — is not read at all. A carriage return, alone or followed by a line feed,
 * stands for one line feed, as in every template literal.
 *
 * @param input - The compiled module.
 * @param chunk - The raw range of the chunk.
 *
 * @returns The cooked chunk, or `null` when an escape stands for no character or for several.
 */
function cookTemplateChunk(input: string, chunk: Region): CookedChunk | null {
	const CHARACTERS: string[] = [];
	const RAW_INDEXES: number[] = [];

	for (let index = chunk.start; index < chunk.end; index++) {
		const CHARACTER = input.charAt(index);

		RAW_INDEXES.push(index);

		// A chunk ends on a backtick or a `${` the scanner read as template syntax, so neither the character a `\`
		// escapes nor the line feed following a carriage return can lie past its end
		if (CHARACTER === '\\') {
			const ESCAPED = input.charAt(index + 1);

			if (MULTI_CHARACTER_ESCAPE_REGEX.test(ESCAPED)) {
				return null;
			}

			CHARACTERS.push(SINGLE_CHARACTER_ESCAPES.get(ESCAPED) ?? ESCAPED);
			index++;
		} else if (CHARACTER === '\r') {
			CHARACTERS.push('\n');

			if (input.charAt(index + 1) === '\n') {
				index++;
			}
		} else {
			CHARACTERS.push(CHARACTER);
		}
	}

	RAW_INDEXES.push(chunk.end);

	return { text: CHARACTERS.join(''), rawIndexes: RAW_INDEXES };
}

/**
 * Converts an index of a cooked chunk into the index of the raw source it was read from.
 *
 * @param chunk - The cooked chunk.
 * @param index - An index of its text, its end included.
 *
 * @returns The raw index.
 *
 * @throws When the index lies outside the chunk, which no edit of the chunk can produce.
 */
function toRawIndex(chunk: CookedChunk, index: number): number {
	const RAW_INDEX = chunk.rawIndexes[index];

	/* v8 ignore next -- offensive invariant: every edit of a chunk lies within that chunk */
	if (RAW_INDEX == null) {
		throw new Error('toRawIndex requires an index within the cooked chunk');
	}

	return RAW_INDEX;
}

/**
 * Finds the edits stripping the inline scripts one text chunk of a compiled template renders.
 *
 * @remarks
 * Once compiled, an `is:inline` script is template text. The chunk is read as the HTML it renders, so the rules of a
 * page decide which `<script>` blocks hold JavaScript, and the directives the compiler leaves in that text apply;
 * a file-level one does not, since only the first lines of the component carry it. A block a `${…}` placeholder cuts
 * — the variables `define:vars` injects — never closes within one chunk, and is left as written, and so is a chunk
 * holding an escape the mapping back to the raw template could not follow exactly.
 *
 * @param input - The compiled module.
 * @param chunk - The raw range of the chunk.
 * @param search - The scan pattern, and whether the directives are honored.
 *
 * @returns The edits, in raw source positions, in source order and non-overlapping, and the raw match index of every
 *   call left in place because its end could not be found.
 */
function findInlineScriptEdits(input: string, chunk: Region, search: InlineScriptSearch): EditScan {
	const COOKED = cookTemplateChunk(input, chunk);

	if (COOKED == null) {
		return { edits: [], skipped: [] };
	}

	const TEXT = COOKED.text;
	const LAYOUT = createSourceLayout(TEXT, 'html');

	if (LAYOUT.regions.length === 0) {
		return { edits: [], skipped: [] };
	}

	const DIRECTIVES = findHonoredDirectives(TEXT, LAYOUT.mask, search.ignoreComments);
	const PROTECTION = addMappedProtection(
		COOKED,
		LAYOUT.mask,
		createDirectiveProtection(TEXT, LAYOUT.mask, DIRECTIVES),
		search,
	);

	const SCAN = findConsoleEdits(TEXT, { pattern: search.pattern, layout: LAYOUT, protection: PROTECTION });

	return {
		edits: SCAN.edits.map((edit) => ({
			start: toRawIndex(COOKED, edit.start),
			end: toRawIndex(COOKED, edit.end),
			replacement: edit.replacement,
		})),
		skipped: SCAN.skipped.map((index) => toRawIndex(COOKED, index)),
	};
}

/**
 * Adds to the protection of a cooked chunk the console calls the directives of the original source protect.
 *
 * @remarks
 * A directive range of the original source can span a template expression, which the compiler turns into a `${…}`
 * placeholder: the directive then sits in one template chunk and the inline script it protects in a later one, where
 * the chunk's own directives cannot see it. The protection mapped back from the original source covers the whole
 * module, so each call of the chunk inherits the protection of the raw character it was read from.
 *
 * That character is the call's opening parenthesis or backtick rather than its first one: Astro's compiler maps the
 * first character of an element's text to the node before it — the line break after a closing directive comment,
 * for instance — which would move a call written right after `<script is:inline>` onto the line above it.
 *
 * @param chunk - The cooked chunk.
 * @param mask - The code mask of the cooked text.
 * @param ownProtection - The protection the chunk's own directives give it, or `null` when they give none.
 * @param search - The scan pattern and the protection mapped back from the original source.
 *
 * @returns The protection of the chunk, or `null` when nothing in it is protected.
 */
function addMappedProtection(
	chunk: CookedChunk,
	mask: CodeMask,
	ownProtection: Uint8Array | null,
	search: InlineScriptSearch,
): Uint8Array | null {
	const MAPPED = search.mappedProtection;

	if (MAPPED == null) {
		return ownProtection;
	}

	const PROTECTION = ownProtection ?? new Uint8Array(chunk.text.length);
	const PATTERN = search.pattern;

	PATTERN.lastIndex = 0;

	for (let match = PATTERN.exec(chunk.text); match != null; match = PATTERN.exec(chunk.text)) {
		const OPENER_INDEX = match.index + match[0].length - 1;

		if (mask[match.index] === MASK_CODE && MAPPED[toRawIndex(chunk, OPENER_INDEX)] === PROTECTED_FLAG) {
			PROTECTION[match.index] = PROTECTED_FLAG;
		}
	}

	return PROTECTION;
}

/**
 * Adds the edits of the inline scripts to those of the compiled module's code.
 *
 * @remarks
 * An inline script is template text, which the code scan never edits, so the two only meet when a template is
 * written inside a call the code scan strips: the inline edit then goes with that call. Both lists are walked once,
 * side by side, which keeps a module holding thousands of edits linear.
 *
 * @param codeEdits - The edits of the module's code, in source order and non-overlapping.
 * @param inlineEdits - The edits of its inline scripts, non-overlapping: the chunks of a template nested in a
 *   placeholder come after those of the template holding it, so they are sorted first.
 *
 * @returns Every edit, in source order and non-overlapping.
 */
function mergeInlineScriptEdits(codeEdits: readonly Edit[], inlineEdits: readonly Edit[]): Edit[] {
	const MERGED: Edit[] = [];

	let codeIndex = 0;

	[...inlineEdits]
		.sort((first, second) => first.start - second.start)
		.forEach((inlineEdit) => {
			let codeEdit = codeEdits[codeIndex];

			while (codeEdit != null && codeEdit.end <= inlineEdit.start) {
				MERGED.push(codeEdit);
				codeIndex++;
				codeEdit = codeEdits[codeIndex];
			}

			if (codeEdit == null || inlineEdit.end <= codeEdit.start) {
				MERGED.push(inlineEdit);
			}
		});

	return [...MERGED, ...codeEdits.slice(codeIndex)];
}

/**
 * Drops the inline script calls left in place that a code edit removes anyway.
 *
 * @remarks
 * An inline script written inside a call the code scan strips goes with that call (see
 * {@link mergeInlineScriptEdits}), so a call of that script the inline scan could not delimit is not left in place.
 * Both lists are walked once, side by side.
 *
 * @param skipped - The raw match index of every inline script call left in place, in any order.
 * @param codeEdits - The edits of the module's code, in source order and non-overlapping.
 *
 * @returns The indices no code edit covers, in ascending order.
 */
function dropSkippedWithinEdits(skipped: readonly number[], codeEdits: readonly Edit[]): number[] {
	let codeIndex = 0;

	return [...skipped]
		.sort((first, second) => first - second)
		.filter((index) => {
			let codeEdit = codeEdits[codeIndex];

			while (codeEdit != null && codeEdit.end <= index) {
				codeIndex++;
				codeEdit = codeEdits[codeIndex];
			}

			return codeEdit == null || index < codeEdit.start;
		});
}

/**
 * Finds every edit neutralizing a stripped `console.*` call in a component Astro compiled before this plugin read it.
 *
 * @remarks
 * The compiled module is a script: the frontmatter statements sit in a function body, where they are removed, and
 * the markup in `$$render` template literals, whose placeholders hold the template expressions. Two things the
 * compiler changed are restored. The directives it dropped are read from the original source its map carries (see
 * {@link resolveCompiledProtection}), and an `is:inline` script, which it turned into template text, is stripped as
 * the `<script>` block it renders (see {@link findInlineScriptEdits}).
 *
 * @param input - The compiled module.
 * @param context - The scan context of the plugin instance; its file kind is not read.
 *
 * @returns The edits to apply, in source order and non-overlapping, the calls left in place because their end could
 *   not be found, whether a file-level directive kept the whole module, and why the directives were lost, if they
 *   were.
 */
function scanCompiledAstroComponent(input: string, context: ScanContext): CompiledAstroScan {
	const PATTERN = context.pattern;

	if (!PATTERN || !input.includes(CONSOLE_IDENTIFIER)) {
		return { edits: [], skipped: [], isFileIgnored: false, sourceMapError: null };
	}

	const LAYOUT = createSourceLayout(input, 'script');
	const PROTECTION = resolveCompiledProtection(input, LAYOUT.mask, context.ignoreComments);

	if (PROTECTION.isFileIgnored) {
		return { edits: [], skipped: [], isFileIgnored: true, sourceMapError: null };
	}

	const CODE_SCAN = findConsoleEdits(input, { pattern: PATTERN, layout: LAYOUT, protection: PROTECTION.protection });
	const INLINE_SEARCH: InlineScriptSearch = {
		pattern: PATTERN,
		ignoreComments: context.ignoreComments,
		mappedProtection: PROTECTION.protection,
	};

	const INLINE_SCANS = input.includes(RENDER_TEMPLATE_TAG)
		? findRenderTemplateChunks(input, LAYOUT.mask)
				.filter((chunk) => hasInlineScriptCall(input, chunk))
				.map((chunk) => findInlineScriptEdits(input, chunk, INLINE_SEARCH))
		: [];
	const INLINE_SKIPPED = dropSkippedWithinEdits(
		INLINE_SCANS.flatMap((scan) => scan.skipped),
		CODE_SCAN.edits,
	);

	return {
		edits: mergeInlineScriptEdits(
			CODE_SCAN.edits,
			INLINE_SCANS.flatMap((scan) => scan.edits),
		),
		skipped: [...CODE_SCAN.skipped, ...INLINE_SKIPPED].sort((first, second) => first - second),
		isFileIgnored: false,
		sourceMapError: PROTECTION.error,
	};
}

/**
 * Returns a copy of the input string with the given edits applied.
 *
 * Each edit replaces the half-open `[start, end)` range by its `replacement`. The function concatenates the
 * untouched segments and the replacements in a single pass.
 *
 * @param input - The original string to edit.
 * @param edits - The edits to apply, sorted by start index and non-overlapping.
 *
 * @returns The resulting string.
 *
 * @throws When the edits are not sorted or overlap, which would silently produce a scrambled file.
 */
function applyEdits(input: string, edits: readonly Edit[]): string {
	if (edits.length === 0) {
		return input;
	}

	const SEGMENTS: string[] = [];

	let lastEnd = 0;

	for (const EDIT of edits) {
		if (EDIT.start < lastEnd || EDIT.end < EDIT.start) {
			throw new Error('applyEdits requires edits sorted by start index and non-overlapping');
		}

		SEGMENTS.push(input.slice(lastEnd, EDIT.start), EDIT.replacement);
		lastEnd = EDIT.end;
	}

	SEGMENTS.push(input.slice(lastEnd));

	return SEGMENTS.join('');
}

/**
 * Reports whether the source mentions the `console` identifier at all.
 *
 * @remarks
 * This is the plugin's cheapest filter and the one that rejects most files. It runs before any path inspection,
 * which matters once dependencies are scanned as well.
 *
 * @param input - The source to test.
 *
 * @returns `true` when the source could hold a console call.
 */
function hasConsoleToken(input: string): boolean {
	return input.includes(CONSOLE_IDENTIFIER);
}

/**
 * Strips the configured `console.*` calls from the given source.
 *
 * A call forming a statement of its own is removed together with its trailing semicolon, and with the whole line
 * when the statement was alone on it; a call used as part of a larger expression is replaced by `void 0`, which
 * keeps the surrounding code parsing exactly as it did.
 *
 * @param input - The source to strip.
 * @param options - The plugin options plus the source kind. Defaults apply to every omitted field.
 *
 * @returns The stripped source.
 *
 * @see scanConsoleCalls
 */
function stripConsole(input: string, options?: StripConsoleOptions): string {
	const CONTEXT = createScanContext(getOptions(options), options?.fileKind ?? 'script');

	return applyEdits(input, scanConsoleCalls(input, CONTEXT).edits);
}

export type {
	CodeMask,
	CodeRegion,
	ConsoleScan,
	DirectiveScope,
	ExtensionMatcher,
	FileKind,
	IgnoreMatcher,
	IgnoreTokens,
	ScanContext,
	SourceLayout,
	StripConsoleOptions,
};

export {
	ANY_DEPTH_DEFAULT_IGNORE_PATHS,
	applyEdits,
	ASTRO_EXTENSIONS,
	cleanIgnoredPaths,
	createCodeMask,
	createExtensionMatcher,
	createIgnoreMatcher,
	createScanContext,
	createSourceLayout,
	DEFAULT_EXTENSIONS,
	DEFAULT_IGNORE_PATHS,
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
	ROOT_ANCHORED_DEFAULT_IGNORE_PATHS,
	scanCompiledAstroComponent,
	scanConsoleCalls,
	SCRIPT_EXTENSIONS,
	stripConsole,
	stripQuery,
	SVELTE_EXTENSIONS,
	toRelativePath,
	TYPESCRIPT_EXTENSIONS,
	VUE_EXTENSIONS,
};
