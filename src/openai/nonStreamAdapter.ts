import crypto from 'node:crypto';
import type { IREvent, IRFinishReason } from '../ir/types.js';
import { toOpenAIUsage, type OpenAIUsage } from './streamAdapter.js';

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Fold a stream of IR events into a single `chat.completion` object. */
export class CompletionAccumulator {
  private text = '';
  private reasoning = '';
  private finishReason: IRFinishReason = 'stop';
  private usage: OpenAIUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  private readonly toolCalls = new Map<number, AccumulatedToolCall>();

  apply(event: IREvent): void {
    switch (event.type) {
      case 'text-delta':
        this.text += event.text;
        break;
      case 'reasoning-delta':
        this.reasoning += event.text;
        break;
      case 'tool-call-start':
        this.toolCalls.set(event.index, { id: event.id, name: event.name, arguments: '' });
        break;
      case 'tool-call-args-delta': {
        const call = this.toolCalls.get(event.index);
        if (call) call.arguments += event.delta;
        break;
      }
      case 'tool-call-end': {
        const call = this.toolCalls.get(event.index);
        if (call) {
          call.id = event.id;
          call.name = event.name;
          call.arguments = JSON.stringify(event.arguments);
        }
        break;
      }
      case 'usage':
        this.usage = toOpenAIUsage(event);
        break;
      case 'done':
        this.finishReason = event.finishReason;
        break;
      case 'error':
        break;
    }
  }

  toCompletion(model: string): Record<string, unknown> {
    const calls = [...this.toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }));

    const message: Record<string, unknown> = {
      role: 'assistant',
      content: this.text.length > 0 ? this.text : calls.length > 0 ? null : '',
    };
    if (this.reasoning) message.reasoning_content = this.reasoning;
    if (calls.length > 0) message.tool_calls = calls;

    const finish = calls.length > 0 ? 'tool_calls' : this.finishReason === 'length' ? 'length' : 'stop';

    return {
      id: `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: this.usage,
    };
  }
}
