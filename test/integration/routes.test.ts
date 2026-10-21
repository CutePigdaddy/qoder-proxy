import { describe, expect, it } from 'vitest';
import { chatBody, createHarness, modelListEntry } from '../helpers/gateway.js';

/**
 * Routes around the chat endpoint.
 *
 * These are what operators and dashboards depend on: a health probe that stays
 * up, metrics that actually record traffic, a model list that matches the
 * upstream, and a quota view that does not hammer the upstream on every refresh.
 */

describe('GET /health', () => {
  it('answers without credentials and without touching the upstream', async () => {
    const harness = createHarness();
    const response = await harness.get('/health', { headers: { Authorization: '' } });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.authConfigured).toBe(true);
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(harness.calls).toHaveLength(0);
  });
});

describe('GET /v1/models', () => {
  it('lists the curated names in OpenAI list shape', async () => {
    const harness = createHarness({
      models: [modelListEntry({ id: 'Test-Model', upstream: 'qmodel_test' })],
    });
    const response = await harness.get('/v1/models');
    const body = (await response.json()) as {
      object: string;
      data: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(body.object).toBe('list');
    expect(body.data[0]).toMatchObject({
      id: 'Test-Model',
      object: 'model',
      owned_by: 'qoder',
      upstream_model: 'qmodel_test',
    });
  });

  it('requires the client key', async () => {
    const harness = createHarness();
    const response = await harness.app.request('http://gateway.test/v1/models');

    // Model names leak the account's plan; the gate applies to every /v1 route.
    expect(response.status).toBe(401);
  });

  it('reports a wrong key with a client-visible error code', async () => {
    const harness = createHarness();
    const response = await harness.post(chatBody(), { auth: 'Bearer wrong' });
    const body = (await response.json()) as { error: { code: string; type: string } };

    // SDKs key their retry/auth prompts off `code`, not off the message text.
    expect(response.status).toBe(401);
    expect(body.error.code).toBe('invalid_api_key');
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('accepts a lowercase bearer scheme', async () => {
    const harness = createHarness();
    const response = await harness.app.request('http://gateway.test/v1/models', {
      headers: { Authorization: 'bearer sk-test' },
    });

    // Header casing varies between SDKs; rejecting it would look like a bad key.
    expect(response.status).toBe(200);
  });
});

describe('GET /v1/quota', () => {
  it('returns the snapshot with cache headers', async () => {
    const harness = createHarness();
    const response = await harness.get('/v1/quota');
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-quota-cached')).toBe('false');
    expect(body).toMatchObject({ unit: 'credits', remaining: 664, plan: 'Free' });
  });
});

describe('GET /metrics', () => {
  it('renders Prometheus text and records completed requests', async () => {
    const harness = createHarness();
    await harness.post({ model: 'Test-Model', messages: [{ role: 'user', content: 'hi' }] });

    const response = await harness.get('/metrics');
    const text = await response.text();

    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(text).toContain('# TYPE qoder_requests_total counter');
    expect(text).toMatch(/qoder_requests_total\{model="Test-Model",status="200"\} [1-9]/);
    expect(text).toContain('# TYPE qoder_request_duration_seconds histogram');
    expect(text).toMatch(/qoder_request_duration_seconds_count [1-9]/);
  });
});

describe('request limits', () => {
  it('rejects a body larger than BODY_LIMIT with 413', async () => {
    const harness = createHarness({ config: { bodyLimit: 1024 } });
    const oversized = {
      model: 'Test-Model',
      messages: [{ role: 'user', content: 'x'.repeat(4096) }],
    };

    const response = await harness.post(oversized);

    // Without this the limit is decorative: a single 50 MB paste would be
    // buffered in the gateway's heap and then re-sent upstream.
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe('invalid_request_error');
    expect(harness.calls).toHaveLength(0);
  });

  it('still accepts a body just under the limit', async () => {
    const harness = createHarness({ config: { bodyLimit: 4096 } });
    const response = await harness.post({
      model: 'Test-Model',
      messages: [{ role: 'user', content: 'x'.repeat(512) }],
    });

    expect(response.status).toBe(200);
  });

  it('rejects an empty message list before spending a slot', async () => {
    const harness = createHarness();
    const response = await harness.post({ model: 'Test-Model', messages: [] });

    expect(response.status).toBe(400);
    expect(harness.calls).toHaveLength(0);
    expect(harness.gate.inFlight).toBe(0);
  });
});
