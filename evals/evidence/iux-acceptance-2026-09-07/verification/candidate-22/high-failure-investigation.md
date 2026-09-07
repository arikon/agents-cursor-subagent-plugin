# Расследование дополнительного terra/high

Оба сбоя в acceptance-07/high.json остаются integration_failure / child_result_invalid. Ни один не переклассифицирован в pass, автоматических повторов нет.

| Сценарий | Serial | Turn start UTC | Последний принятый approval UTC | Timeout UTC | Длительность процесса |
| --- | ---: | --- | --- | --- | ---: |
| model-semantic-failure | 2 | 14:35:14.346 | 14:35:54.566 | 14:40:14.841 | 304013 ms |
| model-long-result | 3 | 14:40:19.954 | 14:41:02.116 | 14:45:20.578 | 305715 ms |

Доказанная ближайшая причина: оцениваемый Codex turn оставался inProgress с error:null весь 300-секундный terminal observation window. Последние client requests — thread/read с шагом около секунды. Terminal lifecycle notification отсутствует. Все waitingOnApproval переходы сняты сразу; незавершённого approval на момент timeout нет.

У semantic stderr пуст. У long-result есть ранняя ошибка codex_models_manager: failed to refresh available models: timeout waiting for child process to exit. Она не объясняет общий сбой: у второго случая её нет. Account rateLimits updated не является доказательством rate limit.

Успешные соседние runs на том же candidate:
- semantic: serial 1 около 69 s, serial 3 около 58 s; delegate → wait → close;
- long-result: serial 1 около 67 s, serial 2 около 202 s; delegate → wait → read_result(offset 0) → read_result(offset 8000) → close.

Два принятых approval у failed semantic и пять у failed long-result согласуются с этими последовательностями, но не доказывают конкретную последнюю операцию. Данные failed serverRequests и MCP transcript не сохранены.

High c12 перекрывался с medium c12. Во время старта failed semantic активны 19 сценариев, failed long-result — 18; после последнего approval long-result — 23. Это корреляция нагрузки. Long-result оставался зависшим до timeout, даже когда стал единственным активным сценарием. Причинная связь с конкуренцией, provider overload или MCP deadlock не установлена. Medium 78/78 прошёл, его максимум около 196 s.

## Граница доказательств и дефект диагностики

Hosted failure diagnostics сохраняет turn status, lifecycle, хвосты client request/method names и stderr, но не сохраняет recorder transcript, safe evidence и server request summary перед cleanup. Fixture cleanup удаляет локальные данные. Поэтому точную последнюю MCP-операцию, ответ fixture и момент возможной потери close/final нельзя восстановить из этого bundle.

Отдельное улучшение диагностики: до cleanup сохранять bounded нормализованные recorder/safe-evidence projections и server-request summaries в failure diagnostics, сохраняя ограничения на raw provider payload и pre-proof manifests. Нужен credential-free failure-path test, доказывающий сохранность после cleanup. Это не repair причины зависания: сама причина ещё не доказана. Текущие данные не обосновывают увеличение 300 s timeout или retry. Harness текущего Astra acceptance не меняется.

Ссылки и hashes исходных TAP/matrix artifacts: [hosted-results.json](hosted-results.json). Исходный код: tests/codex-client-integration.test.mjs, hostedFailureDiagnostics и terminal observation/catch/finally.
