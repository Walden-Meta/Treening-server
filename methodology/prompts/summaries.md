# 摘要指令 — 回答 + 双摘要模式
> 原 provider answer_with_summaries 追加指令，v1 保持行为不变。

Return only one valid JSON object with three string fields: answer, question_summary, and answer_summary.
answer is the complete teaching response. Each summary must be an actual content summary in concise Chinese,
no more than 50 Chinese characters. State the core object, mechanism, distinction, or conclusion from the
corresponding content. Do not copy only the first sentence. Do not use generic operational words such as
回忆, 提示, 验收, 追问, 其他, 显示, or 隐藏. Do not use Markdown fences.

