#!/usr/bin/env bash
#
# qoder-proxy 服务器一键部署脚本（幂等，可反复执行）
#
# 用法：
#   cd ~/qoder-proxy && bash scripts/deploy-server.sh
#
# 环境变量：
#   APP_DIR   项目目录，默认 $HOME/qoder-proxy
#
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/qoder-proxy}"
PORT="${PORT:-3000}"
COMPOSE="docker compose"

info() { printf '\033[36m[%s]\033[0m %s\n' "$1" "$2"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$1"; }
fail() { printf '\033[31m[x]\033[0m %s\n' "$1" >&2; exit 1; }

info 1/6 "环境检查"
cd "$APP_DIR" || fail "项目目录不存在：$APP_DIR"
command -v docker >/dev/null || fail "未安装 docker"
docker info >/dev/null 2>&1 || fail "docker 守护进程未运行（systemctl start docker）"
if ! $COMPOSE version >/dev/null 2>&1; then
  COMPOSE="docker-compose"
  command -v docker-compose >/dev/null || fail "缺少 docker compose 插件"
fi
echo "  docker:  $(docker --version)"
echo "  compose: $($COMPOSE version --short 2>/dev/null || echo unknown)"

info 2/6 "镜像检查"
has_node=0
has_caddy=0
docker image inspect node:22-alpine >/dev/null 2>&1 && has_node=1
docker image inspect caddy:2-alpine >/dev/null 2>&1 && has_caddy=1
if [ "$has_node" = 1 ]; then
  echo "  node:22-alpine   已就绪"
else
  warn "缺少 node:22-alpine（构建会失败，需先导入）"
fi
if [ "$has_caddy" = 1 ]; then
  echo "  caddy:2-alpine   已就绪"
else
  warn "缺少 caddy:2-alpine（将只启动网关，不含 HTTPS 反代）"
fi
[ "$has_node" = 1 ] || fail "缺少 node:22-alpine，无法构建。请先 docker load 或 pull 该镜像"

info 3/6 "配置检查"
if [ ! -f .env ]; then
  cat > .env <<'EOF'
# Qoder 国内版 PAT，形如 pt-xxxx
QODERCN_PAT=
# 客户端调用用的密钥，自己生成一串，形如 sk-xxxx
PROXY_API_KEY=
# 对外域名（Caddy 据此签发证书），本地测试可留空
DOMAIN=
EOF
  chmod 600 .env
  warn "已生成 .env 模板，请填写后重新运行本脚本：nano .env"
  exit 1
fi
chmod 600 .env 2>/dev/null || true
grep -qE '^QODERCN_PAT=.+' .env || fail ".env 中 QODERCN_PAT 为空（PAT 从 qoder.com.cn/account/integrations 获取）"
grep -qE '^PROXY_API_KEY=.+' .env || fail ".env 中 PROXY_API_KEY 为空，可用以下命令生成：
  node -e \"console.log('sk-'+require('crypto').randomBytes(32).toString('hex'))\""
echo "  .env 校验通过"

info 4/6 "构建镜像"
if ! $COMPOSE build; then
  warn "BuildKit 构建失败，回退传统构建器重试"
  DOCKER_BUILDKIT=0 docker build -t qoder-proxy:local . || fail "构建失败，请查看上方错误"
fi

info 5/6 "启动容器"
if [ "$has_caddy" = 1 ]; then
  $COMPOSE up -d --no-build
else
  warn "未找到 caddy 镜像，仅启动网关（对外端口 3000 只绑 127.0.0.1，需自备反代）"
  $COMPOSE up -d --no-build qoder-proxy
fi

info 6/6 "健康检查"
ok=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done

echo
$COMPOSE ps
echo
if [ "$ok" = 1 ]; then
  echo "健康检查：通过 (http://127.0.0.1:${PORT}/health)"
else
  warn "健康检查未通过，最近日志："
  $COMPOSE logs --tail 40 qoder-proxy
  exit 1
fi

cat <<'TIP'

------------------------------------------------------------
后台常驻说明：
  · compose 已设置 restart: unless-stopped，容器崩溃会自动拉起
  · 机器重启后自动恢复的前提是 dockerd 开机自启：
      systemctl is-enabled docker || systemctl enable docker
  · 防止日志撑爆磁盘（全局生效，需重启 docker）：
      /etc/docker/daemon.json 加
      "log-driver": "json-file",
      "log-opts": { "max-size": "50m", "max-file": "3" }
常用命令：
  docker compose ps
  docker compose logs -f qoder-proxy
  docker compose restart qoder-proxy
  git pull && docker compose up -d --build     # 更新
------------------------------------------------------------
TIP
