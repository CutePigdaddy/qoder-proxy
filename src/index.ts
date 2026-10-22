import { loadConfig } from './config.js';
import { loadEnvFile } from './env.js';
import { AdmissionGate } from './concurrency/admission.js';
import { AvailabilityProber } from './obs/availability.js';
import { ErrorStore } from './obs/errorStore.js';
import { applyLogLevel, logger } from './obs/logger.js';
import { metrics } from './obs/metrics.js';
import { ModelLimits } from './obs/modelLimits.js';
import { loadRateCard } from './obs/pricing.js';
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
  const errors = new ErrorStore({ path: config.errorLogPath, logger });
  const limits = new ModelLimits({ path: config.modelLimitsPath, logger });
  await limits.load();
  await usage.load();
  await errors.load();
  const resolver = new ModelResolver({
    catalog,
    models: config.models.models,
    aliases: config.models.aliases,
    fallback: config.models.fallback,
  });
  // 价目表只读一次：面板上的成本是「按当前价目折算」的口径，改价后重启即可
  const pricing = loadRateCard(config.pricingPath, logger);

  // 探测器单独一个 client，maxBusyRetries=0：探测要的是「此刻」的答案，
  // 内部重试会把一次失败抹成成功，也会把周期拉长到秒级。
  const probe = config.probe.enabled
    ? new AvailabilityProber({
        client: new QoderClient({
          endpoints,
          credentials,
          tokenMarkerMode: config.tokenMarkerMode,
          retryMaxWaitMs: config.retryMaxWaitMs,
          maxBusyRetries: 0,
          cacheDiagnostics: false,
        }),
        resolver,
        logger,
        intervalMs: config.probe.intervalMs,
        windowMs: config.probe.windowMs,
        dailyBudget: config.probe.dailyBudget,
        models: config.probe.models,
      })
    : null;
  if (probe) {
    logger.info(
      {
        intervalMs: config.probe.intervalMs,
        windowMs: config.probe.windowMs,
        dailyBudget: config.probe.dailyBudget,
        models: config.probe.models,
      },
      'availability probing enabled (counts against the daily request quota)',
    );
  }

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
    errors,
    limits,
    pricing,
    probe,
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

  // 首轮延迟内置在 start() 里：让启动时的模型目录拉取先完成
  probe?.start();

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    probe?.stop();
    // Flush pending usage/error rows / limit edits so a restart loses nothing.
    void Promise.all([usage.flush(), errors.flush(), limits.flush()]).finally(() =>
      server.close(() => process.exit(0)),
    );
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
