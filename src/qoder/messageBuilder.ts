import type { IRMessage, IRRequest } from '../ir/types.js';

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
export function buildMessages(req: IRRequest): BuiltMessages {
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

  const system = systemChunks.join('\n\n');
  return {
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
    system,
    lastUserText,
  };
}
