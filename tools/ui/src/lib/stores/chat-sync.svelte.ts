/**
 * chatSyncStore - Follows the changes other windows make to chats kept on Pico Server
 *
 * While chats are on Pico Server, reads its change notices. Another window's
 * change reloads the chat list, and the open chat unless this window is
 * replying or editing in it; then the open chat reloads once the reply or
 * edit ends. A deleted chat leaves the list, and the screen
 * when it is open. Group notices reload the groups and the list. Notices that
 * arrive close together share one reload, and a reload that fails is tried
 * again a few times. Each stream's reloads, and the store's first read of the
 * chats, run one after another. The server replays nothing, so the chats are
 * read once the stream is open, and after a reconnect the groups, the list and
 * the open chat are read again.
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

	/** Reloads that failed in a row, while the same stream was open. */
	private failures = 0;

	private groupsChanged = false;

	/** This stream's reloads, run one after another so an older list never lands last; each stream starts a new queue. */
	private reloads: Promise<void> = Promise.resolve();

	private reloadTimer: ReturnType<typeof setTimeout> | null = null;

	/** The open chat whose reload was skipped while this window replied, edited or changed its messages in it. */
	private skipped = $state<string | null>(null);

	/** Ends the effect that waits for that reply or edit to end. */
	private stopIdleWatch: (() => void) | null = null;

	private stream: AbortController | null = null;

	/**
	 * Runs `read` in turn with the reloads of the open stream, or at once when
	 * none is open. For the store's first read of the chats: a reload that a
	 * notice starts meanwhile then reads after it, so an older list never lands last.
	 */
	async inTurn(read: () => Promise<void>): Promise<void> {
		const run = this.reloads.then(read);

		this.reloads = run.catch(() => {});
		await run;
	}

	/**
	 * Opens the notices stream of `store`, as its account; one already open is
	 * closed first. Resolves once the stream is open, so reads made after it
	 * miss no notice, or after OPEN_WAIT_MS at most; a stream that opens later
	 * reads everything again.
	 */
	async start(store: ServerChatStore): Promise<void> {
		this.stop();

		const stream = new AbortController();

		let waiting = true;
		let opened = () => {};

		const open = new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, CONVERSATION_EVENTS.OPEN_WAIT_MS);

			opened = () => {
				clearTimeout(timer);
				resolve();
			};
		});

		this.stream = stream;
		this.stopIdleWatch = $effect.root(() => {
			$effect(() => this.retryWhenIdle());
		});
		stream.signal.addEventListener('abort', () => opened());
		void store.watchEvents(
			stream.signal,
			(event) => this.apply(event),
			() => {
				// chats are read once start() returns, so a stream that opens sooner missed nothing
				if (!waiting) this.resync();

				opened();
			}
		);

		await open;
		waiting = false;
	}

	/**
	 * Closes the stream and drops the reloads it has not run yet. A reload
	 * still reading is not waited for: the store switch makes its calls abort.
	 */
	stop(): void {
		this.stream?.abort();
		this.stream = null;
		this.reloads = Promise.resolve();
		this.stopIdleWatch?.();
		this.stopIdleWatch = null;
		this.skipped = null;

		if (this.reloadTimer) clearTimeout(this.reloadTimer);

		this.reloadTimer = null;
		this.changed.clear();
		this.groupsChanged = false;
		this.failures = 0;
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

	private async reload(stream: AbortController | null): Promise<void> {
		// stopped, or another stream opened, while an earlier reload ran
		if (!stream || this.stream !== stream) return;

		const changed = this.changed;
		const groupsChanged = this.groupsChanged;

		this.changed = new Set();
		this.groupsChanged = false;

		try {
			if (groupsChanged) await groupsStore.reload();

			await conversationsStore.reloadConversations();

			const openId = conversationsStore.activeConversation?.id;

			if (openId && changed.has(openId)) {
				const reloaded = await conversationsStore.reloadActiveConversation(isBusy);

				if (!reloaded && this.stream === stream) this.skipped = openId;
			}

			this.failures = 0;
		} catch (error) {
			// an abort means the store changed meanwhile; a failed call already showed its error
			if (isAbortError(error)) return;

			console.error('Failed to reload chats changed elsewhere:', error);

			// a closed stream drops the batch
			if (this.stream !== stream) return;

			// kept for the next reload; tried again by itself a few times, with backoff
			for (const id of changed) this.changed.add(id);

			this.groupsChanged ||= groupsChanged;

			if (this.failures >= CONVERSATION_EVENTS.RELOAD_RETRIES) {
				this.failures = 0;

				return;
			}

			this.scheduleReload(
				CONVERSATION_EVENTS.INITIAL_RECONNECT_DELAY_MS *
					CONVERSATION_EVENTS.BACKOFF_MULTIPLIER ** this.failures++
			);
		}
	}

	/** After a stream opened once the chats were read: anything may have changed before. */
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

	private scheduleReload(delay: number = CONVERSATION_EVENTS.RELOAD_DEBOUNCE_MS): void {
		if (this.reloadTimer) clearTimeout(this.reloadTimer);

		this.reloadTimer = setTimeout(() => {
			const stream = this.stream;

			this.reloadTimer = null;
			this.reloads = this.reloads.then(() => this.reload(stream));
		}, delay);
	}
}

export const chatSyncStore = new ChatSyncStore();
