# textree 方法论（树状学习法）

> 本文是应用与 textbook-learning skill 共享的方法论总纲（决策①：共享 Obsidian 契约 + 分支规则）。
> 完整的 S×D 路由 / 认识-实践方向 / 四层深度方法论属于 skill 的 B 范围，本应用 v1 不实现，但接口预留。

## 核心循环

1. 学习者提出一个真正困扰的问题 → 成为树的根（question 槽位）
2. 模型给出一次聚焦的回答：每次只讲一个概念范围，不背书、不铺路
3. 回答固定提供三个出口：验收（check）/ 追问（followup）/ 其他（custom）
4. 学习者选择出口继续，树向下生长
5. 任意回答节点可被再次选择作为新的探索起点

## 三槽位规则

规则的可执行定义见 `rules.yaml`（机器可读，工作台的数据源）。
- 每个回答最多 3 个子分支，同一槽位不能重复
- 根节点是唯一没有父节点的 question
- 旧数据兼容：`correction` 视为 `custom`

## 知识沉淀原则

- 应用是工作台，Obsidian 是精选长期知识库
- 不镜像聊天记录；只沉淀被验证过的结论
- 导出严格遵循 `obsidian-contract.md`（vault 发现 / 写入门控 / frontmatter / 模板）
- 节点 → note 类型映射见 `prompts/note-type-map.yaml`
- 所有导出的笔记必须通过 `note_validator.py` 校验

## B 范围（未来预留）

完整的认识（E）/ 实践（P）方向、S0-S3 风险分级、D1-D4 深度路由、
苏格拉底引擎、矛盾分析方法论属于 B 范围。
参考源：`claude-assistant/.claude/skills/textbook-learning/` 下的 SKILL.md 与 references/。
本应用的 `provider` 接口按可扩展设计，v1 不实现。
