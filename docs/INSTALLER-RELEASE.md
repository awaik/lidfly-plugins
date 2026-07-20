# Локальный релиз установщика LidFly для Codex

В этом репозитории нет активных GitHub Actions. Сборка, тесты, подпись,
notarization и проверка выполняются на локальных компьютерах. GitHub получает
только полностью готовые файлы через GitHub CLI и не расходует Actions minutes.

Документ не разрешает сам по себе commit, push, создание tag, GitHub Release,
копирование в `direct-mcp` или production deploy. Для этих действий нужна прямая
команда пользователя.

## Как теперь работает CI

Главная проверка запускается локально на машине разработчика:

```sh
cd installer
npm run ci:local
```

Команда устанавливает точные npm dependencies, дважды собирает plugin bundle и
проверяет его детерминированность, запускает format/type/project/version/Rust
checks, Node/Rust tests, компилирует native development application и отклоняет
случайно отслеживаемые секреты и бинарные artifacts.

Перед commit и push эта команда обязательна. Push и pull request ничего не
запускают на GitHub. Активных файлов в `.github/workflows/` быть не должно;
пояснение хранится в `.github/workflows.disabled/README.md` по схеме Glas.

## Версия и чистый source

Одна версия `X.Y.Z` должна совпадать в:

- `plugins/lidfly/.codex-plugin/plugin.json`;
- `installer/package.json` и root entry `package-lock.json`;
- `installer/src-tauri/tauri.conf.json`;
- `installer/src-tauri/Cargo.toml` и package entry `Cargo.lock`;
- `releases/X.Y.Z.json`, если metadata существует;
- tag `vX.Y.Z` и именах release files.

Платформы собираются из одного и того же уже согласованного tag. Если основной
checkout содержит пользовательские изменения, release выполняется в отдельном
чистом worktree, не затрагивая их:

```sh
RELEASE_ROOT="$(mktemp -d)"
RELEASE_WORKTREE="$RELEASE_ROOT/source"
git worktree add --detach "$RELEASE_WORKTREE" vX.Y.Z
cd "$RELEASE_WORKTREE/installer"
npm run ci:local
```

## Локальные ключи

Updater keypair относится только к `LidFly Codex Plugin Installer`. Local release
не читает GitHub secrets: private key и password не добавляются в Git, artifacts
или shell history. Public key не является секретом, но обе платформы обязаны
использовать один и тот же файл.

Рекомендуемые защищённые локальные файлы:

```text
$USERPROFILE/.tauri/lidfly-codex-installer-updater.key       # Windows
$USERPROFILE/.tauri/lidfly-codex-installer-updater.key.pub

локальный каталог ~/.tauri с правами 600                   # macOS
lidfly-codex-installer-updater.key
lidfly-codex-installer-updater.key.pub
```

На macOS password может лежать в login Keychain как generic password:

```text
service: ru.lidfly.codex-plugin-installer.updater-key
account: имя локального пользователя
```

Скрипт сначала читает `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` из environment, а
при его отсутствии получает password из этого Keychain item без печати.

Для Apple notarization используется сохранённый keychain profile
`glas-notary`. Поэтому `APPLE_ID` и app-specific password не нужно экспортировать
или хранить в репозитории: `notarytool` читает их из Keychain. Доступ проверяется
без раскрытия значений:

```sh
xcrun notarytool history --keychain-profile glas-notary
security find-identity -v -p codesigning
```

Windows следует схеме Glas: EXE намеренно не имеет Authenticode. Переменные
`WINDOWS_CERTIFICATE*` не нужны. Detached Tauri updater signature защищает
обновление, но первоначально скачанный EXE остаётся для SmartScreen приложением
неизвестного издателя.

## Локальная сборка macOS

На Mac должны быть Node 22, Rust stable, targets `aarch64-apple-darwin` и
`x86_64-apple-darwin`, Developer ID Application certificate и профиль
`glas-notary`.

```sh
cd installer
export APPLE_SIGNING_IDENTITY='<SHA-1 Developer ID Application certificate>'
export APPLE_TEAM_ID='<Apple team id>'
export NOTARYTOOL_PROFILE='glas-notary'
export TAURI_SIGNING_PRIVATE_KEY_PATH='/protected/path/lidfly-codex-installer-updater.key'
export TAURI_UPDATER_PUBLIC_KEY_PATH='/protected/path/lidfly-codex-installer-updater.key.pub'

npm run release:macos:local -- X.Y.Z /absolute/output/X.Y.Z/macos
```

Скрипт локально:

1. собирает universal app с `x86_64` и `arm64`;
2. подписывает Developer ID и включает hardened runtime;
3. отправляет app в Apple через локальный `glas-notary`, затем stapling;
4. заново создаёт updater archive из stapled app и подписывает его updater key;
5. создаёт, подписывает, notarizes и staples финальный DMG;
6. проверяет `codesign`, Gatekeeper, stapling, обе архитектуры и updater signature;
7. сохраняет три macOS файла, `apple-evidence.json` и bundle metadata.

## Локальная сборка Windows

Предпочтительный вариант — локальный Windows x64 компьютер или локальная
Windows VM. Нужны Node 22, Rust stable, `x86_64-pc-windows-msvc`, Visual Studio
Build Tools и NSIS prerequisites Tauri.

В PowerShell из чистого checkout того же tag:

```powershell
cd installer
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = 'C:\protected\lidfly-codex-installer-updater.key'
$env:TAURI_UPDATER_PUBLIC_KEY_PATH = 'C:\protected\lidfly-codex-installer-updater.key.pub'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '<read from local secret storage>'

npm run ci:local
npm run release:windows:local -- -Version X.Y.Z -ArtifactsDir C:\release\X.Y.Z\windows
```

Скрипт собирает NSIS для `x86_64-pc-windows-msvc`, проверяет AMD64 application
payload, требует `Get-AuthenticodeSignature = NotSigned`, проверяет updater
signature и сохраняет Windows evidence. Mac и Windows bundle metadata должны
совпасть byte-for-byte.

Если локальной Windows VM нет, Tauri официально допускает менее проверенный
MSVC/NSIS cross-build на macOS через `cargo-xwin`. Это не GNU-подмена: target
остаётся `x86_64-pc-windows-msvc`. Однократная подготовка Mac:

```sh
brew install llvm nsis
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
```

Локальная cross-сборка:

```sh
cd installer
export TAURI_SIGNING_PRIVATE_KEY_PATH='/protected/path/lidfly-codex-installer-updater.key'
export TAURI_UPDATER_PUBLIC_KEY_PATH='/protected/path/lidfly-codex-installer-updater.key.pub'

npm run release:windows:cross-local -- X.Y.Z /absolute/output/X.Y.Z/windows
```

Скрипт использует LLVM linker/resource compiler, NSIS и Microsoft SDK из
защищённого локального `cargo-xwin` cache. Отсутствие Authenticode проверяется
напрямую по пустому PE Security Directory, независимо от PowerShell. Перед
публикацией cross-built EXE всё равно запускается на чистой реальной Windows x64.

## Обязательные пять файлов

Для `1.0.0`:

```text
LidFly Codex Plugin Installer_1.0.0_universal.dmg
LidFly Codex Plugin Installer_1.0.0_universal.app.tar.gz
LidFly Codex Plugin Installer_1.0.0_universal.app.tar.gz.sig
LidFly Codex Plugin Installer_1.0.0_x64-setup.exe
LidFly Codex Plugin Installer_1.0.0_x64-setup.exe.sig
```

## Сборка общего handoff

Каталоги с двух локальных машин объединяются в новый пустой каталог:

```sh
cd installer
npm run release:assemble -- \
  --version X.Y.Z \
  --macos-dir /absolute/output/X.Y.Z/macos \
  --windows-dir /absolute/output/X.Y.Z/windows \
  --output-dir /absolute/output/X.Y.Z/final
```

Затем из чистого tagged worktree выполняется строгая проверка и создаются
`SHA256SUMS.txt` и `release-handoff.json`:

```sh
export TAURI_UPDATER_PUBLIC_KEY="$(< /protected/path/lidfly-codex-installer-updater.key.pub)"
npm run release:verify -- \
  --version X.Y.Z \
  --artifacts-dir /absolute/output/X.Y.Z/final \
  --evidence /absolute/output/X.Y.Z/final/signing-evidence.json

npm run release:handoff -- \
  --version X.Y.Z \
  --tag vX.Y.Z \
  --artifacts-dir /absolute/output/X.Y.Z/final \
  --evidence /absolute/output/X.Y.Z/final/signing-evidence.json
```

Verifier отклоняет отсутствующий/лишний release filename, пустой файл, неверный
hash, несовпадающий plugin bundle, platform evidence от других bytes и любую
невалидную updater signature. Внутренний каталог `plugin-bundle/` нужен только
для этой локальной проверки и не загружается как отдельный GitHub Release asset.

## GitHub только выкладывает

После отдельного разрешения готовые файлы загружаются напрямую через GitHub API.
Это не запускает runner:

```sh
FINAL_DIR='/absolute/output/X.Y.Z/final'
gh release create vX.Y.Z \
  --repo awaik/lidfly-plugins \
  --verify-tag \
  --title 'LidFly Codex Plugin Installer X.Y.Z' \
  --notes 'Release notes' \
  "$FINAL_DIR/LidFly Codex Plugin Installer_X.Y.Z_universal.dmg" \
  "$FINAL_DIR/LidFly Codex Plugin Installer_X.Y.Z_universal.app.tar.gz" \
  "$FINAL_DIR/LidFly Codex Plugin Installer_X.Y.Z_universal.app.tar.gz.sig" \
  "$FINAL_DIR/LidFly Codex Plugin Installer_X.Y.Z_x64-setup.exe" \
  "$FINAL_DIR/LidFly Codex Plugin Installer_X.Y.Z_x64-setup.exe.sig" \
  "$FINAL_DIR/SHA256SUMS.txt" \
  "$FINAL_DIR/plugin-bundle-files.json" \
  "$FINAL_DIR/release-handoff.json"
```

GitHub Release не запускает сборку и не исправляет artifacts. Если проверка
провалилась, локально выпускается исправленная новая версия; опубликованные tag
и versioned files не переписываются.

## Handoff в direct-mcp и smoke

После отдельного разрешения дальнейшие действия выполняются по
`../direct-mcp/docs/RUNBOOK-CODEX-PLUGIN-RELEASE.md`: guarded `latest.json`,
атомарная публикация и smoke stable URLs. Tauri source, signing scripts и
embedded bundle в `direct-mcp` не копируются.

До публичного релиза обязательны чистые macOS и Windows profiles: platform
policy, Prepare → verify → `codex://`, установка плагина, OAuth, полный restart,
`subscription_status`, read-only MCP call, Repair/updater/Remove, сохранение
modified/unknown files и Windows path с пробелами/non-ASCII пользователем.
