import PicoAddMenuHarness from './components/PicoAddMenuHarness.svelte';
import { ATTACHMENT_MENU_TEXT, ATTACHMENT_TOOLTIP_TEXT } from '$lib/constants';
import { IS_PICO_BUILD } from '$lib/constants/app.constants';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

afterEach(async () => {
	await page.viewport(1280, 900);
});

describe('Add menu', () => {
	for (const width of [1280, 390]) {
		it(`keeps attachments reachable at ${width}px and places Pico instructions outside Add`, async () => {
			await page.viewport(width, 900);
			const onFiles = vi.fn();
			const onInstructions = vi.fn();
			const screen = render(PicoAddMenuHarness, { onFiles, onInstructions });

			await screen
				.getByRole('button', {
					name: IS_PICO_BUILD ? 'Add files and tools' : ATTACHMENT_TOOLTIP_TEXT
				})
				.click();
			const addFiles = page.getByRole(width < 768 ? 'button' : 'menuitem', {
				exact: true,
				name: 'Add files'
			});

			await expect.element(addFiles).toBeVisible();

			if (IS_PICO_BUILD) {
				expect(document.body.textContent).not.toContain(ATTACHMENT_MENU_TEXT.SYSTEM_MESSAGE);
			} else {
				await expect
					.element(
						page.getByRole(width < 768 ? 'button' : 'menuitem', {
							exact: true,
							name: ATTACHMENT_MENU_TEXT.SYSTEM_MESSAGE
						})
					)
					.toBeVisible();
			}

			await addFiles.click();
			expect(onFiles).toHaveBeenCalledOnce();
			expect(onInstructions).not.toHaveBeenCalled();
		});
	}
});
