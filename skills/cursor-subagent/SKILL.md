---
name: "cursor-subagent"
description: "Delegate a task to Cursor Agent through an interactive ACP session."
---

# Cursor ACP subagent

Use this skill when the user explicitly asks to delegate part of the work to
Cursor.

1. Start with `cursor_delegate({prompt,cwd,mode,model?,effort?,fast?,
   plugin_dirs?})`. Modes are exactly
   `ask|plan|agent`: choose `ask` for every read-only task, including research,
   Q&A, file review, diagnosis and debugging; choose `plan` for a plan requiring
   approval; choose `agent` only when the current user authority explicitly
   covers write-capable implementation or debugging. `review` is not a mode.
   Omit model for the per-session default `auto`; do not write global Cursor
   configuration. An explicit `model` is a nonempty base-model string without
   `[` or `]`; nested Cursor parameter syntax is not admitted. `effort` is a
   nonempty token matching `[A-Za-z0-9._-]+`. Pass only the public `model`,
   `effort`, and `fast` fields;
   their installed Cursor encoding is owned by the version-specific runtime
   adapter. Prefer a
   verified isolated worktree for any write-capable or concurrent delegation. A
   canonical checkout is allowed when the user authorized the changes and the
   caller accepts the coordination risk; the runtime neither creates nor
   verifies a VCS worktree. In the terminal report for such a canonical-checkout
   write, include this exact sentence: `An isolated worktree was recommended;
   the caller accepted the coordination risk; the runtime does not verify the
   worktree.` Pass only the listed public launch fields; do not
   emulate unlisted provider controls. For every write-capable delegation and
   every file review whose authorized read/search scope is narrower than the
   full `cwd`, put the caller-held boundary in the Cursor prompt. Use one line per action in the
   form `AUTHORIZED_ACTIONS: <operation> <path-or-bounded-class> [with exact
   content <content>] only.` and include the exact sentence
   `NO_SCOPE_EXPANSION: make no other changes; stop and report any required
   expansion.` These prompt fields coordinate
   the delegation; they are not a claim that the facade is a policy engine or OS
   sandbox. Before calling `cursor_delegate` for a write-capable task, verify
   that the prompt contains one exact `AUTHORIZED_ACTIONS` line for every
   caller-authorized write and the exact `NO_SCOPE_EXPANSION` line above. Use
   the operation token `write` for both creating and modifying a file; do not
   replace it with `create`, `edit`, or another synonym. Do not
   call the tool until they are present. Before calling `cursor_delegate` for a bounded file review, verify
   that the prompt contains the exact `AUTHORIZED_ACTIONS: read <path> only.`
   and `NO_SCOPE_EXPANSION` lines plus these exact sentences: `bounded local
   read/search is allowed` and `writes, network access, credentials, and
   private/internal memory or transcript retrieval are forbidden`. Do not call
   the tool until all four boundary clauses are present. Copy every
   user-required exact outcome marker or token into the delegated
   prompt verbatim; do not translate, omit, or replace it with a descriptive
   success condition. Pass each user-provided Agent Plugin root through
   `plugin_dirs` unchanged when it is an absolute local path; do not copy it,
   substitute another root, or pre-empt runtime validation. The runtime owns
   canonicalization, directory existence, and
   `CURSOR_SUBAGENT_ALLOWED_ROOTS` enforcement. On `invalid_args` or `scope_rejected`,
   report the failure; never copy the skill, widen allowed roots, or inject raw
   provider configuration.
   If the delegate response is a failed-allocation result without `turn_id`, do not call
   `cursor_wait`, retry, resume, or start a fallback delegation. Report the
   returned `session_id`, `failure_kind`, and bounded `provider_error` or
   `terminal_reason` when present as exact structured evidence, then stop that delegation as irrecoverably
   failed.
2. For a live delegated turn, retain complete `session_id`/`turn_id` and the
   `last_event_id` returned by `cursor_delegate` or `cursor_send_prompt`, then observe only with
   `cursor_wait({session_id,turn_id,after_event_id?,after_progress_revision?,timeout_ms?})`.
   Pass that returned `last_event_id` as `after_event_id` on the first wait for
   the turn. Each later wait uses the most recent returned
   `resume_after_event_id`; on
   `wait_timeout:true` keep the same turn alive, retain the latest returned
   `progress_revision` (or the prior value when omitted). Omit `timeout_ms` for
   the first wait so the runtime owns its 30-second default, then use 60, 120,
   and at most 180 seconds for subsequent no-change waits. Report only a newly returned bounded
   progress excerpt. Do not poll `cursor_session_status`, which is advanced
   diagnostics rather than the normal workflow. If the caller explicitly
   limited observation to one wait interval, do not start the later-wait
   schedule after that first `wait_timeout:true`: emit a caller-visible final
   JSON report with exact retained `session_id`, `turn_id`,
   `cursor_session_id`, `resume_after_event_id`, and
   `"work_in_progress":true`, then end the current Codex turn while leaving the
   Cursor turn active. If `events_lost:true`, disclose the observation gap and
   continue only from returned cursors and current normalized state; never
   reconstruct or guess omitted history. If that current evidence is
   insufficient, report it as unverifiable; use `cursor_session_status` only as
   advanced current-state diagnostics, never as lost-history reconstruction.
   In the final evidence summary's parseable JSON object include the exact
   typed fields `"observation_gap":true`, `"history_reconstructed":false`, and
   `"evidence_scope":"current_normalized_state"`; do not translate or omit
   those keys. Add `"verification":"unverifiable"`
   only when the retained current evidence cannot verify the requested result.
   Todo/task/image events are progress, not completion.
3. When pending, give the user normalized context and retain the complete
   `session_id`, `turn_id`, and `request_id`: for a question, call
   `cursor_answer_question` only after a separate user follow-up choosing an
   answer, skip, or cancel; for a plan, call `cursor_answer_plan` with `accept`
   only after explicit approval, and with `reject` only after explicit rejection
   or cancellation. End the current Codex turn without calling an answer tool.
   Put the pending report in one parseable JSON object containing the exact
   `session_id`, `turn_id`, `request_id`, pending `kind`, normalized prompt, and
   every offered option's exact `id` and label; prose may introduce the object
   but must not replace any of those fields. Copy the returned normalized
   `prompt`, option `id`, and option label verbatim; do not translate,
   paraphrase, or relabel them. After the separate follow-up,
   answering continues the same delegated turn: use the answer response's
   `last_event_id` as the next `after_event_id` and `timeout_ms:60000`; do not
   restart the first-wait schedule merely because a new Codex turn began. The
   same later-wait rule applies to the fresh wait after a stale/unknown answer.
   A follow-up that supplies the pending decision is consumed by the matching
   answer tool; do not also forward that same decision or a mere request to
   continue/report through `cursor_send_prompt`. Only a separately scoped new
   provider task supplied after terminality starts another delegated turn.
   A pending tool result or commentary update never replaces this report: emit
   it as the caller-visible final answer before ending the current Codex turn.
4. Answer a permission exactly covered by the current task exactly once through
   `cursor_answer_permission` with `decision: "allow-once"`, without another
   user turn. When a permission expands scope or includes a destructive or
   external action or credential access, do not infer permission from implicit
   context: do not call an answer tool until a separate explicit user follow-up;
   then answer exactly once with only `allow-once` or `reject-once`, according
   to that explicit decision.
5. Protocol completion does not prove semantic task success: verify the result
   and changes independently. That verification MUST NOT create an unrequested
   `cursor_send_prompt`, retry, or new provider turn after a terminal result.
   When no later provider stage was declared, retain the result and receipt,
   close the session, and verify only from available independent evidence;
   report an unverifiable limitation instead of asking the provider again.
   `wait_timeout:true` is resumable work-in-progress;
   `turn_status:"timed_out"` is a terminal interrupted turn. Preserve the
   returned result, terminal receipt, returned requested/forwarded launch
   parameters (not a provider-confirmed resolved/effective model),
   caller-held exact requested `plugin_dirs`, and provider
   `cursor_session_id` in caller-held evidence before closing. After the close
   attempt, include that retained evidence in the caller-visible report. Put
   every required scalar and structured field into one parseable JSON evidence object.
   Every terminal report includes the exact returned `model`, including
   `model:"auto"`; do not omit it as an assumed default.
   A terminal turn is not automatically a terminal delegation. If the user has
   already said that a later decision, follow-up, or review stage may continue
   this conversation, the wrapper is still required: do not close or resume it,
   even when the current turn completed after a rejected permission. Report the
   retained terminal evidence and keep the same runtime `session_id` for the
   later between-turn operation. Only when the delegation itself meets one of
   the close conditions below, complete this order before emitting its terminal
   caller report: (1) retain the returned objects and IDs verbatim, without
   manually retyping hashes; (2) call `cursor_close_session`; (3) copy the
   retained values into the JSON object. Never report a completed-and-finished
   delegation before its required close attempt, and never reconstruct a digest
   from memory or prose.
   Likewise, never end a terminal Codex turn immediately after the final MCP
   tool call or with commentary alone: emit the required caller-visible JSON
   evidence object as the final answer.
   Copy the exact bounded `terminal_receipt` object with its returned `session_id`,
   `turn_id`, `turn_status`, `last_event_id`, nullable `result_sha256`, and
   `result_truncated` field names and values. A terminal result, including a
   tombstoned envelope that still carries a `turn_id`, with
   `turn_status:"failed"` is not an automatic retry/resume/redelegation signal:
   report that exact status plus exact bounded `terminal_reason:{text,truncated}`
   and `provider_error:{code,message:{text,truncated}}` inside that JSON evidence object
   and `terminal_receipt`, close the tombstoned wrapper when needed, and require
   a new user decision before another provider operation. In every JSON evidence
   object for a branch that requires that decision, include the exact scalar
   `"next_provider_operation_requires_new_user_decision":true`; omit it on
   recoverable live-idle branches that do not require a new decision.
6. Preserve one reusable conversation and choose the next operation from its
   observed state. Keep a live runtime session open while later user follow-ups
   or review stages remain possible. After a terminal turn, optionally use
   `cursor_set_mode({session_id,mode})` between turns, then
   `cursor_send_prompt({session_id,prompt})`; neither operation replaces a
   running turn. When that expected follow-up grants write authority after an
   `ask` turn, call `cursor_set_mode({session_id,mode:"agent"})` on that same
   live wrapper and then `cursor_send_prompt`; do not close and
   `cursor_resume_session` merely to change the mutable mode. For a repeated
   critic/review turn in that same live session, the next prompt must contain
   exact lines `BASELINE_DIGEST=<retained digest>`,
   `CHANGED_PATHS=<bounded changed paths>`, and `DELTA=<exact bounded delta>`;
   do not include the unchanged baseline body. Verify those three lines and the
   absence of unchanged baseline content before calling `cursor_send_prompt`.
   Launch-only
   settings (`model`, `effort`, `fast`, and
   `plugin_dirs`) cannot change in place. If they must change, close the idle
   wrapper and immediately use
   `cursor_resume_session({cwd,cursor_session_id,mode,model?,effort?,fast?,plugin_dirs?})`
   with the exact retained provider ID. A lost wrapper uses the same explicit
   resume without a redundant close. The resumed wrapper has a new runtime
   `session_id`; a successful resume proves only provider acceptance of the ID,
   not restored semantic history. If the next turn depends on prior semantic
   history, re-establish its minimal bounded context and constraints before
   relying on it; if that evidence is unavailable, report the result as
   unverifiable instead of assuming provider memory. For critic/review work,
   send the full bounded baseline or snapshot plus the new delta. Delta-only
   repeated review is valid only in the same live session with a known baseline
   manifest. Never apply the delta-only template after wrapper loss or explicit
   resume: the resumed prompt must include the retained full bounded baseline
   body as well as the new delta.

   When wrapper loss is suspected, first address a retained active turn with
   `cursor_wait`. A tombstone or unknown wrapper with a retained
   `cursor_session_id` uses explicit resume; without that provider ID the
   conversation is not addressable through the admitted surface. Never search
   `~/.cursor/acp-sessions`, call a session list, or silently replace failed
   resume with a new delegation. If `cursor_resume_session` returns a
   tombstoned/failed allocation, report the new runtime `session_id`, retained
   `cursor_session_id`, and any returned `failure_kind`, `terminal_reason`, or
   bounded `provider_error` in one parseable JSON evidence object; do not wait,
   repeat resume, or start a replacement
   delegation. The next provider operation requires a new user decision. For an
   explicit follow-up received during an active turn, wait for terminality.
   Send the already supplied text only when the observed terminal state is
   `turn_status:"completed"` with `session_state:"live"`; a failed, timed-out,
   cancelled, or tombstoned outcome follows its terminal recovery branch and
   requires a new post-failure user decision before another provider operation.
   There is no active-turn steering tool. Call
   `cursor_close_session({session_id})` idempotently only for a required
   launch-setting change followed immediately by explicit resume, complete
   delegated work, abandonment/cancellation, or irrecoverable failure.
   When the current follow-up completes the last later stage the user had
   previously declared and the user has not declared another stage, delegated
   work is complete and the close attempt is required.
   `cursor_start_session`, `cursor_session_status`, and `cursor_cancel` remain
   advanced diagnosis/recovery tools; status is not the normal source of
   pending context. Always retain runtime `session_id`, provider
   `cursor_session_id`, current turn IDs/cursors, and caller-supplied launch
   settings across these branches.

   If a between-turn `cursor_set_mode` fails, report its exact error and runtime
   `session_id`. For `invalid_args`, correct only a locally malformed call when
   the already authorized intended mode is unambiguous. For `protocol_error`,
   inspect `cursor_session_status` once. The admitted serial between-turn path
   expects a live wrapper without an active turn: preserve its IDs, report the
   rejected/in-flight transition and observed live-idle state, and do not close,
   send a prompt, or invent state. An
   observed active turn is outside that serial path; report it and stop without
   adding an unproved recovery action. Only `mode_timeout`, another provider-transition
   failure, or observed tombstone enters irrecoverable recovery: do not retry,
   resume, or create a replacement delegation and require a new user decision.

Each session belongs to one Cursor process. Do not run two write-capable agents
in the same worktree.

Choose exactly one review evidence form before delegation:

- File review: use `ask` (or `plan` for a requested plan) and tell Cursor it may
  read/search only the exact or bounded user-authorized scope inside the supplied
  `cwd`; use the full `cwd` only when checkout-wide read/search was already
  authorized. Include the same `AUTHORIZED_ACTIONS` and `NO_SCOPE_EXPANSION`
  coordination fields for a narrower scope. Forbid writes, network access, credentials,
  and private/internal memory or transcript retrieval. State both sides of the
  boundary explicitly in the delegated prompt using the exact sentences
  `bounded local read/search is allowed` and `writes, network access,
  credentials, and private/internal memory or transcript retrieval are
  forbidden`.
- Snapshot review: put every artifact needed for the verdict in the prompt and
  state all three boundaries explicitly in the delegated prompt: `do not use
  tools`; `do not search the workspace`; `do not inspect files after the
  snapshot`.

For repeated critic review, keep one ephemeral caller-held manifest with the
frozen baseline, artifact paths and digest; it is not a session registry. After
a repair send the prior digest, changed paths and their exact delta, rather than
a full unchanged snapshot. Label these fields with exact
`BASELINE_DIGEST=...`, `CHANGED_PATHS=...`, and `DELTA=...` lines in the repeat
prompt, and use the same bounded
increasing wait policy. A
stale or unknown pending ID is recovered only by a fresh `cursor_wait` that
returns the complete normalized pending context; the context-free recovery
summary is diagnostics only. Never guess or answer from that summary.
Never infer delete authority from Cursor creating an artifact. If exact
deletion or a bounded deletion class is not already covered by user authority,
preserve each Cursor-created
temporary path returned or observed by the caller and report it for a separate
decision. Do not claim discovery of provider-internal paths absent from the
bounded runtime surface. When deletion was already explicitly authorized, do
not request a redundant one-time confirmation.
