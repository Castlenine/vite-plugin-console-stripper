<template>
	<!-- a <script> tag mentioned in a comment -->
	<button @click="console.log('STRIP_VUE_CLICK')">{{ console.info('KEEP_VUE_TEMPLATE_INFO') }} {{ count }}</button>
	<p>Type `console.log(value)` in a &lt;script&gt; block</p>
</template>

<script lang="ts">
export const MODULE_FLAG: boolean = true;
console.log('STRIP_VUE_NORMAL_SCRIPT');
</script>

<script setup lang="ts">
import { ref } from 'vue';

const count = ref<number>(0);

console.log('STRIP_VUE_SETUP');
console.warn('KEEP_VUE_SETUP_WARN');
// console-stripper-ignore-next-line
console.log('PROTECTED_VUE_SETUP');
</script>
