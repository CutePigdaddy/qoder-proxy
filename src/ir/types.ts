/**
 * Neutral internal representation. Every client protocol adapter (OpenAI today,
 * Anthropic later) maps to and from these types, so the upstream client and the
 * concurrency layer never depend on a specific wire format.
 */

export type IRRole = 'system' | 'user' | 'assistant' | 'tool';

export interface IRTextPart {
  type: 'text';
  text: string;
}

export interface IRImagePart {
  type: 'image';
  /** MIME type, e.g. image/png. */
  mimeType: string;
  /** Base64 payload, no data: prefix. */
  data: string;
}

export type IRContentPart = IRTextPart | IRImagePart;

export interface IRToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface IRMessage {
  role: IRRole;
  /** Flattened text form, always populated for text-only messages. */
  content: string;
  /** Present when the message carries images. */
  parts?: IRContentPart[];
  /** Assistant only. */
  toolCalls?: IRToolCall[];
  /** Tool role only: which call this result answers. */
  toolCallId?: string;
}

export interface IRToolDef {
  name: string;
  description?: string;
  parameters: unknown;
}

export interface IRRequest {
  model: string;
  messages: IRMessage[];
  system?: string;
  tools?: IRToolDef[];
  maxTokens?: number;
  reasoningEffort?: string;
  stream: boolean;
  /** OpenAI `stream_options.include_usage`: emit a trailing usage chunk. */
  includeUsage?: boolean;
}

export type IRFinishReason = 'stop' | 'tool_calls' | 'length' | 'error';

export type IREvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call-start'; index: number; id: string; name: string }
  | { type: 'tool-call-args-delta'; index: number; delta: string }
  | {
      type: 'tool-call-end';
      index: number;
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | { type: 'usage'; promptTokens: number; completionTokens: number; totalTokens: number;
      /** Prompt tokens served from the upstream prompt cache. */
      cachedTokens?: number;
      /** Prompt tokens written into cache on this call (i.e. cache misses). */
      cacheableTokens?: number }
  | { type: 'done'; finishReason: IRFinishReason }
  | { type: 'error'; message: string; status?: number };
