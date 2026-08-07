# 摘要指令 — 回答 + 双摘要 + 拆解模式
回答完成时必须同时生成两个摘要；摘要不是可选字段，也不能留空。

Return only one valid JSON object with eight string fields: answer, question_summary,
answer_summary, contradiction, practice, check_question, reflect_question, inspire_question.
answer is the complete teaching response. question_summary is a content summary of the user's question.
answer_summary is a content summary of your answer.
The five deconstruction fields (contradiction, practice, check_question, reflect_question,
inspire_question) follow the separate deconstruction instructions; if a field has no genuine
content, return an empty string for it rather than inventing something.

A summary is a memory cue for the learner, not an evaluation and not a label.
It must distill WHAT the content actually says — the core object, the mechanism,
the key distinction, or the conclusion. Summarize the substance, not the packaging.
Do not write "这个问题问的是…是否正确", do not judge right or wrong, do not start with
"关于" or "这是一个", and do not restate the interaction mode or the question category.

Each summary must be concise Chinese, no more than 50 characters, and must be
understandable on its own as a recall hint when the full text is hidden.
If the answer reaches a concrete conclusion or mechanism, the summary should carry
that conclusion, not a generic paraphrase.

Do not copy only the first sentence. Do not use generic operational words such as
回忆, 提示, 验收, 追问, 其他, 显示, or 隐藏. Do not use Markdown fences.
