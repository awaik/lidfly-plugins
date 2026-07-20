# Архитектура установщика LidFly для Codex

## Что делает приложение

`LidFly Codex Plugin Installer` — отдельное Tauri 2 приложение. Оно сохраняет проверенную локальную копию marketplace в per-user `app_data_dir`, затем открывает карточку плагина через документированный `codex://` URI. Пользователь сам нажимает кнопку установки в Codex и проходит OAuth LidFly по email.

Приложение не устанавливает и не обновляет Codex, не вызывает Codex CLI и не редактирует `~/.codex/config.toml`, plugin cache или OAuth-сессию Codex.

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
```

Remote MCP остаётся только `https://lidfly.ru/mcp/v3` с transport `http`. В bundle нет исполняемого кода, API-ключей или OAuth-токенов.

## Детерминированный plugin bundle

Allowlist задан в `scripts/lib/plugin-bundle.mjs` и состоит ровно из шести публичных файлов:

```text
.agents/plugins/marketplace.json
plugins/lidfly/.codex-plugin/plugin.json
plugins/lidfly/.mcp.json
plugins/lidfly/assets/icon.svg
plugins/lidfly/assets/logo-dark.svg
plugins/lidfly/assets/logo.svg
```

Сборщик отклоняет пропавшие, пустые, неизвестные, symlink и hardlink-файлы, path traversal, локальные абсолютные пути, development hostnames и похожие на секреты значения. Он валидирует JSON, стабильные идентификаторы, MCP endpoint и ссылки на assets.

Для каждого пути сохраняются размер и SHA-256. Общий `plugin_bundle_sha256` вычисляется по отсортированной последовательности:

```text
UTF8(path) + NUL + ASCII(size) + NUL + file_bytes + NUL
```

Метаданные не содержат timestamp, поэтому одинаковые входные байты дают одинаковый hash. Release job собирает bundle один раз и передаёт одни и те же resources macOS и Windows jobs.

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
```

`installed-state.json` — authoritative manifest и записывается последним. Он содержит schema version, версии installer/plugin, bundle hash, UTC-время успешной установки и полный список managed-файлов с размером и SHA-256. `managed-files.json` — проверяемое зеркало списка для диагностики. Миграция legacy schema без номера поддерживается; неизвестная будущая schema блокирует запись.

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
codex://plugins/?marketplacePath=<encoded path to .agents/plugins/marketplace.json>
```

Тесты покрывают пробелы, кириллицу, macOS path, Windows drive letter и backslash. Системный handler открывается через официальный Tauri opener. Неудача handler отображается как «Codex не найден или не открывает ссылку» и не отменяет уже подготовленный bundle.

## Updater и подписи

Приложение проверяет `https://lidfly.ru/codex-plugin-downloads/latest.json` официальным Tauri updater и никогда не разрешает downgrade автоматически. Production public key внедряет release CI через отдельный config; base development config намеренно не содержит production key. Private updater key существует только в GitHub Actions secrets или защищённом хранилище релиз-инженера.

Три независимых контура нельзя смешивать:

- Developer ID + hardened runtime + notarization + stapling защищают macOS приложение;
- Authenticode SHA-256 + trusted timestamp защищают Windows EXE;
- Tauri updater `.sig` защищает байты updater payload.

Windows updater signature проверяется после Authenticode по финальному EXE.

## Логи и приватность

JSONL-журнал содержит только время, версию приложения, код операции, результат и относительные managed paths. В него не пишутся email, OAuth tokens, cookies, Authorization headers, MCP payload, environment dump и signing values. UI показывает backup как относительный путь внутри `.lidfly-installer`.
