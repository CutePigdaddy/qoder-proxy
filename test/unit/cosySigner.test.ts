import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildCosyHeaders, computeSignaturePath } from '../../src/qoder/cosySigner.js';

const creds = {
  userID: '242546',
  authToken: 'jt-example-token',
  name: 'Tester',
  email: 'tester@example.com',
  machineID: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
};

const chatUrl =
  'https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';

describe('computeSignaturePath', () => {
  it('strips the /algo prefix', () => {
    expect(computeSignaturePath(chatUrl)).toBe('/api/v2/service/pro/sse/agent_chat_generation');
  });

  it('leaves paths without /algo untouched', () => {
    expect(computeSignaturePath('https://openapi.qoder.com.cn/api/v1/userinfo')).toBe('/api/v1/userinfo');
  });
});

describe('buildCosyHeaders', () => {
  it('produces a COSY bearer and the full header bag', () => {
    const body = Buffer.from('{"ping":true}');
    const headers = buildCosyHeaders(body, chatUrl, creds);

    expect(headers.Authorization).toMatch(/^Bearer COSY\.[A-Za-z0-9+/=]+\.[0-9a-f]{32}$/);
    for (const key of [
      'Cosy-Key',
      'Cosy-User',
      'Cosy-Date',
      'Cosy-Machineid',
      'Cosy-Bodyhash',
      'Cosy-Bodylength',
      'Cosy-Sigpath',
      'Login-Version',
      'X-Request-Id',
    ]) {
      expect(headers[key]).toBeTruthy();
    }
    expect(headers['Cosy-User']).toBe(creds.userID);
    expect(headers['Cosy-Machineid']).toBe(creds.machineID);
  });

  it('hashes the exact bytes it sends', () => {
    const body = Buffer.from('héllo');
    const headers = buildCosyHeaders(body, chatUrl, creds);
    expect(headers['Cosy-Bodyhash']).toBe(crypto.createHash('md5').update(body).digest('hex'));
    expect(headers['Cosy-Bodylength']).toBe(String(body.length));
  });

  it('treats a null body as zero bytes', () => {
    const headers = buildCosyHeaders(null, 'https://gateway.qoder.com.cn/algo/api/v2/model/list', creds);
    expect(headers['Cosy-Bodylength']).toBe('0');
    expect(headers['Cosy-Sigpath']).toBe('/api/v2/model/list');
  });

  it('uses a fresh AES key per request', () => {
    const a = buildCosyHeaders(null, chatUrl, creds);
    const b = buildCosyHeaders(null, chatUrl, creds);
    expect(a['Cosy-Key']).not.toBe(b['Cosy-Key']);
    expect(a.Authorization).not.toBe(b.Authorization);
  });

  it('refuses to sign without identity', () => {
    expect(() => buildCosyHeaders(null, chatUrl, { ...creds, userID: '' })).toThrow(/user id/);
    expect(() => buildCosyHeaders(null, chatUrl, { ...creds, authToken: '' })).toThrow(/auth token/);
  });
});
