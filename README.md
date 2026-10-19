# qoder-proxy

把 **Qoder 国内版**订阅额度包装成一个标准 **OpenAI 兼容 API**，供 LangChain、Open WebUI、Dify、各类脚本等任意 OpenAI 客户端调用。

完整设计见 [DESIGN.md](./DESIGN.md)。

---

## 它做什么

```
OpenAI 客户端  --/v1/chat/completions-->  qoder-proxy  --COSY 签名 + 置换编码-->  gateway.qoder.com.cn
                                            ^                                        |
                                            |______ 双层 SSE 解包 <------------------|
```

- 入站：标准 OpenAI `chat.completions`（流式 + 非流式）、`/v1/models`。
- 出站：Qoder 国内版私有协议——COSY 签名（RSA + AES-CBC + MD5）、`Encode=1` 置换 base64、双层 SSE 信封。
- 账号：单账号 PAT，`jrt → PAT` 混合刷新，刷新走**单飞锁**（refresh token 一次性，绝不被并发重复消耗）。
- 不 spawn 子进程：纯 HTTP，常驻几十 MB，天然支持并发。
- 工具调用：透传上游原生 `tool_calls`，支持一轮完整 tool 往返。

## 前置条件

- Node.js ≥ 20（开发用 22）
- 一个 Qoder 国内版账号的 PAT：<https://qoder.com.cn/account/integrations>，形如 `pt-...`

## 快速开始

```bash
npm install
cp .env.example .env      # 填入 QODERCN_PAT 和 PROXY_API_KEY
```

`.env` 会被自动加载（`src/env.ts`，Node 22 原生 `process.loadEnvFile`），不需要手动 `export`；真实环境变量优先级高于文件。`PROXY_API_KEY` 是你自己定义的一串随机密钥（客户端用它做 Bearer 认证），可以用下面这条命令生成：

```bash
node -e "console.log('sk-'+require('crypto').randomBytes(32).toString('hex'))"
```

### 第一步：先跑签名探针（强烈建议）

在铺开任何使用之前，先确认**凭据链和 COSY 签名**是通的：

```bash
npm run probe
```

它依次做三件事：PAT 换 job token → 拉取 userinfo → 对 `model/list` 发一次签名 GET。  
全绿说明最脆弱的一层（签名）是对的；失败则问题被隔离在约一百行代码里。

### 第二步：启动

```bash
npm run dev      # 本地热重载
```

```bash
curl http://127.0.0.1:3000/health
```

### 第三步：调用

非流式：

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"DeepSeek-V4-Pro","messages":[{"role":"user","content":"hello"}]}'
```

流式：

```bash
curl -N http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"DeepSeek-V4-Pro","stream":true,"messages":[{"role":"user","content":"hello"}]}'
```

OpenAI SDK：

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:3000/v1", api_key="sk-your-key")
stream = client.chat.completions.create(
    model="DeepSeek-V4-Pro",
    messages=[{"role": "user", "content": "hello"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

### 模型名怎么填

**填显示名就行**，代理内部换成上游 wire key 再转发：客户端写 `DeepSeek-V4-Pro`，真正发给 Qoder 的是 `dmodel`。

映射表在 [`config/models.json`](./config/models.json)：

| 显示名（客户端填这个） | 上游 wire key | 推理 |
| --- | --- | --- |
| `Auto` | `auto` | ✅ |
| `Qwen3.8-Max` | `qmodel_38max` | ✅ |
| `Qwen3.8-Flash` | `qfmodel` | ✅ |
| `Qwen3.7-Max` | `qmodel_latest` | ✅ |
| `Qwen3.7-Plus` | `qmodel` | |
| `Qwen3.7-Flash` | `q37fmodel` | |
| `DeepSeek-V4-Pro` | `dmodel` | ✅ |
| `DeepSeek-Flash` | `dfmodel` | ✅ |
| `GLM-5.3` | `gmodel` | ✅ |
| `GLM-5.3-Flash` | `gfmodel` | |
| `GLM-5.2` | `gm51model` | ✅ |
| `Kimi-K3` | `kmodel_latest` | ✅ |
| `Kimi-K2.8-Preview` | `kmodel` | ✅ |
| `MiniMax-M2.7` | `mmodel` | ✅ |

解析顺序（大小写、空格、`-`/`_` 都不敏感）：

1. 映射表的显示名 —— `DeepSeek-V4-Pro` / `deepseek-v4-pro` / `DeepSeek V4 Pro` 都能命中
2. 上游原始 wire key —— `dmodel`（脚本与旧配置仍可用）
3. `config/models.json` 的 `aliases` —— `gpt-4o` → `Auto`
4. 上游新出现、表里还没有的模型 —— 直接用它的显示名（`/v1/models` 会自动列出来）
5. 都匹配不到 —— 回退 `MODEL_FALLBACK`

响应里的 `model` 字段回显**可读名**：请求 `qwen3.8-max` 会返回 `Qwen3.8-Max`；请求未知名会返回 `Auto` —— 一眼能看出实际跑了哪个模型。

`/v1/models` 的 `id` 就是这些显示名，并额外带一个 `upstream_model` 字段（如 `dmodel`）便于排障。

> **为什么需要这层翻译**：Qoder 聊天端点只认 wire key，直接把显示名发过去会返回 `400 该模型当前未对账号开放`。
>
> 想改名或增删模型：编辑 `config/models.json` 的 `models` 数组后重启。上游新增、表里没有的模型会自动以显示名出现，不需要改配置。
>
> 想知道自己账号当下能用的完整清单与逐模型连通性，跑 `npm run matrix`（会真实消耗少量额度）。

#### 客户端不会拉取 `/v1/models` 时怎么填

Dify「自定义供应商」、Cherry Studio、ChatBox、NextChat、LobeChat、各类 SDK / 脚本这类**要你手打模型名**的地方，按下面三个字段填即可：

| 字段 | 填什么 | 说明 |
| --- | --- | --- |
| Base URL / API 地址 | `https://你的域名/v1` | 必须是 `/v1` 结尾；有的客户端会自动补，见下方 404 排查 |
| API Key | `.env` 里的 `PROXY_API_KEY` | 就是你自己定义的那串 `sk-...`，不是 Qoder 的 PAT |
| 模型名 / Model ID | 下表任选，**填 `Auto` 最省事** | 填显示名（`DeepSeek-V4-Pro` 这种），不要填 `dmodel` 这类内部 key |

可直接复制的模型名（一行一个，多数客户端支持粘贴多行批量导入）：

```
Auto
Qwen3.8-Max
Qwen3.8-Flash
Qwen3.7-Max
Qwen3.7-Plus
Qwen3.7-Flash
DeepSeek-V4-Pro
DeepSeek-Flash
GLM-5.3
GLM-5.3-Flash
GLM-5.2
Kimi-K3
Kimi-K2.8-Preview
MiniMax-M2.7
```

挑选建议：

- **不想纠结就填 `Auto`**——它一定存在，由 Qoder 决定实际模型。
- **想锁定具体模型就填对应显示名**，例如固定用 DeepSeek V4 就填 `DeepSeek-V4-Pro`。
- 便宜/快的档位：`Qwen3.7-Flash`、`Qwen3.8-Flash`、`DeepSeek-Flash`；最强的：`Qwen3.8-Max`、`DeepSeek-V4-Pro`、`Kimi-K3`。

命名上的三条注意事项：

1. **别加供应商前缀**。写成 `qoder/DeepSeek-V4-Pro`、`openai/deepseek-v4-pro` 不匹配任何规则，会**静默回退到 `Auto`**——看起来「能用」，其实换模型了。
2. **大小写、空格、`-`/`_` 都不敏感**。`DeepSeek-V4-Pro`、`deepseek v4 pro`、`DEEPSEEK_V4_PRO` 指向同一个模型；即使客户端改写名字也不影响。
3. **填错不会报错**，一律回退 `Auto`。配置完建议发一次请求，看响应里的 `model` 字段确认实际用了哪个模型。

```bash
# 配置完自检：确认你填的名字解析到了哪个模型
curl -s https://你的域名/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"DeepSeek-V4-Pro","messages":[{"role":"user","content":"ping"}],"max_tokens":8}' \
  | grep -o '"model":"[^"]*"'
```

**Base URL 的 404 排查**：若客户端报 404 但 `https://你的域名/health` 正常，基本都是路径重复——客户端自己补 `/v1`，而你又填了 `/v1`，实际打到了 `/v1/v1/chat/completions`。把 Base URL 改成不带 `/v1` 的裸域名再试。

`/v1/models` 返回的全部是可读显示名（先列 `config/models.json` 里的映射，再补上游新增的模型）；上游目录拉取失败时只回落 `config/models.json` 里的映射。

## 端点

| 方法   | 路径                     | 鉴权 | 说明                       |
| ---- | ---------------------- | -- | ------------------------ |
| POST | `/v1/chat/completions` | ✅  | 对话，支持 `stream` 与 `tools` |
| GET  | `/v1/models`           | ✅  | 模型目录                     |
| GET  | `/v1/quota`            | ✅  | 上游账号剩余额度（默认缓存 60s）       |
| GET  | `/health`              | —  | 存活探测，不触上游、不烧额度           |
| GET  | `/metrics`             | —  | Prometheus 文本指标（仅 compose 内网可抓取） |

### 余量检测 `GET /v1/quota`

把上游 `/api/v2/quota/usage` 与 `/api/v2/user/plan` 归一化成一份快照，按订阅额度、附加额度、组织共享额度分池返回：

```bash
curl -s https://$DOMAIN/v1/quota -H "Authorization: Bearer $PROXY_API_KEY" | jq
```

```json
{
  "unit": "credits",
  "plan": "Free",
  "paidPlan": false,
  "userType": "personal_standard",
  "exceeded": false,
  "periodEndAt": "9999-12-31T00:00:00.000Z",
  "pools": [
    { "kind": "subscription", "total": 0, "used": 0, "remaining": 0, "percentUsed": null, "unit": "credits" },
    { "kind": "addon", "total": 400, "used": 36, "remaining": 364, "percentUsed": 9, "unit": "credits",
      "detailUrl": "https://qoder.com.cn/account/usage" }
  ],
  "total": 400,
  "used": 36,
  "remaining": 364,
  "percentUsed": 9,
  "fetchedAt": "2026-10-19T06:41:12.004Z",
  "cached": false
}
```

- `remaining` / `total` / `used` 是**各池求和**的结果，Free 账号的订阅池为 0，真实余量在 `addOnQuota` 里。
- 默认命中 60 秒缓存（响应头 `X-Quota-Cached: true`）；加 `?refresh=1` 强制回源，适合面板的“刷新”按钮。
- 上游失败时返回 `502` + `code: quota_unavailable`，不会影响 `/v1/chat/completions`。
- 同余额也会写进 Prometheus：`qoder_quota_remaining`、`qoder_quota_total`、`qoder_quota_used`、`qoder_quota_fetch_total{result}`。

## 配置

| 变量                   | 默认                   | 说明                                      |
| -------------------- | -------------------- | --------------------------------------- |
| `QODERCN_PAT`        | **必填**               | 国内版 PAT，`pt-...`。只读入内存，**绝不落盘、绝不入日志**   |
| `PROXY_API_KEY`      | **必填**               | 客户端密钥。为空则所有 `/v1/*` 返回 503（fail-closed） |
| `PORT`               | `3000`               | 监听端口                                    |
| `CONCURRENCY`        | `3`                  | 同时进上游的请求上限                              |
| `QUEUE_LIMIT`        | `20`                 | 等待队列上限，占满即 429 + `Retry-After`          |
| `REQUEST_TIMEOUT_MS` | `120000`             | 单请求总超时                                  |
| `BODY_LIMIT`         | `10485760`           | 请求体上限（10 MB）                            |
| `MODEL_FALLBACK`     | `auto`               | 未知名模型的回退档位                              |
| `MODELS_CONFIG_PATH` | `config/models.json` | 模型映射表（显示名 → wire key）+ 别名表           |
| `TOKEN_CACHE_PATH`   | `.cache/tokens.json` | jt/jrt 缓存（可丢，重启用 PAT 重换）                |
| `QODER_QUOTA_TTL_MS` | `60000`              | `/v1/quota` 缓存时长，`0` 表示每次都回源            |
| `LOG_LEVEL`          | `info`               | pino 级别                                 |
| `DOMAIN`             | —                    | 仅 Caddyfile 使用                          |

上游主机可用 `QODER_CN_BASE_URL` / `QODER_CN_OPENAPI_URL` 覆盖（企业 VPC 或测试环境）。

## 部署

```bash
# 云上
docker compose up -d --build
curl https://$DOMAIN/health
```

- **Dockerfile** 多阶段构建，运行时只带 prod 依赖。
- **Caddy** 前置终结 TLS（自动签发/续期 Let's Encrypt），`flush_interval -1` 保证 SSE 不被缓冲。网关容器只听 HTTP。
- 本地与云上**同一套 compose**，只换 `.env`；端口默认只绑 `127.0.0.1`，由 Caddy 对外。
- 机型：1C2G 起步可用，2C2G 更稳。

## 运维要点

- **并发是硬约束**：单账号共享同一配额与同一条 token 链。`CONCURRENCY` 默认 3 是保守值，调高前先压测。
- **背压存在**：队列满返回 429，客户端应尊重 `Retry-After`。
- **客户端断开即 abort 上游**，不会为已离开的请求继续消耗额度。
- **日志不含正文与凭据**：每请求一行元数据（模型、耗时、状态、并发）。错误消息会先做 token 形态脱敏。
- **配额**：`qoder_quota_remaining` 指标已预留，但未做告警开关（按设计约定），需要时在 Prometheus 侧接规则。

## 测试

```bash
npm test          # 48 个单测：签名、编码、SSE 解包、并发、错误映射、模型解析、适配层
npm run typecheck
```

签名与编码这类"最容易写错、最难调试"的逻辑用**确定性单测**锁住，不需要真实调用、不烧额度。真实的端到端验证留给 `npm run probe`（手动执行）。

## 已知限制

- **上游协议是逆向事实，不是官方契约**。Qoder 改版可能导致签名或 SSE 结构失效；症状是上游返回含糊的签名失败。此时应重跑 `npm run probe` 并对照 `src/qoder/cosySigner.ts` 中的常量。
- **仅实现 OpenAI 面**。内部有中性 IR，加 Anthropic `/v1/messages` 是新增一个 adapter 的增量工作，不是重构。
- **文本内嵌的工具调用标记未解析**。当前依赖上游原生 `tool_calls`；若模型把工具调用写进正文文本，会被当作普通文本返回。
- **单账号**。凭据层是 `CredentialStore` 抽象，多账号需要另写实现与调度。
- **使用非官方协议路径复用订阅额度，可能违反 Qoder 服务条款**，并存在账号被风控的风险。请自行评估。
