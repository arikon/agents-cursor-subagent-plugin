## Context

См. мотивацию в `proposal.md`. Изменение ограничено наблюдаемыми контрактами
test/eval lanes; runtime, facade и package сохраняют существующее ownership.

## v1 Contract Baseline

**Goal.** Убрать ложнозелёные результаты в локальных и CI test/eval lanes,
сохранив публичные MCP tools, lane names и package bootstrap boundary.

**Non-goals.** Не менять ACP lifecycle, MCP wire schema или authority policy
runtime; не добавлять провайдеры, внешние сервисы, зависимости или новый CI
backend; не превращать disabled optional eval lane в обязательный live run.

**Public-invariant index.** `NTS-2` → «Диагностика текущего прогона без console шума»; `NTS-3` → «Lane selection и coverage scope»; `EVAL-1` → «Eval transcript plumbing и process verdict»; `EVAL-2` → «Изолированные и переносимые integration fixtures».

**Owner map.** `cursor-subagent-skill-evals` owns eval evidence and process verdicts; `node-test-supervision` остаётся владельцем supervisor lifecycle и coverage gate. Recording proxy владеет только bounded transcript; runtime сохраняет немедленную валидацию MCP IDs/order, а facade/package не получают новой state machine.

**Implementation-ready exit.** Каждый инвариант имеет один observable
regression-test owner; `unit`, `coverage` и `release` проходят foreground;
raw coverage counters классифицированы; strict/semantic gates проходят;
независимый critic не находит `baseline_violation`.

**Future-change candidates.** Единая CI policy для optional credentialed lanes
и машинночитаемая классификация branch/function denominator не входят в v1.

## Goals / Non-Goals

**Goals:** единый артефактный путь ранних ошибок, fail-closed per-file coverage,
фактический transcript, переносимые fixtures и честный process verdict.

**Non-Goals:** не дублировать runtime validation в eval driver и не ослаблять
coverage широкими исключениями.

## Decisions

### Единый ранний result publication

Supervisor создаёт artifact directory до preflight/spawn и использует один
publisher для terminal и ранних runner errors. Console-only путь отклонён,
поскольку не оставляет воспроизводимого CI evidence.

### Per-file coverage admission

Gate проверяет line counters каждого manifest source до агрегации. Нулевые
branch/function denominators классифицируются явно; line denominator обязателен.

### Transcript как единственный фактический input

Recording proxy передаёт bounded события в порядке наблюдения; mapper не
добавляет events из scenario program. Семантическую классификацию сохраняет
существующий owner `Scenario program driver и pure scenario oracle`.

### Изолированные fixture ресурсы

Fake provider получает ephemeral port и возвращает endpoint после readiness.
Hosted credential выбирается из явного пути либо portable home resolution.
Version-specific adapter объявляет custom app-server provider с полученным
endpoint и `responses` wire API: встроенный `oss_provider` применим только к
запуску с `--oss` и не является контрактом app-server fixture.

## Risks / Trade-offs

- [Ранний publisher откажет] → только тогда completion marker отсутствует и
  console оставляет bounded diagnostic.
- [Transcript достигнет byte bound] → dropped-call факт сохраняется, результат
  не классифицируется как pass без полного доказательства.
- [Ephemeral provider readiness] → endpoint возвращается только после bind;
  покрываются два параллельных fixtures.

## Migration Plan

Внешней миграции нет. После реализации выполняются стандартные foreground
lanes; rollback — откат одного change, так как артефактная schema и MCP tools
не меняются.
