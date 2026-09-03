## Context

Runtime MCP API expresses ACP mechanics, while Codex needs one small operation
for a delegated task with a prompt and immutable workspace context.

## Decision

`cursor_delegate({prompt,cwd,mode})` is only a facade composition:
`cursor_start_session` → `cursor_send_prompt`. Start already returns a live
session or terminal tombstone synchronously; the facade owns neither
session state, envelopes, wait cursors nor permission policy: those are owned by
the named runtime requirements «Единая машина состояний runtime», «Response
envelopes и фаза allocation», «Публичный MCP tool contract» and «Turn operations
и permission options».

For writing `agent`, the caller supplies an already isolated worktree; runtime
checks canonical scope only and does not invent VCS ownership detection. This is
a discipline boundary, not sandboxing. The facade exposes protocol completion,
not a claim of semantic task success.

## Trade-offs

One facade avoids repetitive start/wait/send plumbing without adding a second
registry, tool family or state machine.

## v1 Contract Baseline

**Goal.** Один `cursor_delegate` composition path и skill workflow поверх runtime.

**Non-goals.** Lifecycle registry, envelope/state ownership, pre-turn wait,
semantic-success claim и VCS/worktree automation.

**Public-invariant index.** «Высокоуровневое создание делегирования»; «Workspace discipline делегирования»; «Skill workflow делегирования». Runtime references are only the named requirements in the owner change.

**Owner map.** Этот change owns only composition; runtime owns lifecycle, MCP
schemas, wait and permission semantics; package owns installation/canary.

**Implementation-ready exit.** Facade scenarios have one result shape and do not
repeat runtime norms; semantic gate is green; independent critic finds no
`baseline_violation`.

**Future-change candidates.** Worktree allocation, semantic task evaluation,
multi-delegate orchestration.
