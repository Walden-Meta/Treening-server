#!/usr/bin/env bash
# deploy.sh — textree 生产发布脚本
#
# 链路：本地 docker build（打版本 tag）→ 记录 Image ID（回滚锚点）
#      → docker save | gzip → scp → 远端 docker load → tag latest
#      → compose up --force-recreate → 健康检查 → 清理旧镜像
#
# 用法：
#   ./deploy.sh            构建并发布
#   ./deploy.sh --no-build 跳过本地构建，直接发布本地 latest 镜像
#   KEEP_IMAGES=5 ./deploy.sh  本地/远端各保留 5 个版本（默认 3）
#
# 依赖：本机可用 docker、scp；SSH 免密（~/.ssh/id_ed25519）已配好。
set -euo pipefail

SERVER="${TREENING_SERVER:-root@47.243.139.50}"
DEPLOY_DIR="/home/admin/textree-server"
BASE_IMAGE="textree-server-textree"
LATEST="${BASE_IMAGE}:latest"
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10"
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nosha)"
TAG="$(date +%Y%m%d-%H%M%S)-${GIT_SHA}"
IMAGE="${BASE_IMAGE}:${TAG}"
GZ="treening-${TAG}.img.gz"
KEEP="${KEEP_IMAGES:-3}"
NO_BUILD="${1:-}"

REMOTE() { ssh $SSH_OPTS "$SERVER" "$@"; }

# ── 1/6 同步源码与部署文件（排除密钥、数据卷、构建产物）──────────
echo "==> [1/6] 同步源码与部署文件到服务器"
tar --exclude=.git --exclude=.env --exclude=docker-data \
    --exclude='*.img.gz' -cf - . \
  | ssh $SSH_OPTS "$SERVER" "mkdir -p $DEPLOY_DIR && tar -xf - -C $DEPLOY_DIR"

# ── 2/6 本地构建 ──────────────────────────────────────────────
if [ "$NO_BUILD" = "--no-build" ]; then
  echo "==> [2/6] 跳过构建，使用本地 ${LATEST} 发布"
  docker tag "$LATEST" "$IMAGE"
else
  echo "==> [2/6] 本地构建 ${IMAGE}"
  docker build -t "$IMAGE" .
fi

# ── 3/6 记录镜像 ID（sha256，回滚锚点）──────────────────────────
DIGEST="$(docker inspect --format='{{.Id}}' "$IMAGE")"
echo "     image id: ${DIGEST}"

# ── 4/6 打包 + 上传 ──────────────────────────────────────────
echo "==> [4/6] 打包上传 ${GZ}"
docker save "$IMAGE" | gzip > "/tmp/${GZ}"
scp $SSH_OPTS "/tmp/${GZ}" "$SERVER:${DEPLOY_DIR}/${GZ}"

# ── 5/6 远端加载 + 换 latest + 滚动重建 ────────────────────────
echo "==> [5/6] 远端加载镜像并重建容器"
REMOTE "docker load -i ${DEPLOY_DIR}/${GZ} \
  && docker tag ${IMAGE} ${LATEST} \
  && cd ${DEPLOY_DIR} && docker compose up -d --force-recreate \
  && echo \"\$(date -u +%Y-%m-%dT%H:%M:%SZ) ${TAG} ${DIGEST}\" >> ${DEPLOY_DIR}/deploys.log"

# ── 6/6 健康检查（最长 120s）─────────────────────────────────
echo "==> [6/6] 等待容器健康（最多 120s）"
healthy=0
for _ in $(seq 1 40); do
  sleep 3
  if REMOTE "docker inspect -f '{{if eq .State.Health.Status \"healthy\"}}H{{else}}B{{end}}' textree" 2>/dev/null | grep -q 'H'; then
    healthy=1; break
  fi
done

if [ "$healthy" != "1" ]; then
  echo "✗ 容器 120s 内未转健康，回滚前状态如下：" >&2
  REMOTE "cd ${DEPLOY_DIR} && docker compose ps; echo '--- 最近日志 ---'; docker logs --tail 40 textree" >&2
  echo "已部署（镜像已加载），但未通过健康检查。需要回滚请执行： ./rollback.sh" >&2
  exit 1
fi

echo "✓ 健康检查通过。"
REMOTE "curl -fsS -m 5 http://127.0.0.1:5001/api/health || true"

# ── 清理：本地 / 远端各保留 KEEP 个版本 ────────────────────────
echo "==> 清理旧镜像（保留最近 ${KEEP} 个）"
docker images --format '{{.Repository}}:{{.Tag}}' \
  | grep "^${BASE_IMAGE}:" | grep -v ':latest$' | head -n "-${KEEP}" \
  | xargs -r docker rmi -f 2>/dev/null || true
REMOTE "docker images --format '{{.Repository}}:{{.Tag}}' \
  | grep '^${BASE_IMAGE}:' | grep -v ':latest$' | head -n -${KEEP} \
  | xargs -r docker rmi -f 2>/dev/null; \
  ls -1 ${DEPLOY_DIR}/treening-*.img.gz 2>/dev/null | head -n -${KEEP} | xargs -r rm -f" || true

echo ""
echo "✔ 发布完成：${TAG}  ${DIGEST}"
echo "  线上：https://treening.cc"
echo "  部署记录：${DEPLOY_DIR}/deploys.log"
