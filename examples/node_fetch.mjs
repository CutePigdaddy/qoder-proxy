// Zero-dependency Node example (native fetch + manual SSE parsing).
//
//   node examples/node_fetch.mjs
//
// Reads PROXY_API_KEY / PROXY_BASE_URL / PROXY_MODEL from the environment,
// falling back to .env in the project root.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(here, '..', '.env');

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const at = trimmed.indexOf('=');
    const key = trimmed.slice(0, at).trim();
    const value = trimmed.slice(at + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

const BASE = process.env.PROXY_BASE_URL ?? 'http://127.0.0.1:3000/v1';
const KEY = process.env.PROXY_API_KEY;
const MODEL = process.env.PROXY_MODEL ?? 'auto';

if (!KEY) {
  console.error('PROXY_API_KEY is not set (checked env and .env)');
  process.exit(1);
}

async function chat(messages, { stream = false } = {}) {
  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, messages, stream }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  if (!stream) {
    const json = await response.json();
    return json.choices[0].message.content;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');

      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        const chunk = JSON.parse(payload);
        const text = chunk.choices?.[0]?.delta?.content;
        if (text) process.stdout.write(text);
      }
    }
  }
  process.stdout.write('\n');
}

console.log('== non-stream ==');
console.log(await chat([{ role: 'user', content: '用一句话解释什么是反向代理' }]));

console.log('\n== stream ==');
await chat([{ role: 'user', content: '数到五，每个数字一行' }], { stream: true });
