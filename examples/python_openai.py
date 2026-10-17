"""OpenAI Python SDK example: non-stream, stream, and a full tool-calling round trip.

    pip install openai
    python examples/python_openai.py
"""

import json
import os
import pathlib

from openai import OpenAI


def load_env() -> None:
    """Read .env so you do not have to export variables by hand."""
    env_path = pathlib.Path(__file__).resolve().parent.parent / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


load_env()

client = OpenAI(
    base_url=os.getenv("PROXY_BASE_URL", "http://127.0.0.1:3000/v1"),
    api_key=os.environ["PROXY_API_KEY"],
)
MODEL = os.getenv("PROXY_MODEL", "Auto")


def demo_non_stream() -> None:
    print("== non-stream ==")
    response = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": "用一句话解释什么是反向代理"}],
    )
    print(response.choices[0].message.content)
    print(f"(usage: {response.usage})\n")


def demo_stream() -> None:
    print("== stream ==")
    stream = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": "数到五，每个数字一行"}],
        stream=True,
    )
    for chunk in stream:
        delta = chunk.choices[0].delta if chunk.choices else None
        if delta and delta.content:
            print(delta.content, end="", flush=True)
    print("\n")


def get_weather(city: str) -> str:
    """Stand-in for a real tool."""
    return json.dumps({"city": city, "temp_c": 22, "condition": "clear"})


def demo_tools() -> None:
    print("== tool calling ==")
    tools = [
        {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get the current weather for a city",
                "parameters": {
                    "type": "object",
                    "properties": {"city": {"type": "string", "description": "City name"}},
                    "required": ["city"],
                },
            },
        }
    ]

    messages = [
        {"role": "user", "content": "杭州现在天气怎么样？请调用工具查询。"},
    ]

    first = client.chat.completions.create(model=MODEL, messages=messages, tools=tools)
    message = first.choices[0].message
    print(f"finish_reason={first.choices[0].finish_reason}")
    print(f"tool_calls={message.tool_calls}")

    if not message.tool_calls:
        print("model answered directly:", message.content, "\n")
        return

    messages.append(message)

    for call in message.tool_calls:
        args = json.loads(call.function.arguments or "{}")
        result = get_weather(args.get("city", "unknown"))
        print(f"-> {call.function.name}({args}) = {result}")
        messages.append({"role": "tool", "tool_call_id": call.id, "content": result})

    second = client.chat.completions.create(model=MODEL, messages=messages, tools=tools)
    print("final:", second.choices[0].message.content, "\n")


if __name__ == "__main__":
    demo_non_stream()
    demo_stream()
    demo_tools()
