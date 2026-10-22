import type { IRContentPart, IRRequest } from '../ir/types.js';

/**
 * 粗略 token 估算：ASCII 约 4 字符/token，CJK 约 1.5 字符/token。
 *
 * 上游并不按 token 数拦截（实测 180K 的模型发 230K 也能过），所以这里只服务于
 * 「网关侧自设上限」这一层闸门。估算误差 ±15% 是可接受的：宁可提示得保守一点，
 * 也不要为了精确而引入一个与 Qwen tokenizer 不一致的依赖。
 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 127) wide += 1;
    else ascii += 1;
  }
  return Math.ceil(ascii / 4 + wide / 1.5);
}

/** 一张图片按固定当量折算，避免把 base64 当文本算出一个荒谬的上限。 */
const IMAGE_TOKEN_EQUIVALENT = 800;

function partTokens(parts: IRContentPart[]): number {
  let total = 0;
  for (const part of parts) {
    total += part.type === 'text' ? estimateTextTokens(part.text) : IMAGE_TOKEN_EQUIVALENT;
  }
  return total;
}

/**
 * 估算一次请求的输入规模（含 system、历史消息、工具定义）。
 * 与真正发给上游的报文同源，因此不会漏掉工具 schema 这类大头。
 */
export function estimatePromptTokens(req: IRRequest): number {
  const chunks: string[] = [];
  if (req.system) chunks.push(req.system);
  for (const message of req.messages) {
    if (message.content) chunks.push(message.content);
    if (message.toolCalls && message.toolCalls.length > 0) chunks.push(JSON.stringify(message.toolCalls));
  }
  if (req.tools && req.tools.length > 0) chunks.push(JSON.stringify(req.tools));

  let total = estimateTextTokens(chunks.join('\n'));
  for (const message of req.messages) {
    if (message.parts) total += partTokens(message.parts);
  }
  return total;
}
