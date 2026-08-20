import { API_CHAT, LEGACY_AGENTIC_REGEX as AGENTIC_REGEX } from '$lib/constants';
import { AttachmentType, MessageRole, StreamConnectionState } from '$lib/enums';
import type {
	ApiChatCompletionToolCall,
	DatabaseMessageExtraMcpPrompt,
	DatabaseMessageExtraMcpResource,
	OpenAIToolDefinition
} from '$lib/types';
import { isAbortError } from '$lib/utils/abort';
import { getJsonHeaders } from '$lib/utils/api-headers';

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
	  };

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
	private static sanitizeToolName(name?: string): string {
		return name?.trim() || 'Tool';
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

	private static functionCallName(item?: OpenResponsesOutputItem): string {
		return OpenResponsesService.sanitizeToolName(item?.name || item?.function?.name);
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

	private static outputItemCallId(item?: OpenResponsesOutputItem): string | undefined {
		return item?.callId || item?.call_id;
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

	private static parseToolCalls(value: unknown): ApiChatCompletionToolCall[] {
		if (Array.isArray(value)) {
			return value as ApiChatCompletionToolCall[];
		}

		if (typeof value !== 'string' || !value.trim()) {
			return [];
		}

		try {
			const parsed = JSON.parse(value);

			return Array.isArray(parsed) ? (parsed as ApiChatCompletionToolCall[]) : [];
		} catch {
			return [];
		}
	}

	private static stripLegacyAgenticMarkers(content: string): string {
		return content
			.replace(AGENTIC_REGEX.REASONING_BLOCK, '')
			.replace(AGENTIC_REGEX.REASONING_OPEN, '')
			.replace(AGENTIC_REGEX.AGENTIC_TOOL_CALL_BLOCK, '')
			.replace(AGENTIC_REGEX.AGENTIC_TOOL_CALL_OPEN, '');
	}

	private static isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}

	private static stringField(
		record: Record<string, unknown> | null | undefined,
		key: string
	): string | undefined {
		const value = record?.[key];

		return typeof value === 'string' && value.length > 0 ? value : undefined;
	}

	private static markErrorHandled(error: Error): ReportedOpenResponsesError {
		const handledError = error as ReportedOpenResponsesError;

		handledError.__openResponsesHandled = true;

		return handledError;
	}

	private static isHandledError(error: unknown): error is ReportedOpenResponsesError {
		return (
			error instanceof Error &&
			(error as ReportedOpenResponsesError).__openResponsesHandled === true
		);
	}

	private static abortError(message: string): Error {
		const error = new Error(message);

		error.name = 'AbortError';

		return error;
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
			onModel,
			onReasoningChunk,
			onTimings,
			onToolCallChunk,
			presence_penalty,
			reasoningEffort,
			repeat_last_n,
			repeat_penalty,
			samplers,
			stream,
			temperature,
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
			messages,
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

		if (tools?.length) {
			requestBody.tools = tools.map((tool: OpenAIToolDefinition) => ({
				description: tool.function.description,
				name: tool.function.name,
				parameters: tool.function.parameters,
				type: tool.type
			}));
		}

		if (custom) {
			try {
				const customParams = typeof custom === 'string' ? JSON.parse(custom) : custom;

				Object.assign(requestBody, customParams);
			} catch (error) {
				console.warn('Failed to parse custom parameters:', error);
			}
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
					signal
				);

				return;
			} else {
				const result = await OpenResponsesService.handleNonStreamResponse(
					response,
					onComplete,
					onToolCallChunk,
					onModel,
					onCompletionId,
					onTimings
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
			toolCalls?: string
		) => void,
		onError?: (error: Error) => void,
		onReasoningChunk?: (chunk: string) => void,
		onToolCallChunk?: (chunk: string) => void,
		onModel?: (model: string) => void,
		onCompletionId?: (id: string) => void,
		onTimings?: (timings?: ChatMessageTimings, promptProgress?: ChatMessagePromptProgress) => void,
		abortSignal?: AbortSignal
	): Promise<void> {
		const reader = response.body?.getReader();

		if (!reader) {
			throw new Error('No response body');
		}

		const decoder = new TextDecoder();

		let aggregatedContent = '';
		let fullReasoningContent = '';
		let lastTimings: ChatMessageTimings | undefined;
		let modelEmitted = false;
		let idEmitted = false;
		let reasoningSummarySeen = false;

		const functionCalls = new Map<string, StreamingFunctionCallState>();
		const functionCallIdsByItemId = new Map<string, string>();

		let currentFunctionCallId: string | null = null;

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

							if (parsed.prompt_progress || parsed.timings) {
								if (parsed.timings) lastTimings = parsed.timings as ChatMessageTimings;

								onTimings?.(
									parsed.timings as ChatMessageTimings | undefined,
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

								if (!parsed.timings && responseData.usage) {
									lastTimings = OpenResponsesService.convertUsageToTimings(responseData.usage);

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

			if (abortSignal?.aborted) return;

			closeOpenFunctionCallsAtTerminalIfNeeded();
			const pendingToolCalls = OpenResponsesService.serializeToolCalls(functionCalls, true);
			const serializedToolCalls = pendingToolCalls === '[]' ? undefined : pendingToolCalls;

			onComplete?.(
				aggregatedContent,
				fullReasoningContent || undefined,
				lastTimings,
				serializedToolCalls
			);
		} catch (error) {
			throw error instanceof Error ? error : new Error('Stream error');
		} finally {
			reader.releaseLock();
		}
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
			toolCalls?: string
		) => void,
		onToolCallChunk?: (chunk: string) => void,
		onModel?: (model: string) => void,
		onCompletionId?: (id: string) => void,
		onTimings?: (timings?: ChatMessageTimings, promptProgress?: ChatMessagePromptProgress) => void
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

			if (data.output && Array.isArray(data.output)) {
				for (const item of data.output) {
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

			if (!content.trim() && toolCalls.length === 0 && !reasoningContent.trim()) {
				const noResponseError = new Error('No response received from server. Please try again.');

				throw noResponseError;
			}

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

			onComplete?.(content, reasoningContent || undefined, timings, serializedToolCalls);

			return content;
		} catch (error) {
			throw error instanceof Error ? error : new Error('Parse error');
		}
	}

	/**
	 * Converts database messages to Responses API input format.
	 */
	static convertMessagesToInput(
		messages: ApiChatMessageData[] | (DatabaseMessage & { extra?: DatabaseMessageExtra[] })[],
		excludeReasoningContent = false
	): ResponsesInputItem[] {
		const input: ResponsesInputItem[] = [];

		for (const msg of messages) {
			let role: string;
			let content: string | ResponsesInputContentPart[];
			let reasoningContent: string | undefined;
			let toolCalls: ApiChatCompletionToolCall[] = [];
			let toolCallId: string | undefined;

			if ('id' in msg && 'convId' in msg && 'timestamp' in msg) {
				const dbMsg = msg as DatabaseMessage & { extra?: DatabaseMessageExtra[] };

				role = dbMsg.role === MessageRole.SYSTEM ? 'developer' : dbMsg.role;
				reasoningContent = dbMsg.reasoningContent;
				toolCalls = OpenResponsesService.parseToolCalls(dbMsg.toolCalls);
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
				toolCalls = OpenResponsesService.parseToolCalls(apiMsg.tool_calls);
				toolCallId = apiMsg.tool_call_id;

				if (typeof apiMsg.content === 'string') {
					content = apiMsg.content;
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
				const assistantContent = OpenResponsesService.convertAssistantContent(content);

				input.push({
					content: assistantContent,
					role: 'assistant',
					status: 'completed',
					type: 'message'
				});

				if (!excludeReasoningContent && reasoningContent?.trim()) {
					input.push({
						content: [{ text: reasoningContent, type: 'reasoning_text' }],
						summary: [],
						type: 'reasoning'
					});
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

	private static contentToText(content: string | ResponsesInputContentPart[]): string {
		if (typeof content === 'string') {
			return content;
		}

		return content.map((part) => part.text || '').join('');
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
}
