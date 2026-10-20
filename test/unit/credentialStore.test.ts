import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore } from '../../src/qoder/credentialStore.js';
import type { Endpoints } from '../../src/qoder/endpoints.js';

const endpoints: Endpoints = {
  gateway: 'https://gateway.example',
  openapi: 'https://openapi.example',
  chat: 'https://gateway.example/api/chat',
  modelList: 'https://gateway.example/api/models',
  exchange: 'https://openapi.example/api/v1/jobToken/exchange',
  refresh: 'https://openapi.example/api/v1/jobToken/refresh',
  userInfo: 'https://openapi.example/api/v1/userinfo',
  usage: 'https://openapi.example/api/v2/quota/usage',
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeStore(dir: string): CredentialStore {
  return new CredentialStore({
    pat: 'pat-secret',
    cachePath: join(dir, 'credentials.json'),
    endpoints,
  });
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-cred-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('CredentialStore.forceRefresh', () => {
  it('discards a still-fresh job token and reloads through the refresh token', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('exchange')) {
        return json({ token: 'tok-1', refresh_token: 'jrt-1', expires_in: 3_600_000 });
      }
      if (href.includes('userinfo')) {
        return json({ id: 'u1', name: 'tester', email: 'tester@example.com' });
      }
      if (href.includes('refresh')) {
        return json({ token: 'tok-2', refresh_token: 'jrt-2', expires_in: 3_600_000 });
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const store = makeStore(tempDir());
    const first = await store.get();
    expect(first.jobToken).toBe('tok-1');

    // The token is still fresh locally; forceRefresh must bypass that.
    const refreshed = await store.forceRefresh();
    expect(refreshed.jobToken).toBe('tok-2');
    expect(refreshed.jobRefreshToken).toBe('jrt-2');

    // The rotated pair is what subsequent reads see.
    expect((await store.get()).jobToken).toBe('tok-2');
  });

  it('falls back to a PAT exchange when the refresh token is rejected', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('exchange')) {
        return json({ token: 'tok-pat', refresh_token: 'jrt-pat', expires_in: 3_600_000 });
      }
      if (href.includes('userinfo')) {
        return json({ id: 'u1', name: 'tester', email: 'tester@example.com' });
      }
      if (href.includes('refresh')) {
        return new Response(JSON.stringify({ code: 105 }), { status: 401 });
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const store = makeStore(tempDir());
    await store.get();
    const refreshed = await store.forceRefresh();

    expect(refreshed.jobToken).toBe('tok-pat');
    const calls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(calls.some((href) => href.includes('refresh'))).toBe(true);
    expect(calls.some((href) => href.includes('exchange'))).toBe(true);
  });
});
