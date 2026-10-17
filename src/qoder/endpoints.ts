/**
 * Qoder CN endpoint set. Public-cloud hosts by default; every host is
 * overridable so an enterprise VPC tenant or a staging deployment can point
 * elsewhere without a code change.
 */

export interface Endpoints {
  gateway: string;
  openapi: string;
  chat: string;
  modelList: string;
  exchange: string;
  refresh: string;
  userInfo: string;
  usage: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function resolveEndpoints(env: NodeJS.ProcessEnv = process.env): Endpoints {
  const gateway = trimTrailingSlash(env.QODER_CN_BASE_URL ?? 'https://gateway.qoder.com.cn');
  const openapi = trimTrailingSlash(env.QODER_CN_OPENAPI_URL ?? 'https://openapi.qoder.com.cn');
  return {
    gateway,
    openapi,
    chat: `${gateway}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`,
    modelList: `${gateway}/algo/api/v2/model/list`,
    exchange: `${openapi}/api/v1/jobToken/exchange`,
    refresh: `${openapi}/api/v1/jobToken/refresh`,
    userInfo: `${openapi}/api/v1/userinfo`,
    usage: `${openapi}/api/v2/quota/usage`,
  };
}
