# qoder-proxy 项目设计文档

> 把 Qoder 国内版订阅额度，包装成一个通用的 OpenAI 兼容 API，供任意 OpenAI 客户端（LangChain、Open WebUI、Dify、脚本等）调用。

本文档是设计拷问（grill-me）后的共识落地，所有关键决策已锁定，可直接据此开工。

---

## 1. 目标与定位

- **形态**：API 改写层（协议转换网关）。不是透明中转，不是账号池。
- **入站**：标准 OpenAI `/v1/chat/completions`（流式 + 非流式）+ `/v1/models`。
- **出站**：Qoder 国内版私有协议（COSY 签名 + 置换 base64 + 双层 SSE 信封）。
- **账号**：单账号（一个国内版 PAT）。
- **能力档位**：对话 + 工具调用（function calling）。不含 Agent runtime。

## 2. 上游情报（已核实，国内版）

| 环节 | 端点 |
|---|---|
| 登录 / 换 token / 用户信息 / 配额 | `openapi.qoder.com.cn` |
| 模型列表 + 聊天网关 | `gateway.qoder.com.cn` |
| 聊天 SSE | `gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common` |
| 模型目录 | `/algo/api/v2/model/list` |
| 配额 | `/api/v2/quota/usage` |

**四个协议难点（必须自己实现，有公开先例可对照移植）：**

1. **PAT 不能直接调 API**：`pt-` PAT 先换短时 job token（`jt-`）+ job refresh token（`jrt-`）。国内版官方 CLI 实际走 device token 直接聊天——先试 job token，被拒（4xx）回退 device token 流程。裸 token **无 silent refresh**，refresh token 用过即废。
2. **COSY 签名**：每个网关请求带 `Cosy-*` 头 + `Authorization: Bearer COSY...`，签名是 RSA + AES-CBC + MD5 三重组合（对 base64 负载、RSA 包裹的 AES 密钥、时间戳、请求体、签名路径做 MD5）。
3. **请求体置换编码**：query 里 `Encode=1` 表示 JSON body 先 base64、再按置换字母表逐字符替换、最后按三分之一旋转。
4. **双层 SSE**：每个 `data:` 帧是信封对象，其 `body` 字段本身又是 JSON 字符串，里面才是 OpenAI 风格 chunk。

**公开参考项目：**

- `CLIProxyAPI` —— Qoder 协议逆向的源头，多数先例在 MIT 授权中注明参考它。
- `pi-qoder-provider`（minglu6/pi-provider-qoder）—— 双区域、PAT 换 job token、动态模型目录、effort 映射、DSML 工具解析，最完整。
- `opencode-qoder-auth`（magpie-community）—— 国内版 device token 回退、双层 `[DONE]` SSE 信封、错误码映射最细。
- `dsh-connect-qoder` —— 置换 base64（`Encode=1`）、COSY 签名头、WAF bypass。

## 3. 技术栈

| 项 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript / Node.js 22 | 先例全是 TS，签名与编码逻辑可直接对照移植 |
| HTTP 框架 | Hono | Web Streams 原生，`streamSSE` 直接对上双层 SSE，管道一路不落缓冲 |
| 密码学 | Node 内置 `crypto` | RSA / AES-CBC / MD5 全覆盖，零依赖 |
| 配置校验 | zod | env 与 `models.json` 启动期校验，配错即失败 |
| 日志 | pino | 结构化 JSON，低开销 |
| 指标 | Prometheus 文本格式（自实现） | 无重依赖 |
| 测试 | vitest + MSW | 单测跑脱敏 fixtures，集成测 mock 上游 |

## 4. 架构分层

```
Client (OpenAI SDK / LangChain / Open WebUI / 脚本)
   |  OpenAI 协议, Authorization: Bearer PROXY_API_KEY
   v
+-----------------------------------------------+
| HTTP 层 (Hono)                                  |
|  - auth 中间件（恒定时间比较, fail-closed）      |
|  - body 大小上限（默认 10MB）                    |
|  - pino 请求日志（仅元数据）                     |
|  - 路由: /v1/chat/completions /v1/models         |
|          /health /metrics                        |
+-----------------------------------------------+
| 并发层                                          |
|  - 有界队列 + 背压（满则 429 + Retry-After）     |
|  - 有界并发信号量（默认 3, 可配）                |
|  - 客户端断开 -> AbortController -> 上游 abort   |
+-----------------------------------------------+
| 协议层 (OpenAI <-> IR)                          |
|  - requestAdapter: OpenAI 请求 -> IR             |
|  - modelResolver: 别名表 + auto 回退             |
|  - streamAdapter: IR 事件 -> OpenAI SSE chunk    |
|  - 工具编解码: Qoder DSML/XML/JSON <-> tool_calls|
+-----------------------------------------------+
| Qoder 上游层 (UpstreamClient 接口)              |
|  - CredentialStore（单飞刷新, jrt->PAT 回退）    |
|  - cosySigner（RSA/AES-CBC/MD5）                 |
|  - bodyCodec（置换 base64, Encode=1）            |
|  - sseDecoder（双层信封 -> IR 事件）             |
|  - modelCatalog（拉取 + 缓存）                   |
|  - quota（/api/v2/quota/usage）                  |
+-----------------------------------------------+
   |  COSY 签名 + 置换编码
   v
gateway.qoder.com.cn / openapi.qoder.com.cn
```

### 4.1 内部表示（IR）

一个中性的消息/事件模型，对外协议 adapter 都映射到它：

- `IRMessage[]`：role、content blocks（text/image）、tool_calls、tool_results。
- `IREvent` 流：`text-delta` / `reasoning-delta` / `tool-call-start` / `tool-call-args-delta` / `tool-call-end` / `usage` / `done` / `error`。

**意义**：协议差异被隔离在最外层 adapter。上游层与并发层不关心对外是 OpenAI 还是 Anthropic——将来加 Anthropic 面（`/v1/messages`，Claude Code 刚需）只是新增一个 adapter，不需重构。

### 4.2 为什么坚持纯 HTTP 而非子进程

同类项目多为「每请求 spawn 一个 `qodercli` 子进程」。本设计**明确排除**该方案：

| | 子进程方案 | 纯 HTTP（本设计） |
|---|---|---|
| 单请求内存 | ~1GB 尖峰 | 几十 MB 常驻 |
| 冷启动 | 数秒至十几秒 | 无 |
| 并发 | 约 1 请求 / 1-2 vCPU | 有界并发可配 |
| 云上机型 | 需 4C4G | 1C2G 可跑 |
| 风险 | 低（协议变更由 CLI 吸收） | 中（上游改版需跟进） |

「给通用途径调用」意味着并发与资源效率是真实约束，子进程方案在云上长期跑不划算。风险由 `UpstreamClient` 接口隔离——若某天签名被彻底封锁，可加一个子进程实现作为降级后备，不动上层。

## 5. 目录结构

```
qoder_proxy/
+-- src/
|   +-- index.ts                 # 入口, Hono app bootstrap
|   +-- config.ts                # env + 配置文件加载 + zod 校验
|   +-- server/
|   |   +-- app.ts               # 中间件装配
|   |   +-- routes/
|   |   |   +-- chat.ts          # POST /v1/chat/completions
|   |   |   +-- models.ts        # GET  /v1/models
|   |   |   +-- health.ts        # GET  /health
|   |   |   +-- metrics.ts       # GET  /metrics
|   |   +-- middleware/
|   |       +-- auth.ts          # 恒定时间 Bearer 校验, fail-closed
|   |       +-- bodyLimit.ts
|   |       +-- logging.ts
|   +-- concurrency/
|   |   +-- semaphore.ts         # 有界并发
|   |   +-- queue.ts             # 有界队列 + 背压
|   |   +-- singleFlight.ts      # token 刷新去重
|   +-- ir/
|   |   +-- types.ts             # 中性消息/事件模型
|   +-- openai/                  # OpenAI <-> IR
|   |   +-- types.ts
|   |   +-- requestAdapter.ts
|   |   +-- streamAdapter.ts
|   |   +-- nonStreamAdapter.ts
|   |   +-- modelResolver.ts     # 别名表 + auto 回退
|   +-- tools/                   # 工具调用编解码
|   |   +-- dsmlParser.ts        # Qoder DSML/XML/JSON -> IR tool calls
|   |   +-- toolTurnBuilder.ts   # IR tool results -> Qoder 原生 tool turn
|   +-- qoder/
|   |   +-- client.ts            # UpstreamClient 实现
|   |   +-- credentialStore.ts   # PAT->jt/jrt, device 回退, 刷新
|   |   +-- cosySigner.ts        # RSA/AES-CBC/MD5 COSY 信封
|   |   +-- bodyCodec.ts         # 置换 base64 (Encode=1)
|   |   +-- sseDecoder.ts        # 双层 SSE 信封 -> IR 事件
|   |   +-- modelCatalog.ts      # 模型目录 + 缓存
|   |   +-- quota.ts             # 配额查询
|   |   +-- endpoints.ts         # 国内版 hosts / paths
|   +-- obs/
|   |   +-- logger.ts
|   |   +-- metrics.ts
|   +-- util/
|       +-- errors.ts            # Qoder code -> HTTP 映射
|       +-- timing.ts
+-- test/
|   +-- fixtures/                # 捕获脱敏的上游帧
|   +-- unit/
|   +-- integration/
|   +-- smoke/                   # env flag 门控的真实端点验证
+-- config/
|   +-- models.json              # 别名表（可编辑, 不写死代码）
+-- .env.example
+-- Dockerfile                   # 多阶段构建
+-- docker-compose.yml
+-- Caddyfile                    # TLS 终结（DOMAIN env）
+-- package.json
+-- tsconfig.json
+-- README.md
+-- DESIGN.md
```

## 6. 关键数据流

### 6.1 聊天（流式）

1. 客户端 `POST /v1/chat/completions {model, messages, tools?, stream:true}`
2. auth 中间件 -> 队列准入（满则 429）-> 信号量获取
3. `requestAdapter`：OpenAI -> IR；`modelResolver`：模型名 -> Qoder 模型
4. `CredentialStore.getValidToken()`（临近过期则单飞刷新）
5. 构造 Qoder body（IR -> Qoder 原生）-> `bodyCodec` 编码 -> `cosySigner` 签名
6. `fetch` SSE 到 `gateway.qoder.com.cn/.../agent_chat_generation`
7. `sseDecoder`：双层信封 -> IR 事件；`dsmlParser`：工具调用标记 -> IR
8. `streamAdapter`：IR 事件 -> OpenAI SSE chunk，管道推给客户端
9. 客户端断开 -> `AbortController` -> 上游 abort（不白烧额度）
10. 释放信号量；记元数据日志；更新 metrics

### 6.2 Token 刷新（单飞锁）

`getValidToken()` 逻辑：

- **有效** -> 直接返回。
- **临近过期** -> 抢刷新锁。**首个**调用者执行 jrt 刷新；若 4xx 则回退用 PAT 重新 exchange；成功后持久化 jt/jrt 缓存。**其余**并发调用者 await 并复用同一结果。
- **绝不重复使用已花掉的 jrt**（refresh token 用过即废，重复发送会互相踩死）。
- **PAT 只从环境变量读、常驻内存、绝不落盘**；换来的短时 jt/jrt 缓存到本地文件（丢失无害，重启拿 PAT 重换）。
- 刷新失败且 PAT 也失效 -> 对外 401，日志标注需人工更新 PAT。

**为什么单飞锁是必须的**：并发请求同时发现 token 过期、同时去刷新，而 refresh token 一次性有效 —— 后发的刷新会因 jrt 已作废而失败，导致整条 token 链崩掉、全部请求 401。这是本设计最高优先级的正确性约束。

## 7. 错误码映射

参考 `opencode-qoder-auth` 的映射表：

| Qoder 返回 | 对外 HTTP |
|---|---|
| 登录被拒（无 code 或 105） | 401 |
| 配额（110, 112-119, 122） | 429 |
| 档位资源限制（10605 + `RESOURCE_LIMIT`，队列为空） | 503 + `Retry-After: 60`，**不重试** |
| 繁忙/排队（10605，`queueCount > 0`） | 503 + `Retry-After`（取 `retryAfterSeconds`，缺省 30） |
| 答案开始前失败 | 透传 Qoder status |
| 答案开始后失败 | 流以 error 帧结束（不可再改状态码） |
| 其他 | 502 |

**重试边界**（客户端可观测的契约，改动需同步本文与 README）：

| 场景 | 网关行为 |
|---|---|
| 429 限流 / 503 繁忙，且**尚未流出任何内容** | 内部退避重试最多 2 次：尊重 `retryAfterSeconds`，否则 2s/4s，单次上限 `RETRY_MAX_WAIT_MS`；等待期间客户端断开则立即放弃并释放并发槽 |
| 429 **配额耗尽**（业务码 110, 112-119, 122） | **终态，不重试**，立即透传 |
| 503 **档位资源限制**（10605 + `RESOURCE_LIMIT`，`queueCount = 0`） | **终态，不重试**；`Retry-After: 60`（上游给的 2s 只对队满有意义） |
| 401 凭据被拒 | 强制刷新一次后重试；仍失败则透传 |
| 已流出内容后失败 | 不重试，以流内 error 帧结束（状态码此时已无法更改） |

同一个 429 承载「限流（瞬态）」与「配额（终态）」两种语义，所以「是否可重试」必须由错误类型 `QuotaExhaustedError` 判定，**不能只看 status**。

10605 同理承载两种语义，要靠 `subCode` 与队列状态区分：`subCode: "RESOURCE_LIMIT"` 配合 `queueCount: 0`、`isQueued: false`、`serviceAvailable: true`，意思是服务正常、队列为空，只是这个账号档位（`queueType: p3`）当前没有资源份额——此时重试只会把上游那个 `retryAfterSeconds: 2` 白等两次（实测每次失败从 4–5s 降到 0.2–0.3s）。判定由类型 `ResourceLimitError` 承担，同样**先于状态码**：503 既可能是真拥堵，也可能是档位无资源。

**工具调用解析失败的处理**（先例 #132 的教训）：流中途截断或无法解析的 tool call，**绝不**当作正常文本答案转发给客户端 —— 应以错误结束该轮（502 或流的 error 帧且不带 finish reason），让上层 agent 重试。代码块或正文里的假标签必须保持为纯文本。

## 8. 配置

### 8.1 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `QODERCN_PAT` | 必填 | 国内版 PAT，**绝不打印 / 绝不落盘** |
| `PROXY_API_KEY` | 必填 | 对外鉴权 key；**为空则 fail-closed 拒绝所有请求** |
| `PORT` | 3000 | 监听端口 |
| `CONCURRENCY` | 3 | 上游并发上限 |
| `QUEUE_LIMIT` | 20 | 等待队列上限，满则 429 |
| `REQUEST_TIMEOUT_MS` | 600000 | 单请求总超时，**从进入队列开始计时**（排队同样受限） |
| `RETRY_MAX_WAIT_MS` | 30000 | 单次退避等待上限（限流/繁忙内部重试用） |
| `BODY_LIMIT` | 10485760 | 请求体上限（10MB） |
| `MODEL_FALLBACK` | auto | 未知模型名回退档位（`config/models.json` 未写 `fallback` 时生效） |
| `TOKEN_CACHE_PATH` | `./.cache/tokens.json` | jt/jrt 缓存位置（可丢） |
| `USAGE_LOG_PATH` | `./.cache/usage.jsonl` | 每请求一行用量明细（面板数据源，环形保留 5000 条） |
| `ERROR_LOG_PATH` | `./.cache/errors.jsonl` | 失败请求的错误明细（日志页「错误」页签，环形保留 2000 条） |
| `TOKEN_MARKER_MODE` | move | `<total_tokens>` 标记处理：move/strip/keep |
| `CACHE_DIAGNOSTICS` | 0 | `1` 时输出缓存哈希网格（排查用，默认关） |
| `DOMAIN` | 部署时填 | Caddyfile 签发证书用 |
| `LOG_LEVEL` | info | pino 级别（写入 `.env` 亦生效） |

### 8.2 模型别名表（`config/models.json`）

`/v1/models` 返回从 `/algo/api/v2/model/list` **动态拉取并缓存**的真实目录，别名表只做映射，不硬编码模型清单：

```json
{
  "aliases": {
    "gpt-4o": "auto",
    "gpt-4": "performance",
    "claude-sonnet-4-5": "performance",
    "claude-3-5-haiku": "lite",
    "deepseek-chat": "auto"
  },
  "fallback": "auto"
}
```

解析顺序：**真实名直通 -> 别名表 -> `fallback`**。未知名不报 404，保证"总能跑通"。

### 8.3 effort 与 context_length

- **reasoning effort**：从模型自身 `thinking_config` 的档位中选最接近请求值的一档；平局取较高档；未请求则用模型默认；请求 "none" 但模型不能关思考时取最低档。
- **context_length**：从模型 `context_config` 的窗口（如 200K / 400K / 1M）中选：请求能装进默认窗口则用默认；否则取能容纳的最小窗口；再否则取最大。**大窗口更贵，只在必要时请求。**

## 9. 部署

### 9.1 本地开发

```bash
cp .env.example .env        # 填 QODERCN_PAT / PROXY_API_KEY
npm install
npm run dev                 # 热重载
npm test                    # 单测（脱敏 fixtures，不烧额度）
npm run smoke               # 真实端点验证（手动，env flag 门控）
```

### 9.2 云上

```bash
docker compose up -d --build
curl https://$DOMAIN/health
```

- **Dockerfile 多阶段**：builder 装 devDeps 编译 TS -> runtime 只留 prod deps + 编译产物。
- **同一套 compose 跑本地与云上**，只换 env，消除"本地能跑云上不行"。
- **TLS**：Caddy 前置终结（自动 Let's Encrypt 签发 + 续期），本服务只听 HTTP。若域名已挂 Cloudflare，改为 CF 终结、回源 HTTP。
- **healthcheck**：compose 配 `/health` 探活，失败自动重启。
- **机型**：1C2G 起步可跑；建议 2C2G。

## 10. 可观测性与安全

**日志**：pino 结构化 JSON，每请求一行 —— 模型、耗时、上游状态码、token 数、是否流式、队列等待时长。
**绝不记录**：PAT、job token、完整请求体 / 响应体（含敏感对话内容）。

**面板日志**（`/v1/usage/dashboard` + `/v1/usage/logs`）：用量与错误分别落两份 JSONL
（`UsageStore` / `ErrorStore`，内存环形缓冲 + 追加写 + 超限压缩），重启不丢。
错误日志只记失败请求，字段是「环节（validate/queue/upstream）+ 语义类型
（quota/credential/busy/rate-limit/timeout/client-gone/invalid/input-limit/upstream）
+ 脱敏截断消息」——429 的两种语义靠类型区分，不靠状态码。错误单独成文件是因为
错误量远小于成功量，混进用量环形缓冲会被几分钟挤掉。校验类失败（非法 JSON、
schema 不合、触发网关输入上限）只进错误日志、不进用量统计，`errorRate` 口径不变。

**指标**（`/metrics`，Prometheus 文本格式）：

- `qoder_requests_total{model,status}` —— 请求计数
- `qoder_request_duration_seconds` —— 直方图
- `qoder_concurrency_inflight` / `qoder_queue_depth` —— 仪表盘
- `qoder_token_refresh_total{result}` —— 刷新成功/失败/jrt 回退 PAT 次数
- `qoder_upstream_errors_total{code}` —— 上游错误码分布
- `qoder_quota_remaining` —— 配额（暴露但**不做告警**，按用户要求；可外部接 Prometheus alert）

**安全**：

- API Key 用 `crypto.timingSafeEqual` 恒定时间比较（防时序攻击）。
- **fail-closed**：`PROXY_API_KEY` 未配置时拒绝所有请求并启动告警，防止忘配 key 裸奔公网。
- 请求体大小上限，防大包打爆内存。
- 客户端断开 -> 主动 abort 上游，**不白烧 Qoder 额度**。

## 11. 测试策略

逆向项目最大的风险是"上游改版后静默错乱"，因此测试重心在**确定性回归**：

| 层 | 手段 | 说明 |
|---|---|---|
| 单元 | vitest + 脱敏 fixtures | `cosySigner` / `bodyCodec` / `sseDecoder` / `dsmlParser` 录制一次真实帧、抹掉 token 即成回归基线。不烧额度、可进 CI |
| 集成 | MSW mock 上游 | 完整请求周期：鉴权 -> 排队 -> 签名 -> 解包 -> SSE 输出 |
| 单飞锁 | 并发单测 | N 个并发同时触发过期，断言只发出**一次** refresh，且 jrt 未被重复使用 |
| 冒烟 | env flag 门控脚本 | 真实端点验证，手动跑，不进 CI |

**fixtures 捕获方法**：开发期加一个 `CAPTURE_FIXTURES=1` 开关，把真实上游帧写入 `test/fixtures/`，随后跑脱敏脚本抹掉 token 字段。

## 12. 构建顺序（里程碑）

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M1 骨架** | Hono app、config、`/health`、auth 中间件、compose | 服务能起；未配 `PROXY_API_KEY` 时拒绝所有请求 |
| **M2 凭据** | CredentialStore：PAT -> jt/jrt、刷新、单飞锁、缓存 | 用 `/algo/api/v2/model/list`（简单鉴权 GET）验证 token 链通 |
| **M3 签名/编码** | cosySigner + bodyCodec + sseDecoder | 单元测试过捕获 fixtures |
| **M4 非流式聊天** | 请求 -> IR -> Qoder -> IR -> OpenAI JSON | **首个端到端跑通** |
| **M5 流式聊天** | SSE 管道、客户端断开传播 | 流式输出正常 + abort 生效 |
| **M6 工具调用** | dsmlParser + toolTurnBuilder | 带 tools 的请求完成一轮 tool 往返 |
| **M7 并发/背压** | semaphore + queue + 429 | 压测不 OOM、不雪崩 |
| **M8 可观测性** | pino + `/metrics` + 配额查询 | 指标可被抓取 |
| **M9 部署** | Dockerfile + compose + Caddyfile | 云上 `compose up -d` 一条命令通 |

**关键路径**：M2 -> M3 -> M4。M3 是全项目最大不确定性来源（COSY 签名 + 置换编码，写错了上游只回一个含糊的签名失败）。**建议 M3 之前先做一次"签名探针"**：写一个最小脚本，只做 PAT 换 token + 签名 + 打一次 `model/list`，验证签名逻辑正确后再铺开架构。这样能把最大的风险前置到几十行代码里解决，而不是等整个框架搭完才发现签名不通。

---

## 附：决策记录速查

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 项目形态 | D — API 改写层，把 Qoder 额度包装成通用 API |
| 2 | 上游通信 | 纯 HTTP 直连（排除子进程方案） |
| 3 | 区域 | 国内版（qoder.com.cn） |
| 4 | 凭据来源 | 官网 PAT |
| 5 | 能力档位 | 对话 + 工具调用（function calling），无 Agent runtime |
| 6 | 语言 | TypeScript / Node.js 22 |
| 7 | 账号规模 | 单账号，但 `CredentialStore` 抽象为可扩展接口 |
| 8 | 刷新策略 | 混合：jrt -> PAT 回退 -> 全断才 401 |
| 9 | PAT 存储 | 只读环境变量、绝不落盘；jt/jrt 缓存落盘 |
| 10 | 对外协议 | 仅 OpenAI（IR 已为 Anthropic 预留） |
| 11 | 对外鉴权 | 单一静态 Key，恒定时间比较，fail-closed |
| 12 | 模型映射 | 透传 + 别名表 + `auto` 回退 |
| 13 | HTTP 框架 | Hono |
| 14 | 并发 | 有界并发（默认 3）+ 刷新单飞锁 |
| 15 | 背压 | 有界队列（默认 20）+ 429/Retry-After + 请求超时 |
| 16 | 部署 | Docker + docker-compose（本地云上一套） |
| 17 | TLS | Caddy 前置终结（域名待部署时填） |
| 18 | 可观测性 | pino 结构化日志 + `/health` + `/metrics` |
| 19 | 配额告警 | 不做（metrics 暴露，可外部接） |

