import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { AdmissionGate } from '../concurrency/admission.js';
import type { ModelResolver } from '../openai/modelResolver.js';
import type { QoderClient } from '../qoder/client.js';
import type { CredentialStore } from '../qoder/credentialStore.js';
import type { ModelCatalog } from '../qoder/modelCatalog.js';
import type { ModelLimits } from '../obs/modelLimits.js';
import type { AvailabilityProber } from '../obs/availability.js';
import type { ErrorStore } from '../obs/errorStore.js';
import type { RateCard } from '../obs/pricing.js';
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
  /** Records one row per failed request; backs the error tab of /v1/usage/logs. */
  errors: ErrorStore;
  /** 公开人民币价目表；成本估算的唯一价格来源 */
  pricing: RateCard;
  /**
   * 模型可用性统计。默认是「被动观测」：样本来自真实请求，零额外上游调用；
   * `PROBE_ENABLED=1` 时才叠加主动探测。窗口内没样本时面板显示「—」。
   */
  probe: AvailabilityProber | null;
  startTime: number;
  /** Push current concurrency/queue values into the exported gauges. */
  updateGauges: () => void;
}
