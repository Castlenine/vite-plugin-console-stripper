import { useEffect, useState } from 'react';

export function App() {
	const [count, setCount] = useState(0);

	useEffect(() => {
		console.log('STRIP_REACT_EFFECT');
		console.warn('KEEP_REACT_EFFECT_WARN');
		// console-stripper-ignore-next-line
		console.log('PROTECTED_REACT_EFFECT');
	}, [count]);

	return (
		<div>
			{/* console.log('inside a JSX comment') */}
			<p>Use console.log(debugValue) to debug</p>
			<button onClick={() => console.log('STRIP_REACT_CLICK')}>{count}</button>
			<button onClick={() => setCount(count + 1)}>{console.clear()}</button>
		</div>
	);
}
