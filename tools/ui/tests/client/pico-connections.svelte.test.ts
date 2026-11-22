import McpServerCard from '$lib/components/app/mcp/McpServerCard/McpServerCard.svelte';
import McpServerForm from '$lib/components/app/mcp/McpServerForm.svelte';
import { IS_PICO_BUILD } from '$lib/constants';
import { HealthCheckStatus } from '$lib/enums';
import { mcpStore } from '$lib/stores';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

const server = {
	displayName: 'My connection',
	enabled: true,
	id: 'connection',
	url: 'https://example.com/mcp'
};

afterEach(() => vi.restoreAllMocks());

describe.runIf(IS_PICO_BUILD)('Pico connection settings', () => {
	it('keeps a failed connection reachable and allows switching it off', async () => {
		vi.spyOn(mcpStore, 'getHealthCheckState').mockReturnValue({
			logs: [],
			message: 'Could not connect',
			status: HealthCheckStatus.ERROR
		});
		const onToggle = vi.fn();
		const screen = render(McpServerCard, {
			onDelete: vi.fn(),
			onToggle,
			onUpdate: vi.fn(),
			server
		});

		await expect.element(screen.getByText('Connection failed', { exact: true })).toBeVisible();
		await expect
			.element(screen.getByRole('switch', { name: 'Enable My connection' }))
			.toBeEnabled();
		await screen.getByRole('switch', { name: 'Enable My connection' }).click();
		expect(onToggle).toHaveBeenCalledWith(false);
		await expect.element(screen.getByRole('button', { name: 'Reconnect' })).toBeVisible();
	});

	it('keeps protocol details collapsed while showing connection status', async () => {
		vi.spyOn(mcpStore, 'getHealthCheckState').mockReturnValue({
			connectionTimeMs: 42,
			logs: [],
			protocolVersion: '2025-06-18',
			status: HealthCheckStatus.SUCCESS,
			tools: []
		});
		const screen = render(McpServerCard, {
			onDelete: vi.fn(),
			onToggle: vi.fn(),
			onUpdate: vi.fn(),
			server
		});

		await expect.element(screen.getByText('Connected', { exact: true })).toBeVisible();
		await expect.element(screen.getByText('Protocol version: 2025-06-18')).not.toBeVisible();
		await screen.getByText('Connection details', { exact: true }).click();
		await expect.element(screen.getByText('Protocol version: 2025-06-18')).toBeVisible();
	});

	it('keeps advanced headers available without cluttering the setup form', async () => {
		const screen = render(McpServerForm, {
			headers: '{"X-Client":"saved-header"}',
			onHeadersChange: vi.fn(),
			onUrlChange: vi.fn(),
			url: server.url
		});

		await expect.element(screen.getByRole('textbox', { name: 'Server URL' })).toBeVisible();
		await expect.element(screen.getByPlaceholder('Header name')).not.toBeVisible();
		await screen.getByText('Advanced connection settings', { exact: true }).click();
		await expect.element(screen.getByPlaceholder('Header name')).toHaveValue('X-Client');
		await expect
			.element(screen.getByPlaceholder('Value', { exact: true }))
			.toHaveValue('saved-header');
		expect(screen.container.textContent).not.toContain('Run llama-server');
	});

	it('keeps resource browsing available in connection details', async () => {
		vi.spyOn(mcpStore, 'getHealthCheckState').mockReturnValue({
			capabilities: { client: {}, server: { resources: {} } },
			logs: [],
			status: HealthCheckStatus.SUCCESS,
			tools: []
		});
		const onBrowseResources = vi.fn();
		const screen = render(McpServerCard, {
			onBrowseResources,
			onDelete: vi.fn(),
			onToggle: vi.fn(),
			onUpdate: vi.fn(),
			server
		});

		await expect.element(screen.getByText('Browse resources', { exact: true })).not.toBeVisible();
		await screen.getByText('Connection details', { exact: true }).click();
		await screen.getByRole('button', { name: 'Browse resources' }).click();
		expect(onBrowseResources).toHaveBeenCalledOnce();
	});

	it('allows a saved unavailable proxy to be turned off', async () => {
		vi.spyOn(mcpStore, 'isProxyAvailable', 'get').mockReturnValue(false);
		const onUseProxyChange = vi.fn();
		const screen = render(McpServerForm, {
			headers: '',
			onHeadersChange: vi.fn(),
			onUrlChange: vi.fn(),
			onUseProxyChange,
			url: server.url,
			useProxy: true
		});

		await screen.getByText('Advanced connection settings', { exact: true }).click();
		await expect.element(screen.getByRole('switch', { name: /Use server proxy/ })).toBeEnabled();
		await screen.getByRole('switch', { name: /Use server proxy/ }).click();
		expect(onUseProxyChange).toHaveBeenCalledWith(false);
	});

	it('keeps removal behind the connection menu and its confirmation', async () => {
		vi.spyOn(mcpStore, 'getHealthCheckState').mockReturnValue({ status: HealthCheckStatus.IDLE });
		const onDelete = vi.fn();
		const screen = render(McpServerCard, {
			onDelete,
			onToggle: vi.fn(),
			onUpdate: vi.fn(),
			server: { ...server, enabled: false }
		});

		await screen.getByRole('button', { name: 'Connection actions' }).click();
		await page.getByRole('menuitem', { name: 'Remove connection' }).click();
		await expect
			.element(page.getByRole('alertdialog', { name: 'Remove connection' }))
			.toBeVisible();
		expect(onDelete).not.toHaveBeenCalled();
		await page.getByRole('button', { exact: true, name: 'Remove' }).click();
		expect(onDelete).toHaveBeenCalledOnce();
	});
});
