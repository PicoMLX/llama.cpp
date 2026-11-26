/**
 * chatStorageStore - Where this browser keeps its chats: its own database or Pico Server
 *
 * Pico Server can keep an account's chats when /props reports
 * `conversation_storage` and an API key is set. The choice is saved per
 * browser, server and account, with a hash of the key standing for the
 * account. Switching waits for running replies and pending writes, drops the
 * loaded chats and messages, and reads the list from the new store;
 * DatabaseService drops what the old store answers late. While Pico Server
 * keeps the chats, chatSyncStore follows other windows' changes; a switch
 * closes its stream at once.
 */

import { base } from '$app/paths';
import { CHAT_STORAGE_LOCALSTORAGE_KEY } from '$lib/constants';
import { ChatStorageLocation, ErrorDialogType } from '$lib/enums';
import { DatabaseService } from '$lib/services/database.service';
import { localChatStore } from '$lib/services/local-chat-store';
import { ServerChatStore } from '$lib/services/server-chat-store';
// direct imports between stores, not via the barrel, to avoid circular deps
import { agenticStore } from '$lib/stores/agentic/index.svelte';
import { chatActivityStore } from '$lib/stores/chat/activity.svelte';
import { chatStore } from '$lib/stores/chat/index.svelte';
import { chatSyncStore } from '$lib/stores/chat-sync.svelte';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';
import { groupsStore } from '$lib/stores/groups.svelte';
import { serverStore } from '$lib/stores/server.svelte';
import { settingsStore } from '$lib/stores/settings/index.svelte';

const REPLY_POLL_INTERVAL_MS = 200;

/** cyrb53, a short non-cryptographic hash: crypto.subtle is missing on pages served over plain HTTP. */
function hashKey(value: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;

	for (let i = 0; i < value.length; i++) {
		const ch = value.charCodeAt(i);

		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}

	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function currentApiKey(): string {
	return settingsStore.config.apiKey?.toString().trim() ?? '';
}

/** The server and account a choice belongs to. */
function scopeOf(apiKey: string): string {
	return `${window.location.origin}${base}#${hashKey(apiKey)}`;
}

function readChoices(): Record<string, ChatStorageLocation> {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(CHAT_STORAGE_LOCALSTORAGE_KEY) ?? '{}');

		return parsed && typeof parsed === 'object'
			? (parsed as Record<string, ChatStorageLocation>)
			: {};
	} catch {
		return {};
	}
}

function showStoreError(error: unknown): void {
	chatStore.showErrorDialog({
		message: error instanceof Error ? error.message : String(error),
		type: ErrorDialogType.SERVER
	});
}

/** Resolves once no conversation has a reply running in this browser. */
async function waitForReplies(): Promise<void> {
	while (chatActivityStore.hasLocal || agenticStore.isAnyRunning) {
		await new Promise((resolve) => setTimeout(resolve, REPLY_POLL_INTERVAL_MS));
	}
}

class ChatStorageStore {
	/** The store chats are read from and written to. */
	location = $state<ChatStorageLocation>(ChatStorageLocation.BROWSER);

	/** The store a running switch moves to, null when none runs. */
	pending = $state<ChatStorageLocation | null>(null);

	/** Account of the Pico Server store in use, null for this browser's store. */
	private scope: string | null = null;

	/** Switches run one after another. */
	private switches: Promise<void> = Promise.resolve();

	/** Choices localStorage could not save, by scope; they hold while this page is open. */
	private unsaved = new Map<string, ChatStorageLocation>();

	/** Whether Pico Server offers to keep this account's chats. */
	get available(): boolean {
		return serverStore.props?.conversation_storage === true && currentApiKey() !== '';
	}

	get isServer(): boolean {
		return this.location === ChatStorageLocation.SERVER;
	}

	/**
	 * Picks the store before the first chat is read. Signed-in browsers use Pico
	 * Server when available unless the person explicitly chose browser storage.
	 */
	async initialize(): Promise<void> {
		const apiKey = currentApiKey();

		if (!apiKey || this.choiceFor(scopeOf(apiKey)) !== ChatStorageLocation.SERVER) return;

		if (!serverStore.props) await serverStore.fetch();

		if (!this.available) return;

		await this.use(ChatStorageLocation.SERVER, apiKey);
	}

	/**
	 * Saves where to keep chats for this server and account, then switches.
	 *
	 * @param target - This browser or Pico Server
	 */
	async select(target: ChatStorageLocation): Promise<void> {
		const apiKey = currentApiKey();

		if (!apiKey) return;

		const scope = scopeOf(apiKey);
		const choices = readChoices();

		choices[scope] = target;

		try {
			localStorage.setItem(CHAT_STORAGE_LOCALSTORAGE_KEY, JSON.stringify(choices));
			this.unsaved.delete(scope);
		} catch {
			// storage full or blocked, the choice still applies to this page
			this.unsaved.set(scope, target);
		}

		await this.sync();
	}

	/**
	 * Moves to the store the saved choice, /props and the API key call for.
	 * The root layout calls it again whenever the props or the key change.
	 */
	sync(): Promise<void> {
		this.switches = this.switches
			.then(() => this.applyChoice())
			.catch((error) => console.error('Failed to switch chat storage:', error));

		return this.switches;
	}

	private async applyChoice(): Promise<void> {
		// until /props is back the server's offer is unknown, so the store in use stays
		if (!serverStore.props) return;

		const apiKey = currentApiKey();
		const scope = apiKey ? scopeOf(apiKey) : null;
		const target =
			this.available && scope && this.choiceFor(scope) === ChatStorageLocation.SERVER
				? ChatStorageLocation.SERVER
				: ChatStorageLocation.BROWSER;
		const targetScope = target === ChatStorageLocation.SERVER ? scope : null;

		if (target === this.location && targetScope === this.scope) return;

		this.pending = target;
		// the notices belong to the account and store being left
		chatSyncStore.stop();

		try {
			// the first list load runs on the store picked at startup, it ends before the switch
			await conversationsStore.initialize();
			await waitForReplies();
			await this.use(target, apiKey);
			// in turn with the new stream's reloads, so a notice that comes during this read reads after it
			await chatSyncStore.inTurn(async () => {
				await conversationsStore.reloadFromStore();
				await groupsStore.reload();
			});
		} finally {
			this.pending = null;
		}
	}

	private choiceFor(scope: string): ChatStorageLocation {
		return this.unsaved.get(scope) ?? readChoices()[scope] ?? ChatStorageLocation.SERVER;
	}

	/**
	 * Points DatabaseService at a store once the current one's writes settle.
	 * A Pico Server store sends `apiKey` with all its requests, also the ones
	 * still queued when the key changes, and its notices stream opens before
	 * any chat is read from it.
	 */
	private async use(target: ChatStorageLocation, apiKey: string): Promise<void> {
		const isServer = target === ChatStorageLocation.SERVER;

		if (isServer) {
			const store = new ServerChatStore(apiKey);

			await DatabaseService.useStore(store, showStoreError);
			await chatSyncStore.start(store);
		} else {
			await DatabaseService.useStore(localChatStore);
		}

		this.location = target;
		this.scope = isServer ? scopeOf(apiKey) : null;
	}
}

export const chatStorageStore = new ChatStorageStore();
