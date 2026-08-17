#!/usr/bin/env bash
# rollback.sh — treening 生产回滚脚本
#
# 回滚基于 immutability 原则：服务器上保留的 treening-<TAG>.img.gz
# 是不可变发布产物，按 TAG 精确还原该版本的镜像与代码状态。
#
# 用法：
#   ./rollback.sh            # 回滚到最近一次成功部署（deploys.log 倒数第 2 条）
#   ./rollback.sh <TAG>      # 回滚到指定 TAG（如 20260810-183232-f81fb76）
#   ./rollback.sh --list     # 仅列出可回滚版本
set -euo pipefail

SERVER="${TREENING_SERVER:-root@47.243.139.50}"
DEPLOY_DIR="/home/admin/treening-server"
BASE_IMAGE="treening-server-treening"
LATEST="${BASE_IMAGE}:latest"
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10"

REMOTE() { ssh $SSH_OPTS "$SERVER" "$@"; }

if [ "${1:-}" = "--list" ]; then
  echo "==> 服务器可用镜像："
  REMOTE "docker images | grep '^${BASE_IMAGE}'"
  echo ""
  echo "==> 部署历史（deploys.log）："
  REMOTE "cat ${DEPLOY_DIR}/deploys.log 2>/dev/null || echo '(无部署日志)'"
  exit 0
fi

TAG="${1:-}"
if [ -z "$TAG" ]; then
  # 默认回滚到最近一次成功部署：日志中倒数第 2 条真实发布（忽略 # 注释行）
  TAG="$(REMOTE "grep -v '^#' ${DEPLOY_DIR}/deploys.log 2>/dev/null | tail -2 | head -1 | awk '{print \$2}'")"
  if [ -z "$TAG" ]; then
    echo "错误：未指定 TAG 且部署日志为空，无法自动回滚。" >&2
    echo "请先执行 ./rollback.sh --list 查看可用版本，再 ./rollback.sh <TAG>" >&2
    exit 1
  fi
  echo "==> 默认回滚到：${TAG}"
else
  echo "==> 指定回滚到：${TAG}"
fi

GZ="treening-${TAG}.img.gz"

# 优先从不可变产物加载（保证与发布时完全一致）；镜像仍在则直接复用
if REMOTE "docker image inspect ${BASE_IMAGE}:${TAG} >/dev/null 2>&1"; then
  echo "   镜像已存在，直接复用"
else
  echo "   镜像不存在，从 ${GZ} 重新加载"
  REMOTE "docker load -i ${DEPLOY_DIR}/${GZ}"
fi

echo "==> 替换 latest 并重建容器"
REMOTE "cd ${DEPLOY_DIR} \
  && docker tag ${BASE_IMAGE}:${TAG} ${LATEST} \
  && docker compose up -d --force-recreate \
  && echo \"# \$(date -u +%Y-%m-%dT%H:%M:%SZ) rollback -> ${TAG}\" >> ${DEPLOY_DIR}/deploys.log"

echo "==> 等待容器健康（最多 120s）"
healthy=0
for _ in $(seq 1 40); do
  sleep 3
  if REMOTE "docker inspect -f '{{if eq .State.Health.Status \"healthy\"}}H{{else}}B{{end}}' treening" 2>/dev/null | grep -q 'H'; then
    healthy=1; break
  fi
done

if [ "$healthy" != "1" ]; then
  echo "✗ 回滚后容器未转健康，查看状态：" >&2
  REMOTE "cd ${DEPLOY_DIR} && docker compose ps; echo '--- 最近日志 ---'; docker logs --tail 40 treening" >&2
  exit 1
fi

echo "✓ 回滚完成，健康检查通过。"
REMOTE "curl -fsS -m 5 http://127.0.0.1:5001/api/health || true"
