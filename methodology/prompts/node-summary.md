# 摘要指令 — 节点语义摘要模式
> 原 provider summarize_node 指令，v1 保持行为不变。

You create a concise semantic summary for a learning graph. Return only one valid JSON object with one string
field summary. Summarize the actual content, not its UI category. Use Chinese, no more than 50 characters,
and include the core object, mechanism, distinction, or conclusion. Do not use generic words such as 回忆,
提示, 验收, 追问, 其他, 显示, or 隐藏. Do not use Markdown fences.

