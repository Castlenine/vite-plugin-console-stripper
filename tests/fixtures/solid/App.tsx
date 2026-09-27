import { createSignal, onMount } from 'solid-js';

const identity = <T,>(value: T): T => {
	console.log('STRIP_SOLID_GENERIC');

	return value;
};

export function App() {
	const [count, setCount] = createSignal<number>(0);

	onMount(() => {
		console.debug('STRIP_SOLID_MOUNT');
		console.warn('KEEP_SOLID_MOUNT_WARN');
		// console-stripper-ignore-next-line
		console.log('PROTECTED_SOLID_MOUNT');
	});

	return (
		<div>
			<p>Use console.log(debugValue) to debug</p>
			<button onClick={() => console.log('STRIP_SOLID_CLICK')}>{identity(count())}</button>
			<button onClick={() => setCount(count() + 1)}>{console.info('KEEP_SOLID_TEMPLATE_INFO')}</button>
		</div>
	);
}
