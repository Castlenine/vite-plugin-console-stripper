import { useEffect, useState } from 'preact/hooks';

export function App() {
	const [count, setCount] = useState(0);

	useEffect(() => {
		console.log('STRIP_PREACT_EFFECT');
		console.error('KEEP_PREACT_EFFECT_ERROR');
		// console-stripper-ignore-next-line
		console.log('PROTECTED_PREACT_EFFECT');
	}, [count]);

	return (
		<div>
			<p>Use console.log(debugValue) to debug</p>
			<button onClick={() => console.log('STRIP_PREACT_CLICK')}>{count}</button>
			<button onClick={() => setCount(count + 1)}>more</button>
		</div>
	);
}
