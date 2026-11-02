import PicoAccessSplash from '$lib/components/app/server/PicoAccessSplash.svelte';
import { serverStore, settingsStore } from '$lib/stores';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

const { goto } = vi.hoisted(() => ({ goto: vi.fn(async () => {}) }));

vi.mock('$app/navigation', () => ({ goto }));

beforeEach(() => {
	settingsStore.updateConfig('apiKey', '');
	goto.mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe('Pico access', () => {
	it('shows a focused access field without treating initial authentication as an error', async () => {
		render(PicoAccessSplash);
		const input = page.getByLabelText('Access Key', { exact: true });

		await expect.element(page.getByRole('heading', { name: 'Connect to Pico' })).toBeVisible();
		await expect.element(input).toHaveFocus();
		await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
		await expect.element(page.getByRole('button', { exact: true, name: 'Connect' })).toBeDisabled();
	});

	it('keeps rejected-key feedback accessible and allows correcting the key', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
		render(PicoAccessSplash);
		const input = page.getByLabelText('Access Key', { exact: true });

		await input.fill('wrong-key');
		await page.getByRole('button', { exact: true, name: 'Connect' }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent('This access key isn’t valid.');
		await expect.element(input).toHaveAttribute('aria-invalid', 'true');
		await expect.element(input).toHaveFocus();
		await input.fill('corrected-key');
		await expect.element(page.getByRole('alert')).toBeVisible();
		await expect.element(page.getByRole('button', { exact: true, name: 'Connect' })).toBeEnabled();
		expect(goto).not.toHaveBeenCalled();
	});

	it('saves a valid key, refreshes the server state and navigates without a success delay', async () => {
		const fetch = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('{}', { status: 200 }));
		const refresh = vi.spyOn(serverStore, 'fetch').mockResolvedValue(undefined);

		render(PicoAccessSplash);
		await page.getByLabelText('Access Key', { exact: true }).fill('  valid-key  ');
		await page.getByRole('button', { exact: true, name: 'Connect' }).click();
		await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('#/', { invalidateAll: true }));
		expect(fetch).toHaveBeenCalledWith('/props', {
			headers: { Authorization: 'Bearer valid-key', 'Content-Type': 'application/json' }
		});
		expect(settingsStore.config.apiKey).toBe('valid-key');
		expect(refresh).toHaveBeenCalledOnce();
	});

	it('offers a retry after a connection failure without losing the entered key', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
		render(PicoAccessSplash);
		const input = page.getByLabelText('Access Key', { exact: true });

		await input.fill('saved-key');
		await page.getByRole('button', { exact: true, name: 'Connect' }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent('Can’t connect to Pico.');
		await expect.element(input).toHaveValue('saved-key');
		await expect.element(page.getByRole('button', { exact: true, name: 'Connect' })).toBeEnabled();
	});
});
