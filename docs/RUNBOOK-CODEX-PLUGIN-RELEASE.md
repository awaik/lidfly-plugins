# Релиз плагина LidFly для Codex

Этот runbook хранит весь release-процесс плагина в репозитории `lidfly-plugins`. Состояние каждого выпуска фиксируется в `releases/<version>.json`, а `releases/latest.json` указывает только на последний полностью опубликованный и проверенный выпуск.

## Источники истины

- `plugins/lidfly/.codex-plugin/plugin.json` — текущая версия и manifest плагина.
- `.agents/plugins/marketplace.json` — стабильные имена marketplace и плагина, путь `./plugins/lidfly` и политика установки.
- `releases/<version>.json` — версионированная release metadata.
- `releases/latest.json` — metadata последнего доступного установщика. Этот файл создаёт только `scripts/manage-release-metadata.mjs --promote`.
- GitHub Release `awaik/lidfly-plugins` — публичное место для бинарных установщиков. Бинарники и подписи не коммитятся в Git.

Codex CLI устанавливает плагин из marketplace и не использует `releases/latest.json`. Установщик для macOS или Windows тоже не устанавливает плагин сам: он готовит проверенную локальную копию marketplace в `app_data_dir` и открывает её карточку через `codex://`. Установку плагина и OAuth пользователь подтверждает отдельно в Codex.

Этот runbook описывает marketplace publication metadata. Сборка, platform signing, пять обязательных installer/updater artifacts и handoff в `direct-mcp` описаны отдельно в `docs/INSTALLER-RELEASE.md`; эти два контракта нельзя подменять друг другом.

## Состояния metadata

У плагина и установщиков независимые состояния:

| Поле | Значение | Смысл |
| --- | --- | --- |
| `publication.status` | `draft` | Git tag и GitHub Release ещё не опубликованы. `commit` и `publishedAt` равны `null`. |
| `publication.status` | `published` | Tag существует, `commit` содержит полный SHA tag commit, `publishedAt` — время публикации GitHub Release. |
| `installers.status` | `unpublished` | Публичных установщиков нет, `artifacts` обязан быть пустым. |
| `installers.status` | `published` | В GitHub Release доступны оба подписанных установщика с проверенными размером и SHA-256. |

`releases/latest.json` может указывать только на metadata со значениями `published / published`. Обратный порядок безопасен: GitHub Release и его файлы сначала становятся доступны, затем появляется `latest.json`. Нельзя публиковать `latest.json` заранее.

## Подготовка версии

1. Убедись, что задача явно разрешает релизные действия. Commit, push, tag, GitHub Release, подпись и production-публикация не подразумеваются обычным изменением кода.
2. Проверь рабочее дерево и не трогай незнакомые изменения:

   ```sh
   git status --short
   ```

3. Обнови `version` в `plugins/lidfly/.codex-plugin/plugin.json`.
4. Скопируй metadata предыдущей версии в `releases/<version>.json` и верни её в безопасное начальное состояние:

   ```json
   {
     "publication": {
       "status": "draft",
       "tag": "v<version>",
       "commit": null,
       "publishedAt": null
     },
     "installers": {
       "status": "unpublished",
       "artifacts": []
     }
   }
   ```

   Это сокращённый пример. Остальные обязательные поля нужно сохранить по текущему файлу metadata.

5. Проверь синхронизацию manifest, marketplace, MCP и metadata:

   ```sh
   node scripts/manage-release-metadata.mjs --check
   ```

Скрипт по умолчанию читает версию из manifest и требует файл `releases/<version>.json`. Стабильные значения должны оставаться такими:

- plugin и marketplace: `lidfly`;
- repository: `https://github.com/awaik/lidfly-plugins`;
- plugin path: `./plugins/lidfly`;
- MCP transport и URL: `http`, `https://lidfly.ru/mcp/v3`.

## Релиз только для CLI

Плагин можно опубликовать для установки через CLI без установщиков:

1. Выполни все проверки из раздела «Финальная проверка».
2. Только по прямому запросу создай commit, push и tag `v<version>`, затем GitHub Release.
3. Запиши в `releases/<version>.json`:
   - `publication.status: "published"`;
   - полный lowercase SHA commit, на который указывает tag;
   - UTC-время публикации в `publication.publishedAt`.
4. Оставь `installers.status: "unpublished"` и пустой `artifacts`.
5. Снова выполни `node scripts/manage-release-metadata.mjs --check`.

В таком состоянии README обязан оставлять Codex CLI основным способом и явно говорить, что установщики ещё не опубликованы. `releases/latest.json` не создаётся.

## Подготовка установщиков

Переход к установщикам — отдельная release-задача. Если исходники сборки, signing identity или процесс notarization не входят в подтверждённую область задачи, остановись и запроси решение.

Перед загрузкой каждого файла проверь:

- установщик добавляет только marketplace `awaik/lidfly-plugins`;
- установка плагина и OAuth не выполняются скрыто или автоматически;
- macOS-сборка подписана Developer ID и notarized;
- Windows-сборка следует схеме Glas: Authenticode отсутствует, а detached Tauri updater `.sig` проверена по финальному EXE;
- в артефактах нет токенов, ключей, приватных hostname и пользовательских данных;
- бинарники не добавлены в Git, а загружаются как assets GitHub Release `v<version>`.

Обязательные платформы metadata:

- `macos-universal`;
- `windows-x86_64`.

Для каждого файла вычисли точный размер и SHA-256 после подписи и notarization:

```sh
wc -c < path/to/installer
shasum -a 256 path/to/installer
```

После публикации GitHub Release заполни `installers` в `releases/<version>.json`:

```json
{
  "status": "published",
  "artifacts": [
    {
      "platform": "macos-universal",
      "filename": "<published-file>.dmg",
      "url": "https://github.com/awaik/lidfly-plugins/releases/download/v<version>/<published-file>.dmg",
      "size": 123,
      "sha256": "<64 lowercase hex characters>"
    },
    {
      "platform": "windows-x86_64",
      "filename": "<published-file>.exe",
      "url": "https://github.com/awaik/lidfly-plugins/releases/download/v<version>/<published-file>.exe",
      "size": 123,
      "sha256": "<64 lowercase hex characters>"
    }
  ]
}
```

Значения `filename`, `size`, `sha256` и URL должны описывать уже опубликованные файлы, а не ожидаемый результат будущей сборки.

## Guarded `latest.json`

Единственный штатный способ создать или обновить `releases/latest.json`:

```sh
node scripts/manage-release-metadata.mjs --promote
```

Перед атомарной записью скрипт:

1. проверяет manifest, marketplace, MCP и release metadata;
2. отклоняет `draft` и `unpublished`;
3. проверяет, что локальный tag указывает на `publication.commit`;
4. скачивает оба установщика по публичным HTTPS URL;
5. сверяет реальный размер и SHA-256 каждого файла;
6. записывает `releases/latest.json` как точную копию `releases/<version>.json`.

После promotion:

```sh
node scripts/manage-release-metadata.mjs --check
git diff --check
git status --short
```

Затем, только по прямому запросу, metadata и `latest.json` можно commit/push. Публичный URL после push в `main`:

```text
https://raw.githubusercontent.com/awaik/lidfly-plugins/main/releases/latest.json
```

README можно переключать с «скоро» на установщики только после успешного promotion, push и проверки публичного `latest.json` и обеих ссылок на скачивание.

## Откат `latest.json`

Не перемещай существующий tag, не заменяй assets под прежними именами и не переписывай versioned metadata опубликованного релиза. Для отката выбери предыдущий проверенный файл:

```sh
node scripts/manage-release-metadata.mjs \
  --file releases/<previous-version>.json \
  --promote
```

Скрипт повторно проверит tag, скачает старые публичные assets и атомарно заменит только локальный `releases/latest.json`. Commit/push отката также требует прямого запроса пользователя.

## Финальная проверка

```sh
node -e 'const fs=require("node:fs"); for (const file of [".agents/plugins/marketplace.json","plugins/lidfly/.codex-plugin/plugin.json","plugins/lidfly/.mcp.json"]) JSON.parse(fs.readFileSync(file,"utf8")); console.log("JSON ok")'
node scripts/manage-release-metadata.mjs --check
test -f plugins/lidfly/assets/icon.svg
test -f plugins/lidfly/assets/logo.svg
test -f plugins/lidfly/assets/logo-dark.svg
git diff --check
git status --short
```

Дополнительно проверь, что diff не содержит `.DS_Store`, бинарных installer-файлов, подписей, секретов и локальных абсолютных путей.

## Жёсткие правила

- Не создавай `releases/latest.json` вручную.
- Не публикуй `latest.json`, если хотя бы один установщик отсутствует или не совпадает по размеру/SHA-256.
- Не публикуй установщик до code signing и platform verification.
- Не меняй стабильные идентификаторы `lidfly`, путь `./plugins/lidfly` и MCP URL.
- Не увеличивай версию только в manifest: для неё всегда нужен `releases/<version>.json`.
- Не выполняй commit, push, tag, GitHub Release, подпись или deploy без прямого запроса пользователя.
