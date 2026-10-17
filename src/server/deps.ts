import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { AdmissionGate } from '../concurrency/admission.js';
import type { ModelResolver } from '../openai/modelResolver.js';
import type { QoderClient } from '../qoder/client.js';
import type { CredentialStore } from '../qoder/credentialStore.js';
import type { ModelCatalog } from '../qoder/modelCatalog.js';

export interface Deps {
  config: AppConfig;
  logger: Logger;
  credentials: CredentialStore;
  catalog: ModelCatalog;
  client: QoderClient;
  resolver: ModelResolver;
  gate: AdmissionGate;
  startTime: number;
  /** Push current concurrency/queue values into the exported gauges. */
  updateGauges: () => void;
}
