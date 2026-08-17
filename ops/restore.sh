#!/bin/bash
# restore.sh — treening 数据库恢复（灾难恢复 / 演练）
#
# 用法：
#   ./restore.sh --drill           演练模式（默认）：把最新备份恢复到临时目录，
#                                  校验完整性并对比用户数，不触碰生产
#   ./restore.sh                   真实恢复：停止容器 → 备份当前库 → 还原 → 启动 → 健康检查
#
# 恢复源：GitHub 私有仓 /root/treening-backup-repo/tree.db.gz（每天 3 点由 backup.sh 写入）
set -euo pipefail

REPO_DIR=/root/treening-backup-repo
DATA_DIR=/home/admin/treening-server/docker-data/treening
DB_PATH=$DATA_DIR/tree.db
SSH_KEY=/root/.ssh/treening_backup_ed25519
GIT_SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new"
MODE="${1:---drill}"

# 1) 拉取最新备份
mkdir -p "$REPO_DIR"
if [ ! -d "$REPO_DIR/.git" ]; then
    GIT_SSH_COMMAND="$GIT_SSH" git clone git@github.com:Walden-Meta/Treening-backup.git "$REPO_DIR"
else
    GIT_SSH_COMMAND="$GIT_SSH" git -C "$REPO_DIR" pull --ff-only origin main -q
fi
GZ=$REPO_DIR/tree.db.gz
[ -f "$GZ" ] || { echo "错误：备份文件不存在 $GZ" >&2; exit 1; }
echo "使用备份：$GZ ($(date -r "$GZ" '+%F %T'))"

# 2) 解压到工作目录并校验
WORK="$(mktemp -d /tmp/treening-restore.XXXXXX)"
gunzip -c "$GZ" > "$WORK/tree.db"
CHECK="$(python3 -c "import sqlite3;print(sqlite3.connect('$WORK/tree.db').execute('PRAGMA integrity_check').fetchone()[0])")"
[ "$CHECK" = "ok" ] || { echo "✗ 备份损坏（integrity=$CHECK）" >&2; exit 1; }
USERS="$(python3 -c "import sqlite3;print(sqlite3.connect('$WORK/tree.db').execute('SELECT COUNT(*) FROM users').fetchone()[0])")"
echo "✓ 备份校验通过: integrity=$CHECK users=$USERS"

if [ "$MODE" = "--drill" ]; then
    LIVE_USERS="$(python3 -c "import sqlite3;print(sqlite3.connect('$DB_PATH').execute('SELECT COUNT(*) FROM users').fetchone()[0])")"
    echo "演练完成：备份可恢复（users=$USERS，线上 users=$LIVE_USERS）"
    rm -rf "$WORK"
    exit 0
fi

# 3) 真实恢复
echo "→ 停止容器"
docker stop treening
echo "→ 备份当前生产库（防止误恢复）"
cp "$DB_PATH" "$WORK/tree.db.before-restore.$(date +%Y%m%d-%H%M%S)"
echo "→ 还原备份"
cp "$WORK/tree.db" "$DB_PATH"
echo "→ 启动容器"
docker start treening

# 4) 健康检查（最长 90s）
ok=0
for _ in $(seq 1 30); do
    sleep 3
    if docker inspect -f '{{if eq .State.Health.Status "healthy"}}H{{else}}B{{end}}' treening 2>/dev/null | grep -q H; then ok=1; break; fi
done
if [ "$ok" != "1" ]; then
    echo "✗ 恢复后容器未转健康！检查日志：docker logs treening" >&2
    echo "  当前生产库已备份在：$WORK/tree.db.before-restore.*（可用 restore.sh 手动还原）" >&2
    exit 1
fi
echo "✓ 恢复完成，容器健康。线上 users=$USERS"
rm -rf "$WORK"
