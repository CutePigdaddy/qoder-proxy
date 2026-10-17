import type { IRContentPart, IRMessage, IRRequest, IRToolCall, IRToolDef } from '../ir/types.js';

export type ParseResult = { ok: true; value: IRRequest } | { ok: false; error: string };

const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeParseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (!match) return null;
  const mimeType = match[1];
  const data = match[2];
  if (!mimeType || !data) return null;
  return { mimeType, data };
}

interface ExtractedContent {
  text: string;
  parts?: IRContentPart[];
}

function extractContent(content: unknown): ExtractedContent {
  if (typeof content === 'string') return { text: content };
  if (!Array.isArray(content)) return { text: '' };

  const texts: string[] = [];
  const parts: IRContentPart[] = [];

  for (const raw of content) {
    const item = asRecord(raw);
    if (!item) continue;
    const type = typeof item.type === 'string' ? item.type : '';

    if (type === 'text' && typeof item.text === 'string') {
      texts.push(item.text);
      parts.push({ type: 'text', text: item.text });
      continue;
    }

    if (type === 'image_url') {
      const imageUrl = asRecord(item.image_url);
      const url = typeof imageUrl?.url === 'string' ? imageUrl.url : '';
      const decoded = parseDataUrl(url);
      if (decoded) parts.push({ type: 'image', mimeType: decoded.mimeType, data: decoded.data });
      continue;
    }

    if (type === 'input_text' && typeof item.text === 'string') {
      texts.push(item.text);
      parts.push({ type: 'text', text: item.text });
    }
  }

  const hasImage = parts.some((p) => p.type === 'image');
  return {
    text: texts.join(''),
    ...(hasImage ? { parts } : {}),
  };
}

function parseToolCalls(raw: unknown): IRToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: IRToolCall[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) continue;
    const fn = asRecord(record.function);
    const name = typeof fn?.name === 'string' ? fn.name : '';
    if (!name) continue;
    calls.push({
      id: typeof record.id === 'string' && record.id ? record.id : `call_${calls.length}`,
      name,
      arguments: safeParseArguments(fn?.arguments),
    });
  }
  return calls;
}

function parseTools(raw: unknown): IRToolDef[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const tools: IRToolDef[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) continue;
    const fn = asRecord(record.function);
    const name = typeof fn?.name === 'string' ? fn.name : '';
    if (!name) continue;
    tools.push({
      name,
      description: typeof fn?.description === 'string' ? fn.description : undefined,
      parameters: fn?.parameters ?? { type: 'object', properties: {} },
    });
  }
  return tools.length > 0 ? tools : undefined;
}

/** Convert an OpenAI chat-completions payload into the neutral IR request. */
export function parseChatRequest(body: unknown): ParseResult {
  const record = asRecord(body);
  if (!record) return { ok: false, error: 'Request body must be a JSON object' };

  const model = typeof record.model === 'string' ? record.model.trim() : '';
  if (!model) return { ok: false, error: '`model` is required and must be a non-empty string' };

  if (!Array.isArray(record.messages) || record.messages.length === 0) {
    return { ok: false, error: '`messages` must be a non-empty array' };
  }

  const messages: IRMessage[] = [];
  const systemChunks: string[] = [];

  for (const raw of record.messages) {
    const msg = asRecord(raw);
    if (!msg) return { ok: false, error: 'Every message must be an object' };

    const role = typeof msg.role === 'string' ? msg.role : '';
    if (!ROLES.has(role)) return { ok: false, error: `Unsupported message role: ${role || '(missing)'}` };

    const { text, parts } = extractContent(msg.content);

    if (role === 'system' || role === 'developer') {
      if (text) systemChunks.push(text);
      continue;
    }

    if (role === 'assistant') {
      const toolCalls = parseToolCalls(msg.tool_calls);
      messages.push({
        role: 'assistant',
        content: text,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
      continue;
    }

    if (role === 'tool') {
      messages.push({
        role: 'tool',
        content: text,
        toolCallId: typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '',
      });
      continue;
    }

    messages.push({ role: 'user', content: text, ...(parts ? { parts } : {}) });
  }

  if (messages.length === 0) {
    return { ok: false, error: 'At least one non-system message is required' };
  }

  const maxTokensRaw = record.max_completion_tokens ?? record.max_tokens;
  const maxTokens = typeof maxTokensRaw === 'number' && maxTokensRaw > 0 ? Math.floor(maxTokensRaw) : undefined;

  const streamOptions = asRecord(record.stream_options);
  const includeUsage = streamOptions?.include_usage === true;

  const effort = record.reasoning_effort;
  const reasoningEffort = typeof effort === 'string' && effort.trim() ? effort.trim() : undefined;

  return {
    ok: true,
    value: {
      model,
      messages,
      ...(systemChunks.length > 0 ? { system: systemChunks.join('\n\n') } : {}),
      tools: parseTools(record.tools),
      maxTokens,
      reasoningEffort,
      stream: record.stream === true,
      includeUsage,
    },
  };
}
