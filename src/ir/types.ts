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
      cacheableTokens?: number;
      /**
       * 上游对本次调用的计费口径（credits，非 token）。
       *
       * `FREE_INPUT` 通道理论上不写 credits，但「不写」与「写 0」在数据里长得
       * 不一样，靠 `/api/v2/quota/usage` 的差值去推断又要等结算延迟。把上游
       * usage 块里这三个字段原样带下来，是唯一能当场确认「到底扣没扣」的办法：
       * `undefined` = 上游没给这个字段，`0` = 明确记为 0。
       */
      credits?: number;
      /** 折扣前的 credits（上游按促销价计费时会同时给两者）。 */
      originalCredits?: number;
      /** 上游自己判定这次调用是否计费。 */
      billable?: boolean }
  | { type: 'done'; finishReason: IRFinishReason }
  | { type: 'error'; message: string; status?: number };
