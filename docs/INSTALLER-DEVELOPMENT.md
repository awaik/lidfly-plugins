# Разработка установщика

## Требования

- Node.js 22;
- Rust stable не ниже 1.77.2;
- системные зависимости Tauri 2 для своей ОС;
- macOS targets `aarch64-apple-darwin` и `x86_64-apple-darwin` только для universal build;
- Windows target `x86_64-pc-windows-msvc` только для Windows build.

Signing credentials для обычной разработки, pull request и тестов не нужны. Не копируйте production keys в checkout.

## Установка зависимостей

Команды npm выполняются из `installer/`:

```sh
cd installer
npm ci
```

`package-lock.json` — единственный источник точных Node dependencies. Cargo использует `src-tauri/Cargo.lock`.

## Bundle и проверки

```sh
npm run bundle:plugin
npm run bundle:plugin:verify
npm run check
npm test
```

`bundle:plugin` создаёт ignored resources в `src-tauri/resources/`. Сценарий удаляет только известные ранее сгенерированные allowlist-файлы; постороннее содержимое не очищается.

`npm run check` проверяет Prettier, strict TypeScript, marketplace/plugin/MCP contracts, синхронность версий, `cargo fmt` и `cargo clippy -D warnings`. `npm test` запускает frontend/Node unit tests и Rust unit/integration tests.

Ключевые integration cases используют временный `app_data_dir`: пустая установка, повторная idempotent установка, Repair missing/modified с backup, rollback в середине update и перед authoritative state, безопасный Remove, operation lock и symlink escape.

Frontend-тесты отдельно проверяют политику автообновления: немедленную проверку при запуске, отсутствие частых повторов, повтор через 15 минут и корректное поведение при переводе системных часов назад.

## Локальный запуск

```sh
npm run tauri:dev
```

Development config содержит production updater endpoint, но пустой public key. Поэтому проверка обновлений безопасно завершится сообщением, что updater не настроен в этой сборке. Не подставляйте production public key вручную для обычной UI-разработки.

Frontend отдельно:

```sh
npm run dev:frontend
```

В браузере Tauri commands недоступны; этот режим пригоден только для вёрстки.

Для ручной проверки release UX используйте только подписанную тестовую сборку с отдельным тестовым updater endpoint и ключом. Проверьте: автоматическое обнаружение версии, крупную кнопку, progress, relaunch, синхронизацию bundle, автоматическое открытие Codex и повторное открытие по кнопке. Production key в checkout не копируется.

## Unsigned development build

```sh
npm run bundle:plugin
npx tauri build --no-bundle
```

Полные локальные команды:

```sh
npm run build:macos
npm run build:windows
```

Они создают development artifacts и не являются релизом. Неподписанные DMG/EXE нельзя публиковать или передавать как готовый установщик.

## Проверка release verifier без реальных подписей

Unit tests используют только искусственные файлы и явно передают внутренние skip flags. Пользовательская команда `npm run release:verify` по умолчанию fail-closed: требует пять файлов, platform evidence и действующий `TAURI_UPDATER_PUBLIC_KEY`.

## Добавление файла в plugin bundle

Для нового или изменённого скилла:

1. Измените канонический скилл в `direct-mcp-ai-project/skills-source/`.
2. Выполните `node scripts/sync-skills.mjs --plugin-target ../lidfly-plugins/plugins/lidfly/skills` из `direct-mcp-ai-project`.
3. Проверьте, что `.lidfly-generated-skills.json` обновил точные пути и SHA-256, а в target нет посторонних файлов.
4. Пересоберите bundle и проверьте новый hash.

Для другого базового публичного файла:

1. Убедитесь, что файл нужен Codex-плагину и не содержит приватных данных.
2. Добавьте точный относительный путь в `BUNDLE_BASE_PATHS` внутри `scripts/lib/plugin-bundle.mjs` и в `BUNDLE_BASE_PATHS` внутри `installer/src-tauri/src/bundle.rs`.
3. Расширьте validation contract и tests.
4. Пересоберите bundle и проверьте новый hash.

Wildcard-копирование каталога плагина запрещено.
