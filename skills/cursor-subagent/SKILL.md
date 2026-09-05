---
name: "cursor-subagent"
description: "Delegate a task to Cursor Agent through an interactive ACP session."
---

# Cursor ACP subagent

Use this skill when the user explicitly asks to delegate part of the work to
Cursor.

1. Start with `cursor_delegate({prompt,cwd,mode})`. A canonical checkout is
   permitted for `ask` and `plan`; for write-capable `agent`, the caller MUST
   provide a separate isolated worktree in advance. This skill neither creates
   nor verifies VCS worktrees.
2. Retain the complete `session_id` and `turn_id`, then observe progress only
   with `cursor_wait({session_id,turn_id,after_event_id,timeout_ms})`. Do not
   poll `cursor_session_status`: it is for advanced diagnostics, not the
   workflow.
3. When pending, give the user normalized context and retain the complete
   `session_id`, `turn_id`, and `request_id`: for a question, call
   `cursor_answer_question` only after a separate user follow-up choosing an
   answer, skip, or cancel; for a plan, call `cursor_answer_plan` with `accept`
   only after explicit approval, and with `reject` only after explicit rejection
   or cancellation.
4. Answer a permission exactly covered by the current task exactly once through
   `cursor_answer_permission` with `decision: "allow-once"`, without another
   user turn. When a permission expands scope or includes a destructive or
   external action or credential access, do not infer permission from implicit
   context: do not call an answer tool until a separate explicit user follow-up;
   then answer exactly once with only `allow-once` or `reject-once`, according
   to that explicit decision.
5. Protocol completion does not prove semantic task success: verify the result
   and changes independently. Always call `cursor_close_session({session_id})`
   in `finally`; calling it repeatedly is safe.
6. Answer tools are part of the primary interactive workflow. The low-level
   `cursor_start_session`, `cursor_send_prompt`, `cursor_session_status`, and
   `cursor_cancel` are intended only for advanced diagnosis or recovery.

Each session belongs to one Cursor process. Do not run two write-capable agents
in the same worktree.
