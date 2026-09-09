---
name: "cursor-subagent"
description: "Delegate a task to Cursor Agent through an interactive ACP session."
---

# Cursor ACP subagent

Use this skill when the user explicitly asks to delegate part of the work to
Cursor.

1. For a model list or unknown ID, use `cursor_list_models({})`; reuse its
   canonical IDs, never aliases or CLI/shell bypasses. Clarify ambiguous families.
   Report discovery errors and missing-key guidance without auth writes or
   fallback launches. A retained catalog does not guarantee future availability.
   Start with `cursor_delegate({prompt,cwd,mode,model?,effort?,fast?,optimize_for?,
   plugin_dirs?})`. Modes are exactly
   `ask|plan|agent`: choose `ask` for every read-only task, including research,
   Q&A, file review, diagnosis and debugging; choose `plan` for a plan requiring
   approval; choose `agent` only when the current user authority explicitly
   covers write-capable implementation or debugging. `review` is not a mode.
   Omit model for the per-session default `auto`; do not write global Cursor
   configuration. Omitted model, `auto`, and `default` need no discovery and
   accept no knobs. Only `auto-smart` requires/allows explicit
   `optimize_for:"cost"|"balanced"|"intelligence"`; ask if unselected, never infer
   it from `default_optimize_for`. An explicit `model` is a nonempty base-model string without
   `[` or `]`; nested Cursor parameter syntax is not admitted. `effort` is a
   nonempty token matching `[A-Za-z0-9._-]+`. Pass only the public `model`,
   `effort`, `fast`, and `optimize_for` fields literally, including `fast:false`.
   Runtime owns variant resolution/verification and encoding; do not infer
   combinations or heal rejected choices. Report echoes as requested/forwarded
   parameters, not effective model. Prefer a
   verified isolated worktree for any write-capable or concurrent delegation. A
   canonical checkout is allowed when the user authorized the changes and the
   caller accepts the coordination risk; the runtime neither creates nor
   verifies a VCS worktree. For a canonical-checkout write, explain the worktree
   recommendation, accepted coordination risk and runtime limitation in ordinary
   language. Pass only the listed public launch fields; do not
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
   the tool until all four boundary clauses are present. Omit `plugin_dirs`
   unless the user explicitly supplied an
   absolute local Agent Plugin root; an installed skill or inferred workspace
   path is not such an input. Pass each user-provided Agent Plugin root through
   `plugin_dirs` unchanged when it is an absolute local path; do not copy it,
   substitute another root, or pre-empt runtime validation. The runtime owns
   canonicalization, directory existence, and
   `CURSOR_SUBAGENT_ALLOWED_ROOTS` enforcement. On `invalid_args` or `scope_rejected`,
   report the failure; never copy the skill, widen allowed roots, or inject raw
   provider configuration.
   If the delegate response is a failed-allocation result without `turn_id`, do not call
   `cursor_wait`, retry, resume, or start a fallback delegation. Report the
   normalized `failure_kind` and the returned `terminal_reason` diagnostic,
   then explicitly require a new user decision; retain
   exact diagnostics in tool evidence and close the failed allocation
   idempotently before the final report.
2. For a live delegated turn, retain its exact `session_id` and `turn_id`, then
   observe only with `cursor_wait({session_id,turn_id,timeout_ms?})`. Omit
   `timeout_ms` for the first wait; later no-change waits use 60, 120, then at
   most 180 seconds. A `wait_timeout:true` keeps the turn live; report its
   bounded `progress_excerpt` when present, and do not poll or spin. A pending
   snapshot is immediately actionable and is handled by steps 3–4. Do not poll
   `cursor_session_status`, which is advanced diagnostics rather than the
   normal workflow. If observation is explicitly limited to one interval,
   report that work remains in progress and end the Codex turn while leaving
   the Cursor turn active.

   If `cursor_wait` is locally rejected with `unknown_session`, `unknown_turn`,
   `invalid_args`, or `invalid_text_encoding`, compare its `session_id` and
   `turn_id` with the latest retained public state. Correct only missing or
   malformed locally known IDs in the same Codex turn; do not guess an address,
   resume, delegate, or send a prompt. If the rejected call already used the
   exact retained IDs, this repair does not apply.
3. When pending, give the user normalized context and retain the complete
   `session_id`, `turn_id`, and `request_id`: for a question, call
   `cursor_answer_question` only after a separate user follow-up choosing an
   answer, skip, or cancel. For a user option selection, use `outcome:"answered"`
   and `answers` containing the exact advertised `question_id` and nonempty
   `selected_option_ids`, respecting `allow_multiple`. For skip or cancel, use
   `outcome:"skipped"` or `outcome:"cancelled"` and omit `answers`.
   For a plan, call `cursor_answer_plan` with `accept`
   only after explicit approval, and with `reject` only after explicit rejection
   or cancellation. End the current Codex turn without calling an answer tool.
   Report the pending question or plan and every offered choice clearly,
   preserving their meaning. Prose, a list or JSON are all acceptable; exact
   runtime IDs remain in tool evidence and are used for the later answer call.
   After the separate follow-up, answering continues the same delegated turn.
   Before the next `cursor_wait`, use the same exact IDs with
   `timeout_ms:60000`; do not restart the first-wait schedule merely because a
   new Codex turn began. If an answer call reports a stale or unknown pending
   ID, call `cursor_wait({session_id,turn_id,timeout_ms:60000})` with the
   current retained IDs. Answer again only from a
   full normalized pending context returned by that wait; a context-free
   recovery summary is diagnostics only, so never guess from it.
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
5. Copy user-required exact outcome markers verbatim into the prompt and report them when requested.
   Protocol completion does not prove semantic task success: verify the result
   and changes independently. That verification MUST NOT create an unrequested
   `cursor_send_prompt`, retry, or new provider turn after a terminal result.
   If terminal `result.truncated:true`, read the full retained text with
   `cursor_read_result({session_id,turn_id,offset:0})`, then pass each returned
   `next_offset` until `eof:true`. Retain the complete text before verification,
   another turn or close. These reads do not regenerate a provider response.
   If a page is unavailable or the turn failed with `terminal_result_limit`,
   report the completeness limitation; a partial review is not a full verdict.
   `wait_timeout:true` and a running turn follow step 2; a pending request
   follows steps 3 and 4. `turn_status:"timed_out"` is a terminal interrupted
   turn, distinct from `wait_timeout:true`. After a terminal turn, use the first
   matching branch:

   1. For `turn_status:"failed"`, including a failed turn in a tombstoned
      session, retain its semantic outcome, safety state, receipt and error;
      close its runtime `session_id` idempotently; report the failure; and
      require a new user decision before another provider operation. Do not
      retry or regenerate without that decision.
   2. For `turn_status:"completed"` with a live session and an explicitly
      declared later decision, follow-up, or review stage that remains
      unfinished, report the semantic outcome and keep the same runtime
      `session_id` open for that stage. A `reject-once` answer rejects only the
      current pending action; it does not cancel or complete the separately
      declared later stage.
   3. Otherwise, retain the semantic outcome and safety state, close the runtime
      `session_id` idempotently, then deliver the final report from the
      available evidence. A completed turn in a tombstoned session is not a
      failed turn; retain its provider `cursor_session_id` so a later explicitly
      requested operation can use the resume rules in step 6.

   The ordinary possibility of a future follow-up is not a declared unfinished
   stage. Preserve exact receipts, launch parameters, plugin roots, provider
   errors, and observed IDs in the runtime/tool transcript. Put only the
   semantic outcome and required safety disclosure in the caller-visible
   report. Prose, lists and JSON are equally valid; do not require or copy
   audit-only IDs, receipts, hashes or full provider diagnostics. An MCP
   response or commentary alone is not the assistant final report.
6. For the wrapper retained under step 5, choose the next operation from its
   observed state.
   After a terminal turn, determine the mode
   required by the next explicitly requested stage using step 1. If it differs
   from the current mode, call `cursor_set_mode({session_id,mode})` before
   `cursor_send_prompt({session_id,prompt})`; otherwise send the prompt without
   a redundant mode change. Neither operation replaces a running turn. When
   that expected follow-up grants write authority after an
   `ask` turn, call `cursor_set_mode({session_id,mode:"agent"})` on that same
   live wrapper and then `cursor_send_prompt`; do not close and
   `cursor_resume_session` merely to change the mutable mode. For a repeated
   critic/review turn in that same live session, the next prompt must contain
   exact lines `BASELINE_DIGEST=<retained digest>`,
   `CHANGED_PATHS=<bounded changed paths>`, and `DELTA=<exact bounded delta>`;
   the `DELTA` value must preserve every caller-supplied delta line verbatim,
   including its `-` or `+` marker. Verify those three lines, every supplied
   delta line, and the absence of unchanged baseline content before calling
   `cursor_send_prompt`.
   Launch-only
   settings (`model`, `effort`, `fast`, `optimize_for`, and
   `plugin_dirs`) cannot change in place. If they must change, close the idle
   wrapper and immediately use
   `cursor_resume_session({cwd,cursor_session_id,mode,model?,effort?,fast?,optimize_for?,plugin_dirs?})`
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
   The new runtime `session_id` becomes the current wrapper for subsequent
   operations and follows the same close rule from step 5.

   When wrapper loss is suspected, first address a retained active turn with
   `cursor_wait` using its exact retained IDs. Only a correctly addressed
   observation establishes wrapper loss; a local rejection caused by different,
   missing, or malformed address fields
   follows step 2 and does not establish loss. A tombstone or unknown wrapper with a retained
   `cursor_session_id` uses explicit resume; without that provider ID the
   conversation is not addressable through the admitted surface. Never search
   `~/.cursor/acp-sessions`, call a session list, or silently replace failed
   resume with a new delegation. After a failed resume, a later request to
   continue that same unavailable Cursor conversation still does not authorize
   `cursor_delegate` or a replacement conversation. Start a fresh delegation
   only when the user explicitly chooses a new or replacement provider
   conversation after the resume failure. A failed or tombstoned resume follows
   the failed-allocation recovery from step 1: retain its new runtime ID, close
   it idempotently and report failure plus the required new user decision. For an explicit follow-up
   received during an active turn, wait for terminality.
   Send the already supplied text only when the observed terminal state is
   `turn_status:"completed"` with `session_state:"live"`; every other terminal
   outcome follows its matching cleanup branch in step 5.
   There is no active-turn steering tool. Call
   `cursor_close_session({session_id})` idempotently only for a required
   launch-setting change followed immediately by explicit resume, complete
   delegated work, abandonment/cancellation, or irrecoverable failure.
   `cursor_start_session`, `cursor_session_status`, and `cursor_cancel` remain
   advanced diagnosis/recovery tools; status is not the normal source of
   pending context. Always retain runtime `session_id`, provider
   `cursor_session_id`, current turn IDs, and caller-supplied launch
   settings across these branches.

   If a between-turn `cursor_set_mode` fails, report the failure with the
   normalized `error_code`; exact provider diagnostics and runtime IDs remain
   in the transcript. For `invalid_args`, correct only a locally malformed call when
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
prompt, and use the same bounded increasing wait policy.
Never infer delete authority from Cursor creating an artifact. If exact
deletion or a bounded deletion class is not already covered by user authority,
preserve each Cursor-created
temporary path returned or observed by the caller and report it for a separate
decision. Do not claim discovery of provider-internal paths absent from the
bounded runtime surface. When deletion was already explicitly authorized, do
not request a redundant one-time confirmation.
