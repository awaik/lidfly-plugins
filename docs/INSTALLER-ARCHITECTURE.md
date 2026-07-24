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

Базовый allowlist задан в `scripts/lib/plugin-bundle.mjs`:

```text
.agents/plugins/marketplace.json
plugins/lidfly/.codex-plugin/plugin.json
plugins/lidfly/.mcp.json
plugins/lidfly/assets/icon.svg
plugins/lidfly/assets/logo-dark.svg
plugins/lidfly/assets/logo.svg
plugins/lidfly/skills/.lidfly-generated-skills.json
```

Остальной allowlist скиллов детерминированно строится из `plugins/lidfly/skills/.lidfly-generated-skills.json`. Manifest содержит точные относительные пути и SHA-256 файлов каждого скилла. Разрешены только `SKILL.md`, `agents/openai.yaml` и ресурсы внутри `assets/`, `references/` или `scripts/`; wildcard-копирование каталога плагина запрещено.

Сборщик отклоняет пропавшие, пустые, неизвестные, рассинхронизированные, symlink и hardlink-файлы, path traversal, локальные абсолютные пути, development hostnames и похожие на секреты значения. Он валидирует JSON, стабильные идентификаторы, MCP endpoint, ссылки на assets и checksum-manifest скиллов. Rust-проверка установщика независимо восстанавливает тот же allowlist из встроенного manifest перед записью файлов.

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
codex://plugins/lidfly?marketplacePath=<encoded path to .agents/plugins/marketplace.json>
```

Имя плагина `lidfly` обязательно передаётся в path: без него Codex не может определить локальную карточку плагина. Тесты покрывают имя плагина, пробелы, кириллицу, macOS path, Windows drive letter и backslash. Системный handler открывается через официальный Tauri opener. Неудача handler отображается как «Codex не найден или не открывает ссылку» и не отменяет уже подготовленный bundle.

## Updater и подписи

Приложение проверяет `https://lidfly.ru/codex-plugin-downloads/latest.json` официальным Tauri updater и никогда не разрешает downgrade автоматически. Production public key внедряет release CI через отдельный config; base development config намеренно не содержит production key. Private updater key существует только в GitHub Actions secrets или защищённом хранилище релиз-инженера.

Проверка запускается после восстановления файлового состояния и повторяется каждые 15 минут, пока окно открыто. Возврат фокуса также инициирует проверку, если предыдущая была достаточно давно. Отсутствие сети не блокирует подготовку уже встроенного bundle; ошибка подписи показывается как отдельная ошибка безопасности.

Когда доступна новая версия, UI показывает отдельную крупную карточку обновления. После подтверждения Tauri скачивает и проверяет updater payload, устанавливает его и перезапускает приложение. Новый бинарник содержит plugin bundle той же версии. При первом запуске `sync_bundle_after_update` транзакционно обновляет локальный marketplace, если предыдущий bundle уже был подготовлен, файлы не изменены пользователем и downgrade не обнаружен. Затем приложение автоматически открывает карточку LidFly в Codex.

Граница Codex остаётся явной: пользователь нажимает штатную кнопку установки или обновления на карточке плагина, перезапускает Codex и начинает новый чат. Установщик не вызывает Codex CLI, не пишет в plugin cache и не подменяет это подтверждение. Если managed-файлы изменены, автоматическая синхронизация останавливается и предлагает Repair с backup.

Приложение не устанавливает фоновый daemon, Login Item или Windows startup task. Автопроверка работает при запуске и пока окно установщика открыто.

Контуры доверия нельзя смешивать:

- Developer ID + hardened runtime + notarization + stapling защищают macOS приложение;
- Tauri updater `.sig` защищает байты updater payload.

По принятой для Glas release policy Windows EXE намеренно остаётся без Authenticode. Его detached `.sig` проверяется по финальным байтам EXE и защищает доставку через updater, но первоначальный запуск Windows всё равно считает запуском приложения неизвестного издателя.

## Логи и приватность

JSONL-журнал содержит только время, версию приложения, код операции, результат и относительные managed paths. В него не пишутся email, OAuth tokens, cookies, Authorization headers, MCP payload, environment dump и signing values. UI показывает backup как относительный путь внутри `.lidfly-installer`.
