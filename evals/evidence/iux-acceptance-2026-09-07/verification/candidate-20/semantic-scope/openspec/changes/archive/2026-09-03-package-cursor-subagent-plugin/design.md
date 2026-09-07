## Context

Current configuration contains machine-specific paths and source checkout is
required after installation.

## Decision

One bootstrap CLI owns managed installation, registrations, generated config and
release verification. Exact topology, schemas, hashes, lifecycle and
recovery are normative only in `cursor-plugin-distribution/spec.md` requirements
«Bootstrap paths and publication topology», «Managed marketplace lifecycle»,
«Внешний контракт bootstrap» and «Проверяемая чистая установка».

The implementation uses staging/backup siblings and atomic rename, not a new
transaction framework. It checks both observed registration tuples before any
mutation, preventing accidental removal of a neighbouring local plugin. Runtime
owns ACP lifecycle and wire fixtures; package owns discovery and one minimal
facade-level release canary.

## Trade-offs

The local single-user model requires deterministic diagnostics and manual recovery
instructions, not automatic force recovery or access to Cursor credentials.

## v1 Contract Baseline

**Goal.** Переносимая локальная установка, discovery и один минимальный canary
плагина в управляемом корне.

**Non-goals.** Управление credentials, автоматическое post-commit recovery,
универсальный transaction framework, raw ACP conformance и семантическая оценка
ответа модели.

**Public-invariant index.** «Переносимая настройка MCP»; «Managed marketplace lifecycle»; «Bootstrap paths and publication topology»; «Предflight готовности окружения»; «Внешний контракт bootstrap»; «Согласованная версия поставки»; «Проверяемая чистая установка».

**Owner map.** Этот change owns install/discovery и release canary; runtime owns
lifecycle and MCP wire contracts; facade owns workflow composition. Versioned
Codex CLI details belong to adapter golden fixtures.

**Implementation-ready exit.** Каждый package requirement имеет один
наблюдаемый outcome; commit predicate классифицирует managed artifact; semantic
gate не находит owner violation или нормативный дубль; independent critic не
находит `baseline_violation`.

**Future-change candidates.** Дополнительные версии Codex, автоматическое
recovery, richer observability и детерминированная оценка качества live-agent.
