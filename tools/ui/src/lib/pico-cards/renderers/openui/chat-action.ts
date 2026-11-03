import { isOpenUIUserAction, normalizeOpenUIAction } from './action';

export interface OpenUICardActionEnvironment {
	conversationId: string;
	activeConversationId: string | null;
	streaming: boolean;
	userActivation: boolean;
	sendMessage(content: string): Promise<void>;
	openURL(url: string): void;
}

export function formatOpenUIContinuation(value: unknown): string | null {
	const action = normalizeOpenUIAction(value);

	if (action?.type !== 'continue_conversation') return null;

	const message = action.humanFriendlyMessage?.trim();

	if (!message) return null;

	const details: Record<string, unknown> = {};

	if (action.params) {
		const { context, ...params } = action.params;

		if (context !== undefined) details.context = context;

		if (Object.keys(params).length > 0) details.params = params;
	}

	if (action.formName !== undefined) details.formName = action.formName;

	if (action.formState !== undefined) details.formState = action.formState;

	if (Object.keys(details).length === 0) return message;

	return `${message}\n\nSubmitted details:\n\n\`\`\`json\n${JSON.stringify(details, null, 2)}\n\`\`\``;
}

export function openUICardURL(value: unknown): string | null {
	const action = normalizeOpenUIAction(value);

	if (action?.type !== 'open_url' || typeof action.params?.url !== 'string') return null;

	try {
		const url = new URL(action.params.url);

		return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
	} catch {
		return null;
	}
}

export async function dispatchOpenUICardAction(
	action: unknown,
	environment: OpenUICardActionEnvironment
): Promise<boolean> {
	if (
		!isOpenUIUserAction(action) ||
		environment.activeConversationId !== environment.conversationId
	)
		return false;

	if (action.type === 'continue_conversation') {
		if (environment.streaming) return false;

		const content = formatOpenUIContinuation(action);

		if (!content) return false;

		await environment.sendMessage(content);

		return true;
	}

	if (action.type === 'open_url' && environment.userActivation) {
		const url = openUICardURL(action);

		if (!url) return false;

		environment.openURL(url);

		return true;
	}

	return false;
}
