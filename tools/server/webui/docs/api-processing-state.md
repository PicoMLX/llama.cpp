# ApiProcessingState Spec

This document describes the `ApiProcessingState` shape expected by the web UI. It is used to
render the "Processing..." banner, progress details, and live stats while streaming.

Source of truth in the UI: `src/lib/types/api.d.ts`.

## Shape

```ts
interface ApiProcessingState {
  status: 'initializing' | 'generating' | 'preparing' | 'idle';
  tokensDecoded: number;
  tokensRemaining: number;
  contextUsed: number;
  contextTotal: number;
  outputTokensUsed: number;
  outputTokensMax: number;
  temperature: number;
  topP: number;
  speculative: boolean;
  hasNextToken: boolean;
  tokensPerSecond?: number;
  progressPercent?: number;
  promptProgress?: ChatMessagePromptProgress;
  promptTokens?: number;
  promptMs?: number;
  cacheTokens?: number;
}
```

## Field details

- `status`
  - One of: `initializing`, `preparing`, `generating`, `idle`.
  - Drives the banner text in `use-processing-state.svelte.ts`.
- `tokensDecoded`
  - Number of output tokens decoded so far.
- `tokensRemaining`
  - Remaining output tokens before the response completes (if known).
- `contextUsed`
  - Current context tokens used.
- `contextTotal`
  - Total context capacity.
  - Used to show `Context: used/total (percent)` details.
- `outputTokensUsed`
  - Total output tokens used so far (includes both thinking and normal output).
  - If > 0, the UI shows output usage details.
- `outputTokensMax`
  - Maximum output tokens allowed.
  - If <= 0, UI renders `Output: used/∞`.
- `temperature`
  - Sampling temperature.
- `topP`
  - Top-p sampling parameter.
- `speculative`
  - Whether speculative decoding is enabled.
  - If true, the UI adds a "Speculative decoding enabled" detail.
- `hasNextToken`
  - Whether the model reports more tokens pending.
- `tokensPerSecond` (optional)
  - Current generation speed.
  - If present and > 0, the UI shows `X tokens/sec`.
- `progressPercent` (optional)
  - Progress percent for prompt processing (0-100).
  - Used when `status` is `preparing` to show `Processing (N%)`.
- `promptProgress` (optional)
  - Progress detail object used to show `Processing N% (ETA: Ns)`.
  - Structure is in `src/lib/types/api.d.ts` as `ChatMessagePromptProgress`.
- `promptTokens` (optional)
  - Total prompt tokens (if exposed by server).
- `promptMs` (optional)
  - Prompt processing time in ms (if exposed by server).
- `cacheTokens` (optional)
  - Cached prompt tokens (if exposed by server).

## UI behavior summary

- The banner text is computed in `src/lib/hooks/use-processing-state.svelte.ts`.
- `promptProgress` takes precedence for the banner (if present).
- `status` values map to:
  - `initializing` -> "Initializing..."
  - `preparing` -> "Preparing response..." or "Processing (N%)"
  - `generating` -> "" (no banner text)
  - `idle` -> "Processing..." (fallback)

## Endpoint and update cadence

The UI does not call a dedicated "processing state" endpoint. Instead, it derives
`ApiProcessingState` from streaming responses:

- Chat Completions: `POST /v1/chat/completions`
  - `return_progress: true` is set when `stream: true`.
  - The UI updates processing state for each streamed SSE chunk that contains:
    - `timings` (generation stats)
    - `prompt_progress` (prompt processing stats)
  - See `src/lib/services/chat.ts` and `src/lib/stores/chat.svelte.ts`.

- Responses API: `POST /v1/responses`
  - The UI updates processing state when it receives `response.completed` / `response.done`
    and converts `usage` to timings.
  - There is no per-chunk prompt progress handling in this path today.
  - See `src/lib/services/responses.ts` and `src/lib/stores/chat.svelte.ts`.

## Example payload

```json
{
  "status": "preparing",
  "tokensDecoded": 0,
  "tokensRemaining": 256,
  "contextUsed": 2048,
  "contextTotal": 8192,
  "outputTokensUsed": 0,
  "outputTokensMax": 256,
  "temperature": 0.8,
  "topP": 0.95,
  "speculative": false,
  "hasNextToken": true,
  "tokensPerSecond": 0,
  "progressPercent": 42,
  "promptProgress": {
    "processed": 420,
    "total": 1000,
    "time_ms": 850,
    "cache": 0
  },
  "promptTokens": 1000,
  "promptMs": 850,
  "cacheTokens": 0
}
```

## timings and prompt_progress

These fields arrive in streamed chunks for `POST /v1/chat/completions` and are used to
derive `ApiProcessingState`.

### timings

From `ApiChatCompletionStreamChunk.timings` in `src/lib/types/api.d.ts`:

```json
{
  "prompt_n": 0,
  "prompt_ms": 0,
  "predicted_n": 0,
  "predicted_ms": 0,
  "cache_n": 0
}
```

- `prompt_n`: number of prompt tokens processed (excluding cache).
- `prompt_ms`: time spent processing the prompt.
- `predicted_n`: number of output tokens generated so far.
- `predicted_ms`: time spent generating output tokens.
- `cache_n`: number of cached prompt tokens.

### prompt_progress

From `ChatMessagePromptProgress` in `src/lib/types/chat.d.ts`:

```json
{
  "cache": 0,
  "processed": 0,
  "time_ms": 0,
  "total": 0
}
```

- `cache`: cached prompt tokens.
- `processed`: prompt tokens processed so far (includes `cache`).
- `time_ms`: elapsed time for prompt processing.
- `total`: total prompt tokens to process.

## Example SSE chunk (Chat Completions)

Each stream event is an SSE `data:` line containing JSON with optional `timings` and
`prompt_progress` fields.

```json
{
  "object": "chat.completion.chunk",
  "model": "some-model",
  "choices": [
    {
      "delta": {
        "content": "Hello",
        "reasoning_content": ""
      }
    }
  ],
  "timings": {
    "prompt_n": 128,
    "prompt_ms": 42,
    "predicted_n": 12,
    "predicted_ms": 18,
    "cache_n": 0
  },
  "prompt_progress": {
    "cache": 0,
    "processed": 128,
    "time_ms": 42,
    "total": 512
  }
}
```
