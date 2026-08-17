# Treening

一棵会生长的知识树 —— 把"一个真正困扰你的问题"放进来，让它长成一棵有路径的知识树。

> 线上地址：https://treening.cc
>
> 当前状态：私有仓库，陌生人测试中，验证通过后转公开。

## 一句话定位

一个执行「可版本化学习方法」的在线知识树，产出标准格式、用户自有的知识资产。

## 核心特性

- **树状化问答**：每个回答固定长出三个出口（验收 / 追问 / ＋其他），问题不是被回答掉，而是长成一条路径
- **账号制**：管理员 + 普通用户，每人维护自己的知识树，历史主题全部保留
- **BYO-Key**：模型来自 OpenAI 兼容 API Key，边际成本趋近于零
- **配额管理**：普通用户每日有提问上限（默认 10 次），管理员可按人调整
- **Obsidian 可移植**：整棵树可导出为多 md 集成格式（vault 文件夹 + wikilink + MOC）
- **本地优先存储**：SQLite 单文件，WAL 模式，备份 = 复制一个数据库文件

## 快速开始（开发态）

```bash
pip install -r requirements.txt
cp .env.example .env
treening serve    # 或 python -m treening serve
```

首次启动：浏览器打开站点 → 创建管理员账号 → 配置模型服务（API Key / 接口 / 模型）→ 开始使用。

## 目录

- `methodology/` — 方法论单一事实来源（与 textbook-learning skill 共享）
- `src/treening/` — 应用本体（Flask + 原生 JS）
- `data/` — 运行时数据（SQLite + settings，gitignored）
- `docs/` — 操作手册（md / PDF / HTML）与设计文档

## 提交流程约定（提交 ≠ 上线）

**代码落库与部署上线是两件事，默认不捆绑。**

每批改动完成后：

1. 本地测试通过 → 提交 **treening** main → push GitHub（主仓库）
2. 同步改动文件到 **treening-server**（本地部署仓库）并提交
3. **到此为止，不部署**。等负责人明确说「上线 / 部署」后，才执行 `./deploy.sh`

> 例外：紧急安全修复（如服务器已被攻击、密钥泄漏）可跳过第 3 步等待直接部署，但要在提交信息里注明。

## 生产发布与回滚

发布链路：**本机构建 → docker save | gzip → scp → 远端 docker load → compose up**。
镜像按 `TAG=时间戳+commit` 打版本标签并永久保留最近 N 份不可变产物，可精确回滚。

```bash
./deploy.sh              # 构建 + 同步部署文件 + 发布 + 健康检查
./deploy.sh --no-build   # 用本地已有 latest 镜像发布
./rollback.sh            # 回滚到最近一次成功部署
./rollback.sh <TAG>      # 回滚到指定版本（./rollback.sh --list 查看）
KEEP_IMAGES=5 ./deploy.sh  # 本地/远端各保留 5 个版本（默认 3）
```

- 每次发布的镜像 ID（sha256）记入远端 `deploys.log`，`rollback.sh` 据此定位可回滚版本。
- 健康检查通过 `docker compose` healthcheck（含 SQLite 只读探测），失败会直接提示回滚命令。
- 回滚先加载不可变的 `.img.gz`（保证与发布时完全一致），再 `docker tag` 到 `latest` 重建。

## 数据备份与恢复演练

`ops/` 目录存放数据库备份/恢复脚本（安装到服务器 `/root/` 并配 cron）：

```bash
# 安装（已内置在脚本注释里；服务器 cron：每天 3 点执行）
cp ops/backup.sh /root/treening-backup.sh
cp ops/restore.sh /root/treening-restore.sh
0 3 * * * bash /root/treening-backup.sh >> /var/log/treening-backup.log 2>&1
```

- `backup.sh`：**WAL 一致性快照**（sqlite 在线备份 API，不用 cp——避免半写状态）→ `integrity_check` 校验 → gzip → 推 GitHub 私有仓 `Walden-Meta/Treening-backup`（异机冗余）
- `restore.sh --drill`：非破坏式恢复演练（默认模式），把最新备份恢复到临时目录、校验完整性并对比用户数
- `restore.sh`：真实灾难恢复——停容器 → 备份当前库 → 还原 → 启动 → 健康检查

> 原则：**能备份 ≠ 能恢复**。上线前必须跑一次 `restore.sh --drill`，且每季度演练一次。

## 错误监控（Sentry）

- 代码与镜像已就绪：`_init_sentry()` 在 `TREENING_SENTRY_DSN` 非空时自动启用；Dockerfile 已含 `sentry-sdk`
- **激活只需两步**：① 在 [sentry.io](https://sentry.io) 建项目拿 DSN → ② 服务器 `.env` 写 `TREENING_SENTRY_DSN=https://xxx@sentry.io/yyy`，然后 `./deploy.sh`
- 配套建议：加一个外部 uptime 探针（如 UptimeRobot 免费版），覆盖"站点整体挂掉"而 Sentry 只管"应用报错"的盲区

## 敏感配置与威胁边界

- **API Key / SMTP 授权码**：放在服务器 `.env`（`chmod 600`）或应用内 `settings.json`，**不要提交到仓库**。
- 本仓库已 `.gitignore` 排除 `.env` / `docker-data/` / `*.img.gz`。
- **威胁边界**：这是单机 2C2G 部署。服务器被攻破即视为 Key 泄露——按此边界设计，不要依赖"加密 at rest"来补救权限失控。加密在传输层（TLS）与密钥访问控制（文件权限）上做，不叠加无意义的静态加密。

## 生产加固清单（已部署）

- 注册策略：`open / invite / closed` 三态，邀请码一次性使用（管理面板可运行时切换）
- 禁用用户 / 改密后旧 session 全局失效（`is_active` + `password_changed_at` 校验）
- 登录限速：每用户 5 次失败锁 15 分钟；每 IP 40 次失败跨用户名锁（防字典爆破）
- 真实 IP 信任链：nginx 反代 + `BEHIND_PROXY`（werkzeug ProxyFix `x_for=1`）
- `SESSION_COOKIE_SECURE=true` + Origin 校验（跨域写请求拒绝）
- `/api/health` 带 SQLite 只读探测（DB 坏时 503，Docker healthcheck 转红）
- Sentry 可选错误聚合（`TREENING_SENTRY_DSN`，镜像内需装 `sentry-sdk`）
- 日志轮转：json-file 驱动，单文件 20MB / 最多 5 个
- nginx 限流（`ops/nginx-fail2ban/ratelimit.conf`）：`/api/auth/` 10r/m + burst 10（登录防爆破粗筛），`/api/` 240r/m + burst 60（挡扫描器循环，不误伤学习轮询）
- fail2ban（`ops/nginx-fail2ban/`）：`treening-scan` 扫描特征 300s 内 3 次封 24h；`treening-http-429` 60s 内 10 个 429 封 1h
