# Архитектура установщика LidFly для Codex

## Что делает приложение

`LidFly Codex Plugin Installer` — отдельное Tauri 2 приложение. Оно сохраняет проверенную локальную копию marketplace в per-user `app_data_dir`, затем открывает карточку плагина через документированный `codex://` URI. Пользователь сам нажимает кнопку установки в Codex и проходит OAuth LidFly по email.

Вторая, необязательная цель — Claude Desktop (Cowork). Установщик создаёт пользовательскую папку `<home>/LidFly` со снапшотом клиентского шаблона `awaik/direct-mcp-ai-project` (CLAUDE.md, скиллы, инструкции), обновляет в ней только свои managed-файлы и открывает папку через документированный deep link `claude://cowork/new`. MCP-коннектор `https://lidfly.ru/mcp/v3` пользователь добавляет вручную в настройках Claude, там же проходит OAuth; проект Cowork он подключает сам через «Use existing folder».

Приложение не устанавливает и не обновляет Codex или Claude Desktop, не вызывает их CLI и не редактирует `~/.codex/config.toml`, `claude_desktop_config.json`, plugin cache или OAuth-сессии этих приложений.

## Границы и поток данных

```text
tracked allowlist в lidfly-plugins
        │
        ▼
scripts/build-plugin-bundle.mjs
        │  стабильный порядок + SHA-256 manifest
        ▼
Tauri resources/plugin-bundle
        │
        ▼
staging в <app_data_dir>/marketplace/.lidfly-installer
        │  проверка → backup → transaction journal → переключение
        ▼
<app_data_dir>/marketplace/.agents/plugins/marketplace.json
        │
        ▼
codex://plugins/?marketplacePath=<percent-encoded-absolute-path>

тот же verified bundle ──▶ view файлов claude-project/** (префикс снят)
        │  тот же transaction engine, отдельный managed state
        ▼
<home>/LidFly/ (CLAUDE.md, .claude/skills/, инструкции)
        │
        ▼
claude://cowork/new?folder=<encoded-path>&q=<encoded-prompt>
```

Remote MCP остаётся только `https://lidfly.ru/mcp/v3` с transport `http`. В marketplace-части bundle нет исполняемого кода; снапшот `claude-project/` переносит инструкции, скиллы и вспомогательные скрипты публичного шаблон-репозитория, но исключает автоматически исполняемые hooks и project MCP settings. Установщик оставшиеся скрипты не запускает и раскладывает как обычные данные. API-ключей и OAuth-токенов в bundle нет.

## Детерминированный plugin bundle

Базовый allowlist задан в `scripts/lib/plugin-bundle.mjs`:

```text
.agents/plugins/marketplace.json
plugins/lidfly/.codex-plugin/plugin.json
plugins/lidfly/.mcp.json
plugins/lidfly/assets/icon.svg
plugins/lidfly/assets/logo-dark.svg
plugins/lidfly/assets/logo.svg
plugins/lidfly/skills-source.lock.json
plugins/lidfly/skills/.lidfly-generated-skills.json
claude-project-source.lock.json
claude-project/.lidfly-claude-project.json
```

Остальной allowlist скиллов детерминированно строится из `plugins/lidfly/skills/.lidfly-generated-skills.json`. Manifest содержит точные относительные пути и SHA-256 файлов каждого скилла. Разрешены только `SKILL.md`, `agents/openai.yaml` и ресурсы внутри `assets/`, `references/` или `scripts/`; wildcard-копирование каталога плагина запрещено.

Секция `claude-project/**` (bundle schema 3) строится из `claude-project/.lidfly-claude-project.json`, который генерирует `scripts/sync-claude-project.mjs` строго из закоммиченного `HEAD` локального клона `awaik/direct-mcp-ai-project` (`git archive`, не рабочая копия). Из пользовательского снапшота исключаются repository-only GitHub workflows, Claude project MCP/autoload settings, hooks и их аудиофайлы: подключение MCP остаётся явным действием пользователя в Claude. Пути снапшота — только печатный ASCII, без `..`, `\`, `.git/` и служебных имён установщика; `claude-project-source.lock.json` фиксирует repository, commit, детерминированный digest дерева и число файлов. Rust-проверка восстанавливает и сверяет этот контракт независимо.

Сборщик отклоняет пропавшие, пустые, неизвестные, рассинхронизированные, symlink и hardlink-файлы, path traversal, локальные абсолютные пути, development hostnames и похожие на секреты значения. Он валидирует JSON, стабильные идентификаторы, MCP endpoint, ссылки на assets и checksum-manifest скиллов. Rust-проверка установщика независимо восстанавливает тот же allowlist из встроенного manifest перед записью файлов.

Для каждого пути сохраняются размер и SHA-256. Общий `plugin_bundle_sha256` вычисляется по отсортированной последовательности:

```text
UTF8(path) + NUL + ASCII(size) + NUL + file_bytes + NUL
```

`skills-source.lock.json` связывает snapshot с полным commit `awaik/direct-mcp-ai-project` и детерминированным digest дерева skills. Метаданные не содержат timestamp, поэтому одинаковые входные байты дают одинаковый hash. Release job собирает bundle один раз и передаёт одни и те же resources macOS и Windows jobs.

## Раскладка данных пользователя

Tauri определяет `app_data_dir`; домашний каталог и `%APPDATA%` не хардкодятся.

```text
<app_data_dir>/marketplace/
├── .agents/plugins/marketplace.json
├── plugins/lidfly/...
└── .lidfly-installer/
    ├── installed-state.json
    ├── managed-files.json
    ├── operation.lock
    ├── backups/
    ├── transactions/
    └── logs/installer.jsonl

<app_data_dir>/content-cache/
├── <plugin-version>-<archive-sha256>/
│   ├── bundle.tar.gz
│   ├── bundle.tar.gz.sig
│   ├── plugin-bundle/
│   ├── plugin-bundle-files.json
│   ├── release.json
│   └── release.json.sig
└── active.json

<home>/LidFly/                  (создаётся только по явному действию пользователя)
├── CLAUDE.md, .claude/skills/, … — managed-файлы снапшота claude-project
├── … собственные документы пользователя (не управляются и не удаляются)
└── .lidfly-installer/          — тот же формат state/backups/transactions/logs
```

Папкой `<home>/LidFly` управляет второй `InstallerCore` с тем же транзакционным движком: производный bundle-view содержит файлы `claude-project/**` со снятым префиксом и собственным пересчитанным `plugin_bundle_sha256`, поэтому обновление marketplace-части не помечает папку как устаревшую. Managed-пути каждого layout проверяются своей политикой (`is_allowed_bundle_path` для marketplace, `is_safe_claude_project_source_path` для папки), так что state одного контура не может адресовать файлы другого. Автоматическая синхронизация после обновлений трогает папку только если пользователь уже создал её; неизвестные (пользовательские) файлы никогда не удаляются, изменённые managed-файлы требуют явного Repair с backup.

`installed-state.json` schema 2 — authoritative manifest и записывается последним. Он содержит версии installer/plugin, `bundle_origin`, source repository/commit, content key id, bundle hash, UTC-время успешной установки и полный список managed-файлов. Schema 0/1 мигрируется при чтении как `embedded`; неизвестная будущая schema блокирует запись.

## Файловый протокол и состояния

Перед каждой операцией приложение берёт exclusive lock. Затем оно проверяет root и все родительские каталоги без следования по symlink.

Состояние каждого allowlist-файла классифицируется как:

- `missing` — отсутствует;
- `unchanged` — совпадает с embedded SHA-256;
- `outdated` — совпадает с предыдущим managed state, но в новом bundle другие байты;
- `modified` — изменён вне установщика;
- `unsafe` — symlink, каталог или другой неподдерживаемый тип.

Install, Repair и bundle Update используют staging на том же filesystem. До переключения файлы повторно хешируются. Затрагиваемые обычные файлы копируются в backup с правами текущего пользователя. Transaction journal записывается до первого rename; authoritative state — последним. При обычной ошибке выполняется rollback. Если процесс аварийно завершился, следующий запуск обнаруживает journal: завершённая по state транзакция очищается, незавершённая откатывается.

Repair требует отдельного действия пользователя. Symlink не заменяется даже после подтверждения: сначала пользователь должен убрать небезопасный объект. Неизвестные файлы не удаляются.

Remove сверяет файл с SHA-256 из установленного state. Совпавшие файлы временно перемещаются и удаляются только после обновления state. Изменённые, unsafe и неизвестные файлы сохраняются и показываются пользователю; удаляются только опустевшие известные каталоги.

## Codex deep link

URI строит библиотека URL, а абсолютный путь кодируется как query value:

```text
codex://plugins/lidfly?marketplacePath=<encoded path to .agents/plugins/marketplace.json>
```

Имя плагина `lidfly` обязательно передаётся в path: без него Codex не может определить локальную карточку плагина. Тесты покрывают имя плагина, пробелы, кириллицу, macOS path, Windows drive letter и backslash. Системный handler открывается через официальный Tauri opener. Неудача handler отображается как «Codex не найден или не открывает ссылку» и не отменяет уже подготовленный bundle.

## Claude deep link

Для Claude Desktop используется документированный Anthropic deep link Cowork:

```text
claude://cowork/new?folder=<encoded absolute path to LidFly folder>&q=<encoded prompt>
```

Ссылка только открывает Cowork на папке и предзаполняет промпт — Claude показывает предупреждение «Prompt from an external link», и пользователь сам подтверждает выполнение. Постоянную запись в списке проектов Cowork установщик создать не может: пользователь один раз добавляет папку через «Use existing folder». Кодирование и ошибки handler обрабатываются так же, как для `codex://`; отсутствие Claude Desktop не отменяет уже подготовленную папку.

## Два updater-канала и подписи

Приложение проверяет `https://lidfly.ru/codex-plugin-downloads/latest.json` официальным Tauri updater и никогда не разрешает downgrade автоматически. Production public key внедряет release CI через отдельный config; base development config намеренно не содержит production key. Private updater key существует только в GitHub Actions secrets или защищённом хранилище релиз-инженера.

Проверка запускается после восстановления файлового состояния и повторяется каждые 15 минут, пока окно открыто. Возврат фокуса также инициирует проверку, если предыдущая была достаточно давно. Отсутствие сети не блокирует подготовку уже встроенного bundle; ошибка подписи показывается как отдельная ошибка безопасности.

Plugin content проверяется независимо по фиксированному `https://lidfly.ru/codex-plugin-content/latest.json`. Manifest и archive подписаны отдельным Ed25519 key, не связанным с Tauri updater key. Backend не принимает URL от frontend. Он проверяет strict schema, `min_installer_version`, anti-downgrade, exact HTTPS origin/route, размер, SHA-256 и обе подписи.

Archive extractor запрещает absolute/Windows/UNC/traversal paths, symlink, hardlink, duplicate и special entries и ограничивает compressed/unpacked size, число и размер файлов. Только после этого вызывается общий `verify_bundle`. Проверенный cache выбирается, если его версия не ниже embedded; повреждённый active pointer и каталог переводятся в диагностический quarantine при явной повторной проверке, после чего та же signed версия может быть загружена заново. Предыдущие versioned cache не удаляются автоматически.

Content-only update не вызывает relaunch. Полученный `VerifiedBundle` передаётся тому же `InstallerCore`, поэтому backup, operation lock, journal, atomic replace и crash recovery не дублируются. Tauri updater остаётся отдельным каналом приложения; если `min_installer_version` выше текущей, UI сначала предлагает обновить установщик.

Граница Codex остаётся явной: пользователь нажимает штатную кнопку установки или обновления на карточке плагина, перезапускает Codex и начинает новый чат. Установщик не вызывает Codex CLI, не пишет в plugin cache и не подменяет это подтверждение. Если managed-файлы изменены, автоматическая синхронизация останавливается и предлагает Repair с backup.

Приложение не устанавливает фоновый daemon, Login Item или Windows startup task. Автопроверка работает при запуске и пока окно установщика открыто.

Контуры доверия нельзя смешивать:

- Developer ID + hardened runtime + notarization + stapling защищают macOS приложение;
- Tauri updater `.sig` защищает байты updater payload.

По принятой для Glas release policy Windows EXE намеренно остаётся без Authenticode. Его detached `.sig` проверяется по финальным байтам EXE и защищает доставку через updater, но первоначальный запуск Windows всё равно считает запуском приложения неизвестного издателя.

## Логи и приватность

JSONL-журнал содержит только время, версию приложения, код операции, результат и относительные managed paths. В него не пишутся email, OAuth tokens, cookies, Authorization headers, MCP payload, environment dump и signing values. UI показывает backup как относительный путь внутри `.lidfly-installer`.
