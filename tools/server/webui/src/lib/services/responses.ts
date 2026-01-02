import { getJsonHeaders } from '$lib/utils';
import { AttachmentType } from '$lib/enums';

/**
 * ResponsesService - API communication layer for OpenAI Responses API
 *
 * This service provides an alternative to ChatService, using OpenAI's newer
 * Responses API (v1/responses) instead of Chat Completions (v1/chat/completions).
 *
 * The Responses API has a different request/response format but this service
 * normalizes the output to match ChatService's callback interface for seamless
 * integration with the chat store.
 *
 * Key differences from Chat Completions:
 * - Uses `input` instead of `messages` array
 * - Supports `previous_response_id` for stateful conversations
 * - Different streaming event types
 * - Response content in `output[].content[].text` instead of `choices[].message.content`
 */
export class ResponsesService {
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
			disableReasoningFormat
		} = options;

		const input = ResponsesService.convertMessagesToInput(messages);

		const apiKey = ResponsesService.getApiKey();
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

		if (!disableReasoningFormat) {
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
				const error = await ResponsesService.parseErrorResponse(response);
				if (onError) {
					onError(error);
				}
				throw error;
			}

			if (stream) {
				await ResponsesService.handleStreamResponse(
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
				return ResponsesService.handleNonStreamResponse(
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

			console.error('Error in ResponsesService.sendMessage:', error);
			if (onError) {
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

							if (eventType === 'response.output_text.delta') {
								const delta = parsed.delta || '';
								if (delta) {
									aggregatedContent += delta;
									if (!abortSignal?.aborted) {
										onChunk?.(delta);
									}
								}
							}

							if (eventType === 'response.reasoning_summary_text.delta') {
								const delta = parsed.delta || '';
								if (delta) {
									fullReasoningContent += delta;
									if (!abortSignal?.aborted) {
										onReasoningChunk?.(delta);
									}
								}
							}

							if (eventType === 'response.function_call_arguments.delta') {
								const delta = parsed.delta || '';
								if (delta && !abortSignal?.aborted) {
									onToolCallChunk?.(delta);
								}
							}

							if (eventType === 'response.completed' || eventType === 'response.done') {
								const responseData = parsed.response || parsed;
								if (responseData.usage) {
									lastTimings = ResponsesService.convertUsageToTimings(responseData.usage);
									onTimings?.(lastTimings, undefined);
								}
								if (responseData.model && !modelEmitted) {
									modelEmitted = true;
									onModel?.(responseData.model);
								}
							}
						} catch (e) {
							console.error('Error parsing Responses API JSON chunk:', e);
						}
					}
				}

				if (abortSignal?.aborted) break;
			}

			if (abortSignal?.aborted) return;

			onComplete?.(aggregatedContent, fullReasoningContent || undefined, lastTimings, undefined);
		} catch (error) {
			const err = error instanceof Error ? error : new Error('Stream error');
			onError?.(err);
			throw err;
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
					if (item.type === 'message' && item.content) {
						for (const contentItem of item.content) {
							if (contentItem.type === 'output_text') {
								content += contentItem.text || '';
							}
						}
					}
					if (item.type === 'reasoning') {
						for (const contentItem of item.content || []) {
							if (contentItem.type === 'reasoning_summary_text') {
								reasoningContent += contentItem.text || '';
							}
						}
					}
				}
			}

			if (!content.trim()) {
				const noResponseError = new Error('No response received from server. Please try again.');
				throw noResponseError;
			}

			const timings = data.usage ? ResponsesService.convertUsageToTimings(data.usage) : undefined;

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
					content = dbMsg.content;
				} else {
					content = ResponsesService.convertExtrasToContent(dbMsg);
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
					content = ResponsesService.convertApiContentParts(apiMsg.content);
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
	}): ChatMessageTimings {
		return {
			prompt_n: usage.input_tokens || 0,
			predicted_n: usage.output_tokens || 0,
			cache_n: usage.input_tokens_details?.cached_tokens || 0
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
