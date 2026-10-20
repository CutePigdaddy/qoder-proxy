import type { IRMessage, IRRequest } from '../ir/types.js';

export type TokenMarkerMode = 'move' | 'strip' | 'keep';

/**
 * Claude Code's `totalTokensReminder` appends a `<total_tokens>N tokens
 * left</total_tokens>` line to the system prompt after every tool result and
 * user turn. The upstream prompt cache matches prefixes byte-exactly, so a
 * growing system tail voids every cache entry past the first marker. We
 * neutralise it here: strip the markers from the system prompt and (in the
 * default `move` mode) re-attach the latest one to the tail of the current
 * turn so the model still sees the budget.
 */
const TOKEN_MARKER_RE = /<total_tokens>[\s\S]*?<\/total_tokens>/g;

export interface BuiltMessages {
  /** Wire payload: a leading system message (if any) followed by the conversation. */
  messages: unknown[];
  /** Joined system prompt, kept for logging/debugging. */
  system: string;
  /** Last user turn, used for upstream metadata such as the session title. */
  lastUserText: string;
}

function contentOf(message: IRMessage): unknown {
  if (!message.parts || message.parts.length === 0) return message.content;
  return message.parts.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } },
  );
}

/**
 * Translate the neutral IR request into the upstream conversation array.
 *
 * The Qoder gateway ignores a top-level `system` field — it only reads the
 * message list. The system prompt therefore has to travel as a leading
 * `role: "system"` message, otherwise client-side instructions are silently
 * dropped and the model answers without them.
 */
export function buildMessages(
  req: IRRequest,
  opts?: { tokenMarkerMode?: TokenMarkerMode },
): BuiltMessages {
  const mode: TokenMarkerMode = opts?.tokenMarkerMode ?? 'move';
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

  let system = systemChunks.join('\n\n');

  // Neutralise totalTokensReminder markers so the system prompt stays
  // byte-stable across turns and the whole history remains cacheable.
  const markers = mode === 'keep' ? [] : (system.match(TOKEN_MARKER_RE) ?? []);
  if (markers.length > 0) {
    system = system.replace(TOKEN_MARKER_RE, '').replace(/\n{3,}/g, '\n\n').trimEnd();
    if (mode === 'move') {
      const latest = markers[markers.length - 1];
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i] as { role?: string; content?: unknown };
        if (message.role !== 'user' && message.role !== 'tool') continue;
        if (typeof message.content === 'string') {
          message.content = `${message.content}\n\n${latest}`;
        } else if (Array.isArray(message.content)) {
          const parts = message.content as Array<{ type?: string; text?: string }>;
          const lastText = [...parts].reverse().find((part) => part.type === 'text');
          if (lastText && typeof lastText.text === 'string') {
            lastText.text = `${lastText.text}\n\n${latest}`;
          } else {
            parts.push({ type: 'text', text: latest });
          }
        } else {
          message.content = latest;
        }
        break;
      }
    }
  }

  return {
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
    system,
    lastUserText,
  };
}
