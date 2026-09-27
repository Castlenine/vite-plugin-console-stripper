const identity = <T,>(value: T): T => {
	console.log('STRIP_TSX_GENERIC');

	return value;
};

interface WidgetProps {
	label: string;
}

export function Widget({ label }: WidgetProps) {
	console.info('KEEP_TSX_INFO');

	return <span onClick={() => console.debug('STRIP_TSX_CLICK')}>Call console.log(label) here: {identity(label)}</span>;
}
