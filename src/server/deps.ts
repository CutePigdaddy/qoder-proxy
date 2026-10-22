import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { AdmissionGate } from '../concurrency/admission.js';
import type { ModelResolver } from '../openai/modelResolver.js';
import type { QoderClient } from '../qoder/client.js';
import type { CredentialStore } from '../qoder/credentialStore.js';
import type { ModelCatalog } from '../qoder/modelCatalog.js';
import type { ModelLimits } from '../obs/modelLimits.js';
import type { QuotaService } from '../qoder/quota.js';
import type { UsageStore } from '../obs/usageStore.js';

export interface Deps {
  config: AppConfig;
  logger: Logger;
  credentials: CredentialStore;
  catalog: ModelCatalog;
  client: QoderClient;
  resolver: ModelResolver;
  gate: AdmissionGate;
  quota: QuotaService;
  /** 面板维护的每模型输入上限（空表 = 不限制） */
  limits: ModelLimits;
  /** Records one row per chat request; backs /v1/usage/dashboard. */
  usage: UsageStore;
  startTime: number;
  /** Push current concurrency/queue values into the exported gauges. */
  updateGauges: () => void;
}
