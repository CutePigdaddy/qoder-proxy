# 调用示例

网关默认跑在 `http://127.0.0.1:3000`，OpenAI 兼容前缀是 `/v1`，鉴权用 `Authorization: Bearer <PROXY_API_KEY>`。

三个示例都会自动读取项目根目录的 `.env`，所以配好 `.env` 后直接跑即可。

| 文件 | 依赖 | 内容 |
|---|---|---|
| `curl.sh` | 无 | 模型列表、非流式、原始 SSE |
| `node_fetch.mjs` | 无（原生 fetch） | 非流式 + 流式，手写 SSE 解析 |
| `python_openai.py` | `pip install openai` | 非流式、流式、完整工具调用往返 |

```bash
bash examples/curl.sh
node examples/node_fetch.mjs
pip install openai && python examples/python_openai.py
```

## 其他客户端接入

**Open WebUI / Dify / AnythingLLM / Cherry Studio** 等：在「OpenAI 兼容」设置里填

- Base URL：`http://你的地址:3000/v1`
- API Key：`.env` 里的 `PROXY_API_KEY`
- 模型：随便填，未知名会回退到 `auto`

**LangChain（Python）**

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="auto",
    base_url="http://127.0.0.1:3000/v1",
    api_key="sk-你的 PROXY_API_KEY",
)
print(llm.invoke("你好").content)
```

**OpenAI Python SDK / Node SDK / LlamaIndex** 等都只是把 `base_url` 指过来、`api_key` 换掉，其余不用改。

## 注意

- 当前只实现了 **OpenAI 协议**。Claude Code 这类只认 Anthropic `/v1/messages` 的客户端**不能**直接接；需要的话按 DESIGN.md 4.1 加一个 adapter。
- 网关是单账号、有界并发（默认 3）。并发打满会返回 `429` 并带 `Retry-After`，客户端要能重试。
- 流式输出里如果出现 `"error"` 帧而不是 `finish_reason`，说明上游中途失败；此时不要把已收到的半截内容当最终答案。
