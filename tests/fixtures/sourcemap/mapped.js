console.log('STRIP_MAPPED_ONE', { verbose: true });
export function computeTotal(prices) {
	console.debug('STRIP_MAPPED_TWO');
	return prices.reduce((sum, price) => sum + price, 0) * TAX_RATE_MULTIPLIER;
}

const TAX_RATE_MULTIPLIER = 1.2;
