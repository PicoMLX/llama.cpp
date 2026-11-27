import {
	API_CHAT,
	LEGACY_AGENTIC_REGEX as AGENTIC_REGEX,
	PICO_MCP,
	SETTINGS_KEYS
} from '$lib/constants';
import { IS_PICO_BUILD } from '$lib/constants/app.constants';
import { AttachmentType, MessageRole, StreamConnectionState } from '$lib/enums';
import { modelsStore } from '$lib/stores/models/index.svelte';
import { serverStore } from '$lib/stores/server.svelte';
import { settingsStore } from '$lib/stores/settings/index.svelte';
import type {
	ApiChatCompletionToolCall,
	DatabaseMessageExtraMcpPrompt,
	DatabaseMessageExtraMcpResource,
	OpenAIToolDefinition,
	ResponsesMcpCallItem,
	ResponsesMcpItem,
	ResponsesMcpTool,
	ResponsesMcpWireItem
} from '$lib/types';
import { isAbortError } from '$lib/utils/abort';
import { getJsonHeaders } from '$lib/utils/api-headers';
import { capImageDataURLSize } from '$lib/utils/cap-img-size';
import { isMcpItem, mcpItemRuns, picoMcpUrl, splitStoredToolCalls } from '$lib/utils/pico-tools';
import { createReasoningTiming } from '$lib/utils/reasoning-timing';

type OpenResponsesOutputItem = {
	id?: string;
	type?: string;
	callId?: string;
	call_id?: string;
	name?: string;
	arguments?: unknown;
	output?: unknown;
	function?: {
		name?: string;
		arguments?: unknown;
	};
};

type StreamingFunctionCallState = {
	callId: string;
	itemId: string;
	index: number;
	name: string;
	arguments: string;
	hasArguments: boolean;
	argumentsClosed: boolean;
	hasOutput: boolean;
};

type ResponsesInputContentPart = {
	type: string;
	text?: string;
	image_url?: string;
	input_audio?: { data: string; format: string };
	input_video?: { data: string; format: string };
};

type ResponsesInputItem =
	| {
			role: 'developer' | 'user';
			content: string | ResponsesInputContentPart[];
	  }
	| {
			type: 'message';
			role: 'assistant';
			status: 'completed';
			content: string | ResponsesInputContentPart[];
	  }
	| {
			type: 'function_call';
			call_id: string;
			name: string;
			arguments: string;
	  }
	| {
			type: 'function_call_output';
			call_id: string;
			output: string;
	  }
	| {
			type: 'reasoning';
			summary: [];
			content: [{ type: 'reasoning_text'; text: string }];
	  }
	| ResponsesMcpWireItem;

const MCP_CALL_INTERRUPTED = 'The call was interrupted before Pico reported its result.';
const MCP_CALL_DECLINED = 'The user declined this tool call.';

type ReportedOpenResponsesError = Error & {
	__openResponsesHandled?: boolean;
};

/**
 * OpenResponsesService - API communication layer for Open Responses API
 *
 * This service provides an alternative to ChatService, using OpenAI's newer
 * Responses API (v1/responses) instead of Chat Completions (v1/chat/completions).
 *
 * The Open Responses API has a different request/response format but this service
 * normalizes the output to match ChatService's callback interface for seamless
 * integration with the chat store.
 *
 * Key differences from Chat Completions:
 * - Uses `input` instead of `messages` array
 * - Different streaming event types
 * - Response content in `output[].content[].text` instead of `choices[].message.content`
 */
export class OpenResponsesService {
	/**
	 * Converts database messages to Responses API input format.
	 */
	static convertMessagesToInput(
		messages: ApiChatMessageData[] | (DatabaseMessage & { extra?: DatabaseMessageExtra[] })[],
		excludeReasoningContent = false
	): ResponsesInputItem[] {
		const input: ResponsesInputItem[] = [];

		// Pico resumes only the last turn: an assistant message with nothing but tool results after it
		let lastTurn = messages.length - 1;

		while (lastTurn >= 0 && messages[lastTurn].role === MessageRole.TOOL) lastTurn--;
		const pendingTurn = messages[lastTurn]?.role === MessageRole.ASSISTANT ? lastTurn : -1;
		const carriedOut = new Set(
			messages.flatMap((msg) =>
				OpenResponsesService.storedMcpItems(msg).flatMap((item) =>
					item.type === 'mcp_call' && item.approval_request_id ? [item.approval_request_id] : []
				)
			)
		);

		for (const [index, msg] of messages.entries()) {
			let role: string;
			let content: string | ResponsesInputContentPart[];
			let reasoningContent: string | undefined;
			let toolCalls: ApiChatCompletionToolCall[] = [];
			let mcpItems: ResponsesMcpItem[] = [];
			let toolCallId: string | undefined;

			if ('id' in msg && 'convId' in msg && 'timestamp' in msg) {
				const dbMsg = msg as DatabaseMessage & { extra?: DatabaseMessageExtra[] };

				role = dbMsg.role === MessageRole.SYSTEM ? 'developer' : dbMsg.role;
				reasoningContent = dbMsg.reasoningContent;
				toolCalls = splitStoredToolCalls(dbMsg.toolCalls).toolCalls;
				mcpItems = OpenResponsesService.storedMcpItems(dbMsg);
				toolCallId = dbMsg.toolCallId;

				if (!dbMsg.extra || dbMsg.extra.length === 0) {
					content = dbMsg.content;
				} else {
					content = OpenResponsesService.convertExtrasToContent(dbMsg);
				}
			} else {
				const apiMsg = msg as ApiChatMessageData;

				role = apiMsg.role === MessageRole.SYSTEM ? 'developer' : apiMsg.role;
				reasoningContent = apiMsg.reasoning_content;
				toolCalls = splitStoredToolCalls(apiMsg.tool_calls ?? []).toolCalls;
				mcpItems = OpenResponsesService.storedMcpItems(apiMsg);
				toolCallId = apiMsg.tool_call_id;

				if (typeof apiMsg.content === 'string' || apiMsg.content == null) {
					// a tool-only agentic turn carries no content
					content = apiMsg.content ?? '';
				} else {
					content = OpenResponsesService.convertApiContentParts(apiMsg.content);
				}
			}

			if (role === MessageRole.TOOL) {
				if (toolCallId) {
					input.push({
						call_id: toolCallId,
						output: OpenResponsesService.contentToText(content),
						type: 'function_call_output'
					});
				}

				continue;
			}

			if (role === MessageRole.ASSISTANT) {
				const reasoning: ResponsesInputItem[] =
					!excludeReasoningContent && reasoningContent?.trim()
						? [
								{
									content: [{ text: reasoningContent, type: 'reasoning_text' }],
									summary: [],
									type: 'reasoning'
								}
							]
						: [];

				// with Pico's items the turn ends on its calls, which a pending approval needs
				if (mcpItems.length > 0) {
					input.push(
						...reasoning,
						...OpenResponsesService.convertMcpTurn(
							content,
							mcpItems,
							index === pendingTurn ? null : carriedOut
						)
					);
				} else {
					input.push(
						{
							content: OpenResponsesService.convertAssistantContent(content),
							role: 'assistant',
							status: 'completed',
							type: 'message'
						},
						...reasoning
					);
				}

				for (const [index, toolCall] of toolCalls.entries()) {
					const callId = toolCall.id || `call_${input.length}_${index}`;

					input.push({
						arguments: OpenResponsesService.stringifyToolArguments(toolCall.function?.arguments),
						call_id: callId,
						name: OpenResponsesService.sanitizeToolName(toolCall.function?.name),
						type: 'function_call'
					});
				}

				continue;
			}

			if (role === 'developer' && typeof content === 'string' && !content.trim()) {
				continue;
			}

			input.push({ content, role: role === 'developer' ? 'developer' : 'user' });
		}

		return input;
	}

	/**
	 * Sends a message using the Responses API.
	 * Normalizes the response to match ChatService callback signatures.
	 */
	static async sendMessage(
		messages: ApiChatMessageData[] | (DatabaseMessage & { extra?: DatabaseMessageExtra[] })[],
		options: SettingsChatServiceOptions = {},
		conversationId?: string,
		signal?: AbortSignal
	): Promise<string | void> {
		const {
			backend_sampling,
			continueFinalMessage,
			custom,
			disableReasoningParsing,
			dry_allowed_length,
			dry_base,
			dry_multiplier,
			dry_penalty_last_n,
			dynatemp_exponent,
			dynatemp_range,
			enableThinking,
			excludeReasoningFromContext,
			frequency_penalty,
			max_tokens,
			min_p,
			onChunk,
			onComplete,
			onCompletionId,
			onConnectionState,
			onError,
			onMcpItems,
			onModel,
			onReasoningChunk,
			onReasoningEnd,
			onTimings,
			onToolCallChunk,
			picoMcpTool,
			presence_penalty,
			reasoningEffort,
			repeat_last_n,
			repeat_penalty,
			samplers,
			stream,
			temperature,
			thinkingBudgetTokens,
			timings_per_token,
			tools,
			top_k,
			top_p,
			typ_p,
			xtc_probability,
			xtc_threshold
		} = options;
		const shouldStream = stream ?? true;
		const input = OpenResponsesService.convertMessagesToInput(
			await OpenResponsesService.capImages(messages),
			excludeReasoningFromContext
		);
		const headers = getJsonHeaders();
		const requestBody: Record<string, unknown> = {
			input,
			store: false,
			stream: shouldStream
		};

		if (options.model) {
			requestBody.model = options.model;
		}

		if (temperature !== undefined) requestBody.temperature = temperature;

		if (max_tokens !== undefined) {
			requestBody.max_output_tokens = max_tokens !== null && max_tokens !== 0 ? max_tokens : -1;
		}

		if (dynatemp_range !== undefined) requestBody.dynatemp_range = dynatemp_range;

		if (dynatemp_exponent !== undefined) requestBody.dynatemp_exponent = dynatemp_exponent;

		if (top_k !== undefined) requestBody.top_k = top_k;

		if (top_p !== undefined) requestBody.top_p = top_p;

		if (min_p !== undefined) requestBody.min_p = min_p;

		if (xtc_probability !== undefined) requestBody.xtc_probability = xtc_probability;

		if (xtc_threshold !== undefined) requestBody.xtc_threshold = xtc_threshold;

		if (typ_p !== undefined) requestBody.typ_p = typ_p;

		if (repeat_last_n !== undefined) requestBody.repeat_last_n = repeat_last_n;

		if (repeat_penalty !== undefined) requestBody.repeat_penalty = repeat_penalty;

		if (presence_penalty !== undefined) requestBody.presence_penalty = presence_penalty;

		if (frequency_penalty !== undefined) requestBody.frequency_penalty = frequency_penalty;

		if (dry_multiplier !== undefined) requestBody.dry_multiplier = dry_multiplier;

		if (dry_base !== undefined) requestBody.dry_base = dry_base;

		if (dry_allowed_length !== undefined) requestBody.dry_allowed_length = dry_allowed_length;

		if (dry_penalty_last_n !== undefined) requestBody.dry_penalty_last_n = dry_penalty_last_n;

		if (samplers !== undefined) {
			requestBody.samplers =
				typeof samplers === 'string'
					? samplers.split(';').filter((sampler) => sampler.trim())
					: samplers;
		}

		if (backend_sampling !== undefined) requestBody.backend_sampling = backend_sampling;

		if (timings_per_token !== undefined) requestBody.timings_per_token = timings_per_token;

		if (thinkingBudgetTokens !== undefined)
			requestBody.thinking_budget_tokens = thinkingBudgetTokens;

		if (shouldStream) {
			requestBody.return_progress = true;
			requestBody.sse_ping_interval = 1;
		}

		requestBody.reasoning_control = true;

		if (continueFinalMessage) {
			requestBody.continue_final_message = true;
			requestBody.add_generation_prompt = false;
		}

		if (!disableReasoningParsing) {
			const effort =
				enableThinking === false || reasoningEffort === 'off'
					? 'none'
					: reasoningEffort && reasoningEffort !== 'default'
						? reasoningEffort
						: 'medium';

			requestBody.reasoning = { effort };
		}

		const requestTools: Array<Record<string, unknown> | ResponsesMcpTool> = (tools ?? []).map(
			(tool: OpenAIToolDefinition) => ({
				description: tool.function.description,
				name: tool.function.name,
				parameters: tool.function.parameters,
				type: tool.type
			})
		);
		// Pico offers its tools to a request that does not name them, so side requests name none
		const picoTool =
			picoMcpTool ??
			(serverStore.isPicoServer
				? ({
						allowed_tools: [],
						server_label: PICO_MCP.SERVER_LABEL,
						server_url: picoMcpUrl(),
						type: 'mcp'
					} satisfies ResponsesMcpTool)
				: undefined);

		if (picoTool) requestTools.push(picoTool);

		if (requestTools.length > 0) requestBody.tools = requestTools;

		if (custom) {
			try {
				const customParams = typeof custom === 'string' ? JSON.parse(custom) : custom;

				Object.assign(requestBody, customParams);
			} catch (error) {
				console.warn('Failed to parse custom parameters:', error);
			}
		}

		if (serverStore.isPicoServer && !serverStore.supportsModelSelection) {
			requestBody.model = modelsStore.activeModelId ?? undefined;
		}

		try {
			const response = await fetch(API_CHAT.RESPONSES, {
				body: JSON.stringify(requestBody),
				headers,
				method: 'POST',
				signal
			});

			if (!response.ok) {
				const error = await OpenResponsesService.parseErrorResponse(response);

				throw error;
			}

			if (shouldStream) {
				onConnectionState?.(StreamConnectionState.STREAMING);
				await OpenResponsesService.handleStreamResponse(
					response,
					onChunk,
					onComplete,
					onError,
					onReasoningChunk,
					onToolCallChunk,
					onModel,
					onCompletionId,
					onTimings,
					signal,
					onReasoningEnd,
					onMcpItems
				);

				return;
			} else {
				const result = await OpenResponsesService.handleNonStreamResponse(
					response,
					onComplete,
					onToolCallChunk,
					onModel,
					onCompletionId,
					onTimings,
					onMcpItems
				);

				return result;
			}
		} catch (error) {
			if (isAbortError(error)) {
				console.log('Responses API request was aborted');

				return;
			}

			const errorAlreadyHandled = OpenResponsesService.isHandledError(error);

			let userFriendlyError: Error;

			if (error instanceof Error) {
				if (error.name === 'TypeError' && error.message.includes('fetch')) {
					userFriendlyError = new Error(
						'Unable to connect to server - please check if the server is running'
					);
					userFriendlyError.name = 'NetworkError';
				} else if (error.message.includes('ECONNREFUSED')) {
					userFriendlyError = new Error('Connection refused - server may be offline');
					userFriendlyError.name = 'NetworkError';
				} else if (error.message.includes('ETIMEDOUT')) {
					userFriendlyError = new Error('Request timed out - the server took too long to respond');
					userFriendlyError.name = 'TimeoutError';
				} else {
					userFriendlyError = error;
				}
			} else {
				userFriendlyError = new Error('Unknown error occurred while sending message');
			}

			console.error('Error in OpenResponsesService.sendMessage:', error);

			if (onError && !errorAlreadyHandled) {
				onError(userFriendlyError);
			}

			throw userFriendlyError;
		}
	}

	private static abortError(message: string): Error {
		const error = new Error(message);

		error.name = 'AbortError';

		return error;
	}

	/**
	 * Caps each attached image at the maximum resolution in Settings, as Chat Completions does
	 * in `ChatService.convertDbMessageToApiChatMessageData`. Pico always uses Responses, so
	 * without this its images would go out at full resolution.
	 */
	private static async capImages(
		messages: ApiChatMessageData[] | (DatabaseMessage & { extra?: DatabaseMessageExtra[] })[]
	): Promise<typeof messages> {
		const maxImageResolution = settingsStore.getConfig(SETTINGS_KEYS.MAX_IMAGE_RESOLUTION);

		return (await Promise.all(
			(
				messages as Array<
					ApiChatMessageData | (DatabaseMessage & { extra?: DatabaseMessageExtra[] })
				>
			).map(async (msg) => {
				// Only stored messages keep their attachments as extras
				const extras = (msg as { extra?: DatabaseMessageExtra[] }).extra;

				if (!extras?.some((extra) => extra.type === AttachmentType.IMAGE)) return msg;

				const extra = await Promise.all(
					extras.map(async (extra) =>
						extra.type === AttachmentType.IMAGE
							? {
									...extra,
									base64Url: await capImageDataURLSize(
										(extra as DatabaseMessageExtraImageFile).base64Url,
										maxImageResolution
									)
								}
							: extra
					)
				);

				return { ...msg, extra };
			})
		)) as typeof messages;
	}

	private static completionReason(response: Record<string, unknown>, toolCalls?: string): string {
		const reason = OpenResponsesService.incompleteReason(response);

		if (reason === 'max_output_tokens') return 'length';

		return reason ?? (toolCalls ? 'tool_calls' : 'stop');
	}

	private static contentToText(content: string | ResponsesInputContentPart[]): string {
		if (typeof content === 'string') {
			return content;
		}

		return content.map((part) => part.text || '').join('');
	}

	/**
	 * Converts API content parts to Responses API format.
	 */
	private static convertApiContentParts(parts: ApiChatMessageContentPart[]): Array<{
		type: string;
		text?: string;
		image_url?: string;
		input_audio?: { data: string; format: string };
		input_video?: { data: string; format: string };
	}> {
		return parts.map((part) => {
			if (part.type === 'text') {
				return { text: part.text, type: 'input_text' };
			} else if (part.type === 'image_url') {
				return { image_url: part.image_url?.url, type: 'input_image' };
			} else if (part.type === 'input_audio') {
				return {
					input_audio: {
						data: part.input_audio?.data || '',
						format: part.input_audio?.format || 'wav'
					},
					type: 'input_audio'
				};
			} else if (part.type === 'input_video') {
				return {
					input_video: {
						data: part.input_video?.data || '',
						format: part.input_video?.format || 'auto'
					},
					type: 'input_video'
				};
			}

			return { text: '', type: 'input_text' };
		});
	}

	private static convertAssistantContent(
		content: string | ResponsesInputContentPart[]
	): string | ResponsesInputContentPart[] {
		if (typeof content === 'string') {
			return OpenResponsesService.stripLegacyAgenticMarkers(content);
		}

		return content
			.filter((part) => typeof part.text === 'string')
			.map((part) => ({
				text: OpenResponsesService.stripLegacyAgenticMarkers(part.text || ''),
				type: 'output_text'
			}));
	}

	/**
	 * Converts database message extras to Responses API content format.
	 */
	private static convertExtrasToContent(
		message: DatabaseMessage & { extra?: DatabaseMessageExtra[] }
	): ResponsesInputContentPart[] {
		const contentParts: ResponsesInputContentPart[] = [];

		if (message.content) {
			contentParts.push({ text: message.content, type: 'input_text' });
		}

		if (!message.extra) return contentParts;

		for (const extra of message.extra) {
			if (extra.type === AttachmentType.IMAGE) {
				const imageExtra = extra as DatabaseMessageExtraImageFile;

				contentParts.push({ image_url: imageExtra.base64Url, type: 'input_image' });
			} else if (extra.type === AttachmentType.TEXT) {
				const textExtra = extra as DatabaseMessageExtraTextFile;

				contentParts.push({
					text: `\n\n--- File: ${textExtra.name} ---\n${textExtra.content}`,
					type: 'input_text'
				});
			} else if (extra.type === AttachmentType.LEGACY_CONTEXT) {
				const legacyExtra = extra as DatabaseMessageExtraLegacyContext;

				contentParts.push({
					text: `\n\n--- File: ${legacyExtra.name} ---\n${legacyExtra.content}`,
					type: 'input_text'
				});
			} else if (extra.type === AttachmentType.AUDIO) {
				const audioExtra = extra as DatabaseMessageExtraAudioFile;

				contentParts.push({
					input_audio: {
						data: audioExtra.base64Data,
						format: audioExtra.mimeType.includes('wav') ? 'wav' : 'mp3'
					},
					type: 'input_audio'
				});
			} else if (extra.type === AttachmentType.VIDEO) {
				const videoExtra = extra as DatabaseMessageExtraVideoFile;

				contentParts.push({
					input_video: {
						data: videoExtra.base64Data,
						format: videoExtra.mimeType.includes('mp4')
							? 'mp4'
							: videoExtra.mimeType.includes('ogg')
								? 'ogg'
								: 'auto'
					},
					type: 'input_video'
				});
			} else if (extra.type === AttachmentType.PDF) {
				const pdfExtra = extra as DatabaseMessageExtraPdfFile;

				if (pdfExtra.processedAsImages && pdfExtra.images) {
					for (const imageUrl of pdfExtra.images) {
						contentParts.push({ image_url: imageUrl, type: 'input_image' });
					}
				} else {
					contentParts.push({
						text: `\n\n--- PDF File: ${pdfExtra.name} ---\n${pdfExtra.content}`,
						type: 'input_text'
					});
				}
			} else if (extra.type === AttachmentType.MCP_PROMPT) {
				const promptExtra = extra as DatabaseMessageExtraMcpPrompt;

				contentParts.push({
					text: `\n\n--- MCP Prompt: ${promptExtra.name} (${promptExtra.serverName}) ---\n${promptExtra.content}`,
					type: 'input_text'
				});
			} else if (extra.type === AttachmentType.MCP_RESOURCE) {
				const resourceExtra = extra as DatabaseMessageExtraMcpResource;

				contentParts.push({
					text: `\n\n--- MCP Resource: ${resourceExtra.name} (${resourceExtra.serverName}) ---\n${resourceExtra.content}`,
					type: 'input_text'
				});
			}
		}

		return contentParts;
	}

	/**
	 * An assistant message with Pico's MCP items, as input items in the model's order.
	 * Each approval request goes out with its response, or with a denial when the user moved on without one.
	 * A call cut off before its result goes out as failed.
	 * Pico resumes only the last turn, so an earlier approval that no call carried out gets a failed call that closes it.
	 *
	 * @param closeApprovals - for an earlier turn, the approval ids some `mcp_call` carries out
	 */
	private static convertMcpTurn(
		content: string | ResponsesInputContentPart[],
		items: ResponsesMcpItem[],
		closeApprovals: ReadonlySet<string> | null
	): ResponsesInputItem[] {
		const input: ResponsesInputItem[] = [];
		const text = OpenResponsesService.contentToText(content);
		const requestIds = new Set(
			items.flatMap((item) => (item.type === 'mcp_approval_request' ? [item.id] : []))
		);
		const responses = new Map(
			items.flatMap((item) =>
				item.type === 'mcp_approval_response' ? [[item.approval_request_id, item] as const] : []
			)
		);
		const withoutOffset = ({ content_offset: _offset, ...item }: ResponsesMcpItem) =>
			item as ResponsesMcpWireItem;

		for (const run of mcpItemRuns(text, items)) {
			if (run.text.trim()) {
				input.push({
					content: OpenResponsesService.convertAssistantContent(run.text),
					role: 'assistant',
					status: 'completed',
					type: 'message'
				});
			}

			for (const item of run.items) {
				if (item.type === 'mcp_approval_response' && requestIds.has(item.approval_request_id)) {
					continue;
				}

				if (item.type === 'mcp_call' && item.output == null && item.error == null) {
					input.push({
						...(withoutOffset(item) as ResponsesMcpCallItem),
						error: MCP_CALL_INTERRUPTED,
						status: 'failed'
					});

					continue;
				}

				input.push(withoutOffset(item));

				if (item.type === 'mcp_approval_request') {
					const response = responses.get(item.id);
					const approve = response?.approve ?? false;

					input.push(
						response
							? withoutOffset(response)
							: { approval_request_id: item.id, approve, type: 'mcp_approval_response' }
					);

					if (closeApprovals && !closeApprovals.has(item.id)) {
						input.push({
							approval_request_id: item.id,
							arguments: item.arguments,
							error: approve ? MCP_CALL_INTERRUPTED : MCP_CALL_DECLINED,
							id: `mcp_${item.id}`,
							name: item.name,
							output: null,
							server_label: item.server_label,
							status: 'failed',
							type: 'mcp_call'
						});
					}
				}
			}
		}

		return input;
	}

	/**
	 * Converts Responses API usage to ChatMessageTimings format.
	 */
	private static convertUsageToTimings(usage: {
		input_tokens?: number;
		output_tokens?: number;
		total_tokens?: number;
		input_tokens_details?: { cached_tokens?: number };
		output_tokens_details?: { reasoning_tokens?: number };
		prompt_time_ms?: number;
		generation_time_ms?: number;
	}): ChatMessageTimings {
		return {
			cache_n: usage.input_tokens_details?.cached_tokens || 0,
			predicted_ms: usage.generation_time_ms,
			predicted_n: usage.output_tokens || 0,
			prompt_ms: usage.prompt_time_ms,
			prompt_n: usage.input_tokens || 0
		};
	}

	private static functionCallName(item?: OpenResponsesOutputItem): string {
		return OpenResponsesService.sanitizeToolName(item?.name || item?.function?.name);
	}

	/**
	 * Handles non-streaming response from the Responses API.
	 */
	private static async handleNonStreamResponse(
		response: Response,
		onComplete?: (
			response: string,
			reasoningContent?: string,
			timings?: ChatMessageTimings,
			toolCalls?: string,
			finishReason?: string
		) => void,
		onToolCallChunk?: (chunk: string) => void,
		onModel?: (model: string) => void,
		onCompletionId?: (id: string) => void,
		onTimings?: (timings?: ChatMessageTimings, promptProgress?: ChatMessagePromptProgress) => void,
		onMcpItems?: (items: ResponsesMcpItem[]) => void
	): Promise<string> {
		try {
			const responseText = await response.text();

			if (!responseText.trim()) {
				const noResponseError = new Error('No response received from server. Please try again.');

				throw noResponseError;
			}

			const data = JSON.parse(responseText);

			if (data.model) {
				onModel?.(data.model);
			}

			if (data.id) {
				onCompletionId?.(data.id);
			}

			let content = '';
			let reasoningContent = '';

			const toolCalls: ApiChatCompletionToolCall[] = [];
			const completedToolCallIds = new Set<string>();
			const mcpItems: ResponsesMcpItem[] = [];

			if (data.output && Array.isArray(data.output)) {
				for (const item of data.output) {
					if (isMcpItem(item)) {
						mcpItems.push({ ...item, content_offset: content.length });
					}

					if (item.type === 'function_call') {
						toolCalls.push({
							function: {
								arguments: OpenResponsesService.stringifyToolArguments(item.arguments),
								name: OpenResponsesService.functionCallName(item)
							},
							id: OpenResponsesService.outputItemCallId(item) || item.id,
							index: toolCalls.length,
							type: 'function'
						});
					}

					if (item.type === 'function_call_output') {
						const callId = OpenResponsesService.outputItemCallId(item);

						if (callId) completedToolCallIds.add(callId);
					}

					if (item.type === 'message' && item.content) {
						for (const contentItem of item.content) {
							if (contentItem.type === 'output_text') {
								content += contentItem.text || '';
							}
						}
					}

					if (item.type === 'reasoning') {
						let summaryText = '';
						let rawReasoningText = '';

						for (const summaryItem of item.summary || []) {
							if (
								summaryItem.type === 'summary_text' ||
								summaryItem.type === 'reasoning_summary_text'
							) {
								summaryText += summaryItem.text || '';
							}
						}
						for (const contentItem of item.content || []) {
							if (
								contentItem.type === 'reasoning_text' ||
								contentItem.type === 'reasoning_summary_text'
							) {
								rawReasoningText += contentItem.text || '';
							}
						}
						const reasoningText = summaryText || rawReasoningText;

						if (reasoningText) {
							reasoningContent += reasoningText;
						}
					}
				}
			}

			if (
				!content.trim() &&
				toolCalls.length === 0 &&
				mcpItems.length === 0 &&
				!reasoningContent.trim()
			) {
				const noResponseError = new Error('No response received from server. Please try again.');

				throw noResponseError;
			}

			if (mcpItems.length > 0) onMcpItems?.(mcpItems);

			const timings = data.timings
				? (data.timings as ChatMessageTimings)
				: data.usage
					? OpenResponsesService.convertUsageToTimings(data.usage)
					: undefined;

			if (data.usage && import.meta.env.DEV) {
				console.log('[OpenResponses] response usage:', data.usage);
				console.log('[OpenResponses] mapped timings:', timings);
			}

			const pendingToolCalls = toolCalls.filter(
				(toolCall) => !toolCall.id || !completedToolCallIds.has(toolCall.id)
			);
			const serializedToolCalls = pendingToolCalls.length
				? JSON.stringify(pendingToolCalls)
				: undefined;

			if (serializedToolCalls) onToolCallChunk?.(serializedToolCalls);

			if (timings) onTimings?.(timings, undefined);

			onComplete?.(
				content,
				reasoningContent || undefined,
				timings,
				serializedToolCalls,
				OpenResponsesService.completionReason(data, serializedToolCalls)
			);

			return content;
		} catch (error) {
			throw error instanceof Error ? error : new Error('Parse error');
		}
	}

	/**
	 * Handles streaming response from the Responses API.
	 * Parses SSE events and normalizes to ChatService callback format.
	 */
	private static async handleStreamResponse(
		response: Response,
		onChunk?: (chunk: string) => void,
		onComplete?: (
			response: string,
			reasoningContent?: string,
			timings?: ChatMessageTimings,
			toolCalls?: string,
			finishReason?: string
		) => void,
		onError?: (error: Error) => void,
		onReasoningChunk?: (chunk: string) => void,
		onToolCallChunk?: (chunk: string) => void,
		onModel?: (model: string) => void,
		onCompletionId?: (id: string) => void,
		onTimings?: (timings?: ChatMessageTimings, promptProgress?: ChatMessagePromptProgress) => void,
		abortSignal?: AbortSignal,
		onReasoningEnd?: () => void,
		onMcpItems?: (items: ResponsesMcpItem[]) => void
	): Promise<void> {
		const reader = response.body?.getReader();

		if (!reader) {
			throw new Error('No response body');
		}

		const decoder = new TextDecoder();

		let aggregatedContent = '';
		let fullReasoningContent = '';
		let lastTimings: ChatMessageTimings | undefined;

		const reasoningTiming = IS_PICO_BUILD ? createReasoningTiming(true, onReasoningEnd) : undefined;
		const finishReasoning = () => {
			if (!reasoningTiming) return;

			const timings = reasoningTiming.finish(lastTimings);

			if (timings?.reasoning_ms !== lastTimings?.reasoning_ms) {
				lastTimings = timings;
				onTimings?.(timings);
			}
		};

		let terminalResponse: Record<string, unknown> = {};
		let modelEmitted = false;
		let idEmitted = false;
		let reasoningSummarySeen = false;

		const functionCalls = new Map<string, StreamingFunctionCallState>();
		const functionCallIdsByItemId = new Map<string, string>();
		// Pico's MCP items by item id, in output order; calls whose arguments streamed in deltas
		const mcpItems = new Map<string, ResponsesMcpItem>();
		const mcpArgumentsStreamed = new Set<string>();

		let currentFunctionCallId: string | null = null;

		const setMcpItem = (id: string, item: ResponsesMcpItem): void => {
			mcpItems.set(id, item);

			if (!abortSignal?.aborted) onMcpItems?.([...mcpItems.values()]);
		};
		const updateMcpCall = (
			id: unknown,
			update: (item: Extract<ResponsesMcpItem, { type: 'mcp_call' }>) => Partial<ResponsesMcpItem>
		): void => {
			const item = typeof id === 'string' ? mcpItems.get(id) : undefined;

			if (item?.type === 'mcp_call') {
				setMcpItem(item.id, { ...item, ...update(item) } as ResponsesMcpItem);
			}
		};
		const emitContentChunk = (chunk: string): void => {
			if (!chunk) return;

			aggregatedContent += chunk;

			if (!abortSignal?.aborted) {
				onChunk?.(chunk);
			}
		};
		const closeFunctionCallArgumentsIfNeeded = (callId: string | null): void => {
			if (!callId) return;

			const functionCall = functionCalls.get(callId);

			if (!functionCall || functionCall.argumentsClosed) {
				return;
			}

			functionCall.argumentsClosed = true;
		};
		const closeFunctionCallIfNeeded = (callId: string | null): void => {
			if (!callId) return;

			const functionCall = functionCalls.get(callId);

			if (!functionCall) {
				return;
			}

			closeFunctionCallArgumentsIfNeeded(callId);

			if (currentFunctionCallId === callId) {
				currentFunctionCallId = null;
			}
		};
		const closeOpenFunctionCallsForNextContentIfNeeded = (): void => {
			if (!currentFunctionCallId) {
				return;
			}

			closeFunctionCallIfNeeded(currentFunctionCallId);
		};
		const closeOpenFunctionCallsAtTerminalIfNeeded = (): void => {
			if (!currentFunctionCallId) {
				return;
			}

			const functionCall = functionCalls.get(currentFunctionCallId);

			if (!functionCall) {
				currentFunctionCallId = null;

				return;
			}

			closeFunctionCallArgumentsIfNeeded(currentFunctionCallId);

			if (functionCall.hasOutput) {
				closeFunctionCallIfNeeded(currentFunctionCallId);

				return;
			}

			currentFunctionCallId = null;
		};

		try {
			let buffer = '';

			while (true) {
				if (abortSignal?.aborted) break;

				const { done, value } = await reader.read();

				if (done) break;

				if (abortSignal?.aborted) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');

				buffer = lines.pop() || '';

				for (const line of lines) {
					if (abortSignal?.aborted) break;

					if (line.startsWith('event: ')) {
						continue;
					}

					if (line.startsWith('data: ')) {
						const data = line.slice(6);

						if (data === '[DONE]') {
							continue;
						}

						try {
							const parsed = JSON.parse(data);
							const eventType = parsed.type;

							if (parsed.model && !modelEmitted) {
								modelEmitted = true;
								onModel?.(parsed.model);
							}

							const responseData = OpenResponsesService.isRecord(parsed.response)
								? parsed.response
								: parsed;
							const responseId = OpenResponsesService.stringField(responseData, 'id');

							if (responseId && !idEmitted) {
								idEmitted = true;
								onCompletionId?.(responseId);
							}

							const reasoningDelta =
								Boolean(parsed.delta) &&
								(eventType === 'response.reasoning_summary_text.delta' ||
									(!reasoningSummarySeen &&
										(eventType === 'response.reasoning.delta' ||
											eventType === 'response.reasoning_text.delta')));
							const reasoningEnded =
								(eventType === 'response.output_text.delta' && Boolean(parsed.delta)) ||
								(eventType === 'response.output_item.added' &&
									(OpenResponsesService.isFunctionCallItem(parsed.item) ||
										isMcpItem(parsed.item))) ||
								[
									'response.reasoning_text.done',
									'response.reasoning_summary_text.done',
									'response.completed',
									'response.done',
									'response.incomplete',
									'response.failed',
									'error'
								].includes(eventType);
							const measuredTimings = reasoningTiming?.update(
								reasoningDelta,
								reasoningEnded,
								parsed.timings as ChatMessageTimings | undefined
							);
							const timings = measuredTimings
								? { ...lastTimings, ...measuredTimings }
								: parsed.timings;

							if (parsed.prompt_progress || timings) {
								if (timings) lastTimings = timings as ChatMessageTimings;

								onTimings?.(
									timings as ChatMessageTimings | undefined,
									parsed.prompt_progress as ChatMessagePromptProgress | undefined
								);
							}

							if (eventType === 'error' || eventType === 'response.failed') {
								closeOpenFunctionCallsAtTerminalIfNeeded();
								const handledError = OpenResponsesService.markErrorHandled(
									OpenResponsesService.streamTerminalError(parsed)
								);

								onError?.(handledError);

								throw handledError;
							}

							if (eventType === 'response.incomplete') {
								terminalResponse = responseData;
								closeOpenFunctionCallsAtTerminalIfNeeded();

								if (OpenResponsesService.incompleteReason(parsed) === 'cancelled') {
									throw OpenResponsesService.abortError('Generation cancelled');
								}
							}

							if (eventType === 'response.output_text.delta') {
								const delta = parsed.delta || '';

								if (delta) {
									closeOpenFunctionCallsForNextContentIfNeeded();
									emitContentChunk(delta);
								}
							}

							if (eventType === 'response.reasoning_summary_text.delta') {
								const delta = parsed.delta || '';

								if (delta) {
									closeOpenFunctionCallsForNextContentIfNeeded();
									reasoningSummarySeen = true;
									fullReasoningContent += delta;

									if (!abortSignal?.aborted) {
										onReasoningChunk?.(delta);
									}
								}
							}

							if (eventType === 'response.reasoning.delta') {
								const delta = parsed.delta || '';

								// Prefer summaries when available; many local models only emit reasoning deltas.
								if (delta && !reasoningSummarySeen) {
									closeOpenFunctionCallsForNextContentIfNeeded();
									fullReasoningContent += delta;

									if (!abortSignal?.aborted) {
										onReasoningChunk?.(delta);
									}
								}
							}

							if (eventType === 'response.reasoning_text.delta') {
								const delta = parsed.delta || '';

								if (delta && !reasoningSummarySeen) {
									fullReasoningContent += delta;

									if (!abortSignal?.aborted) onReasoningChunk?.(delta);
								}
							}

							if (eventType === 'response.output_item.added') {
								const item = parsed.item;

								if (isMcpItem(item) && typeof item.id === 'string' && item.id) {
									setMcpItem(item.id, { ...item, content_offset: aggregatedContent.length });
								}

								if (OpenResponsesService.isFunctionCallItem(item)) {
									const callId =
										OpenResponsesService.outputItemCallId(item) ||
										(typeof item.id === 'string' ? item.id : `call_${functionCalls.size}`);
									const itemId =
										typeof item.id === 'string' && item.id.length > 0
											? item.id
											: `fc_${functionCalls.size}`;

									closeOpenFunctionCallsForNextContentIfNeeded();
									functionCalls.set(callId, {
										arguments: OpenResponsesService.stringifyToolArguments(item.arguments),
										argumentsClosed: false,
										callId,
										hasArguments: false,
										hasOutput: false,
										index: functionCalls.size,
										itemId,
										name: OpenResponsesService.functionCallName(item)
									});
									functionCallIdsByItemId.set(itemId, callId);
									currentFunctionCallId = callId;
									onToolCallChunk?.(OpenResponsesService.serializeToolCalls(functionCalls));
								}

								if (OpenResponsesService.isFunctionCallOutputItem(item)) {
									const callId: string | null =
										OpenResponsesService.outputItemCallId(item) || currentFunctionCallId;

									if (callId) {
										const functionCall = functionCalls.get(callId);

										if (functionCall) {
											functionCall.hasOutput = true;
											currentFunctionCallId = callId;
											closeFunctionCallArgumentsIfNeeded(callId);
											onToolCallChunk?.(
												OpenResponsesService.serializeToolCalls(functionCalls, true)
											);
										}
									}
								}
							}

							if (eventType === 'response.mcp_call_arguments.delta' && parsed.delta) {
								updateMcpCall(parsed.item_id, (item) => {
									const streamed = mcpArgumentsStreamed.has(item.id);

									mcpArgumentsStreamed.add(item.id);

									return { arguments: (streamed ? item.arguments : '') + parsed.delta };
								});
							}

							if (
								eventType === 'response.mcp_call_arguments.done' &&
								typeof parsed.arguments === 'string'
							) {
								updateMcpCall(parsed.item_id, () => ({ arguments: parsed.arguments }));
							}

							if (eventType === 'response.mcp_call.in_progress') {
								updateMcpCall(parsed.item_id, () => ({ status: 'in_progress' }));
							}

							if (eventType === 'response.mcp_call.completed') {
								updateMcpCall(parsed.item_id, () => ({ status: 'completed' }));
							}

							if (eventType === 'response.mcp_call.failed') {
								updateMcpCall(parsed.item_id, () => ({ status: 'failed' }));
							}

							if (eventType === 'response.function_call_arguments.delta') {
								const delta = parsed.delta || '';
								const itemId = typeof parsed.item_id === 'string' ? parsed.item_id : undefined;
								const callId =
									(itemId ? functionCallIdsByItemId.get(itemId) : undefined) ||
									currentFunctionCallId;

								if (delta && callId) {
									const functionCall = functionCalls.get(callId);

									if (functionCall) {
										functionCall.hasArguments = true;
										functionCall.arguments += delta;
									}

									onToolCallChunk?.(OpenResponsesService.serializeToolCalls(functionCalls));
								}
							}

							if (eventType === 'response.function_call_arguments.done') {
								const itemId = typeof parsed.item_id === 'string' ? parsed.item_id : undefined;
								const callId =
									(itemId ? functionCallIdsByItemId.get(itemId) : undefined) ||
									currentFunctionCallId;

								if (callId) {
									const functionCall = functionCalls.get(callId);
									const argumentsText = OpenResponsesService.stringifyToolArguments(
										parsed.arguments
									);

									if (functionCall && !functionCall.hasArguments && argumentsText) {
										functionCall.hasArguments = true;
										functionCall.arguments = argumentsText;
									}

									closeFunctionCallArgumentsIfNeeded(callId);
									onToolCallChunk?.(OpenResponsesService.serializeToolCalls(functionCalls));
								}
							}

							if (eventType === 'response.output_item.done') {
								const item = parsed.item;

								if (isMcpItem(item) && typeof item.id === 'string' && item.id) {
									setMcpItem(item.id, {
										...item,
										content_offset:
											mcpItems.get(item.id)?.content_offset ?? aggregatedContent.length
									});
								}

								if (OpenResponsesService.isFunctionCallItem(item)) {
									const callId =
										OpenResponsesService.outputItemCallId(item) || currentFunctionCallId;
									const functionCall = callId ? functionCalls.get(callId) : undefined;

									if (functionCall) {
										functionCall.name = OpenResponsesService.functionCallName(item);
										const completedArguments = OpenResponsesService.stringifyToolArguments(
											item.arguments
										);

										if (completedArguments || !functionCall.hasArguments) {
											functionCall.arguments = completedArguments;
										}

										functionCall.hasArguments = Boolean(functionCall.arguments);
										onToolCallChunk?.(OpenResponsesService.serializeToolCalls(functionCalls));
									}

									closeFunctionCallIfNeeded(callId);
								}

								if (OpenResponsesService.isFunctionCallOutputItem(item)) {
									const callId =
										OpenResponsesService.outputItemCallId(item) || currentFunctionCallId;
									const functionCall = callId ? functionCalls.get(callId) : undefined;

									if (functionCall) {
										functionCall.hasOutput = true;
										onToolCallChunk?.(OpenResponsesService.serializeToolCalls(functionCalls, true));
									}

									closeFunctionCallIfNeeded(callId);
								}
							}

							if (eventType === 'response.completed' || eventType === 'response.done') {
								closeOpenFunctionCallsAtTerminalIfNeeded();
								const responseData = parsed.response || parsed;

								terminalResponse = responseData;

								if (!parsed.timings && responseData.usage) {
									lastTimings = reasoningTiming
										? reasoningTiming.apply(
												OpenResponsesService.convertUsageToTimings(responseData.usage)
											)
										: OpenResponsesService.convertUsageToTimings(responseData.usage);

									if (import.meta.env.DEV) {
										console.log('[OpenResponses] response.completed usage:', responseData.usage);
										console.log('[OpenResponses] mapped timings:', lastTimings);
									}

									onTimings?.(lastTimings, undefined);
								}

								if (responseData.model && !modelEmitted) {
									modelEmitted = true;
									onModel?.(responseData.model);
								}
							}
						} catch (e) {
							if (
								(e instanceof Error && OpenResponsesService.isHandledError(e)) ||
								(e instanceof Error && e.name === 'AbortError')
							) {
								throw e;
							}

							console.error('Error parsing Responses API JSON chunk:', e);
						}
					}
				}

				if (abortSignal?.aborted) break;
			}

			finishReasoning();

			if (abortSignal?.aborted) return;

			closeOpenFunctionCallsAtTerminalIfNeeded();
			const pendingToolCalls = OpenResponsesService.serializeToolCalls(functionCalls, true);
			const serializedToolCalls = pendingToolCalls === '[]' ? undefined : pendingToolCalls;

			onComplete?.(
				aggregatedContent,
				fullReasoningContent || undefined,
				lastTimings,
				serializedToolCalls,
				OpenResponsesService.completionReason(terminalResponse, serializedToolCalls)
			);
		} catch (error) {
			finishReasoning();

			throw error instanceof Error ? error : new Error('Stream error');
		} finally {
			reader.releaseLock();
		}
	}

	private static incompleteReason(parsed: Record<string, unknown>): string | undefined {
		const response = OpenResponsesService.isRecord(parsed.response) ? parsed.response : undefined;
		const details = OpenResponsesService.isRecord(response?.incomplete_details)
			? response.incomplete_details
			: OpenResponsesService.isRecord(parsed.incomplete_details)
				? parsed.incomplete_details
				: undefined;

		return (
			OpenResponsesService.stringField(details, 'reason') ||
			OpenResponsesService.stringField(details, 'type')
		);
	}

	private static isFunctionCallItem(item: unknown): item is OpenResponsesOutputItem {
		return Boolean(
			item && typeof item === 'object' && (item as OpenResponsesOutputItem).type === 'function_call'
		);
	}

	private static isFunctionCallOutputItem(item: unknown): item is OpenResponsesOutputItem {
		return Boolean(
			item &&
			typeof item === 'object' &&
			(item as OpenResponsesOutputItem).type === 'function_call_output'
		);
	}

	private static isHandledError(error: unknown): error is ReportedOpenResponsesError {
		return (
			error instanceof Error &&
			(error as ReportedOpenResponsesError).__openResponsesHandled === true
		);
	}

	private static isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}

	private static markErrorHandled(error: Error): ReportedOpenResponsesError {
		const handledError = error as ReportedOpenResponsesError;

		handledError.__openResponsesHandled = true;

		return handledError;
	}

	private static outputItemCallId(item?: OpenResponsesOutputItem): string | undefined {
		return item?.callId || item?.call_id;
	}

	/**
	 * Parses error response from Responses API.
	 */
	private static async parseErrorResponse(response: Response): Promise<Error> {
		try {
			const errorText = await response.text();
			const errorData = JSON.parse(errorText);
			const message = errorData.error?.message || 'Unknown server error';
			const error = new Error(message);

			error.name = response.status === 400 ? 'ServerError' : 'HttpError';

			return error;
		} catch {
			const fallback = new Error(`Server error (${response.status}): ${response.statusText}`);

			fallback.name = 'HttpError';

			return fallback;
		}
	}

	private static sanitizeToolName(name?: string): string {
		return name?.trim() || 'Tool';
	}

	private static serializeToolCalls(
		functionCalls: Map<string, StreamingFunctionCallState>,
		pendingOnly = false
	): string {
		const toolCalls: ApiChatCompletionToolCall[] = Array.from(functionCalls.values())
			.filter((call) => !pendingOnly || !call.hasOutput)
			.sort((a, b) => a.index - b.index)
			.map((call) => ({
				function: { arguments: call.arguments, name: call.name },
				id: call.callId,
				index: call.index,
				type: 'function'
			}));

		return JSON.stringify(toolCalls);
	}

	/** Pico's MCP items of a stored or API message, next to its function calls */
	private static storedMcpItems(
		msg: ApiChatMessageData | (DatabaseMessage & { extra?: DatabaseMessageExtra[] })
	): ResponsesMcpItem[] {
		if ('id' in msg && 'convId' in msg && 'timestamp' in msg) {
			return splitStoredToolCalls(msg.toolCalls).mcpItems;
		}

		const api = msg as ApiChatMessageData;

		return [...(api.mcp_items ?? []), ...splitStoredToolCalls(api.tool_calls ?? []).mcpItems];
	}

	private static streamTerminalError(parsed: Record<string, unknown>): Error {
		const nestedError = OpenResponsesService.isRecord(parsed.error) ? parsed.error : undefined;
		const response = OpenResponsesService.isRecord(parsed.response) ? parsed.response : undefined;
		const responseError = OpenResponsesService.isRecord(response?.error)
			? response.error
			: undefined;
		const message =
			OpenResponsesService.stringField(responseError, 'message') ||
			OpenResponsesService.stringField(nestedError, 'message') ||
			OpenResponsesService.stringField(parsed, 'message') ||
			'Unknown server error';
		const code =
			OpenResponsesService.stringField(responseError, 'code') ||
			OpenResponsesService.stringField(nestedError, 'code') ||
			OpenResponsesService.stringField(parsed, 'code');
		const error = new Error(message);

		if (code) {
			error.name = code;
		}

		return error;
	}

	private static stringField(
		record: Record<string, unknown> | null | undefined,
		key: string
	): string | undefined {
		const value = record?.[key];

		return typeof value === 'string' && value.length > 0 ? value : undefined;
	}

	private static stringifyToolArguments(argumentsValue: unknown): string {
		if (typeof argumentsValue === 'string') {
			return argumentsValue;
		}

		if (argumentsValue == null) {
			return '';
		}

		try {
			return JSON.stringify(argumentsValue);
		} catch {
			return String(argumentsValue);
		}
	}

	private static stripLegacyAgenticMarkers(content: string): string {
		return content
			.replace(AGENTIC_REGEX.REASONING_BLOCK, '')
			.replace(AGENTIC_REGEX.REASONING_OPEN, '')
			.replace(AGENTIC_REGEX.AGENTIC_TOOL_CALL_BLOCK, '')
			.replace(AGENTIC_REGEX.AGENTIC_TOOL_CALL_OPEN, '');
	}
}
