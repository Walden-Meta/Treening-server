# textree

一棵会生长的知识树 —— textbook-learning 的独立应用化版本。

> 工作名。M6 定型后确定正式名称。
> 当前状态：私有仓库，测试通过后转公开。

## 一句话定位

一个执行「可版本化学习方法」的本地运行时，产出标准格式、用户自有的知识资产。

## 核心特性

- 本地优先：SQLite 单文件，备份 = 复制一个文件
- BYO-Key：模型来自用户自己的 OpenAI 兼容 API Key
- 三槽位规则：每个回答固定三个出口（验收 / 追问 / 其他）
- Obsidian 可移植：整棵树可导出为多 md 集成格式（vault 文件夹 + wikilink + MOC）
- 零登录墙：本地单用户，双击即用

## 快速开始（开发态）

```bash
pip install -r requirements.txt
cp .env.example .env
textree serve    # 或 python -m textree serve
```

## Docker 部署（推荐生产用）

```bash
# 构建并启动（宿主机端口默认 5001，可用 TEXTREE_HOST_PORT 覆盖）
docker compose up -d --build

# API Key：两种方式任选
# 1) 环境变量
TEXTREE_API_KEY=sk-xxx docker compose up -d
# 2) 首次访问 http://<host>:5001/ 走设置向导填写（写入 /app/data/settings.json）

# 数据持久化：./docker-data/textree（SQLite + 设置 + secret）
# 备份 = 直接复制这个目录；重启不丢会话
```

服务使用 gunicorn（1 worker × 4 线程，SQLite 并发安全），配置项见 `docker-compose.yml`。

## 目录

- `methodology/` — 方法论单一事实来源（与 textbook-learning skill 共享）
- `src/textree/` — 应用本体（Flask + 原生 JS）
- `data/` — 运行时数据（SQLite + settings，gitignored）
- `Dockerfile` / `docker-compose.yml` — 生产部署
- `docker-data/` — Docker 持久化数据卷（本地目录，gitignored）
