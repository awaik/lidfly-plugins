# Релиз установщика LidFly для Codex

Этот документ описывает подготовку подписанных файлов в `lidfly-plugins`. Он не разрешает commit, push, tag, GitHub Release, копирование в `direct-mcp` или production deploy. Каждое такое действие требует отдельной прямой команды пользователя.

## Версия и source gate

Одна версия `X.Y.Z` должна совпадать в:

- `plugins/lidfly/.codex-plugin/plugin.json`;
- `installer/package.json` и root записи `package-lock.json`;
- `installer/src-tauri/tauri.conf.json`;
- `installer/src-tauri/Cargo.toml` и локальном package entry `Cargo.lock`;
- `releases/X.Y.Z.json`, если metadata этого marketplace-релиза существует;
- tag `vX.Y.Z` и именах artifacts.

Проверка:

```sh
cd installer
npm run version:check
```

Release workflow принимает только точный clean tag commit. Bundle собирается один раз в `prepare`, а platform jobs получают одинаковый artifact и сравнивают `plugin_bundle_sha256`.

## Production updater keypair

Создайте отдельный keypair только для `LidFly Codex Plugin Installer` в защищённом окружении релиз-инженера:

```sh
cd installer
umask 077
npx tauri signer generate \
  --write-keys /secure/path/lidfly-codex-installer-updater.key \
  --password '<strong unique password>'
```

Не используйте key Glas или другого приложения. Private key и password не добавляются в Git, artifacts или cache. Значение созданного `.pub` добавляется как repository variable `TAURI_UPDATER_PUBLIC_KEY`; workflow валидирует его и внедряет только в release Tauri config. Base `tauri.conf.json` оставляет `pubkey` пустым для development builds.

Ротация key требует отдельного плана совместимости: уже установленные приложения доверяют ключу, с которым они были собраны.

## GitHub Actions secrets и variables

Secrets без значений:

```text
APPLE_CERTIFICATE
APPLE_CERTIFICATE_PASSWORD
APPLE_SIGNING_IDENTITY
APPLE_ID
APPLE_PASSWORD
APPLE_TEAM_ID

WINDOWS_CERTIFICATE
WINDOWS_CERTIFICATE_PASSWORD
WINDOWS_CERTIFICATE_THUMBPRINT

TAURI_UPDATER_PRIVATE_KEY
TAURI_UPDATER_PRIVATE_KEY_PASSWORD
```

Repository variables:

```text
TAURI_UPDATER_PUBLIC_KEY
WINDOWS_TIMESTAMP_URL
```

`APPLE_CERTIFICATE` и `WINDOWS_CERTIFICATE` — base64 архивы сертификатов с private key. Workflow не доступен pull requests, поэтому signing secrets не попадают в fork jobs.

## Запуск workflow

Поддерживаются:

- push уже согласованного tag `vX.Y.Z`;
- manual dispatch с `version: X.Y.Z`, только если такой tag уже существует и checkout совпадает с ним.

Workflow не создаёт GitHub Release и ничего не публикует на `lidfly.ru`. Результат — один защищённый Actions artifact `lidfly-installer-X.Y.Z-handoff`.

## Обязательные пять файлов

Для `1.0.0`:

```text
LidFly Codex Plugin Installer_1.0.0_universal.dmg
LidFly Codex Plugin Installer_1.0.0_universal.app.tar.gz
LidFly Codex Plugin Installer_1.0.0_universal.app.tar.gz.sig
LidFly Codex Plugin Installer_1.0.0_x64-setup.exe
LidFly Codex Plugin Installer_1.0.0_x64-setup.exe.sig
```

Verifier отклоняет пропуск, пустой файл и любой дополнительный filename с другим suffix/build number/alias.

Дополнительные handoff-файлы:

```text
SHA256SUMS.txt
plugin-bundle-files.json
release-handoff.json
```

## macOS job

Job собирает `universal-apple-darwin`, импортирует отдельный Developer ID Application certificate, включает hardened runtime, выполняет notarization и проверяет stapling DMG. Проверяются:

```sh
codesign --verify --deep --strict --verbose=2 <app>
codesign --verify --strict --verbose=2 <dmg>
spctl --assess --type execute --verbose=4 <app>
xcrun stapler validate <dmg>
lipo -archs <app binary>
```

`lipo` обязан показать `x86_64` и `arm64`. Эти проверки повторяются для app в build output, app из updater `.app.tar.gz` и app внутри DMG.

## Windows job

NSIS настроен как per-user installer для `x86_64-pc-windows-msvc`. До build workflow проверяет private key, срок действия и Code Signing EKU сертификата. У основного application binary, который упаковывает NSIS, отдельно читается PE header: machine обязан быть `AMD64` (`0x8664`). Сам NSIS bootstrapper может оставаться PE32 — это не меняет архитектуру установленного приложения. Tauri получает certificate thumbprint, SHA-256 и timestamp URL через release-only config. После build выполняются `Get-AuthenticodeSignature` и `signtool verify /pa /all /v`; status обязан быть `Valid`, timestamp certificate — присутствовать, а file digest — SHA-256.

Порядок обязателен:

1. Tauri собирает финальный NSIS EXE.
2. Bundler применяет Authenticode и timestamp.
3. Tauri signer создаёт `.sig` по уже подписанному EXE.
4. Отдельный Rust verifier проверяет `.sig` по финальным байтам EXE.

## Локальная проверка готового handoff

На каталоге уже подписанных artifacts:

```sh
cd installer
TAURI_UPDATER_PUBLIC_KEY='<public key>' npm run release:verify -- \
  --version X.Y.Z \
  --artifacts-dir /path/to/artifacts \
  --evidence /path/to/signing-evidence.json
```

`release:handoff` дополнительно требует clean checkout, существующий tag на текущем commit и формирует `SHA256SUMS.txt`/`release-handoff.json`:

```sh
TAURI_UPDATER_PUBLIC_KEY='<public key>' npm run release:handoff -- \
  --version X.Y.Z \
  --tag vX.Y.Z \
  --artifacts-dir /path/to/artifacts \
  --evidence /path/to/signing-evidence.json
```

Platform evidence содержит hashes реально проверенных payload, поэтому устаревший JSON не принимается.

## Handoff в direct-mcp

После отдельного разрешения передаются пять файлов, `plugin_bundle_sha256` и handoff metadata. Дальнейшие действия выполняются строго по соседнему `direct-mcp/docs/RUNBOOK-CODEX-PLUGIN-RELEASE.md`: подготовка guarded `latest.json`, атомарная публикация и stable URL smoke.

Нельзя копировать Tauri source, signing workflow или embedded bundle в `direct-mcp`.

## Rollback

До завершения smoke сохраняйте предыдущий полный подписанный release. Rollback на стороне раздачи возвращает предыдущий `latest.json` и каталог artifacts атомарно. Опубликованный tag и versioned файлы не переписываются. Исправление выпускается новой semver-версией.

Installer updater не смешивает версии: после перезапуска приложение синхронизирует embedded plugin bundle той же версии. Локально изменённые файлы блокируют update bundle до явного Repair с backup; автоматический downgrade запрещён.

## Ручной smoke перед публичным гайдом

Подписанные artifacts считаются непроверенными, пока на чистых профилях macOS и Windows x64 без Codex CLI не выполнены:

1. системная проверка подписи installer;
2. Prepare → verify → open `codex://`;
3. штатная установка LidFly в Codex и OAuth по email;
4. полный перезапуск Codex и новый чат;
5. `subscription_status` и один read-only запрос;
6. повторный Install, Repair, updater и Remove;
7. проверка сохранения modified и unknown файлов;
8. Windows path с пробелами и non-ASCII пользователем.

README нельзя переключать со статуса «установщик готовится» до публикации полного подписанного набора и успешного smoke обеих ОС.
