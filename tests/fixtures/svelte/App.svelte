<script module>
	export const MODULE_VALUE = 1;
	console.log('STRIP_SVELTE_MODULE');
	console.warn('KEEP_SVELTE_MODULE_WARN');
</script>

<script lang="ts">
	let count: number = $state(0);
	const markup: string = '<b>bold console.log(markup)</b>';

	console.debug('STRIP_SVELTE_INSTANCE');
	console.error('KEEP_SVELTE_INSTANCE_ERROR');
	// console-stripper-ignore-next-line
	console.log('PROTECTED_SVELTE_INSTANCE');

	$effect(() => console.log('STRIP_SVELTE_EFFECT', count));
</script>

<button onclick={() => console.log('STRIP_SVELTE_CLICK')}>Clicked {count}</button>
{#if count > 0}
	<p>Use console.log(debugValue) to debug</p>
{/if}
{@html markup}
<p>{console.info('KEEP_SVELTE_TEMPLATE_INFO')}</p>
<p>{console.log('STRIP_SVELTE_TEMPLATE')}</p>
