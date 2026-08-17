#!/bin/bash
# backup.sh — treening 数据库安全备份（WAL 一致性快照 → 校验 → gzip → GitHub 私有仓）
#
# 为何不用 cp：应用是 SQLite WAL 模式，主文件可能落后于 -wal 中的未落盘事务，
# 凌晨备份撞上写操作会得到损坏/缺数据的快照。这里用 sqlite 在线备份 API，
# 无论是否并发写入，快照都保持一致、可被 integrity_check 验证。
#
# 安装：复制到服务器 /root/treening-backup.sh，cron 每日执行：
#   0 3 * * * bash /root/treening-backup.sh >> /var/log/treening-backup.log 2>&1
set -euo pipefail

REPO_DIR=/root/treening-backup-repo
SRC=/home/admin/treening-server/docker-data/treening/tree.db
REPO_URL=git@github.com:Walden-Meta/Treening-backup.git
SSH_KEY=/root/.ssh/treening_backup_ed25519
GIT_SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new"
TMP="$(mktemp /tmp/treening-snapshot.XXXXXX.db)"

[ -f "$SRC" ] || { echo "错误：源数据库不存在 $SRC" >&2; exit 1; }

# 1) WAL 安全一致性快照（sqlite 在线备份 API）
python3 - "$SRC" "$TMP" <<'PY'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1])
dst = sqlite3.connect(sys.argv[2])
with dst:
    src.backup(dst)
dst.close(); src.close()
PY

# 2) 校验快照完整 + 记录用户数
CHECK="$(python3 -c "import sqlite3;print(sqlite3.connect('$TMP').execute('PRAGMA integrity_check').fetchone()[0])")"
if [ "$CHECK" != "ok" ]; then
    echo "完整性校验失败: $CHECK" >&2; exit 1
fi
USERS="$(python3 -c "import sqlite3;print(sqlite3.connect('$TMP').execute('SELECT COUNT(*) FROM users').fetchone()[0])")"
echo "快照校验通过: users=$USERS"

# 3) 压缩（减少仓库体积；历史 bin 由 git 再压缩一次）
gzip -f "$TMP"    # → ${TMP}.gz

# 4) 推送 GitHub 私有仓（首次 clone，之后增量提交）
mkdir -p "$REPO_DIR"
if [ ! -d "$REPO_DIR/.git" ]; then
    GIT_SSH_COMMAND="$GIT_SSH" git clone "$REPO_URL" "$REPO_DIR"
fi
cd "$REPO_DIR"
git rm --quiet tree.db 2>/dev/null || true    # 迁移旧的未压缩格式（历史保留）
mv "$TMP.gz" ./tree.db.gz
git add tree.db.gz
git -c user.name="treening-backup" -c user.email="treening-backup@localhost" \
    commit -m "backup $(date +%Y%m%d-%H%M%S) users=$USERS integrity=$CHECK" -q \
    || { echo "无变更"; exit 0; }
GIT_SSH_COMMAND="$GIT_SSH" git push origin main -q
echo "备份完成 $(date) users=$USERS integrity=$CHECK"
