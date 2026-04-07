import { getJsonHeaders } from '$lib/utils';
import { AttachmentType } from '$lib/enums';
import { AGENTIC_REGEX, AGENTIC_TAGS, REASONING_TAGS } from '$lib/constants/agentic';

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
	hasArguments: boolean;
	argumentsClosed: boolean;
	hasOutput: boolean;
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
 * - Supports `previous_response_id` for stateful conversations
 * - Different streaming event types
 * - Response content in `output[].content[].text` instead of `choices[].message.content`
 */
export class OpenResponsesService {
	private static sanitizeToolName(name?: string): string {
		return name?.replaceAll(AGENTIC_TAGS.TAG_SUFFIX, '') || 'Tool';
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
			item &&
				typeof item === 'object' &&
				(item as OpenResponsesOutputItem).type === 'function_call'
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

	private static stringifyToolOutput(outputValue: unknown): string {
		if (typeof outputValue === 'string') {
			return outputValue;
		}

		if (outputValue == null) {
			return '';
		}

		try {
			return JSON.stringify(outputValue);
		} catch {
			return String(outputValue);
		}
	}

	private static buildToolCallStart(name: string): string {
		return `${AGENTIC_TAGS.TOOL_CALL_START}\n${AGENTIC_TAGS.TOOL_NAME_PREFIX}${name}${AGENTIC_TAGS.TAG_SUFFIX}\n${AGENTIC_TAGS.TOOL_ARGS_START}`;
	}

	private static buildCompletedToolCallContent(
		name: string,
		argumentsText = ''
	): string {
		return `${OpenResponsesService.buildToolCallStart(name)}${argumentsText}${AGENTIC_TAGS.TOOL_ARGS_END}${AGENTIC_TAGS.TOOL_CALL_END}`;
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
			stream,
			onChunk,
			onComplete,
			onError,
			onReasoningChunk,
			onToolCallChunk,
			onModel,
			onTimings,
			temperature,
			max_tokens,
			top_p,
			custom,
			disableReasoningParsing
		} = options;

		const input = OpenResponsesService.convertMessagesToInput(messages);

		const apiKey = OpenResponsesService.getApiKey();
		const headers = getJsonHeaders();

		const requestBody: Record<string, unknown> = {
			input,
			stream: stream ?? true,
			store: false
		};

		if (options.model) {
			requestBody.model = options.model;
		}

		if (temperature !== undefined) requestBody.temperature = temperature;
		if (max_tokens !== undefined) {
			requestBody.max_output_tokens =
				max_tokens !== null && max_tokens !== 0 ? max_tokens : undefined;
		}
		if (top_p !== undefined) requestBody.top_p = top_p;

		if (!disableReasoningParsing) {
			requestBody.reasoning = { effort: 'medium' };
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
			const response = await fetch('./v1/responses', {
				method: 'POST',
				headers: {
					...headers,
					...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
				},
				body: JSON.stringify(requestBody),
				signal
			});

			if (!response.ok) {
				const error = await OpenResponsesService.parseErrorResponse(response);
				throw error;
			}

			if (stream) {
				await OpenResponsesService.handleStreamResponse(
					response,
					onChunk,
					onComplete,
					onError,
					onReasoningChunk,
					onToolCallChunk,
					onModel,
					onTimings,
					signal
				);
				return;
			} else {
				return OpenResponsesService.handleNonStreamResponse(
					response,
					onComplete,
					onError,
					onToolCallChunk,
					onModel
				);
			}
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
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
		let reasoningSummarySeen = false;
		let reasoningTextSeen = false;
		let reasoningBlockOpen = false;
		const functionCalls = new Map<string, StreamingFunctionCallState>();
		const functionCallIdsByItemId = new Map<string, string>();
		let currentFunctionCallId: string | null = null;
		const { START: reasoningStartTag, END: reasoningEndTag } = REASONING_TAGS;

		const emitContentChunk = (chunk: string): void => {
			if (!chunk) return;
			aggregatedContent += chunk;
			if (!abortSignal?.aborted) {
				onChunk?.(chunk);
			}
		};

		const openReasoningBlockIfNeeded = (): void => {
			if (reasoningBlockOpen) return;
			reasoningBlockOpen = true;
			emitContentChunk(reasoningStartTag);
		};

		const closeReasoningBlockIfNeeded = (): void => {
			if (!reasoningBlockOpen) return;
			reasoningBlockOpen = false;
			emitContentChunk(reasoningEndTag);
		};

		const closeFunctionCallArgumentsIfNeeded = (callId: string | null): void => {
			if (!callId) return;

			const functionCall = functionCalls.get(callId);
			if (!functionCall || functionCall.argumentsClosed) {
				return;
			}

			functionCall.argumentsClosed = true;
			emitContentChunk(AGENTIC_TAGS.TOOL_ARGS_END);
		};

		const closeFunctionCallIfNeeded = (callId: string | null): void => {
			if (!callId) return;

			const functionCall = functionCalls.get(callId);
			if (!functionCall) {
				return;
			}

			closeFunctionCallArgumentsIfNeeded(callId);
			emitContentChunk(`\n${AGENTIC_TAGS.TOOL_CALL_END}\n`);
			functionCalls.delete(callId);
			functionCallIdsByItemId.delete(functionCall.itemId);

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

							if (eventType === 'error' || eventType === 'response.failed') {
								closeOpenFunctionCallsAtTerminalIfNeeded();
								closeReasoningBlockIfNeeded();
								const handledError = OpenResponsesService.markErrorHandled(
									OpenResponsesService.streamTerminalError(parsed)
								);
								onError?.(handledError);
								throw handledError;
							}

							if (eventType === 'response.incomplete') {
								closeOpenFunctionCallsAtTerminalIfNeeded();
								closeReasoningBlockIfNeeded();
								if (OpenResponsesService.incompleteReason(parsed) === 'cancelled') {
									throw OpenResponsesService.abortError('Generation cancelled');
								}
							}

							if (eventType === 'response.output_text.delta') {
								const delta = parsed.delta || '';
								if (delta) {
									closeOpenFunctionCallsForNextContentIfNeeded();
									closeReasoningBlockIfNeeded();
									emitContentChunk(delta);
								}
							}

							if (eventType === 'response.reasoning_summary_text.delta') {
								const delta = parsed.delta || '';
								if (delta) {
									closeOpenFunctionCallsForNextContentIfNeeded();
									reasoningSummarySeen = true;
									fullReasoningContent += delta;
									openReasoningBlockIfNeeded();
									emitContentChunk(delta);
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
									openReasoningBlockIfNeeded();
									emitContentChunk(delta);
									if (!abortSignal?.aborted) {
										onReasoningChunk?.(delta);
									}
								}
							}

							if (eventType === 'response.reasoning_text.delta') {
								if (!reasoningTextSeen) {
									reasoningTextSeen = true;
									if (!abortSignal?.aborted) {
										onReasoningChunk?.('');
									}
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
									closeReasoningBlockIfNeeded();
									closeOpenFunctionCallsForNextContentIfNeeded();
									functionCalls.set(callId, {
										callId,
										itemId,
										hasArguments: false,
										argumentsClosed: false,
										hasOutput: false
									});
									functionCallIdsByItemId.set(itemId, callId);
									currentFunctionCallId = callId;
									emitContentChunk(
										OpenResponsesService.buildToolCallStart(
											OpenResponsesService.functionCallName(item)
										)
									);
								}

								if (OpenResponsesService.isFunctionCallOutputItem(item)) {
									const callId: string | null =
										OpenResponsesService.outputItemCallId(item) || currentFunctionCallId;
									if (callId) {
										const functionCall = functionCalls.get(callId);
										if (functionCall) {
											functionCall.hasOutput = true;
											currentFunctionCallId = callId;
											closeReasoningBlockIfNeeded();
											closeFunctionCallArgumentsIfNeeded(callId);

											const outputText = OpenResponsesService.stringifyToolOutput(item.output);
											if (outputText) {
												emitContentChunk(`\n${outputText}`);
											}
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
									}
									closeReasoningBlockIfNeeded();
									emitContentChunk(delta);
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
										closeReasoningBlockIfNeeded();
										emitContentChunk(argumentsText);
									}
									closeFunctionCallArgumentsIfNeeded(callId);
								}
							}

							if (eventType === 'response.output_item.done') {
								const item = parsed.item;
								if (OpenResponsesService.isFunctionCallItem(item)) {
									closeReasoningBlockIfNeeded();
								}

								if (OpenResponsesService.isFunctionCallOutputItem(item)) {
									const callId =
										OpenResponsesService.outputItemCallId(item) || currentFunctionCallId;
									closeReasoningBlockIfNeeded();
									closeFunctionCallIfNeeded(callId);
								}
							}

							if (eventType === 'response.completed' || eventType === 'response.done') {
								closeOpenFunctionCallsAtTerminalIfNeeded();
								closeReasoningBlockIfNeeded();
								const responseData = parsed.response || parsed;
								if (responseData.usage) {
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
			closeReasoningBlockIfNeeded();
			onComplete?.(aggregatedContent, fullReasoningContent || undefined, lastTimings, undefined);
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
		onError?: (error: Error) => void,
		onToolCallChunk?: (chunk: string) => void,
		onModel?: (model: string) => void
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

			let content = '';
			let reasoningContent = '';

			if (data.output && Array.isArray(data.output)) {
				for (const item of data.output) {
					if (item.type === 'function_call') {
						const toolName = OpenResponsesService.functionCallName(item);
						const argumentsText = OpenResponsesService.stringifyToolArguments(item.arguments);
						content += OpenResponsesService.buildCompletedToolCallContent(
							toolName,
							argumentsText
						);
					}
					if (item.type === 'message' && item.content) {
						for (const contentItem of item.content) {
							if (contentItem.type === 'output_text') {
								content += contentItem.text || '';
							}
						}
					}
					if (item.type === 'reasoning') {
						let reasoningText = '';
						for (const contentItem of item.content || []) {
							if (contentItem.type === 'reasoning_summary_text') {
								reasoningText += contentItem.text || '';
							}
						}
						if (reasoningText) {
							reasoningContent += reasoningText;
							content += `${REASONING_TAGS.START}${reasoningText}${REASONING_TAGS.END}`;
						}
					}
				}
			}

			if (!content.trim()) {
				const noResponseError = new Error('No response received from server. Please try again.');
				throw noResponseError;
			}

			const timings = data.usage
				? OpenResponsesService.convertUsageToTimings(data.usage)
				: undefined;
			if (data.usage && import.meta.env.DEV) {
				console.log('[OpenResponses] response usage:', data.usage);
				console.log('[OpenResponses] mapped timings:', timings);
			}

			onComplete?.(content, reasoningContent || undefined, timings, undefined);

			return content;
		} catch (error) {
			const err = error instanceof Error ? error : new Error('Parse error');
			onError?.(err);
			throw err;
		}
	}

	/**
	 * Converts database messages to Responses API input format.
	 */
	static convertMessagesToInput(
		messages: ApiChatMessageData[] | (DatabaseMessage & { extra?: DatabaseMessageExtra[] })[]
	): Array<{
		role: string;
		content:
			| string
			| Array<{
					type: string;
					text?: string;
					image_url?: string;
					input_audio?: { data: string; format: string };
			  }>;
	}> {
		const input: Array<{
			role: string;
			content:
				| string
				| Array<{
						type: string;
						text?: string;
						image_url?: string;
						input_audio?: { data: string; format: string };
				  }>;
		}> = [];

		for (const msg of messages) {
			let role: string;
			let content:
				| string
				| Array<{
						type: string;
						text?: string;
						image_url?: string;
						input_audio?: { data: string; format: string };
				  }>;

			if ('id' in msg && 'convId' in msg && 'timestamp' in msg) {
				const dbMsg = msg as DatabaseMessage & { extra?: DatabaseMessageExtra[] };

				if (dbMsg.role === 'system') {
					role = 'developer';
				} else {
					role = dbMsg.role;
				}

				if (!dbMsg.extra || dbMsg.extra.length === 0) {
					if (dbMsg.role === 'assistant' && typeof dbMsg.content === 'string') {
						content = dbMsg.content
							.replace(AGENTIC_REGEX.REASONING_BLOCK, '')
							.replace(AGENTIC_REGEX.REASONING_OPEN, '')
							.replace(AGENTIC_REGEX.AGENTIC_TOOL_CALL_BLOCK, '')
							.replace(AGENTIC_REGEX.AGENTIC_TOOL_CALL_OPEN, '');
					} else {
						content = dbMsg.content;
					}
				} else {
					content = OpenResponsesService.convertExtrasToContent(dbMsg);
				}
			} else {
				const apiMsg = msg as ApiChatMessageData;

				if (apiMsg.role === 'system') {
					role = 'developer';
				} else {
					role = apiMsg.role;
				}

				if (typeof apiMsg.content === 'string') {
					content = apiMsg.content;
				} else {
					content = OpenResponsesService.convertApiContentParts(apiMsg.content);
				}
			}

			if (role === 'developer' && typeof content === 'string' && !content.trim()) {
				continue;
			}

			input.push({ role, content });
		}

		return input;
	}

	/**
	 * Converts database message extras to Responses API content format.
	 */
	private static convertExtrasToContent(
		message: DatabaseMessage & { extra?: DatabaseMessageExtra[] }
	): Array<{
		type: string;
		text?: string;
		image_url?: string;
		input_audio?: { data: string; format: string };
	}> {
		const contentParts: Array<{
			type: string;
			text?: string;
			image_url?: string;
			input_audio?: { data: string; format: string };
		}> = [];

		if (message.content) {
			contentParts.push({ type: 'input_text', text: message.content });
		}

		if (!message.extra) return contentParts;

		for (const extra of message.extra) {
			if (extra.type === AttachmentType.IMAGE) {
				const imageExtra = extra as DatabaseMessageExtraImageFile;
				contentParts.push({ type: 'input_image', image_url: imageExtra.base64Url });
			} else if (extra.type === AttachmentType.TEXT) {
				const textExtra = extra as DatabaseMessageExtraTextFile;
				contentParts.push({
					type: 'input_text',
					text: `\n\n--- File: ${textExtra.name} ---\n${textExtra.content}`
				});
			} else if (extra.type === AttachmentType.LEGACY_CONTEXT) {
				const legacyExtra = extra as DatabaseMessageExtraLegacyContext;
				contentParts.push({
					type: 'input_text',
					text: `\n\n--- File: ${legacyExtra.name} ---\n${legacyExtra.content}`
				});
			} else if (extra.type === AttachmentType.AUDIO) {
				const audioExtra = extra as DatabaseMessageExtraAudioFile;
				contentParts.push({
					type: 'input_audio',
					input_audio: {
						data: audioExtra.base64Data,
						format: audioExtra.mimeType.includes('wav') ? 'wav' : 'mp3'
					}
				});
			} else if (extra.type === AttachmentType.PDF) {
				const pdfExtra = extra as DatabaseMessageExtraPdfFile;
				if (pdfExtra.processedAsImages && pdfExtra.images) {
					for (const imageUrl of pdfExtra.images) {
						contentParts.push({ type: 'input_image', image_url: imageUrl });
					}
				} else {
					contentParts.push({
						type: 'input_text',
						text: `\n\n--- PDF File: ${pdfExtra.name} ---\n${pdfExtra.content}`
					});
				}
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
	}> {
		return parts.map((part) => {
			if (part.type === 'text') {
				return { type: 'input_text', text: part.text };
			} else if (part.type === 'image_url') {
				return { type: 'input_image', image_url: part.image_url?.url };
			} else if (part.type === 'input_audio') {
				return {
					type: 'input_audio',
					input_audio: {
						data: part.input_audio?.data || '',
						format: part.input_audio?.format || 'wav'
					}
				};
			}
			return { type: 'input_text', text: '' };
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
			prompt_n: usage.input_tokens || 0,
			predicted_n: usage.output_tokens || 0,
			cache_n: usage.input_tokens_details?.cached_tokens || 0,
			prompt_ms: usage.prompt_time_ms,
			predicted_ms: usage.generation_time_ms
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

	/**
	 * Gets API key from settings if available.
	 */
	private static getApiKey(): string | null {
		if (typeof window !== 'undefined' && window.localStorage) {
			try {
				const configStr = localStorage.getItem('llama-config');
				if (configStr) {
					const config = JSON.parse(configStr);
					return config.apiKey || null;
				}
			} catch {
				// Ignore parsing errors
			}
		}
		return null;
	}
}
