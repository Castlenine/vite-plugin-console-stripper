<script lang="ts">
	// console-stripper-ignore
	import type { Snippet } from 'svelte';

	interface Props {
		children?: Snippet;
	}

	const { children }: Props = $props();

	console.log('FILE_IGNORED_SVELTE_PREPROCESS');
</script>

{@render children?.()}
