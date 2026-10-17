#!/usr/bin/env bash
# Zero-dependency examples. Assumes the gateway runs on 127.0.0.1:3000.
set -euo pipefail

BASE="${PROXY_BASE_URL:-http://127.0.0.1:3000/v1}"
KEY="${PROXY_API_KEY:?set PROXY_API_KEY first}"
MODEL="${PROXY_MODEL:-auto}"

echo "== models =="
curl -s "$BASE/models" -H "Authorization: Bearer $KEY" | head -c 600; echo

echo
echo "== non-stream =="
curl -s "$BASE/chat/completions" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"用一句话解释什么是反向代理\"}]}"

echo
echo "== stream (raw SSE) =="
curl -sN "$BASE/chat/completions" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"数到五，每个数字一行\"}]}"
