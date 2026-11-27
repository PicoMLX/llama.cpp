/**
 * AgenticGates - User interaction gates for the agentic loop
 *
 * Owns the state the loop waits on between turns: tool permission requests,
 * turn-limit continue prompts and queued steering messages. The loop awaits
 * requestPermission/requestContinue; the UI resolves them through
 * resolvePermission/resolveContinue. Owned by agenticStore, no host coupling.
 */

import { ToolPermissionDecision } from '$lib/enums';
// direct imports between stores, not via the barrel, to avoid circular deps
import { permissionsStore } from '$lib/stores/permissions.svelte';
import { toolsStore } from '$lib/stores/tools.svelte';
import type { AgenticPermissionRequest, DatabaseMessageExtra, SteeringMessage } from '$lib/types';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';

export class AgenticGates {
	/** Resolve functions for pending continue Promises; nothing derives from this map */
	private continueResolvers = new SvelteMap<string, (shouldContinue: boolean) => void>();
	/** Conversations whose pending permission a steering message denies */
	private denyOnSteering = new SvelteSet<string>();

	/** Dedicated reactive state for pending continue requests (turn limit reached) */
	private pendingContinueRequests = new SvelteMap<string, boolean>();
	/** Dedicated reactive state for pending permission requests (ensures immediate UI updates) */
	private pendingPermissions = new SvelteMap<string, AgenticPermissionRequest | null>();
	/** Resolve functions for pending permission Promises; nothing derives from this map */
	private permissionResolvers = new SvelteMap<string, (decision: ToolPermissionDecision) => void>();

	/** Reactive: queued steering messages to inject between turns */
	private steeringMessages = new SvelteMap<string, SteeringMessage>();

	/**
	 * Drop all pending gate state for a conversation, e.g. when a flow exits.
	 */
	clear(conversationId: string): void {
		this.pendingPermissions.set(conversationId, null);
		this.denyOnSteering.delete(conversationId);
		this.permissionResolvers.delete(conversationId);
		this.pendingContinueRequests.set(conversationId, false);
		this.continueResolvers.delete(conversationId);
		this.steeringMessages.delete(conversationId);
	}

	/**
	 * Clear the pending steering message without consuming it.
	 */
	clearSteeringMessage(conversationId: string): void {
		this.steeringMessages.delete(conversationId);
	}

	/**
	 * Consume and return the pending steering message for re-sending.
	 * Called by chatStore after the agentic flow exits.
	 */
	consumePendingSteeringMessage(conversationId: string): SteeringMessage | null {
		const msg = this.steeringMessages.get(conversationId);

		if (!msg) return null;

		this.steeringMessages.delete(conversationId);

		return msg;
	}

	getPendingContinueRequest(conversationId: string): boolean {
		return this.pendingContinueRequests.get(conversationId) ?? false;
	}

	getPendingPermissionRequest(conversationId: string): AgenticPermissionRequest | null {
		return this.pendingPermissions.get(conversationId) ?? null;
	}

	getPendingSteeringMessageContent(conversationId: string): string | null {
		return this.steeringMessages.get(conversationId)?.content ?? null;
	}

	getPendingSteeringMessageExtras(conversationId: string): DatabaseMessageExtra[] | undefined {
		return this.steeringMessages.get(conversationId)?.extras;
	}

	hasPendingSteeringMessage(conversationId: string): boolean {
		return this.steeringMessages.has(conversationId);
	}

	/**
	 * Queue a steering message. When the current agentic turn completes,
	 * the flow exits and the caller re-sends the message as a normal chat message.
	 */
	injectSteeringMessage(
		conversationId: string,
		content: string,
		extras?: DatabaseMessageExtra[]
	): void {
		this.steeringMessages.set(conversationId, { content, extras });

		// moving on without answering is a denial, e.g. for a Pico approval
		if (this.denyOnSteering.has(conversationId)) {
			this.resolvePermission(conversationId, ToolPermissionDecision.DENY);
		}
	}

	async requestContinue(conversationId: string, signal?: AbortSignal): Promise<boolean> {
		this.pendingContinueRequests.set(conversationId, true);

		return new Promise<boolean>((resolve) => {
			if (signal?.aborted) {
				this.pendingContinueRequests.set(conversationId, false);
				resolve(false);

				return;
			}

			this.continueResolvers.set(conversationId, (shouldContinue) => {
				this.pendingContinueRequests.set(conversationId, false);
				resolve(shouldContinue);
			});

			signal?.addEventListener(
				'abort',
				() => {
					const resolver = this.continueResolvers.get(conversationId);

					if (resolver) {
						this.continueResolvers.delete(conversationId);
						this.pendingContinueRequests.set(conversationId, false);
						resolve(false);
					}
				},
				{ once: true }
			);
		});
	}

	/**
	 * @param prompt - What the prompt shows instead of the raw tool name, the
	 * tool's permission key when its name alone may not find it, and
	 * `denyOnSteering` to resolve as denied when the user sends a new message
	 */
	async requestPermission(
		conversationId: string,
		toolName: string,
		serverLabel: string,
		signal?: AbortSignal,
		prompt: {
			label?: string;
			details?: string;
			permissionKey?: string;
			denyOnSteering?: boolean;
		} = {}
	): Promise<ToolPermissionDecision> {
		const permissionKey = prompt.permissionKey ?? toolsStore.getPermissionKey(toolName);

		if (permissionKey && permissionsStore.hasTool(permissionKey)) {
			return ToolPermissionDecision.ONCE;
		}

		if (prompt.denyOnSteering && this.steeringMessages.has(conversationId)) {
			return ToolPermissionDecision.DENY;
		}

		this.pendingPermissions.set(conversationId, {
			details: prompt.details,
			label: prompt.label,
			serverLabel,
			toolName
		});

		if (prompt.denyOnSteering) this.denyOnSteering.add(conversationId);

		return new Promise<ToolPermissionDecision>((resolve) => {
			if (signal?.aborted) {
				this.pendingPermissions.set(conversationId, null);
				this.denyOnSteering.delete(conversationId);
				resolve(ToolPermissionDecision.DENY);

				return;
			}

			this.permissionResolvers.set(conversationId, (decision) => {
				this.pendingPermissions.set(conversationId, null);
				this.denyOnSteering.delete(conversationId);

				if (decision === ToolPermissionDecision.ALWAYS && permissionKey) {
					permissionsStore.allowTool(permissionKey);
				} else if (decision === ToolPermissionDecision.ALWAYS_SERVER) {
					const serverToolKeys = toolsStore.allTools
						.filter((t) =>
							t.serverName
								? t.serverName === serverLabel
								: toolsStore.getToolServerLabel(t.definition.function.name) === serverLabel
						)
						.map((t) => toolsStore.getPermissionKey(t.definition.function.name)!)
						.filter((k): k is string => k !== null);

					permissionsStore.allowTools(serverToolKeys);
				}

				resolve(decision);
			});

			signal?.addEventListener(
				'abort',
				() => {
					const resolver = this.permissionResolvers.get(conversationId);

					if (resolver) {
						this.permissionResolvers.delete(conversationId);
						this.pendingPermissions.set(conversationId, null);
						this.denyOnSteering.delete(conversationId);
						resolve(ToolPermissionDecision.DENY);
					}
				},
				{ once: true }
			);
		});
	}

	resolveContinue(conversationId: string, shouldContinue: boolean): void {
		const resolver = this.continueResolvers.get(conversationId);

		if (resolver) {
			this.continueResolvers.delete(conversationId);
			resolver(shouldContinue);
		}
	}

	resolvePermission(conversationId: string, decision: ToolPermissionDecision): void {
		const resolver = this.permissionResolvers.get(conversationId);

		if (resolver) {
			this.permissionResolvers.delete(conversationId);
			resolver(decision);
		}
	}
}
