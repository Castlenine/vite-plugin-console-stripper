<script>
export default {
	name: 'PlainCounter',
	mounted() {
		console.log('STRIP_VUE_PLAIN_MOUNTED');
		console.error('KEEP_VUE_PLAIN_ERROR');
		/* console-stripper-ignore-start */
		console.debug('PROTECTED_VUE_PLAIN');
		/* console-stripper-ignore-end */
	},
};
</script>

<template>
	<p @click="console.debug('STRIP_VUE_PLAIN_CLICK')">Plain console.log(text) stays</p>
</template>
