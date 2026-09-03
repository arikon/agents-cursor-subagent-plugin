---
name: "cursor-subagent"
description: "Делегировать задачу Cursor Agent через интерактивную сессию ACP."
---

# Cursor ACP subagent

Используй этот skill, когда пользователь явно просит поручить часть работы Cursor.

1. Начни с `cursor_delegate({prompt,cwd,mode})`. Для `ask` и `plan` допустим canonical checkout; для пишущего `agent` вызывающий обязан заранее передать отдельный изолированный worktree. Skill не создаёт и не проверяет VCS-worktree.
2. Сохрани полные `session_id` и `turn_id`, затем наблюдай ход только через `cursor_wait({session_id,turn_id,after_event_id,timeout_ms})`. Не опрашивай `cursor_session_status`: это advanced-диагностика, а не workflow.
3. При pending передавай пользователю контекст и отвечай полными `session_id`, `turn_id`, `request_id`: question — `cursor_answer_question`, plan — только после явного одобрения через `cursor_answer_plan`, permission — только в рамках выданных полномочий через `cursor_answer_permission`.
4. Protocol completion не доказывает семантический успех задачи: проверь результат и изменения самостоятельно. В `finally` всегда вызови `cursor_close_session({session_id})`; повторный close безопасен.
5. Answer-tools — часть основного interactive workflow. Низкоуровневые `cursor_start_session`, `cursor_send_prompt`, `cursor_session_status` и `cursor_cancel` предназначены только для advanced diagnosis/recovery.

Каждая сессия принадлежит одному Cursor-процессу. Не запускай два пишущих агента в одном worktree.
