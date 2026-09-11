---
name: "cursor-subagent"
description: "Delegate a task to Cursor Agent through an interactive ACP session."
---

# Cursor ACP subagent

Use this skill when the user explicitly asks to delegate part of the work to
Cursor.

1. Start with `cursor_delegate`. Choose `ask` for read-only work (including
   diagnosis/debugging), `plan` for a plan requiring approval, and `agent` only
   for explicitly authorized write-capable work. Use the MCP schemas for arguments.
   Omit model for per-session `auto`. Omitted model, `auto`, and `default` require
   `effort`, `fast`, and `optimize_for` to be omitted and need no discovery.
   Only `auto-smart` takes `optimize_for`: ask for an
   explicit strategy if absent, never infer it from `default_optimize_for`.
   For a model list or unknown ID, use `cursor_list_models`; reuse canonical IDs
   and clarify ambiguous families. Pass only user-supplied optional launch choices unchanged,
   including `fast:false`; runtime resolves/verifies variants. Do not infer
   combinations, heal rejected choices, emulate unlisted controls, use CLI/shell
   bypasses, or write global/auth configuration. Report discovery failure and
   missing-key guidance without fallback. A retained catalog does not guarantee
   availability; launch echoes are requested/forwarded, not effective models.

   Prefer a verified isolated worktree for write-capable or concurrent work.
   Canonical checkout is allowed with authorized changes and accepted coordination
   risk; runtime neither creates nor verifies worktrees. Report such writes as
   specified in step 4.
   Coordinate non-overlapping write scopes when sharing a worktree.

   Before every `cursor_delegate` or `cursor_send_prompt`, verify every write-capable prompt and every file review
   narrower than `cwd` carries each authorized operation/path/content as
   `AUTHORIZED_ACTIONS: <operation> <path-or-bounded-class> [with exact content
   <content>] only.` plus `NO_SCOPE_EXPANSION: make no other changes; stop and
   report any required expansion.` Use exactly `write` for creation/modification,
   and `AUTHORIZED_ACTIONS: read <path> only.` for bounded reads. Do not send the prompt
   until these clauses and the applicable review boundaries below are present.
   When the user specifies exact content, the `with exact content <content>`
   clause is required; preserve that content verbatim.
   They coordinate scope; they are not a policy engine or OS sandbox.
   Preserve user-required exact outcome markers in the prompt and requested report.

   For review, choose one evidence form:
   - File: permit only authorized local read/search (full `cwd` only if authorized).
     Include exactly `bounded local read/search is allowed` and `writes, network
     access, credentials, and private/internal memory or transcript retrieval are
     forbidden`, plus the bounded-read clauses above when narrower than `cwd`.
   - Snapshot: supply all evidence in the prompt and include exactly `do not use
     tools`; `do not search the workspace`; `do not inspect files after the snapshot`.

   Omit `plugin_dirs` unless the user supplied absolute local Agent Plugin roots;
   pass them unchanged, not installed-skill or inferred workspace paths. Runtime
   owns canonicalization, existence and allowed roots. Report `invalid_args` or
   `scope_rejected` without copying/substituting roots, widening scope or injecting
   provider configuration. Never infer deletion authority from Cursor-created
   artifacts: preserve/report observed temporary paths unless exact or bounded
   deletion was already authorized; do not search provider-internal paths or ask
   again for already granted deletion authority.

2. Handle `cursor_delegate` and failed-resume results before continuing:
   - No runtime ID: report the launch error; no cleanup or wait.
   - Failed allocation with a runtime ID but no `turn_id`, including failed or
     tombstoned resume: report normalized `failure_kind`, available
     `terminal_reason` and the need for a new user decision. Do not wait, retry,
     resume or redelegate. Runtime already stored the tombstone.
   - With `turn_id`: retain exact runtime `session_id`, provider `cursor_session_id`,
     `turn_id` and launch choices in tool history. Observe live work below;
     handle terminality with step 5.

   For a live turn use
   `cursor_wait({session_id,turn_id})`: first timeout omitted, later no-change
   waits 60, 120, then at most 180 seconds. `wait_timeout:true` leaves work live;
   report `progress_excerpt` when present. Pending is actionable: handle it
   instead of spinning. Do not poll `cursor_session_status`. If the user limits
   observation to one interval, report work in progress and end the Codex turn
   with the Cursor turn active. Recovery is below.
3. For pending requests, preserve full normalized context and exact session,
   turn and request IDs; answer only using these observed IDs.

   | Pending | Decision and tool |
   |---|---|
   | Question | Show the question and every option in final, then end this Codex turn unanswered. Only a separate user follow-up permits `cursor_answer_question`: map their choice to advertised `question_id`/`selected_option_ids`, respecting `allow_multiple`; skip/cancel omit `answers`. |
   | Plan | Show the plan in final and end this Codex turn unanswered. `cursor_answer_plan` uses `accept` only after explicit approval, `reject` only after explicit rejection/cancellation. |
   | Permission | Exactly covered current authority → `cursor_answer_permission` with `allow-once` immediately. Otherwise show the pending request and end this Codex turn without answering. Both `allow-once` and `reject-once` require a separate explicit user follow-up; do not reject on the user's behalf. Scope expansion, destructive/external action or credentials cannot be inferred from implicit context. Answer exactly once after that decision. |

   The matching answer consumes a pending decision; do not also send it or a
   mere continue/report request through `cursor_send_prompt`. Answering continues
   the same turn: next wait uses its retained IDs and `timeout_ms:60000`, not a
   restarted first-wait schedule. For stale/unknown pending IDs, fresh wait with
   those IDs and 60000 ms must supply full normalized context before another
   answer. Never guess from a context-free recovery summary.
4. Before ending each Codex turn, report the semantic outcome and any pending
   decision, observation gap or safety/completeness limit in the final; tool
   results or commentary alone are insufficient. If this workflow requires
   a new user decision, explicitly say that further provider work needs that
   decision; fixing a prerequisite does not authorize a retry.
   In the terminal report of an authorized write in canonical checkout include this exact sentence:
   `An isolated worktree was recommended; the caller accepted the coordination risk; the runtime does not verify the worktree.`
   Preserve received questions/options/plans. Distinguish your own analysis from
   Cursor's result and report requested content that Cursor did not provide.
   Prose, lists and JSON are
   acceptable. Exact IDs, receipts, hashes, launch choices and provider diagnostics
   stay in tool evidence; do not duplicate them in final unless requested.
5. At terminality, protocol completion does not prove semantic success: verify
   the result/changes independently from available evidence, without an
   unrequested provider turn or regeneration. For `result.truncated:true`, call
   `cursor_read_result` with the same session/turn IDs and `offset:0`, following
   each `next_offset` to `eof:true` before verification, another turn or close.
   An unavailable result page must be reported as incomplete; a partial review
   is not a full verdict. Terminal `turn_status:"timed_out"`
   means interrupted work, unlike a live `wait_timeout:true`.

   Use the first matching terminal branch:
   - `failed`, including `terminal_result_limit` or a failed turn in a tombstoned
     session: retain the outcome/error and close idempotently. In the final,
     report the failure, any result-completeness limit, and that further Cursor
     work requires a new user decision. Do not automatically retry, resume,
     redelegate, or send a later-stage prompt.
   - `completed` + live + a named later stage (next message, later mode/plan/review,
     wait for my decision): keep this runtime session; report; end this Codex turn
     without `cursor_send_prompt` until that input. Do not close. `reject-once`
     rejects only its pending action, not that named stage.
   - Otherwise retain outcome/limitations, close idempotently, then report.
     A completed turn in a tombstone is still completed; retain its provider ID
     for a later explicitly requested resume.

   A merely possible future follow-up is not a named later stage. Close only when
   work is complete, abandoned/cancelled, irrecoverably failed, or an idle wrapper
   needs changed launch settings followed immediately by explicit resume. Close
   the current runtime ID, including the new ID after resume.
6. On a named later stage, keep the live session: `cursor_set_mode` first if the
   required mode differs, then `cursor_send_prompt`. Never close+resume to change
   mode. Do not claim a mode change without a successful `cursor_set_mode`.
   After the last named stage completes, close idempotently. There is no
   active-turn steering: a follow-up while running waits for `completed` +
   `live` before sending. Every other terminal outcome follows step 5, without
   sending.

   Launch-only `model`, `effort`, `fast`, `optimize_for`, `plugin_dirs` cannot
   change in place: close the idle wrapper and immediately explicitly resume
   with `cursor_resume_session` and the exact retained `cursor_session_id`.
   Wrapper loss/terminal close also uses explicit resume for a requested later
   operation, without redundant close. Keep its new runtime ID. Resume proves
   acceptance of the provider ID, not semantic memory: restore the minimal
   bounded context/constraints required by the next task, or report unverifiable.

   For repeated critic review, keep one ephemeral manifest of frozen baseline,
   artifact paths and digest, not a session registry. In the same live session
   with a known unchanged baseline digest, assemble and verify these prompt lines
   from retained baseline and user-supplied change evidence before sending:
   `BASELINE_DIGEST=<retained digest>`, `CHANGED_PATHS=<bounded changed paths>`,
   `DELTA=<exact bounded delta>`. Preserve every supplied delta line verbatim,
   including `-`/`+`, and omit the unchanged baseline body. Explicit delta text may
   be supplied inline; do not require a preformatted diff block. After wrapper loss
   or explicit resume, send the full bounded baseline/snapshot plus new delta;
   never use delta-only. If that evidence is missing, report unverifiable.

## Recovery

- **Missing wait response:** repeat `cursor_wait` with retained session/turn IDs.
  Repeated terminal state is observation, not execution; no prompt/resume/redelegate.
- **Rejected wait** (`unknown_session`, `unknown_turn`, `invalid_args`,
  `invalid_text_encoding`): compare against the latest retained public IDs.
  Correct only locally wrong/missing/malformed IDs in this Codex turn, never guess
  or launch provider work. A rejection using the exact retained IDs is not this
  repair. Suspected wrapper loss first requires correctly addressed observation
  of the retained active turn; an address typo does not establish loss.
- **Lost wrapper/tombstone:** use step 6 only with a retained provider ID and
  explicit continuation authority; without it the conversation is unaddressable.
  Never search `~/.cursor/acp-sessions`, list sessions or replace failed resume
  silently. After resume failure, asking to continue the same conversation still
  does not authorize replacement; fresh delegation requires an explicit new or
  replacement conversation choice after the failure.
- **Between-turn mode error:** report normalized `error_code`. For `invalid_args`,
  repair only a malformed call with unambiguous already-authorized mode. For
   `protocol_error`, inspect status once: live-idle → retain IDs and report the
   rejected/in-flight transition and observed live-idle state. The session stays
   open and prior user authority remains valid; report this recoverable state
   without requiring renewed authorization. Do not close, send a prompt, or
   claim the transition completed. Active → report and stop. Only `mode_timeout`, another provider
  transition failure or observed tombstone enters irrecoverable recovery: require
  a new user decision, no retry/resume/replacement.

`cursor_start_session`, `cursor_session_status` and `cursor_cancel` are advanced
diagnosis/recovery tools; normal observation and pending context come from wait.
