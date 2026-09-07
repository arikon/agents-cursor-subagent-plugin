## Context

Текущий MCP-сервер хранит Cursor ACP-процессы в памяти, выдаёт общий текст
ответа и не имеет устойчивого контракта для адресуемого ожидания, закрытия и
ограниченных callbacks.

## Goals / Non-Goals

Цель — один небольшой sessions registry с адресуемыми ходами и предсказуемым
завершением процесса. В scope входят scope guard рабочего каталога и
нормализованные ACP callbacks; это не sandbox, не durable resume и не
high-level facade делегирования.

## Decisions

### Владение контрактами

Один `SessionRecord` хранит immutable session metadata, active turn и последний
terminal turn. Один transition/terminalization path меняет lifecycle. Точные
переходы принадлежат requirement «Единая машина состояний runtime», публичные
MCP-схемы и event records — «Публичный MCP tool contract», а ограничения —
«Нормативные limits runtime». Design намеренно не повторяет их таблицы.

Ожидание, операции ответа и ACP filesystem callbacks имеют самостоятельных
owners в соответствующих requirements. Это SRP-разделение внутри одного модуля,
а не новые registry, supervisor или framework.

### Процесс и scope

Runtime запускает Cursor только с выбранной v1 process policy Auto-Review with
sandbox и передаёт только фактически полученные ACP requests. Canonical cwd и
optional allowed roots защищают от обычной ошибки scope; права процесса Cursor
не меняются. Общий graceful shutdown используют close, cancel, EOF, signal и
ошибки child process.

### Диагностика

Публичные результаты — bounded normalized records; raw ACP/stderr и public trace
не входят в v1. Package проверяет только свою release-ответственность, а exact
ACP callbacks остаются runtime fake-fixtures.

## v1 Contract Baseline

**Goal.** Адресуемый bounded ACP runtime.

**Non-goals.** OS sandbox, durable resume, policy engine, raw ACP mirror,
durable or unbounded audit trace and terminal-output evidence.

**Public-invariant index.** «Единая машина состояний runtime»; «Response envelopes и фаза allocation»; «Публичный MCP tool contract»; «Turn operations и permission options»; «Адресуемое ожидание состояния сессии»; «Изолированное состояние ходов и событий»; «Ограниченный жизненный цикл ACP-процесса»; «Нормативные limits runtime»; «Проверка scope рабочего каталога»; «Режимы Cursor и ACP callbacks»; «Ограниченный контекст интерактивных запросов».

**Owner map.** Этот change owns runtime requirements; facade и package only
reference them. Version-specific ACP forms belong to adapter golden fixtures.

**Implementation-ready exit.** Все перечисленные requirements имеют один
наблюдаемый outcome per scenario; semantic gate не находит дублирования или
верхнеуровневого owner violation; independent critic не находит
`baseline_violation`.

**Future-change candidates.** Durable resume, OS isolation, trace/event store,
richer terminal evidence.

## Risks / Trade-offs

- Различия ACP версий фиксируются fake ACP и строгим нормализующим контрактом.
- Scope guard не называется security sandbox; real OS isolation вне scope.
- Больше detail в named spec requirements делает handoff однозначным, не
  усложняя runtime-архитектуру.

## Migration Plan

1. Ввести `SessionRecord`, transition path и owner functions по runtime spec.
2. Покрыть fake-ACP tests lifecycle, events, callbacks и shutdown.
3. Package change использует этот runtime contract для единственного
   credential-gated release E2E.
