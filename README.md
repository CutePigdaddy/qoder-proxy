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
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'
```

流式：

```bash
curl -N http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"hello"}]}'
```

OpenAI SDK：

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:3000/v1", api_key="sk-your-key")
stream = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "hello"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

### 模型名怎么填

解析顺序（大小写、空格、`-`/`_` 都不敏感）：

1. 精确 wire key —— `dmodel`
2. 目录里的显示名 —— `DeepSeek-V4-Pro`
3. `config/models.json` 里的别名 —— `gpt-4o`
4. 都匹配不到则回退到 `MODEL_FALLBACK`（默认 `auto`），响应里的 `model` 字段会告诉你实际用了谁

上游 `model/list` 的常见条目（wire key ← 显示名）：

| wire key | 显示名 | 推理 |
| --- | --- | --- |
| `auto` | Auto | ✅ |
| `qmodel_38max` | Qwen3.8-Max | ✅ |
| `qfmodel` | Qwen3.8-Flash | ✅ |
| `qmodel_latest` | Qwen3.7-Max | ✅ |
| `qmodel` | Qwen3.7-Plus | ✅ |
| `q37fmodel` | Qwen3.7-Flash | ✅ |
| `dmodel` | DeepSeek-V4-Pro | ✅ |
| `dfmodel` | DeepSeek-Flash | ✅ |
| `gmodel` | GLM-5.3 | ✅ |
| `gfmodel` | GLM-5.3-Flash | ✅ |
| `gm51model` | GLM-5.2 | ✅ |
| `kmodel_latest` | Kimi-K3 | ✅ |
| `kmodel` | Kimi-K2.8-Preview | ✅ |
| `mmodel` | MiniMax-M2.7 | ✅ |

> **注意**：直连上游时**只能**传 wire key。传显示名（`DeepSeek-V4-Pro`）会被网关拒成 `400 该模型当前未对账号开放`——本代理已在解析层帮你转换，所以两个名字都能用。
>
> 想知道自己账号当下能用的完整清单与逐模型连通性，跑 `npm run matrix`（会真实消耗少量额度）。

`/v1/models` 返回从上游动态拉取的目录（拉取失败时回落 `auto` / `lite` / `performance` / `ultimate`）。

## 端点

| 方法   | 路径                     | 鉴权 | 说明                       |
| ---- | ---------------------- | -- | ------------------------ |
| POST | `/v1/chat/completions` | ✅  | 对话，支持 `stream` 与 `tools` |
| GET  | `/v1/models`           | ✅  | 模型目录                     |
| GET  | `/health`              | —  | 存活探测，不触上游、不烧额度           |
| GET  | `/metrics`             | —  | Prometheus 文本指标          |

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
| `MODELS_CONFIG_PATH` | `config/models.json` | 别名表                                     |
| `TOKEN_CACHE_PATH`   | `.cache/tokens.json` | jt/jrt 缓存（可丢，重启用 PAT 重换）                |
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
npm test          # 46 个单测：签名、编码、SSE 解包、并发、错误映射、适配层
npm run typecheck
```

签名与编码这类"最容易写错、最难调试"的逻辑用**确定性单测**锁住，不需要真实调用、不烧额度。真实的端到端验证留给 `npm run probe`（手动执行）。

## 已知限制

- **上游协议是逆向事实，不是官方契约**。Qoder 改版可能导致签名或 SSE 结构失效；症状是上游返回含糊的签名失败。此时应重跑 `npm run probe` 并对照 `src/qoder/cosySigner.ts` 中的常量。
- **仅实现 OpenAI 面**。内部有中性 IR，加 Anthropic `/v1/messages` 是新增一个 adapter 的增量工作，不是重构。
- **文本内嵌的工具调用标记未解析**。当前依赖上游原生 `tool_calls`；若模型把工具调用写进正文文本，会被当作普通文本返回。
- **单账号**。凭据层是 `CredentialStore` 抽象，多账号需要另写实现与调度。
- **使用非官方协议路径复用订阅额度，可能违反 Qoder 服务条款**，并存在账号被风控的风险。请自行评估。
