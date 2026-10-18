#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# switch-domain.sh
#
# 用途：等待域名的 DNS 委派真正生效，生效后自动把 .env 的 DOMAIN 切到该域名，
#       重建 caddy 容器让 Let's Encrypt 签发正式证书，并做端到端验证。
#
# 为什么需要它：域名在注册商处"已注册 + 已配 A 记录"并不等于全球可解析。
# 注册局必须先发布该域名的 NS 委派，递归 DNS 才能问到权威服务器。新注册的
# 域名这一段可能有延迟，期间任何 ACME 验证都会失败。本脚本只在解析真的通
# 之后才动作，避免无谓失败把 Let's Encrypt 的失败配额耗掉。
#
# 用法：
#   bash scripts/switch-domain.sh              # 前台等待（Ctrl+C 可中断）
#   nohup bash scripts/switch-domain.sh &      # 后台等待，日志在 .domain-switch.log
# ---------------------------------------------------------------------------
set -uo pipefail

DOMAIN="${DOMAIN_TARGET:-pigdaddy.xyz}"
EXPECT_IP="${EXPECT_IP:-120.55.48.92}"
PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG_FILE="$PROJECT_DIR/.domain-switch.log"
LOCK_FILE="/tmp/qoder-domain-switch.lock"
MAX_HOURS="${MAX_HOURS:-8}"
INTERVAL="${INTERVAL:-90}"

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG_FILE"; }

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "已有 switch-domain.sh 实例在运行，本次退出。"
  exit 0
fi

command -v dig >/dev/null 2>&1 || { log "缺少 dig（apt-get install -y dnsutils）"; exit 1; }
[ -f "$PROJECT_DIR/.env" ] || { log "找不到 $PROJECT_DIR/.env"; exit 1; }
[ -f "$PROJECT_DIR/docker-compose.yml" ] || { log "找不到 docker-compose.yml"; exit 1; }

cd "$PROJECT_DIR" || exit 1

if [ -f .domain-switch.done ] && grep -q "^DOMAIN=$DOMAIN$" .env 2>/dev/null; then
  log "已完成过切换且 .env 已是 DOMAIN=$DOMAIN，无需重复。强制重做请先 rm -f .domain-switch.done"
  exit 0
fi

log "=== 等待 $DOMAIN 的 DNS 委派生效（最长 ${MAX_HOURS}h，每 ${INTERVAL}s 探测）==="

deadline=$(( $(date +%s) + MAX_HOURS * 3600 ))
last_seen=""
while :; do
  ip_ali=$(dig +short +time=3 +tries=1 A "$DOMAIN" @223.5.5.5 2>/dev/null | tail -1)
  ip_ten=$(dig +short +time=3 +tries=1 A "$DOMAIN" @119.29.29.29 2>/dev/null | tail -1)

  if [ "$ip_ali" = "$EXPECT_IP" ] && [ "$ip_ten" = "$EXPECT_IP" ]; then
    log "DNS 已生效：$DOMAIN -> $EXPECT_IP"
    break
  fi

  cur="ali=${ip_ali:-空} tencent=${ip_ten:-空}"
  if [ "$cur" != "$last_seen" ]; then
    log "尚未生效：$cur"
    last_seen="$cur"
  fi

  if [ "$(date +%s)" -ge "$deadline" ]; then
    log "!! 等待超过 ${MAX_HOURS}h 仍未生效，退出。"
    log "   请确认：① 域名实名认证是否通过 ② 云解析的 A 记录是否存在"
    log "   诊断：dig +norec NS $DOMAIN @ns0.centralnic.net"
    exit 1
  fi
  sleep "$INTERVAL"
done

old_domain=$(grep -E '^DOMAIN=' .env | head -1 | cut -d= -f2-)
if [ "$old_domain" = "$DOMAIN" ]; then
  log ".env 中 DOMAIN 已是 $DOMAIN，跳过修改"
else
  cp .env ".env.bak.$(date +%s)"
  if grep -q '^DOMAIN=' .env; then
    sed -i "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" .env
  else
    printf 'DOMAIN=%s\n' "$DOMAIN" >> .env
  fi
  log "已更新 .env：DOMAIN ${old_domain:-空} -> $DOMAIN（原文件已备份为 .env.bak.*）"
fi

log "重建 caddy 容器以加载新 DOMAIN..."
if ! docker compose up -d --force-recreate caddy >>"$LOG_FILE" 2>&1; then
  log "!! caddy 重建失败，请查看：docker compose logs caddy"
  exit 1
fi

log "等待 Let's Encrypt 证书签发（最多约 2 分钟）..."
cert_ok=0
for _ in $(seq 1 20); do
  sleep 6
  if docker compose logs --since 10m caddy 2>&1 | grep -qi "certificate obtained successfully"; then
    cert_ok=1
    log "证书签发成功"
    break
  fi
  if docker compose logs --since 10m caddy 2>&1 | grep -qiE "rate limit|too many failed|acme:error"; then
    log "!! ACME 返回错误，最近日志："
    docker compose logs --tail 20 caddy 2>&1 | tee -a "$LOG_FILE"
    exit 1
  fi
done

if [ "$cert_ok" -ne 1 ]; then
  log "!! 2 分钟内未确认证书签发，请手动检查：docker compose logs --tail 50 caddy"
  exit 1
fi

log "端到端验证（强制解析到 $EXPECT_IP 并校验证书链）..."
health=$(curl -sS --resolve "$DOMAIN:443:$EXPECT_IP" -m 15 "https://$DOMAIN/health" 2>&1)
log "/health -> $health"

models_code=$(curl -sS --resolve "$DOMAIN:443:$EXPECT_IP" -m 20 -o /dev/null -w '%{http_code}' \
  "https://$DOMAIN/v1/models" -H "Authorization: Bearer $(grep -E '^PROXY_API_KEY=' .env | cut -d= -f2-)" 2>&1)
log "/v1/models -> HTTP $models_code（200 正常，401 说明 KEY 不对）"

if echo "$health" | grep -q '"ok"'; then
  touch .domain-switch.done
  log "=== 完成。对外地址： https://$DOMAIN/v1 ==="
else
  log "!! /health 异常，切换已生效但服务可能有问题，请查看 docker compose ps 与日志"
  exit 1
fi
