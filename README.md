# Codex Cursor Subagent Plugin

Прототип локального плагина Codex, который запускает установленный `agent acp` и предоставляет его как интерактивного субагента через MCP.

Для personal-установки `.mcp.json` использует подтверждённые абсолютные пути к Node из ChatGPT.app и Cursor Agent с файловым credential store. Переносимая managed-установка остаётся отдельным package-canary механизмом; source checkout после неё не нужен.

## Модель взаимодействия

`Codex → MCP-плагин → Cursor ACP (stdio JSON-RPC)`

Плагин не использует `cursor-agent --yolo`, файловый IPC или автоматическое подтверждение команд. Основной workflow — `cursor_delegate → cursor_wait`; вопросы, планы и разрешения остаются ожидающими до явного адресного ответа.

## Требования

- Node.js 18+;
- установленный Cursor Agent (`agent`) и выполненный `agent login`; для нестандартного пути задайте `CURSOR_AGENT_COMMAND` в окружении MCP-сервера;
- Codex с поддержкой локальных плагинов/MCP.

Для локальной проверки:

```sh
node --test tests/mcp-smoke.test.mjs
```

## Глобальная personal-установка

Это единственный пользовательский путь глобальной установки. Marketplace
`personal` уже имеет root `/Users/arikon`; его plugin source должен быть
симлинком `/Users/arikon/plugins/codex-cursor-subagent-plugin` на этот checkout.
Не передавайте `/Users/arikon` в `cursor-subagent-bootstrap.mjs`: managed
bootstrap владеет целым root и предназначен только для отдельного disposable
marketplace в package-canary.

После изменения плагина обновите cachebuster и переустановите тот же personal
plugin:

```sh
python3 /Users/arikon/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py \
  /Users/arikon/projects/codex-cursor-subagent-plugin
/Applications/ChatGPT.app/Contents/Resources/codex plugin add \
  codex-cursor-subagent-plugin@personal --json
```

Проверьте результат через `codex plugin list --json`: должен присутствовать
ровно один `codex-cursor-subagent-plugin@personal`, указывающий на симлинк
выше. Для подхвата обновлённых skills и MCP создайте новую задачу Codex.

## Использование при разработке

После global personal-установки основной инструмент — `cursor_delegate`; answer-tools и `cursor_wait` составляют interactive workflow. Runtime advanced API включает только `cursor_start_session`, `cursor_send_prompt`, `cursor_session_status` и `cursor_cancel`.

Передавайте `cwd` отдельного worktree для любой задачи, которая может изменять файлы. Для read-only задачи явно передавайте режим `ask`; перед изменением файлов явно выберите `agent`.

## Изолированная переносимая установка

`scripts/cursor-subagent-bootstrap.mjs` — единственная точка изолированного managed-install для package release canary.
Она принимает абсолютные canonical пути к source root, managed marketplace root,
Node.js, Codex, Cursor Agent и разрешённым workspace roots. Команда
`preflight` только проверяет readiness; `install`, `update` и `uninstall`
работают через version-specific adapter. Перед реальной регистрацией сначала
запусти preflight; live Codex/Cursor canary является явным opt-in и не заменяет
детерминированные fake-fixture тесты.
