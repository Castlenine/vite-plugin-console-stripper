# How it works

This page explains how `@castlenine/vite-plugin-console-stripper` works internally, for contributors. Installation, options, examples and limitations are in the [README](../README.md).

## Table of Contents

- [File kinds](#file-kinds)
- [Statement removal vs `void 0`](#statement-removal-vs-void-0)
- [Framework notes](#framework-notes)
  - [Vue and Astro script sub-requests](#vue-and-astro-script-sub-requests)
  - [Compiled Astro modules](#compiled-astro-modules)
  - [HTML entries](#html-entries)
  - [Angular through Analog](#angular-through-analog)
- [Dependencies](#dependencies)
- [Warnings](#warnings)
- [Sourcemaps](#sourcemaps)
- [Multi-environment and concurrent builds](#multi-environment-and-concurrent-builds)

## File kinds

A module's kind decides how much of it the plugin may edit. The kind comes from the module's extension, not from the preset that listed it, and a compound name uses its last extension, so `Counter.svelte.ts` is a `ts` file. The extension still has to be in `extensions` for the file to be scanned at all; the kind only matters after that.

| Kind | Resolves from | Behavior |
| - | - | - |
| `script` | `SCRIPT_EXTENSIONS` except `.ts` / `.mts` / `.cts` (`.tsx` stays here); Vite's inline-script proxy id for an HTML entry (`…?html-proxy&index=N.js`); a Vue or Astro component's extracted `<script>` sub-request (`App.vue?vue&type=script…`, `Page.astro?astro&type=script…`) | The whole file or sub-request is code. A provable standalone statement is removed, and any other call becomes `void 0`. |
| `ts` | `.ts`, `.mts`, `.cts` | Same as `script`, but JSX is never detected, because TypeScript forbids JSX in these files. |
| `html` | `HTML_EXTENSIONS` | Only JavaScript `<script>` blocks are code. A call anywhere else (page text, a `<code>` sample, an attribute handler) stays byte-identical. |
| `astro` | `ASTRO_EXTENSIONS` | Statements are removed only inside a `<script>` block or the `---` frontmatter fence. A call in a `{…}` template expression becomes `void 0`. Text, plain quoted attributes and `<style>` stay byte-identical. In a real Astro build the module arrives compiled and is scanned as `script` instead (see [Compiled Astro modules](#compiled-astro-modules)). |
| `vue` | `VUE_EXTENSIONS` | Statements are removed only inside a `<script>` block. Outside it, only a `{{ … }}` interpolation or a directive attribute value (`@…`, `:…`, `#…`, `v-*`) is code, and a call there becomes `void 0`. A single `{` is text, even inside a tag. Text, plain quoted attributes and `<style>` stay byte-identical. |
| `markdown` | `.md`, `.mdx`, `.svx` | Works like `markup` with single-brace `{…}` slots. Fenced code blocks (```` ``` ```` or `~~~`, with or without an info string, indented up to 3 spaces, LF or CRLF) are literal text, and a leading `---` front-matter block stays byte-identical. |
| `markup` | `SVELTE_EXTENSIONS`, plus any extension no other kind claims | The safe fallback. Statements are removed only inside a `<script>` block, and a call in a `{…}` template slot becomes `void 0`. Text, plain quoted attributes and `<style>` stay byte-identical. So does a leading `---` front-matter block, since only Astro treats that fence as code. |

Per-kind details the table leaves out:

- In a `script` file, the remove-or-`void 0` rule applies everywhere. JSX text (`<p>Use console.log(x) to debug</p>`) is detected with a heuristic and never edited; inside JSX, only `{…}` expressions are code.
- A `ts` file behaves like `script` without JSX detection. `.tsx` is still `script`.
- In an `astro` file, `{` and `}` delimit statements the same way they do in plain script, inside a `<script>` block or the `---` frontmatter fence. Removing the last frontmatter statement leaves no blank line, and an empty `---`/`---` fence is recognized. Everywhere else, only a `{…}` expression slot is code.
- In a `vue` file, the only code outside `<script>` is `{{ }}` interpolations and directive attribute values (`@click`, `:prop`, `#slot`, `v-*`).
- A `markdown` file is scanned like `markup`, and its fenced code samples are literal text.
- In a `markup` file, the only code outside `<script>` is a `{…}` template slot.
- An `html` file is stricter than `markup`. Outside a JavaScript `<script>` block the document is inert text, so a console call there (page copy, a `<code>` sample, an inline event handler) is left exactly as written. It never becomes `void 0`.

The README lists the matched call forms and the `<script>` blocks every kind skips, under [Matched call forms](../README.md#matched-call-forms) and [Skipped `<script>` blocks](../README.md#skipped-script-blocks).

## Statement removal vs `void 0`

When a console call is a statement on its own, the plugin removes it together with its trailing semicolon, if there is one. That includes calls inside `catch` / `static` blocks, calls after a TypeScript return-type annotation before `{`, multiline calls, nested parentheses, and string or template-literal arguments. If the statement had its line (or lines) to itself, the leading indentation and one trailing line break go too, so no blank line is left. If other code or a trailing comment shares the line, only the statement and its semicolon are removed.

In semicolon-less code, removing a statement can fuse the lines around it (an ASI hazard). The plugin then inserts a `;` guard in its place. A run of consecutive removed statements gets a single guard, and only when the code before the run and the line after it would otherwise fuse (`a()`, then removed calls, then `[1].forEach(f)`). There is never a guard after `;` or `{`, or at the end of the file.

When a console call is part of a larger expression, it becomes `void 0`, or `(void 0)` when a member access, call, tagged template, optional chain or `**` follows it (`console.log(1).x` → `(void 0).x`). Removing the call there would break the code or change what it does. `void 0` is a valid expression with no side effects, and minifiers drop it.

A call also becomes `void 0` instead of being removed when the plugin cannot prove it is a standalone statement:

- after a label or a `case` clause (`case 1: console.log(1);` becomes `case 1: void 0;`)
- inside a TypeScript `namespace` body
- right above a line that starts with `!=` or `!==`, because that line continues the previous expression

## Framework notes

### Vue and Astro script sub-requests

A Vue or Astro component's extracted `<script>` sub-request (`App.vue?vue&type=script…`, `Page.astro?astro&type=script…`) is scanned as plain script despite its `.vue` / `.astro` extension, the same way an HTML entry's html-proxy module is. A provable standalone call there is removed rather than turned into `void 0`. `type=template` and `type=style` sub-requests, and Svelte's own sub-requests, keep their component's kind.

### Compiled Astro modules

In a real Astro build, Astro's `astro:build` plugin compiles each `.astro` file before this plugin sees it. When the plugin finds `astro:build` registered ahead of it, it scans `.astro` modules as `script`. The compiled template keeps page text inside template literals, so the text is untouched while frontmatter statements are removed and template expressions become `void 0`.

- Ignore directives are read from the original source that Astro embeds in its inline sourcemap (`sourcesContent`).
- `is:inline` scripts inside the compiled template are stripped too.
- `define:vars` scripts are left alone.
- A `console-stripper-ignore-start` / `-end` range reaches into an `is:inline` script body only when it spans the whole `{…}` expression that contains the script.
- If Astro's inline sourcemap can't be read, the plugin ignores that file's directives and warns once (project files only; see [Warnings](#warnings)).

### HTML entries

Ignore directives in HTML comments also apply to inline module scripts, even though Vite later re-emits those scripts as separate html-proxy modules. A script injected by another plugin (through `transformIndexHtml`) has no directives of its own, so it is still stripped. On a page with a file-level `<!-- console-stripper-ignore -->`, the page's own inline scripts are kept and injected scripts are stripped, whether or not the page contains a stripped call.

### Angular through Analog

`consoleStripper()` returns a tuple of two plugins, and Vite flattens it:

- `console-stripper` (`enforce: 'pre'`) is the source pass that the rest of this page describes.
- `console-stripper:angular` (`apply: 'build'`, `enforce: 'post'`) runs only when `@analogjs/vite-plugin-angular` is registered, and strips Analog's compiled JavaScript.

Analog's AOT compiler (the default) and `jit: true` build from the files on disk, so the pre pass never sees their output. The post pass does, whichever order the plugins are in, and it reads the file-level `console-stripper-ignore` directive from the authored source. With `fastCompile: true`, `consoleStripper()` has to come before `angular()`. Listed after it, the plugin only sees the fastCompile output, which drops a file-level directive written above an `import type`, and it logs this warning through Vite's logger, once per plugin instance:

```text
[console-stripper] @analogjs/vite-plugin-angular-fast-compile runs before console-stripper, which then reads its emit: a file-level ignore directive written above a type-only import is dropped with it. List consoleStripper() before angular() in the plugins
```

`ignore-next-line` and `-start` / `-end` work on runtime code. A directive attached only to type-only code (`import type`, `interface`, `type`) disappears with that code when TypeScript emits. Sometimes the authored source has next-line or start/end directives but the Angular compiler strips them from its output, for example with `"removeComments": true` in the tsconfig. The post pass then leaves the module unstripped, so it can't remove calls the directives were protecting, and warns once for that file (see [Warnings](#warnings)). The file-level directive still works, since it comes from the authored source. Template text (inline `template:` and `templateUrl` `.html` files) is never edited.

## Dependencies

Files under `node_modules` get the same method list, extension list and ignore-comment handling as project files.

The built-in ignore list (`dist`, `build`, `public`, `node_modules`, …) never applies to dependency files. Almost every published package keeps its output in one of those folders, so applying the list there would quietly turn off stripping for most dependencies. A dependency file is skipped only through `stripDependencies: false`, `ignoreDependencies`, or your own `ignoreFolders` / `ignoreFiles`. `console-stripper-ignore*` comments inside a dependency's source are still honored.

`ignoreDependencies` compares names exactly against the package that owns the file, which is the package named right after the *last* `node_modules/` segment of its path. That handles nested installs (`node_modules/a/node_modules/b` belongs to `b`) and pnpm-store layouts. The check runs on the absolute module path, so dependencies hoisted above the Vite root (a monorepo package, a pnpm store) are still recognized.

## Warnings

Per-module warnings go through Rollup's `this.warn`. They come with a code frame, can be filtered in `onwarn`, and print as `[plugin console-stripper] …` (or `[plugin console-stripper:angular] …` from the Angular pass). Without a plugin context, they fall back to Vite's logger. Three situations produce one:

- a stripped-method call left in place because the plugin couldn't find where it ends (an unclosed parenthesis or template literal, or a call running past `</script>`)
- an Astro inline sourcemap that can't be read
- an Angular module left unstripped because the Angular compiler removed its ignore comments: `the Angular compiler removed the ignore comments of <file> (e.g. "removeComments": true in its tsconfig), so the file was left unstripped`

Only project files warn, never dependency files. Each module warns once per plugin instance: the client and SSR environments share that record, and `vite build --watch` doesn't repeat the warning on later rebuilds. Two other warnings go through Vite's logger instead, each once per plugin instance: the fastCompile plugin-order warning and the empty `methods` / `extensions` warning.

## Sourcemaps

The README's [Sourcemaps](../README.md#sourcemaps) section says when a map is generated. With `build.sourcemap: false`, Vite's default, the transform returns no map.

Each line gets word-boundary segments, the same as magic-string's `hires: 'boundary'`, so original line and column numbers survive the edit. Every map includes the original source in `sourcesContent`. For an HTML entry's inline `<script>`, `sources` holds the html-proxy module id.

## Multi-environment and concurrent builds

On Vite 6+, the `verbose` summary starts with the environment name, and a multi-environment build prints one line per environment (`[console-stripper] [client] stripped 12 console calls in 4 project files and 3 console calls in 2 dependency files`). Vite 5 and earlier print no `[client]` prefix. A count of one uses the singular (`1 console call`, `1 project file`). If undelimitable calls were left in place, the line ends with `; left N undelimitable call(s) in place (X project, Y dependency)`; if not, nothing is added. The empty-list warning names non-string `methods` entries by their type (for example `<object>`) and never fails the build.

Concurrent builds that share one plugin instance keep their own counters and html-proxy page records per environment. `root`, `logger` and framework detection (Astro, Analog) are also read per environment, so concurrent builds with different roots don't interfere. On Vite 5 and earlier, all builds share a single state.
