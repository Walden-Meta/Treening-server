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

## 目录

- `methodology/` — 方法论单一事实来源（与 textbook-learning skill 共享）
- `src/textree/` — 应用本体（Flask + 原生 JS）
- `data/` — 运行时数据（SQLite + settings，gitignored）
