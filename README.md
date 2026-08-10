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
- **配额管理**：普通用户每日有提问上限（默认 20 次），管理员可按人调整
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
