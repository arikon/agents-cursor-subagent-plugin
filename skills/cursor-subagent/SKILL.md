---
name: "cursor-subagent"
description: "Делегировать задачу Cursor Agent через интерактивную сессию ACP."
---

# Cursor ACP subagent

Используй этот skill, когда пользователь явно просит поручить часть работы Cursor.

1. Начни с `cursor_delegate({prompt,cwd,mode})`. Для `ask` и `plan` допустим canonical checkout; для пишущего `agent` вызывающий обязан заранее передать отдельный изолированный worktree. Skill не создаёт и не проверяет VCS-worktree.
2. Сохрани полные `session_id` и `turn_id`, затем наблюдай ход только через `cursor_wait({session_id,turn_id,after_event_id,timeout_ms})`. Не опрашивай `cursor_session_status`: это advanced-диагностика, а не workflow.
3. При pending передавай пользователю нормализованный контекст и отвечай полными `session_id`, `turn_id`, `request_id`: question — `cursor_answer_question` только после отдельного user follow-up с выбором, skip или cancel; plan — `cursor_answer_plan` с `accept` только после явного одобрения, а с `reject` только после явного отклонения или отмены.
4. Permission, точно покрытый текущим поручением, отвечай ровно один раз через `cursor_answer_permission` с `decision: "allow-once"` без дополнительного user turn. Если permission расширяет scope, содержит destructive/external action или доступ к credentials, не выводи разрешение из неявного контекста: до отдельного explicit user follow-up не вызывай answer-tool, а после него ответь ровно один раз и только `allow-once` или `reject-once` согласно явному решению.
5. Protocol completion не доказывает семантический успех задачи: проверь результат и изменения самостоятельно. В `finally` всегда вызови `cursor_close_session({session_id})`; повторный close безопасен.
6. Answer-tools — часть основного interactive workflow. Низкоуровневые `cursor_start_session`, `cursor_send_prompt`, `cursor_session_status` и `cursor_cancel` предназначены только для advanced diagnosis/recovery.

Каждая сессия принадлежит одному Cursor-процессу. Не запускай два пишущих агента в одном worktree.
