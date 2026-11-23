import Logo from '$lib/components/app/misc/Logo.svelte';
import { IS_PICO_BUILD } from '$lib/constants/app.constants';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';

// The Pico badge's first bar is the only lime fill in either logo.
const LIME_BAR = 'rect[fill="#c9ff00"]';

describe.runIf(IS_PICO_BUILD)('Pico logo', () => {
	it('shows the Pico badge', () => {
		const { container } = render(Logo);

		expect(container.querySelectorAll('svg')).toHaveLength(1);
		expect(container.querySelector(LIME_BAR)).not.toBeNull();
	});
});

describe.skipIf(IS_PICO_BUILD)('standard logo', () => {
	it("keeps llama.cpp's mark", () => {
		const { container } = render(Logo);

		expect(container.querySelectorAll('svg')).toHaveLength(1);
		expect(container.querySelector(LIME_BAR)).toBeNull();
	});
});
