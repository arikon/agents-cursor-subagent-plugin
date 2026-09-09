Провожу независимую openspec-verify для `add-cursor-model-discovery`: сначала skill и артефакты change, затем сопоставление с кодом и тестами.Читаю артефакты change и evidence в указанном scope.Дальше — evidence, registry и ключевые implementation/test файлы.Search guard блокирует широкий grep — читаю ключевые файлы точечно.Serena отклонена — читаю implementation-файлы напрямую.Читаю runtime и связанные файлы по частям — поиск по содержимому блокируется.Проверяю тесты stderr/E2E, bootstrap и evidence приёмки.## Verification Report: `add-cursor-model-discovery`

Статический read-only review: реализация MD-1…MD-8 в коде и тестах выглядит согласованной с frozen baseline; **CRITICAL по отсутствующей реализации не найдены**. Приёмку coverage/release/live **не перезапускал** — вердикт archive условный.

### Summary

| Dimension | Status |
|-----------|--------|
| Completeness | **13/13** tasks `[x]`; **8/8** MD-1…MD-8 с найденной реализацией |
| Correctness | **8/8** req mapped to code+observable tests (static); soft gaps по 1–2 сценариям |
| Coherence | Baseline/owner map/KISS соблюдены; риск параллельного `simplify-task-state-wait` |

**Verified evidence (этот проход):** артефакты change, `AGENTS.md`, код в `scripts/`/`skills/`/`.codex-plugin`/`.mcp.json`, тесты/fixtures в `tests/`, evidence в `openspec/changes/add-cursor-model-discovery/evidence/`.

**Inference only:** PASS coverage/release/live из `evidence/implementation.md` (ссылки на `/var/folders/.../result.json` **вне scope**, не открывались). Тесты **не объявляются выполненными**.

---

### Completeness

**Tasks:** 1.1–1.2, 2.1–2.5, 3.1–3.2, 4.1–4.4 — все `[x]` (13/13). Incomplete: 0.

**Requirements → реализация**

| ID | Requirement | Implementation (path:line) |
|----|-------------|----------------------------|
| MD-1 | Получение моделей | `scripts/cursor-subagent-mcp.mjs:746-786,852`; adapter `scripts/cursor-model-adapter.mjs:11-63`; tool `993-994` |
| MD-2 | MCP tool contract | tools/`optimize_for` `987-1007`; `admitModelParams` `240-250`; envelopes `299-308,860-868` |
| MD-3 | Limits | `LIMITS.discoveryMs/Bytes` `11-15`; slot/timeout/abort `746-785` |
| MD-4 | Bounded provider errors + stderr | capture/drain `379-388,699-709`; probe `390-416` |
| MD-5 | Skill workflow | `skills/cursor-subagent/SKILL.md:11-71` (discovery/Auto/diagnostics) |
| MD-6 | Выбор до prompt | `resolveModelSelection`/`verifyModelSelection` `64-102`; `selectModel` `787-791`; verify after new/load `446,457` |
| MD-7 | Неинтерактивный auth | `readApiKey`/`childEnvironment` `722-744`; no `authenticate` in init `438-460` |
| MD-8 | Resume | `resume` `813-826` → общий `start`/`childEnvironment` |

---

### Correctness (сценарии → code/tests)

| Scenario | Code | Observable test (не запускался) |
|----------|------|----------------------------------|
| Список до сессии | mcp `852`, adapter `11-63` | `tests/model-discovery.test.mjs:19-26` |
| API key отсутствует | `722-733` | `57-67`, `68-78` |
| Повтор discovery без cache | `746-785` | `35-55` |
| API/schema failure | `761-780` | `80-97`, `270-297`, `397-418` |
| Параллель + shutdown | `748,793-795` | `99-119`, `421-435` |
| Explicit Auto / mismatch | `246-248`, argv `120` | `198-228`, `230-238`, `350-354` |
| GPT fast / Grok / aliases | adapter `64-85` | `183-196`, `230-238` |
| Resume selection mismatch | `443-446` | `356-378` |
| Auth file apiKey / token-only / malformed | `735-744` | `466-557` |
| Stderr init / late drain / version probe | `379-388,699-709,248-257` | `runtime.test.mjs:199-280` |
| Package E2E discovery + diagnostics | — | `release-e2e.test.mjs:212-239,474-497` |
| tools/list schema | `993-997` | `mcp-transport.test.mjs:72-104` |
| MD-5 discovery/Auto/diagnostics | SKILL `11-71` | semantic audit в evidence (не model-behavior eval) |

**Шумный успешный startup (MD-4):** поведение «не failure + очистка buffer» в коде (`373`); тест покрывает **version probe** success с шумным stderr (`248-257`). ACP `session/new` с нефатальным stderr fixture **не моделирует** (`fake-acp.mjs:387-392` всегда `exit(1)`).

---

### Coherence

- **v1 baseline** в `design.md` есть: goal/non-goals, MD-1…8, owner map, exit, future candidates.
- **Owner map** согласован с `openspec-semantic-registry.mjs:196-209` и design: runtime MD-1–4,6–8; facade MD-5; adapter/golden — schema.
- **KISS/SSOT:** один HTTP discovery path, один resolver, один auth reader; нет registry/cache/policy engine.
- **Version-specific boundary:** adapter+fixture `cursor-model-catalog-1.0.31.json`; product MCP остаётся compact.
- **Параллельный `simplify-task-state-wait`:** оба change ветвят MD-2/MD-5 от одного IUX `sourceDigest` (`3d712b…` / `3f8e7fb…`) с разными replacementDigest — риск rebase при land другого change (design Risks это уже фиксирует).

---

### Issues

#### CRITICAL
*Нет.* Незавершённых tasks и отсутствующих реализаций MD-1…MD-8 по статическому review не видно.

#### WARNING

1. **Приёмочные lanes не независимо подтверждены** — `implementation_concern`  
   Tasks 4.2/4.3 опираются на temp `result.json` вне scope.  
   **Мин. рекомендация:** перед archive в foreground повторить `coverage`, `release` и (при необходимости) live canary; приложить in-scope evidence или принять claims явно.

2. **Коллизия digests с `simplify-task-state-wait`** — `implementation_concern`  
   Одинаковые source blocks MD-2/MD-5, разные replacements.  
   **Мин. рекомендация:** перед sync/archive сверить source digests с целевым base; при land SW — минимальный rebase MD delta (task 1.1/4.4).

3. **Сценарий «Шумный успешный startup» слабо закрыт на ACP-пути** — `implementation_concern`  
   Есть probe-success; нет non-fatal ACP stderr → live.  
   **Мин. рекомендация:** один fixture: stderr warning на `session/new` без exit → `live`, `terminal_reason: null`, buffer не удерживается.

#### SUGGESTION

4. **Live canary пишет skill copy в `/tmp`** — `implementation_concern`  
   `release-e2e.test.mjs:470-471`.  
   **Мин. рекомендация:** писать под `layout.root` / diagnostic-only, без глобального `/tmp`.

5. **Eval corpus не расширялся под discovery** — `new_scope` (совпадает с design future-change)  
   Package E2E расширен; behavior eval не обязателен для v1.  
   **Мин. рекомендация:** не тащить в этот change; отдельный candidate при необходимости.

---

### Archive readiness

**Не ready к archive без оговорок.**  
Статически blockers/`baseline_violation` не найдены; для archive нужно:

1. Принять или закрыть WARNING #1 (перепрогон lanes) и #2 (SW digests).  
2. Желательно закрыть WARNING #3.  
3. Sync/archive — отдельный явный запрос (по design Migration).

**Пропущено в этом проходе:** `openspec status/validate`, semantic gate CLI, любой `run-node-tests`, Cursor CLI, live/network, внешние `/var/folders` и `/tmp` artifacts, другие агенты/ICM.