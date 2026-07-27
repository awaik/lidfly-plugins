# Релизы установщика и plugin content LidFly

Репозиторий использует два независимых release-канала. Этот документ не даёт сам по себе разрешения на commit, push, tag, подпись, GitHub Release или production-публикацию.

## Контракты

- Installer: версия приложения, tag `installer-vX.Y.Z`, metadata `releases/X.Y.Z.json`, guarded `releases/latest.json`, Tauri updater.
- Plugin content: версия manifest/skills, tag `plugin-vX.Y.Z`, metadata `plugin-releases/X.Y.Z.json`, guarded `plugin-releases/latest.json`.
- Legacy tags `v1.0.x` и `v1.1.0` остаются без изменений.
- Первый installer с content updater — `1.2.0`.
- Plugin content требует `min_installer_version >= 1.2.0`.
- Стабильные идентификаторы `lidfly`, `./plugins/lidfly` и `https://lidfly.ru/mcp/v3` не меняются.

`node scripts/check-versions.mjs` проверяет installer и plugin как две отдельные SemVer-линии. Installer metadata schema 2 хранит `installer.version` и `embeddedPlugin.version`; их равенство не требуется. Только реальная сборка installer вызывает `npm run version:check -- --installer-build` и требует, чтобы текущий bundle точно совпадал с зафиксированной embedded version.

## Синхронизация canonical skills

Источник — `awaik/direct-mcp-ai-project/skills-source`. Workflow source-репозитория получает короткоживущий GitHub App token, пересобирает `automation/sync-skills` от актуального `main` и создаёт или обновляет один rolling PR.

Automation может менять только:

- `plugins/lidfly/skills/**`;
- `plugins/lidfly/skills-source.lock.json`;
- `plugins/lidfly/.codex-plugin/plugin.json`;
- один draft `plugin-releases/<next-patch>.json`.

Неизменившийся tree digest не создаёт diff и не повышает версию. Изменённая вручную generated copy останавливает sync. После merge PR content release остаётся ручной подписанной операцией.

## Локальная проверка

```sh
cd installer
npm run ci:local
```

Минимум:

```sh
npm run bundle:plugin
npm run bundle:plugin:verify
npm run version:check
npm run test
npm run check
```

Перед DMG/EXE дополнительно обязательно:

```sh
npm run version:check -- --installer-build
```

## Installer release

Installer release выполняется по `docs/INSTALLER-RELEASE.md`. Tag и GitHub Release:

```text
installer-vX.Y.Z
```

В release входят DMG, macOS updater archive и `.sig`, Windows installer и `.sig`, `SHA256SUMS.txt`, `plugin-bundle-files.json` и `release-handoff.json`. Embedded bundle version фиксируется отдельно в handoff и `releases/X.Y.Z.json`.

После platform signing/notarization и публикации:

```sh
node scripts/manage-release-metadata.mjs --check
node scripts/manage-release-metadata.mjs --promote
```

`--promote` разрешён только для опубликованного tag и проверенных публичных installer artifacts. `releases/latest.json` вручную не редактируется.

## Plugin content signing key

Используется отдельная Ed25519 keypair:

- private PKCS#8 PEM хранится только в защищённом локальном хранилище release-машины;
- raw 32-byte public key в base64 встраивается в installer через compile-time `LIDFLY_PLUGIN_CONTENT_PUBLIC_KEY_BASE64`;
- тот же public key задаётся в production verifier `direct-mcp`;
- key id текущей линии: `lidfly-plugin-content-2026-01`.

Tauri updater key для plugin content не используется. При ротации сначала выпускается installer с новым public key, затем новый key начинает подписывать content.

## Сборка plugin content

`plugin-releases/<version>.json` последовательно имеет два явных состояния:

- sync automation создаёт draft с `status: "draft"`, `min_installer_version`, `plugin` и `source`; это вход для ручного релиза, а не публичный content manifest, поэтому он намеренно не проходит `validateContentManifest`;
- `build-plugin-content-release.mjs` сверяет identity и provenance draft, затем атомарно заменяет его полным подписываемым manifest без поля `status`, но с `published_at`, `bundle` и `key_id`. Только этот второй формат допускается к verify и promotion.

Из чистого checkout после merge sync-PR:

```sh
cd installer
npm run release:content:build -- \
  --private-key /protected/lidfly-plugin-content-ed25519.pem \
  --output /absolute/output/plugin-X.Y.Z \
  --published-at 2026-07-27T00:00:00Z \
  --min-installer-version 1.2.0
```

Скрипт создаёт:

```text
LidFly_Codex_Plugin_X.Y.Z_<sha-prefix>.tar.gz
LidFly_Codex_Plugin_X.Y.Z_<sha-prefix>.tar.gz.sig
release.json
release.json.sig
release-handoff.json
```

Archive детерминирован: отсортированные regular files, uid/gid/mtime 0, gzip mtime 0. Внутри находятся `plugin-bundle/` и `plugin-bundle-files.json`. Manifest связывает версию, source commit/tree digest, min installer version, filename, URL, size, SHA-256 и key id.

Повторная проверка:

```sh
npm run release:content:verify -- \
  --directory /absolute/output/plugin-X.Y.Z \
  --public-key /protected/lidfly-plugin-content-ed25519.pub.pem
```

## Tag и GitHub Release plugin content

Только после прямого разрешения:

```sh
git tag plugin-vX.Y.Z
git push origin plugin-vX.Y.Z
gh release create plugin-vX.Y.Z \
  --repo awaik/lidfly-plugins \
  --verify-tag \
  --title "LidFly plugin content X.Y.Z" \
  /absolute/output/plugin-X.Y.Z/LidFly_Codex_Plugin_X.Y.Z_*.tar.gz \
  /absolute/output/plugin-X.Y.Z/LidFly_Codex_Plugin_X.Y.Z_*.tar.gz.sig \
  /absolute/output/plugin-X.Y.Z/release.json \
  /absolute/output/plugin-X.Y.Z/release.json.sig \
  /absolute/output/plugin-X.Y.Z/release-handoff.json
```

Guarded repository metadata создаётся только script:

```sh
npm run release:content:promote -- \
  --directory /absolute/output/plugin-X.Y.Z \
  --public-key /protected/lidfly-plugin-content-ed25519.pub.pem
```

`plugin-releases/latest.json` и `.sig` вручную не создаются.

## Handoff в direct-mcp

Production route и atomic publication находятся в `direct-mcp`. Обычный content release не требует пересборки DMG/EXE и app deploy. Порядок:

1. развернуть route `/codex-plugin-content` без feed;
2. выпустить installer 1.2.0 с public key;
3. передать четыре immutable/signed файла и handoff в `direct-mcp`;
4. verifier копирует immutable artifacts и signed release metadata первыми, затем одним atomic rename переключает внутренний active pointer; публичные `latest.json`/`.sig` читаются через него;
5. выполнить GET/HEAD smoke.

Не публиковать feed, пока installer и production verifier не содержат один и тот же public key.
Пользовательский раздел README про независимый content-канал обновляется только после promotion installer 1.2.0 и успешного smoke публичного feed. Draft metadata или готовый, но ещё не опубликованный код не считаются доступной пользователю функцией.

## Rollback

Remote downgrade запрещён. Плохую версию не заменяют и feed назад не понижают. Выпускается новая patch-версия с содержимым последнего исправного bundle:

```text
bad: 1.2.4
forward rollback: 1.2.5
```

До применения можно заморозить/убрать stable feed; уже установленный verified plugin продолжит работать. Immutable artifacts и опубликованные tags не удаляются и не переписываются.

## Финальная проверка

```sh
node -e 'const fs=require("node:fs"); for (const file of [".agents/plugins/marketplace.json","plugins/lidfly/.codex-plugin/plugin.json","plugins/lidfly/.mcp.json","plugins/lidfly/skills-source.lock.json"]) JSON.parse(fs.readFileSync(file,"utf8")); console.log("JSON ok")'
node scripts/manage-release-metadata.mjs --check
test -f plugins/lidfly/assets/icon.svg
test -f plugins/lidfly/assets/logo.svg
test -f plugins/lidfly/assets/logo-dark.svg
git diff --check
git status --short
```

В Git не должны попадать private keys, signatures/content archives вне явной release-задачи, installer binaries, credentials, `.DS_Store` или локальные абсолютные пути.
