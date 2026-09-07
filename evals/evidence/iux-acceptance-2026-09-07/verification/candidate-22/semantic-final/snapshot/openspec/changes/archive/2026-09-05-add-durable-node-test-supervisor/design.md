## Context

См. `proposal.md` для мотивации. Текущий coverage wrapper корректно ожидает
`close`, но наследует весь stdout test runner и не сохраняет единый полный
report. Node.js 22.23.1 в этом окружении поддерживает process isolation,
`--test-concurrency`, multiple reporters, coverage include/thresholds и
`--test-timeout`.

## Goals / Non-Goals

**Goals:**

- Один owner запуска и terminal verdict для документированных Node test lanes.
- Компактный success output, complete diagnostics текущего failed run и
  воспроизводимые artifacts.
- Завершение owned process tree при deadline или interrupt с обязательным
  ожиданием terminal state.
- Product-only coverage с явной baseline-политикой.

**Non-Goals:**

- Изменять runtime/facade/package/ACP semantics или скрывать их failures.
- Автоматически retry/re-run failing tests, использовать `--test-force-exit`
  или лечить coverage искусственными tests.
- Управлять процессами, не созданными supervisor, или заявлять OS-level
  гарантию graceful termination для неубиваемого процесса.

## Decisions

### Один supervisor с явным lane registry

`scripts/run-node-tests.mjs` владеет маленьким неизменяемым registry `unit`,
`coverage`, `release`. Это SSOT для CLI, README и project rules; отдельные
wrappers могут только передавать имя lane. `coverage` использует ровно тот же
набор, что `unit`, и добавляет coverage-adapter flags.

| Lane | Точный test-file набор | File concurrency | Individual timeout | Suite deadline | Preconditions |
| --- | --- | ---: | ---: | ---: | --- |
| `unit` | `bootstrap`, `check-openspec-semantics`, `codex-app-server-client`, `cursor-skill-eval`, `facade`, `mcp-smoke`, `mcp-transport`, `node-test-reporter-v22`, `run-cursor-skill-eval`, `runtime`, `node-test-supervisor` | 1 | 120 s | 600 s | Только local fixtures; hosted/live opt-ins очищены |
| `coverage` | Тот же точный набор, что `unit` | 1 | 120 s | 900 s | Полный coverage manifest загружен и сопоставлен с report |
| `release` | `release-e2e.test.mjs` | 1 | 120 s | 300 s | Hosted/live opt-ins очищены; отдельный явный запуск владеет ими |

`codex-client-integration.test.mjs` не входит в эти lanes: это отдельная
real-Codex/hosted-auth поверхность, которой уже владеет `run-cursor-skill-eval`.
Новый `node-test-supervisor.test.mjs` проверяет сам supervisor и reporter.

Альтернатива — shell commands в документации — отклонена: она не владеет
artifact lifecycle, process cleanup и единым terminal verdict.

### Reporter split: failure stream и полные artifacts

Supervisor создаёт новый artifact directory вне workspace fixture. Node запускается
с custom failure reporter, который получает `test:fail`, `test:summary` и
`test:coverage`; полный TAP/raw output пишется в artifacts. Parent process
сохраняет reporter output и raw stderr, после `close` печатает только summary
при success либо каждый failure error/cause и путь к artifacts при non-success.
Таким образом failure output берётся из того же run, а не из повторного
targeted execution.

Альтернатива — `stdio: inherit` — отклонена: успешные tests засоряют console и
полный diagnostics не имеет устойчивого artifact owner.

### Bounded lifecycle без masking leaks

На POSIX supervisor создаёт новую process group для test runner. При suite
deadline или полученном SIGINT/SIGTERM он записывает первый terminal cause,
посылает TERM только этой группе, ждёт bounded grace period, затем при
необходимости посылает KILL и ждёт `close`. На неподдерживаемой платформе
preflight возвращает `runner_error` до spawn. `--test-force-exit` исключён: он
может скрыть active handles и нарушить claim о clean completion.

Альтернатива — убивать только runner PID — отклонена: MCP/ACP child process
может пережить parent. Альтернатива — ждать бесконечно — отклонена: supervisor
тогда не даёт terminal verdict.

### Fail-closed coverage manifest и meaningful 90%

Coverage владеет точным manifest всех production `scripts/*.mjs`:
`check-openspec-semantics`, `codex-app-server-client`, `cursor-skill-eval`,
`cursor-subagent-bootstrap`, `cursor-subagent-mcp`, `recording-mcp-proxy`,
`run-cursor-skill-eval`, `run-node-tests`, versioned `node-test-reporter-v22` и
legacy `run-unit-coverage` (пока он существует). Test fixtures и reports не
входят в gate. До verdict supervisor требует равенство manifest, обнаруженных
product sources и per-file coverage entries; отсутствующий, новый
незарегистрированный или незагруженный source даёт failure. Meaningful tests
доводят lines, branches и functions каждого clean manifest-complete run не ниже
90.00%; этот minimum baseline является постоянным контрактом v1. Его повышение
требует отдельного change с воспроизводимым evidence. Качество тестов и допустимость локально обоснованных исключений
остаются governance policy владельца `AGENTS.md`; source нельзя скрыть из
manifest.

## Risks / Trade-offs

- [Custom reporter меняет форму event payload между Node versions] → reporter
  проверяется contract fixtures; Node version/flags проверяются preflight до
  start run.
- [Child создаёт detached descendant] → test contract запрещает detached
  children без собственного cleanup; timeout verdict сохраняет process-tree
  evidence и никогда не объявляется pass.
- [Множество failure details всё ещё велики] → success output остаётся
  компактным; при failure полные ошибки важнее краткости, raw artifact остаётся
  источником без truncation.
- [Новый source исчезает из denominator] → manifest equality fail-closed, а не
  улучшает percentage; preflight печатает отсутствующий путь.

## Migration Plan

1. Добавить POSIX supervisor, versioned reporter adapter, artifact schema и их
   contract tests.
2. Перенести существующий unit coverage wrapper на supervisor `coverage` lane.
3. Зафиксировать clean baseline и обновить README/AGENTS.md на единственный
   invocation path.
4. Добавить release lane без включения hosted/credential-gated runs по
   умолчанию.

Rollback: вернуть документированные прямые Node commands и удалить только
supervisor/reporter artifacts; product runtime contracts не затрагиваются.

## v1 Contract Baseline

**Goal.** Дать каждому Node test lane один foreground owner, terminal verdict,
полные artifacts текущего run и failure-only diagnostics.

**Non-goals.** Runtime/facade/package/ACP behavior, automatic retries,
coverage-by-gaming, чужие процессы, hosted credentials и OS-level promise
graceful shutdown.

**Public-invariant index.** `NTS-1` → «Терминальный foreground verdict»; `NTS-2` → «Диагностика текущего прогона без console шума»; `NTS-3` → «Lane selection и coverage scope».

**Owner map.** `node-test-supervision` owns runner lifecycle, artifacts, reporting and coverage gate. Node test runner owns test execution/report events; each existing runtime/facade/package/eval capability owns its test semantics and fixtures. AGENTS.md owns project-wide governance and coverage-quality policy.

**Implementation-ready exit.** Independent tests prove success, test failure,
crash, deadline, signal cleanup, POSIX process-group scope,
failure-without-rerun reporting, lane selection, manifest-complete coverage at
or above 90.00% per metric and coverage regression; `openspec validate --strict`
and semantic gate find no owner duplication.

**Future-change candidates.** CI artifact upload, cross-platform Windows
tree implementation, parallel safe-lane scheduling and historical coverage trend
dashboards.
