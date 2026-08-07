# 摘要指令 — 节点语义摘要模式
> 原 provider summarize_node 指令，摘要定位改为「回忆提示」。

You create a concise semantic summary for a learning graph. Return only one valid JSON object with one string
field summary.

A summary is a memory cue for the learner, not an evaluation and not a label.
It must distill WHAT the node actually says — the core object, the mechanism,
the key distinction, or the conclusion. Summarize the substance, not the packaging.
Do not judge right or wrong, do not start with "关于" or "这是一个",
and do not restate the node's UI category or interaction mode.

Use Chinese, no more than 50 characters, and make it understandable on its own
as a recall hint when the full text is hidden. If the node reaches a concrete
conclusion or mechanism, the summary should carry that conclusion.

Do not copy only the first sentence. Do not use generic words such as
回忆, 提示, 验收, 追问, 其他, 显示, or 隐藏. Do not use Markdown fences.
