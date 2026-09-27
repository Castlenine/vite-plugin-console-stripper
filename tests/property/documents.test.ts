import type { FileKind } from '../../src/utilities';

import { describe, expect } from 'vitest';
import { fc, test } from '@fast-check/vitest';

import { stripConsole } from '../../src/utilities';

/**
 * What stripping must do to a generated part: a `stripped` one holds code whose `S<n>_` markers must disappear from
 * the output, a `kept` one must reach the output verbatim
 */
type PartRole = 'kept' | 'stripped';

interface Part {
	code: string;
	role: PartRole;
}

type PartFactory = (index: number) => Part;

type DocumentKind = Exclude<FileKind, 'script' | 'ts'>;

interface GeneratedDocument {
	fileKind: DocumentKind;
	parts: Part[];
}

// ─── Part pools ─────────────────────────────────────────────────────────────────

function stripped(build: (marker: string) => string): PartFactory {
	return (index) => ({ code: build(`S${index}_`), role: 'stripped' });
}

function kept(build: (marker: string) => string): PartFactory {
	return (index) => ({ code: build(`K${index}_`), role: 'kept' });
}

/**
 * Text, attributes, styles and non-JavaScript scripts, which no document kind edits
 */
const TEXT_PARTS: readonly PartFactory[] = [
	kept((marker) => `<p>Say console.log('${marker}') here</p>`),
	kept((marker) => `console.log('${marker}' (never closed`),
	kept((marker) => `<!-- console.log('${marker}') -->`),
	kept((marker) => `<p title="console.log('${marker}')">x</p>`),
	kept((marker) => `<p title="{console.log('${marker}')}">x</p>`),
	kept((marker) => `<style>\n.a::after { content: "console.log('${marker}')"; }\n</style>`),
	kept((marker) => `<script type="application/json">{"a": "console.log('${marker}')"}</script>`),
	kept((marker) => `<script src="x.js">console.log('${marker}')</script>`),
	kept((marker) => `<script type="text/template">console.log('${marker}')</script>`),
];

/**
 * JavaScript `<script>` blocks, which every document kind strips
 */
const SCRIPT_PARTS: readonly PartFactory[] = [
	stripped((marker) => `<script>\nconsole.log('${marker}');\nconst a = 1;\n</script>`),
	stripped((marker) => `<script type="module">console.log('${marker}')</script>`),
	stripped((marker) => `<script>\n\tif (a) {\n\t\tconsole.debug(\`${marker} \${a}\`)\n\t}\n</script>`),
	kept((marker) => `<script>\n// console-stripper-ignore-next-line\nconsole.log('${marker}');\n</script>`),
	kept((marker) => `<script>\nconsole.error('${marker}');\nconst s = 'console.log(${marker})';\n</script>`),
];

/**
 * `{…}` expressions, which are code in Svelte, Astro and Markdown documents
 */
const SLOT_PARTS: readonly PartFactory[] = [
	stripped((marker) => `<p>{console.log('${marker}')}</p>`),
	stripped((marker) => `<p>{ok && console.log('${marker}')}</p>`),
	kept((marker) => `<p>{console.warn('${marker}')}</p>`),
];

/**
 * The same `{…}` expressions, which are text in Vue and HTML documents
 */
const LITERAL_SLOT_PARTS: readonly PartFactory[] = [
	kept((marker) => `<p>{console.log('${marker}')}</p>`),
	kept((marker) => `<p>{ok && console.log('${marker}')}</p>`),
];

const VUE_PARTS: readonly PartFactory[] = [
	stripped((marker) => `<script setup lang="ts">\nconsole.log('${marker}')\nconst n: number = 1\n</script>`),
	stripped((marker) => `<p>{{ console.log('${marker}') }}</p>`),
	stripped((marker) => `<button @click="console.log('${marker}')">x</button>`),
	stripped((marker) => `<i :title="console.log('${marker}')" />`),
	stripped((marker) => `<i v-on:click="console.log('${marker}')" />`),
];

const MARKUP_PARTS: readonly PartFactory[] = [
	stripped((marker) => `<script lang="ts">\nconsole.debug('${marker}')\nlet n: number = 1\n</script>`),
	stripped((marker) => `{#if v}<b>{console.log('${marker}')}</b>{/if}`),
];

const MARKDOWN_PARTS: readonly PartFactory[] = [
	kept((marker) => `\`\`\`js\nconsole.log('${marker}')\n\`\`\``),
	kept((marker) => `~~~\n{console.log('${marker}')}\n~~~`),
	kept((marker) => `   \`\`\`\n<script>console.log('${marker}')</script>\n   \`\`\``),
	kept((marker) => `\`\`\`\r\n{console.log('${marker}')}\r\n\`\`\``),
];

const POOLS: Record<DocumentKind, readonly PartFactory[]> = {
	astro: [...TEXT_PARTS, ...SCRIPT_PARTS, ...SLOT_PARTS],
	html: [...TEXT_PARTS, ...SCRIPT_PARTS, ...LITERAL_SLOT_PARTS],
	markdown: [...TEXT_PARTS, ...SCRIPT_PARTS, ...SLOT_PARTS, ...MARKDOWN_PARTS],
	markup: [...TEXT_PARTS, ...SCRIPT_PARTS, ...SLOT_PARTS, ...MARKUP_PARTS],
	vue: [...TEXT_PARTS, ...SCRIPT_PARTS, ...LITERAL_SLOT_PARTS, ...VUE_PARTS],
};

/**
 * The block a document may open with: Astro reads a `---` fence as code, the other kinds leave it untouched
 */
const LEADING_FENCES: Record<DocumentKind, readonly (PartFactory | null)[]> = {
	astro: [null, stripped((marker) => `---\nconsole.log('${marker}');\nconst a = 1;\n---`)],
	html: [null],
	markdown: [null, kept((marker) => `---\ntitle: console.log('${marker}')\n---`)],
	markup: [null, kept((marker) => `---\ntitle: console.log('${marker}')\n---`)],
	vue: [null],
};

const DOCUMENT_KINDS: readonly DocumentKind[] = ['astro', 'html', 'markdown', 'markup', 'vue'];

const MARKER_REGEX = /[KS]\d+_/g;

const RUN_OPTIONS = { numRuns: 300, seed: 20_260_925 } as const;

// ─── Arbitraries ────────────────────────────────────────────────────────────────

const DOCUMENT_ARBITRARY: fc.Arbitrary<GeneratedDocument> = fc.constantFrom(...DOCUMENT_KINDS).chain((fileKind) =>
	fc
		.tuple(
			fc.constantFrom(...LEADING_FENCES[fileKind]),
			fc.array(fc.constantFrom(...POOLS[fileKind]), { minLength: 1, maxLength: 10 }),
		)
		.map(([fence, factories]) => ({
			fileKind,
			parts: [...(fence ? [fence] : []), ...factories].map((factory, index) => factory(index)),
		})),
);

/**
 * Syntax fragments every document scanner reads, assembled at random into documents that are rarely well formed
 */
const SYNTAX_FRAGMENTS = [
	'<script>',
	'</script>',
	'<script type="module">',
	'<style>',
	'</style>',
	'<!--',
	'-->',
	'---\n',
	'```\n',
	'~~~',
	'{',
	'}',
	'{{',
	'}}',
	'@click="',
	'"',
	"'",
	'`',
	'${',
	'/*',
	'*/',
	'//',
	'\n',
	'console.log(',
	'console.log(1)',
	')',
	'<p>',
	'</p>',
	'// console-stripper-ignore-next-line\n',
] as const;

const SYNTAX_SOUP_ARBITRARY = fc
	.array(
		fc.oneof(
			{ arbitrary: fc.constantFrom(...SYNTAX_FRAGMENTS), weight: 6 },
			{ arbitrary: fc.string({ unit: 'binary', minLength: 1, maxLength: 4 }), weight: 1 },
		),
		{ maxLength: 40 },
	)
	.map((fragments) => fragments.join(''));

// ─── Helpers ────────────────────────────────────────────────────────────────────

function toSource(parts: readonly Part[]): string {
	return `${parts.map((part) => part.code).join('\n\n')}\n`;
}

/**
 * Finds where each part starts in the output, searching in order.
 *
 * @returns The index of every part, `-1` for a part missing from the output after the previous one.
 */
function findInOrder(output: string, codes: readonly string[]): number[] {
	let searchFrom = 0;

	return codes.map((code) => {
		const INDEX = output.indexOf(code, searchFrom);

		searchFrom = INDEX === -1 ? searchFrom : INDEX + code.length;

		return INDEX;
	});
}

// ─── Properties ─────────────────────────────────────────────────────────────────

describe('stripConsole on generated documents', () => {
	test.prop([DOCUMENT_ARBITRARY], RUN_OPTIONS)('is idempotent', ({ fileKind, parts }) => {
		const ONCE = stripConsole(toSource(parts), { fileKind });

		expect(stripConsole(ONCE, { fileKind })).toBe(ONCE);
	});

	test.prop([DOCUMENT_ARBITRARY], RUN_OPTIONS)(
		'keeps text, attributes, styles, fences and kept calls byte-identical, in order, and drops every stripped call',
		({ fileKind, parts }) => {
			const OUTPUT = stripConsole(toSource(parts), { fileKind });
			const KEPT_CODES = parts.filter((part) => part.role === 'kept').map((part) => part.code);
			const STRIPPED_MARKERS = parts
				.filter((part) => part.role === 'stripped')
				.flatMap((part) => part.code.match(MARKER_REGEX) ?? []);

			expect(findInOrder(OUTPUT, KEPT_CODES)).not.toContain(-1);
			expect(STRIPPED_MARKERS.filter((marker) => OUTPUT.includes(marker))).toStrictEqual([]);
		},
	);

	test.prop([fc.oneof(fc.string({ unit: 'binary' }), SYNTAX_SOUP_ARBITRARY), fc.constantFrom(...DOCUMENT_KINDS)], {
		...RUN_OPTIONS,
		numRuns: 500,
	})('never throws on arbitrary text and stays idempotent', (input, fileKind) => {
		const ONCE = stripConsole(input, { fileKind });

		expect(stripConsole(ONCE, { fileKind })).toBe(ONCE);
	});
});
