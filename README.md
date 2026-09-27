<div align="center">

# `@castlenine/vite-plugin-console-stripper`

[![npm.badge]][npm] [![download.badge]][download] [![contribution.badge]][contribution]

A Vite plugin that removes console calls from your production build and keeps the ones you still need (by default `console.error`, `console.warn`, `console.info` and `console.clear`). It works on your own code and on dependencies, and supports ignore comments, path ignore rules, composable extension presets and sourcemaps.
</div>

## Table of Contents

- [Disclaimer](#disclaimer)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
  - [Quick start](#quick-start)
  - [Plugin order](#plugin-order)
  - [CommonJS](#commonjs)
- [Options](#options)
  - [`methods`](#methods)
  - [`extensions`](#extensions)
  - [`ignoreComments`](#ignorecomments)
  - [`ignoreFolders` and `ignoreFiles`](#ignorefolders-and-ignorefiles)
  - [`ignoreDefaults`](#ignoredefaults)
  - [`stripDependencies`](#stripdependencies)
  - [`ignoreDependencies`](#ignoredependencies)
  - [`verbose`](#verbose)
  - [Types](#types)
- [Ignore comments](#ignore-comments)
- [What gets removed](#what-gets-removed)
  - [File kinds](#file-kinds)
  - [Matched call forms](#matched-call-forms)
  - [Skipped `<script>` blocks](#skipped-script-blocks)
  - [Sourcemaps](#sourcemaps)
  - [Build warnings](#build-warnings)
- [Framework notes](#framework-notes)
  - [Svelte and SvelteKit](#svelte-and-sveltekit)
  - [Vue](#vue)
  - [React, Preact and Solid](#react-preact-and-solid)
  - [Astro](#astro)
  - [Angular through Analog](#angular-through-analog)
  - [HTML entries](#html-entries)
  - [Markdown, MDX and svx](#markdown-mdx-and-svx)
- [Limitations](#limitations)
- [Examples](#examples)
  - [SvelteKit project](#sveltekit-project)
  - [Vue project](#vue-project)
  - [Astro project](#astro-project)
  - [Angular project](#angular-project)
- [How it works](#how-it-works)
- [Changelog](#changelog)
- [License](#license)

## Disclaimer

**Tested against real `vite build` runs** with Svelte (with and without `vitePreprocess()`), Vue.js, React, Preact, Solid, Astro, Angular through Analog (AOT, JIT and `fastCompile`), `.svx` pages and entry HTML, including multi-environment and concurrent builds. Qwik is verified on the transform only. Please [open an issue](https://github.com/Castlenine/vite-plugin-console-stripper/issues) if you run into problems with these or other frameworks.

## Features

- Removes a standalone console statement however it is written: multiline, with nested parentheses or string and template-literal arguments, with or without a semicolon. No blank line is left behind.
- Matches qualified and less common call forms: `window.console.log()`, `console?.log()`, `console['log']()`, `console.log<T>()` and tagged templates.
- Turns a call used inside a larger expression into `void 0`, so the code still parses.
- Keeps `console.error`, `console.warn`, `console.info` and `console.clear` by default; `methods` sets the list.
- Processes script, markup and HTML files out of the box (`DEFAULT_EXTENSIONS`), and ships frozen extension presets (`SCRIPT_EXTENSIONS`, `SVELTE_EXTENSIONS`, `VUE_EXTENSIONS`, …) that you compose instead of listing extensions by hand.
- Never edits text: markup text, plain quoted attributes, `<style>` blocks and JSX text stay byte-identical.
- Strips dependencies under `node_modules` too, with per-package and global opt-outs.
- Keeps specific calls through ignore comments, and skips the folders and files you configure on top of a built-in ignore list.
- Leaves a call it cannot delimit in place and emits a build warning.
- Emits a sourcemap for each changed file when sourcemaps are enabled. No runtime dependencies.

## Requirements

| Requirement | Version |
| - | - |
| Node.js | `>=18.0.0` |
| Vite | `>=2.0.0` (peer dependency) |

## Installation

Use your package manager to install it as a development dependency:

```shell
pnpm add -D @castlenine/vite-plugin-console-stripper
# or
npm i -D @castlenine/vite-plugin-console-stripper
# or
yarn add -D @castlenine/vite-plugin-console-stripper
```

## Usage

### Quick start

List `consoleStripper()` first in `plugins`:

```typescript
// vite.config.ts
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import consoleStripper from '@castlenine/vite-plugin-console-stripper';

export default defineConfig({
	plugins: [consoleStripper(), sveltekit()],
});
```

Run `vite build`. `console.log`, `console.debug` and the other [default methods](#methods) disappear from your code and your dependencies, while `console.error`, `console.warn`, `console.info` and `console.clear` stay.

The plugin only runs during `vite build` (`apply: 'build'`), so the dev server and Vitest keep every console call without a mode check. To keep them in one build mode as well, a staging build for example, register the plugin conditionally:

```typescript
export default defineConfig(({ mode }) => ({
	plugins: [mode === 'staging' ? null : consoleStripper(), sveltekit()],
}));
```

Vite ignores falsy entries in `plugins`, so `mode !== 'staging' && consoleStripper()` is equivalent to the ternary.

### Plugin order

`consoleStripper()` returns two plugins, and Vite flattens the array, so `plugins: [consoleStripper()]` is all you write:

- `console-stripper` runs with `enforce: 'pre'` so it sees raw source, before a later transform such as esbuild drops the comments that carry [ignore directives](#ignore-comments).
- `console-stripper:angular` runs with `enforce: 'post'` and only does something when Analog's `angular()` plugin is registered (see [Angular through Analog](#angular-through-analog)).

`pre` plugins run in the order they appear in `plugins`, so order can matter when a framework plugin has its own `pre` pass.

| Framework | Where to list `consoleStripper()` | Why |
| - | - | - |
| Svelte / SvelteKit | Before `svelte()` / `sveltekit()` | `@sveltejs/vite-plugin-svelte` runs your preprocessors in a `pre` pass. With `vitePreprocess({ script: true })`, TypeScript is transpiled there, and a file-level `console-stripper-ignore` written above an `import type` is erased with it. Next-line and start/end directives survive in either order. |
| Markdown via mdsvex | Before `svelte()` / `sveltekit()` | mdsvex is a Svelte preprocessor, so the stripper should read the source before it does. |
| Vue | Anywhere | `@vitejs/plugin-vue` is not pre-enforced. |
| React, Preact, Solid | Anywhere | Their plugins have `pre` passes, but builds in both orders keep ignore directives working. |
| Astro | In `astro.config.*` under `vite.plugins` | Astro's own plugins run first, so `.astro` modules arrive compiled (see [Astro](#astro)). |
| Angular (Analog) | Anywhere for AOT and `jit: true`; before `angular()` with `fastCompile: true` | See [Angular through Analog](#angular-through-analog). |
| HTML entries | Anywhere | There is no framework plugin to order against. |

When in doubt, list `consoleStripper()` first.

### CommonJS

The package also ships a CommonJS entry. `require()` returns the plugin function directly (`.default` works too), and `DEFAULT_METHODS` and every extension preset are properties of the same module:

```javascript
// vite.config.cjs
const { defineConfig } = require('vite');
const consoleStripper = require('@castlenine/vite-plugin-console-stripper');

module.exports = defineConfig({
	plugins: [
		consoleStripper({
			methods: [...consoleStripper.DEFAULT_METHODS, 'info'],
			extensions: [...consoleStripper.SCRIPT_EXTENSIONS, ...consoleStripper.SVELTE_EXTENSIONS],
		}),
	],
});
```

## Options

Everything is configured through the options object; the plugin reads no environment variables. Array options are typed `readonly`, so you can pass the frozen presets, `DEFAULT_METHODS` and `as const` lists as they are.

| Option | Type | Default | Purpose |
| - | - | - | - |
| [`methods`](#methods) | `readonly ConsoleMethod[]` | `DEFAULT_METHODS` | Console methods to strip |
| [`extensions`](#extensions) | `readonly string[]` | `DEFAULT_EXTENSIONS` | File extensions to process (leading dot optional, case-insensitive) |
| [`ignoreComments`](#ignorecomments) | `boolean` | `true` | Honor the `console-stripper-ignore*` comments |
| [`ignoreFolders`](#ignorefolders-and-ignorefiles) | `readonly string[]` | `[]` | Folders to skip, relative to the Vite root |
| [`ignoreFiles`](#ignorefolders-and-ignorefiles) | `readonly string[]` | `[]` | Files to skip, relative to the Vite root |
| [`ignoreDefaults`](#ignoredefaults) | `boolean` | `true` | Also apply the built-in ignore list to project files |
| [`stripDependencies`](#stripdependencies) | `boolean` | `true` | Strip files under `node_modules` too |
| [`ignoreDependencies`](#ignoredependencies) | `readonly string[]` | `[]` | Packages to leave untouched, by exact name |
| [`verbose`](#verbose) | `boolean` | `false` | Print a summary line when the build ends |

### `methods`

The console methods to strip. Default: `DEFAULT_METHODS`:

```typescript
['assert', 'count', 'countReset', 'debug', 'dir', 'dirxml', 'group',
 'groupCollapsed', 'groupEnd', 'log', 'profile', 'profileEnd', 'table',
 'time', 'timeEnd', 'timeLog', 'timeStamp', 'trace']
```

`error`, `warn`, `info`, `clear` (and the non-standard `exception`) are kept by default because production code usually still needs them.

- `methods` replaces the default list. Spread `DEFAULT_METHODS` to extend it.
- Names that are not `console` members are ignored.
- `methods: []` turns stripping off. Whenever `methods` or `extensions` resolves to an empty list, the plugin logs one `[console-stripper]` warning naming the rejected entries. It never fails the build.

```typescript
import consoleStripper, { DEFAULT_METHODS } from '@castlenine/vite-plugin-console-stripper';

// Strip the default list plus console.info
consoleStripper({ methods: [...DEFAULT_METHODS, 'info'] });
```

### `extensions`

The file extensions to process. Default: `DEFAULT_EXTENSIONS`. Entries are trimmed.

The package exports nine frozen presets. Pass one directly (`extensions: SCRIPT_EXTENSIONS`) or spread several into a new array.

| Constant | Extensions | Typical use |
| - | - | - |
| `JAVASCRIPT_EXTENSIONS` | `js`, `mjs`, `cjs` | Plain JavaScript; also Lit and Angular |
| `TYPESCRIPT_EXTENSIONS` | `ts`, `mts`, `cts` | Plain TypeScript; also Lit and Angular |
| `JSX_EXTENSIONS` | `jsx`, `tsx` | React, Preact, Solid, Qwik, Vue JSX |
| `SCRIPT_EXTENSIONS` | The three above | Any plain script file |
| `SVELTE_EXTENSIONS` | `svelte` | Svelte components (`.svelte.js` / `.svelte.ts` rune modules are covered by the script presets) |
| `VUE_EXTENSIONS` | `vue` | Vue single-file components |
| `ASTRO_EXTENSIONS` | `astro` | Astro components |
| `HTML_EXTENSIONS` | `html`, `htm` | Inline `<script>` blocks in entry HTML |
| `DEFAULT_EXTENSIONS` | Every preset above | The default |

A preset decides which files get scanned, not how they are scanned (see [File kinds](#file-kinds)). Only add extensions whose files are JavaScript or contain JavaScript `<script>` blocks (see [Limitations](#limitations)).

```typescript
import consoleStripper, { DEFAULT_EXTENSIONS, SCRIPT_EXTENSIONS, SVELTE_EXTENSIONS } from '@castlenine/vite-plugin-console-stripper';

// Only the file kinds this project uses
consoleStripper({ extensions: [...SCRIPT_EXTENSIONS, ...SVELTE_EXTENSIONS] });

// The defaults plus a custom extension
consoleStripper({ extensions: [...DEFAULT_EXTENSIONS, 'svx'] });
```

### `ignoreComments`

Whether [ignore comments](#ignore-comments) are honored. Default: `true`. Set it to `false` to strip every matching call, marked or not.

```typescript
consoleStripper({ ignoreComments: false });
```

### `ignoreFolders` and `ignoreFiles`

Folders and files to skip, relative to the Vite root. Default: `[]` for both. They apply to dependency files too.

- Tokens match on whole path segments, at any depth: `build` matches `build/app.js` but not `buildhome/app.js`, and `Header.svelte` matches `src/components/Header.svelte`.
- `*` matches within one segment: `*.stories` matches a `Button.stories/` folder; use `*.stories.*` for `Button.stories.ts`.
- Entries are trimmed, `\` becomes `/`, and a leading `/`, `./` or `../` and a trailing `/` are dropped.
- A module id's `?query` and `#hash` are ignored, but a `#` followed by `/` is part of a folder name.

```typescript
consoleStripper({
	ignoreFolders: ['src/tests', 'fixtures'],
	ignoreFiles: ['Header.svelte', 'src/components/Modal.svelte'],
});
```

### `ignoreDefaults`

Whether the built-in ignore list applies on top of `ignoreFolders` / `ignoreFiles`. Default: `true`. The list:

```text
node_modules, .git, .idea, .vscode, .DS_Store, Thumbs.db, .env, .env.*, logs, *.log, public, build,
.svelte-kit, dist, .nuxt, .output, .nitro, .data, .next, out, .react-router, .astro, .solid, .vinxi,
.tanstack, .angular, e2e, angular.json, browserslist, .vercel, .netlify, .wrangler, .cache
```

It only applies to your project's files, never to dependencies. Apart from `node_modules` and `.git`, each token matches only as the first segment under the Vite root: `public/` is skipped, `src/routes/public/` is not. Add a nested folder to `ignoreFolders` if you want it skipped.

```typescript
// Strip everything in the project, build and public folders included
consoleStripper({ ignoreDefaults: false });
```

### `stripDependencies`

Whether files under `node_modules` are stripped. Default: `true`. Dependencies get the same methods, extensions and ignore-comment handling as your files. Turn it off to keep a library's own diagnostics, or to check whether an issue comes from a dependency. SSR builds only reach bundled dependencies (see [Limitations](#limitations)).

```typescript
consoleStripper({ stripDependencies: false });
```

### `ignoreDependencies`

Packages whose files are left alone while other dependencies are still stripped. Default: `[]`.

A name matches the package that owns the file, by exact name including its scope (`@scope/pkg`). There are no wildcards or version ranges. A nested install belongs to its innermost package, so `node_modules/a/node_modules/b` belongs to `b`, and listing `a` does not cover it. pnpm-store layouts and dependencies hoisted above the Vite root resolve the same way. A path token works too: `ignoreFolders: ['node_modules/some-logger']`.

```typescript
consoleStripper({ ignoreDependencies: ['some-logger', '@scope/pkg'] });
```

### `verbose`

Prints one summary line through Vite's logger after a successful build, with project and dependency counts. A failed build prints nothing. Default: `false`.

```typescript
consoleStripper({ verbose: true });
```

```text
[console-stripper] [client] stripped 12 console calls in 4 project files and 3 console calls in 2 dependency files
```

On Vite 6+, the line is prefixed with the environment name, and a multi-environment build prints one line per environment. Before Vite 6 there is no prefix. When some calls had to be left in place (see [Build warnings](#build-warnings)), the line ends with `; left N undelimitable call(s) in place (X project, Y dependency)`.

### Types

`Options` and `ConsoleMethod` are exported for typing a shared options object:

```typescript
import type { ConsoleMethod, Options } from '@castlenine/vite-plugin-console-stripper';

const sharedOptions: Options = { methods: ['error', 'warn'] as ConsoleMethod[] };
```

## Ignore comments

Directives work in any comment: `//`, `/* */`, and `<!-- -->` in markup files. Each takes an optional `: reason`. [`ignoreComments: false`](#ignorecomments) disables them all.

`console-stripper-ignore-next-line` keeps every console call on the next line, even one written across several lines:

```javascript
// console-stripper-ignore-next-line: needed to trace this in production
console.log('trace', payload);
```

`console-stripper-ignore-start` / `console-stripper-ignore-end` keep every call between the two markers. A start with no matching end protects the rest of the file:

```javascript
// console-stripper-ignore-start: temporary diagnostics
console.log('a');
console.log('b');
// console-stripper-ignore-end
```

`console-stripper-ignore` within the first 10 lines of a file leaves the whole file untouched:

```javascript
// console-stripper-ignore: this file is excluded on purpose
console.log('kept');
```

## What gets removed

A console call that stands alone as a statement is removed with its trailing semicolon, if any. If it had the line to itself, the whole line goes, so no blank line is left. When removal would glue two lines into one expression, the plugin inserts a `;` guard.

```javascript
// Before
before();
console.log('hello');
after();

// After
before();
after();
```

A call used inside a larger expression becomes `void 0` (parenthesized when something follows it, as in `console.log(1).x` → `(void 0).x`). Minifiers drop it.

```javascript
// Before
if (debug) console.log(x);
ready && console.log('up');
const log = () => console.log(x);

// After
if (debug) void 0;
ready && void 0;
const log = () => void 0;
```

### File kinds

How much of a file counts as code depends on its extension, not on which preset matched it. Compound names use the last extension, so `Counter.svelte.ts` is a `ts` file.

| Kind | Extensions | What is edited |
| - | - | - |
| `script` | `.js`, `.mjs`, `.cjs`, `.jsx`, `.tsx` | The whole file (JSX text is left alone) |
| `ts` | `.ts`, `.mts`, `.cts` | Like `script`, but JSX is never detected |
| `html` | `.html`, `.htm` | JavaScript `<script>` blocks only |
| `astro` | `.astro` | Removal in `<script>` and the `---` frontmatter; `void 0` in `{…}` expressions |
| `vue` | `.vue` | Removal in `<script>`; `void 0` in `{{ }}` and directive values |
| `markdown` | `.md`, `.mdx`, `.svx` | Like `markup`, but fenced code and front matter are left alone |
| `markup` | `.svelte` and any other extension | Removal in `<script>`; `void 0` in `{…}` slots |

A Vue or Astro component's extracted `<script>` sub-request (`App.vue?vue&type=script…`) is scanned as `script`.

### Matched call forms

The plugin matches `console.<method>(`, optionally qualified by `window`, `globalThis`, `self` or `global`, plus:

- optional chaining: `console?.log()`, `console.log?.()`
- bracket access: `console['log']()`
- TypeScript generics and non-null assertions: `console.log<T>()`, `console.log!()`
- tagged templates: `` console.log`x` ``

Left alone:

- other qualifiers: `foo.console.log(…)`, `window?.console.log(…)`
- identifiers that just end in `console`: `$console.log(…)`, `this.#console.log(…)`
- a comment between `console` and the method: `console/* c */.log(1)`
- anything that is not a direct call: `const log = console.log`, `console.log.bind(…)`, `new console.log(…)`, `console[level](…)`, `.apply`, `.call`

### Skipped `<script>` blocks

A `<script>` block is never edited, in any file kind, when:

- its `type` is not JavaScript (`application/json`, `importmap`, `text/template`, `speculationrules`, …). Parameters are ignored, so `text/javascript; charset=utf-8` still counts.
- the tag has a `src` attribute.
- the tag is self-closing (`<script … />`). Everything up to the next `</script>` is skipped too, so write `<script src="…"></script>`.
- the block contains another `<script` opener, which makes its end impossible to know.

### Sourcemaps

A changed file gets a sourcemap only when the resolved `build.sourcemap` is `true`, `'inline'` or `'hidden'`. On Vite 6+, the per-environment setting wins over the top-level one. Maps keep original line and column positions and include `sourcesContent`.

### Build warnings

When the plugin cannot tell where a call ends, it leaves the call untouched rather than risk a wrong edit. For an unclosed parenthesis or template literal, or a call running past `</script>`, it also raises a warning through Rollup's `this.warn`, with a code frame, filterable in `onwarn`:

```text
[plugin console-stripper] …
```

The Astro and Angular warnings described under [Framework notes](#framework-notes) use the same channel. Warnings only come from project files, never dependencies, and each fires once per module per plugin instance, across client and SSR builds and `vite build --watch` rebuilds.

## Framework notes

For plugin ordering, see [Plugin order](#plugin-order).

### Svelte and SvelteKit

- `.svelte` files are `markup`: statements are removed inside `<script>`, and a call in a `{…}` template slot becomes `void 0`. Text, plain quoted attributes (even `title="{console.log()}"`) and `<style>` are left alone.
- `.svelte.js` / `.svelte.ts` rune modules are plain script files.

### Vue

- In `.vue` files, statements are removed inside `<script>`. Outside it, only `{{ }}` interpolations and directive values (`@click`, `:prop`, `#slot`, `v-*`) are code, and a call there becomes `void 0`. A single `{` is text.

### React, Preact and Solid

- `.jsx` / `.tsx` files are `script`: the whole file is code, but JSX text (`<p>Use console.log(x) to debug</p>`) is left alone. JSX detection is a heuristic, not a full parser.
- `.ts` files never detect JSX, since TypeScript forbids it there.

### Astro

- In `.astro` source, statements are removed inside `<script>` and the `---` frontmatter, and a call in a `{…}` expression becomes `void 0`.
- In a real Astro build, Astro's plugins run first, so `.astro` modules arrive compiled and are scanned as `script`. Ignore directives are recovered from Astro's inline sourcemap, and `is:inline` scripts are stripped too.
- `define:vars` scripts are left untouched. An ignore-start/end range reaches into an `is:inline` script body only when it spans the whole `{…}` expression containing it.
- If Astro's inline sourcemap cannot be read, the plugin warns once for that file (project files only) and ignores its directives.

### Angular through Analog

With `@analogjs/vite-plugin-angular`, the `console-stripper:angular` pass (`enforce: 'post'`) strips Analog's compiled JavaScript.

- AOT (the default) and `jit: true` work in either plugin order. The file-level `console-stripper-ignore` directive is read from your authored source.
- With `fastCompile: true`, list `consoleStripper()` before `angular()`. Listed after it, the plugin only sees fastCompile output, which drops a file-level directive written above an `import type`, and it logs one `[console-stripper] @analogjs/vite-plugin-angular-fast-compile runs before console-stripper, …` warning.
- A directive attached only to type-only code (`import type`, `interface`, `type`) is erased along with it by TypeScript.
- If the Angular compiler drops comments from its output (for example `"removeComments": true`), a module whose source had next-line or start/end directives is left unstripped, with one `[plugin console-stripper:angular] the Angular compiler removed the ignore comments of <file> …` warning per file. The file-level directive still works.
- Template text (inline `template:` and `templateUrl` `.html` files) is never edited. Angular templates cannot call `console` anyway.

### HTML entries

- In `.html` / `.htm` files only JavaScript `<script>` blocks are edited. Page text, `<code>` samples and inline event handlers stay byte-identical.
- HTML-comment ignore directives are honored for inline module scripts. Inline scripts injected by other plugins (`transformIndexHtml`) are still stripped, even on a page marked with `<!-- console-stripper-ignore -->`.

### Markdown, MDX and svx

- `.md`, `.mdx` and `.svx` have no preset. Add them to `extensions` yourself, for example `[...DEFAULT_EXTENSIONS, 'svx']`.
- They are scanned as `markdown`: like `markup`, but fenced code blocks (```` ``` ```` or `~~~`) and a leading `---` front-matter block stay byte-identical.

## Limitations

- **Side effects in arguments are dropped.** `console.log(index++)` loses the increment. Use an ignore comment if the side effect must run. The same goes for third-party code, where you cannot add one; use `ignoreDependencies` for packages that rely on it, or whose job is printing through `console.log` / `console.debug`.
- **Some removable calls become `void 0` instead.** After a label or `case` clause (`case 1: void 0;`), inside a TypeScript `namespace` body, and right above a line starting with `!=` or `!==`. The output is still valid.
- **Undelimitable calls stay.** See [Build warnings](#build-warnings).
- **It works on text, not a syntax tree.** A locally shadowed `console` is treated like the global one, and only direct calls are matched. Most logger libraries, which alias or wrap `console`, keep working.
- **SSR builds only reach bundled dependencies.** Vite externalizes dependencies in SSR by default, so they never go through `transform`. Only the client build and packages in `ssr.noExternal` are stripped.
- **Only add JavaScript-syntax files to `extensions`.** A language like Imba, Civet, CoffeeScript, ReScript, Elm or Gleam would be scanned as JavaScript and corrupted.
- **Marko, Riot and Ripple are unverified.** They have no preset; adding their extension uses markup mode at your own risk.

## Examples

### SvelteKit project

Strip the defaults plus `console.info`, skip the test folder and keep one package's logging:

```typescript
// vite.config.ts
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import consoleStripper, { DEFAULT_METHODS, SCRIPT_EXTENSIONS, SVELTE_EXTENSIONS } from '@castlenine/vite-plugin-console-stripper';

export default defineConfig({
	plugins: [
		// List it before sveltekit() so it reads the source before any preprocessor (see Plugin order)
		consoleStripper({
			methods: [...DEFAULT_METHODS, 'info'],
			extensions: [...SCRIPT_EXTENSIONS, ...SVELTE_EXTENSIONS, 'svx'],
			ignoreFolders: ['src/tests'],
			ignoreDependencies: ['some-logger'],
		}),
		sveltekit(),
	],
});
```

### Vue project

Only process Vue and script files, and print a summary at the end of the build:

```typescript
// vite.config.ts
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import consoleStripper, { SCRIPT_EXTENSIONS, VUE_EXTENSIONS } from '@castlenine/vite-plugin-console-stripper';

export default defineConfig({
	plugins: [
		vue(), // Order doesn't matter with vue()
		consoleStripper({
			extensions: [...SCRIPT_EXTENSIONS, ...VUE_EXTENSIONS],
			ignoreFiles: ['src/components/DebugPanel.vue'],
			verbose: true,
		}),
	],
});
```

### Astro project

Register it under Astro's `vite` key:

```javascript
// astro.config.mjs
import { defineConfig } from 'astro/config';
import consoleStripper from '@castlenine/vite-plugin-console-stripper';

export default defineConfig({
	vite: {
		plugins: [consoleStripper()],
	},
});
```

### Angular project

With Analog, list `consoleStripper()` first so the order still holds if you turn on `fastCompile`:

```typescript
// vite.config.ts
import angular from '@analogjs/vite-plugin-angular';
import { defineConfig } from 'vite';
import consoleStripper from '@castlenine/vite-plugin-console-stripper';

export default defineConfig({
	plugins: [consoleStripper(), angular()],
});
```

## How it works

For the mechanics behind file kinds, `void 0` replacement, compiled Astro and Angular modules, dependency ownership, sourcemaps and concurrent builds, see [documentation/how-it-works.md](./documentation/how-it-works.md).

## Changelog

For more information, refer to the [CHANGELOG.md](./CHANGELOG.md).

## License

[MIT](./LICENSE)

[npm]: https://www.npmjs.com/package/@castlenine/vite-plugin-console-stripper
[npm.badge]: https://img.shields.io/npm/v/@castlenine/vite-plugin-console-stripper
[download]: https://www.npmjs.com/package/@castlenine/vite-plugin-console-stripper
[download.badge]: https://img.shields.io/npm/d18m/@castlenine/vite-plugin-console-stripper
[contribution]: https://github.com/Castlenine/vite-plugin-console-stripper
[contribution.badge]: https://img.shields.io/badge/contributions-welcome-green
