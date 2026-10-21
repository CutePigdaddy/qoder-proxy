import { loadConfig } from './config.js';
import { loadEnvFile } from './env.js';
import { AdmissionGate } from './concurrency/admission.js';
import { applyLogLevel, logger } from './obs/logger.js';
import { metrics } from './obs/metrics.js';
import { UsageStore } from './obs/usageStore.js';
import { ModelResolver } from './openai/modelResolver.js';
import { QoderClient } from './qoder/client.js';
import { CredentialStore } from './qoder/credentialStore.js';
import { resolveEndpoints } from './qoder/endpoints.js';
import { ModelCatalog } from './qoder/modelCatalog.js';
import { QuotaService } from './qoder/quota.js';

async function main(): Promise<void> {
  loadEnvFile();

  // `node dist/index.js --probe` verifies credentials + COSY signing and exits.
  // Loaded dynamically so the probe works even where the HTTP stack is absent.
  if (process.argv.includes('--probe')) {
    try {
      const { runProbe } = await import('./probe.js');
      process.exit(await runProbe());
    } catch (error: unknown) {
      logger.error({ err: error instanceof Error ? error.message : String(error) }, 'probe failed');
      process.exit(1);
    }
  }

  const [{ serve }, { createApp }] = await Promise.all([
    import('@hono/node-server'),
    import('./server/app.js'),
  ]);

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : String(error) }, 'configuration error');
    process.exit(1);
  }

  // `.env` is only readable now, so the boot-time log level was a placeholder.
  applyLogLevel(config.logLevel);

  if (!config.authEnabled) {
    logger.error('PROXY_API_KEY is empty: every /v1 request will be refused (fail-closed)');
  }

  const endpoints = resolveEndpoints();
  const credentials = new CredentialStore({
    pat: config.pat,
    cachePath: config.tokenCachePath,
    endpoints,
  });
  const catalog = new ModelCatalog({ endpoints, credentials });
  const client = new QoderClient({
    endpoints,
    credentials,
    tokenMarkerMode: config.tokenMarkerMode,
    retryMaxWaitMs: config.retryMaxWaitMs,
    cacheDiagnostics: config.cacheDiagnostics,
  });
  const quota = new QuotaService({ endpoints, credentials, ttlMs: config.quotaTtlMs });
  const gate = new AdmissionGate(config.concurrency, config.queueLimit);
  // Load the on-disk history before serving so the dashboard is not empty for
  // the first 30 seconds after a restart.
  const usage = new UsageStore({ path: config.usageLogPath, logger });
  await usage.load();
  const resolver = new ModelResolver({
    catalog,
    models: config.models.models,
    aliases: config.models.aliases,
    fallback: config.models.fallback,
  });

  const updateGauges = (): void => {
    metrics.concurrency.set(gate.inFlight);
    metrics.queueDepth.set(gate.depth);
  };

  const app = createApp({
    config,
    logger,
    credentials,
    catalog,
    client,
    resolver,
    gate,
    quota,
    usage,
    startTime: Date.now(),
    updateGauges,
  });

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info(
      {
        port: info.port,
        concurrency: config.concurrency,
        queueLimit: config.queueLimit,
        gateway: endpoints.gateway,
      },
      'qoder-proxy listening',
    );
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    // Flush pending usage rows so a restart does not lose the last few requests.
    void usage.flush().finally(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: String(reason) }, 'unhandled rejection');
  });
}

main().catch((error: unknown) => {
  logger.error({ err: error instanceof Error ? error.message : String(error) }, 'fatal startup error');
  process.exit(1);
});
