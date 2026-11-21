/**
 * chatSyncStore - Follows the changes other windows make to chats kept on Pico Server
 *
 * While chats are on Pico Server, reads its change notices. Another window's
 * change reloads the chat list, and the open chat unless this window is
 * replying or editing in it; then the open chat reloads once the reply or
 * edit ends. A deleted chat leaves the list, and the screen
 * when it is open. Group notices reload the groups and the list. Notices that
 * arrive close together share one reload. The server replays nothing, so
 * after a reconnect the groups, the list and the open chat are read again.
 */

import { CONVERSATION_EVENTS } from '$lib/constants';
import { ConversationEventType } from '$lib/enums';
import type { ServerChatStore } from '$lib/services/server-chat-store';
// direct imports between stores, not via the barrel, to avoid circular deps
import { agenticStore } from '$lib/stores/agentic/index.svelte';
import { chatActivityStore } from '$lib/stores/chat/activity.svelte';
import { chatStore } from '$lib/stores/chat/index.svelte';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';
import { groupsStore } from '$lib/stores/groups.svelte';
import type { ApiConversationEvent } from '$lib/types/api';
import { isAbortError } from '$lib/utils/abort';

/** Whether this window is replying or editing in the chat; edit forms only open in the open chat. */
function isBusy(convId: string): boolean {
	return (
		chatActivityStore.isLocal(convId) || agenticStore.isRunning(convId) || chatStore.isEditing()
	);
}

class ChatSyncStore {
	/** Chats changed since the last reload, by id. */
	private changed = new Set<string>();

	private groupsChanged = false;

	/** Reloads run one after another, so an older list never lands last. */
	private reloads: Promise<void> = Promise.resolve();

	private reloadTimer: ReturnType<typeof setTimeout> | null = null;

	/** The open chat whose reload was skipped while this window replied or edited in it. */
	private skipped = $state<string | null>(null);

	/** Ends the effect that waits for that reply or edit to end. */
	private stopIdleWatch: (() => void) | null = null;

	private stream: AbortController | null = null;

	/** Opens the notices stream of `store`, as its account; one already open is closed first. */
	start(store: ServerChatStore): void {
		this.stop();

		this.stream = new AbortController();
		this.stopIdleWatch = $effect.root(() => {
			$effect(() => this.retryWhenIdle());
		});
		void store.watchEvents(
			this.stream.signal,
			(event) => this.apply(event),
			() => this.resync()
		);
	}

	/** Closes the stream and drops the reloads it has not run yet. */
	stop(): void {
		this.stream?.abort();
		this.stream = null;
		this.stopIdleWatch?.();
		this.stopIdleWatch = null;
		this.skipped = null;

		if (this.reloadTimer) clearTimeout(this.reloadTimer);

		this.reloadTimer = null;
		this.changed.clear();
		this.groupsChanged = false;
	}

	private apply(event: ApiConversationEvent): void {
		const convId = event.data.conversation_id;

		switch (event.event) {
			case ConversationEventType.CONVERSATION_CHANGED:
				if (convId) this.changed.add(convId);

				break;
			case ConversationEventType.CONVERSATION_DELETED:
				// the reload below picks up the forks the server moved to the deleted chat's parent
				if (convId) void conversationsStore.forgetConversation(convId);

				break;
			case ConversationEventType.GROUP_CHANGED:
			case ConversationEventType.GROUP_DELETED:
				this.groupsChanged = true;

				break;
			default:
				return;
		}

		this.scheduleReload();
	}

	private async reload(): Promise<void> {
		const stream = this.stream;

		// stopped while an earlier reload ran
		if (!stream) return;

		const changed = this.changed;
		const groupsChanged = this.groupsChanged;

		this.changed = new Set();
		this.groupsChanged = false;

		try {
			if (groupsChanged) await groupsStore.reload();

			await conversationsStore.reloadConversations();

			const openId = conversationsStore.activeConversation?.id;

			if (!openId || !changed.has(openId)) return;

			const reloaded = await conversationsStore.reloadActiveConversation(isBusy);

			if (!reloaded && this.stream === stream) this.skipped = openId;
		} catch (error) {
			// an abort means the store changed meanwhile; a failed call already showed its error
			if (!isAbortError(error)) console.error('Failed to reload chats changed elsewhere:', error);
		}
	}

	/** After a reconnect: anything may have changed while the stream was down. */
	private resync(): void {
		const openId = conversationsStore.activeConversation?.id;

		if (openId) this.changed.add(openId);

		this.groupsChanged = true;
		this.scheduleReload();
	}

	/** Runs the skipped reload once this window is no longer busy in the chat, if it is still open. */
	private retryWhenIdle(): void {
		const convId = this.skipped;

		if (!convId || isBusy(convId)) return;

		this.skipped = null;

		if (conversationsStore.activeConversation?.id !== convId) return;

		this.changed.add(convId);
		this.scheduleReload();
	}

	private scheduleReload(): void {
		if (this.reloadTimer) clearTimeout(this.reloadTimer);

		this.reloadTimer = setTimeout(() => {
			this.reloadTimer = null;
			this.reloads = this.reloads.then(() => this.reload());
		}, CONVERSATION_EVENTS.RELOAD_DEBOUNCE_MS);
	}
}

export const chatSyncStore = new ChatSyncStore();
