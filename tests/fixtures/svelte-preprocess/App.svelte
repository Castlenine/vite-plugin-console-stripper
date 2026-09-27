<script lang="ts">
	interface Counter {
		value: number;
	}

	const counter: Counter = { value: 0 };

	console.log('STRIP_SVELTE_PREPROCESS', counter.value);
	console.warn('KEEP_SVELTE_PREPROCESS_WARN');
	// console-stripper-ignore-next-line
	console.log('PROTECTED_SVELTE_PREPROCESS_NEXT_LINE');
	// console-stripper-ignore-start
	console.log('PROTECTED_SVELTE_PREPROCESS_RANGE');
	// console-stripper-ignore-end
</script>

<p>{counter.value}</p>

<style>
	p {
		color: red;
	}
</style>
