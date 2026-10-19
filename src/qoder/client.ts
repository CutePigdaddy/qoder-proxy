import crypto from 'node:crypto';
import type { IREvent, IRMessage, IRRequest } from '../ir/types.js';
import { HttpError, mapUpstreamFailure } from '../util/errors.js';
import { encodeQoderBody } from './bodyCodec.js';
import { buildCosyHeadersFor } from './cosySigner.js';
import type { CredentialStore } from './credentialStore.js';
import type { Endpoints } from './endpoints.js';
import { decodeQoderSse } from './sseDecoder.js';

export interface ResolvedModel {
  /** Wire key sent as `model_config.key` and `X-Model-Key`. */
  key: string;
  /** Client-facing name echoed back to the caller, e.g. `DeepSeek-V4-Pro`. */
  id: string;
  isReasoning: boolean;
  maxOutputTokens: number;
  /** How the key was chosen, for logging and debugging clients. */
  matched?: 'key' | 'mapped' | 'display' | 'alias' | 'fallback';
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface QoderDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: ToolCallDelta[];
}

interface QoderInner {
  choices?: Array<{ delta?: QoderDelta; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
}

function stableId(prefix: string, ...parts: string[]): string {
  const hash = crypto.createHash('sha256').update(prefix);
  for (const part of parts) {
    hash.update('\u0000');
    hash.update(part);
  }
  return hash.digest('hex').slice(0, 32);
}

function contentOf(message: IRMessage): unknown {
  if (!message.parts || message.parts.length === 0) return message.content;
  return message.parts.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } },
  );
}

function buildMessages(req: IRRequest): { messages: unknown[]; system: string; lastUserText: string } {
  const systemChunks: string[] = [];
  if (req.system) systemChunks.push(req.system);

  const messages: unknown[] = [];
  let lastUserText = '';

  for (const message of req.messages) {
    switch (message.role) {
      case 'system':
        if (message.content) systemChunks.push(message.content);
        break;
      case 'user':
        lastUserText = message.content;
        messages.push({ role: 'user', content: contentOf(message) });
        break;
      case 'assistant': {
        const out: Record<string, unknown> = { role: 'assistant', content: message.content };
        if (message.toolCalls && message.toolCalls.length > 0) {
          out.tool_calls = message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          }));
        }
        messages.push(out);
        break;
      }
      case 'tool':
        messages.push({
          role: 'tool',
          tool_call_id: message.toolCallId ?? '',
          content: message.content,
        });
        break;
    }
  }

  return {
    // The gateway ignores a top-level `system` field; it only reads the
    // conversation array. Keep the field for compatibility but carry the real
    // instruction as a leading system message, otherwise client-side system
    // prompts are silently discarded.
    messages: [
      ...(systemChunks.length > 0 ? [{ role: 'system', content: systemChunks.join('\n\n') }] : []),
      ...messages,
    ],
    system: systemChunks.join('\n\n'),
    lastUserText,
  };
}

function parseToolArguments(raw: string, identity: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(502, `Upstream tool call arguments were not valid JSON (${identity})`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(502, `Upstream tool call arguments were not an object (${identity})`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Upstream client for the Qoder CN chat gateway.
 *
 * The whole wire contract lives here: body shape, WAF encoding, COSY signing,
 * double-layer SSE unwrapping, and translation into neutral IR events.
 */
export class QoderClient {
  constructor(
    private readonly opts: {
      endpoints: Endpoints;
      credentials: CredentialStore;
    },
  ) {}

  async *chat(req: IRRequest, model: ResolvedModel, signal: AbortSignal): AsyncGenerator<IREvent> {
    const creds = await this.opts.credentials.get();
    const { messages, system, lastUserText } = buildMessages(req);

    const tools = (req.tools ?? []).map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));

    const maxTokens =
      req.maxTokens && req.maxTokens > 0
        ? Math.min(req.maxTokens, model.maxOutputTokens)
        : model.maxOutputTokens;

    const sessionId = stableId('qoder-session', creds.userID, model.key);
    const recordId = stableId(
      'qoder-record',
      model.key,
      JSON.stringify(messages),
      JSON.stringify(tools),
      String(maxTokens),
    );

    const body: Record<string, unknown> = {
      request_id: crypto.randomUUID(),
      request_set_id: recordId,
      chat_record_id: recordId,
      session_id: sessionId,
      stream: true,
      chat_task: 'FREE_INPUT',
      is_reply: true,
      is_retry: false,
      source: 1,
      version: '3',
      session_type: 'qodercli',
      agent_id: 'agent_common',
      task_id: 'common',
      code_language: '',
      chat_prompt: '',
      image_urls: null,
      aliyun_user_type: '',
      system,
      messages,
      tools,
      parameters: {
        max_tokens: maxTokens,
        ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
      },
      chat_context: {
        chatPrompt: '',
        imageUrls: null,
        extra: {
          context: [],
          modelConfig: { key: model.key, is_reasoning: model.isReasoning },
          originalContent: lastUserText,
        },
        features: [],
        text: lastUserText,
      },
      model_config: { key: model.key, is_reasoning: model.isReasoning },
      business: {
        product: 'cli',
        version: '1.0.0',
        type: 'agent',
        stage: 'start',
        id: crypto.randomUUID(),
        name: lastUserText.slice(0, 30),
        begin_at: Date.now(),
      },
    };

    const encodedBody = encodeQoderBody(Buffer.from(JSON.stringify(body)));
    const encodedBytes = Buffer.from(encodedBody, 'utf8');
    const headers = buildCosyHeadersFor(encodedBytes, this.opts.endpoints.chat, creds);

    let response: Response;
    try {
      response = await fetch(this.opts.endpoints.chat, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Accept-Encoding': 'identity',
          'X-Model-Key': model.key,
          'X-Model-Source': 'system',
          ...headers,
        },
        body: encodedBytes,
        signal,
      });
    } catch (error) {
      if (signal.aborted) return;
      throw new HttpError(502, `Upstream request failed: ${String(error)}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw mapUpstreamFailure({ status: response.status, body: text });
    }
    if (!response.body) {
      throw new HttpError(502, 'Upstream returned an empty body');
    }

    const toolsInFlight = new Map<number, { id: string; name: string; arguments: string }>();
    let sawContent = false;

    for await (const envelope of decodeQoderSse(response.body)) {
      if (typeof envelope.statusCodeValue === 'number' && envelope.statusCodeValue !== 200) {
        throw mapUpstreamFailure({
          status: envelope.statusCodeValue,
          body: envelope.body ?? '',
        });
      }
      if (!envelope.body || envelope.body === '[DONE]') continue;

      let inner: QoderInner;
      try {
        inner = JSON.parse(envelope.body) as QoderInner;
      } catch {
        throw new HttpError(502, 'Upstream SSE payload was not valid JSON');
      }

      if (inner.usage) {
        const prompt = inner.usage.prompt_tokens ?? inner.usage.input_tokens ?? 0;
        const completion = inner.usage.completion_tokens ?? inner.usage.output_tokens ?? 0;
        yield {
          type: 'usage',
          promptTokens: prompt,
          completionTokens: completion,
          totalTokens: inner.usage.total_tokens ?? prompt + completion,
        };
      }

      const delta = inner.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.reasoning_content) {
        sawContent = true;
        yield { type: 'reasoning-delta', text: delta.reasoning_content };
      }

      if (delta.content) {
        sawContent = true;
        yield { type: 'text-delta', text: delta.content };
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index = call.index ?? 0;
          let state = toolsInFlight.get(index);
          if (!state) {
            state = {
              id: call.id || `call_${crypto.randomUUID().slice(0, 8)}`,
              name: call.function?.name ?? '',
              arguments: '',
            };
            toolsInFlight.set(index, state);
            sawContent = true;
            yield { type: 'tool-call-start', index, id: state.id, name: state.name };
          }
          if (call.id) state.id = call.id;
          if (call.function?.name) state.name = call.function.name;

          const argsDelta = call.function?.arguments ?? '';
          if (argsDelta) {
            state.arguments += argsDelta;
            yield { type: 'tool-call-args-delta', index, delta: argsDelta };
          }
        }
      }
    }

    if (signal.aborted) return;

    for (const [index, state] of [...toolsInFlight.entries()].sort((a, b) => a[0] - b[0])) {
      yield {
        type: 'tool-call-end',
        index,
        id: state.id,
        name: state.name,
        arguments: parseToolArguments(state.arguments, state.name || state.id),
      };
    }

    if (!sawContent) {
      throw new HttpError(502, 'Upstream completed without producing any content');
    }

    yield { type: 'done', finishReason: toolsInFlight.size > 0 ? 'tool_calls' : 'stop' };
  }
}
