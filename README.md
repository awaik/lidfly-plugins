<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="plugins/lidfly/assets/logo-dark.svg">
    <img src="plugins/lidfly/assets/logo.svg" width="320" alt="LidFly">
  </picture>
</p>

# Плагин и установщик LidFly MCP для OpenAI Codex и Claude Desktop: Яндекс Директ, Метрика, Вордстат, Вебмастер, ВКонтакте, VK Ads, Telegram, MAX, Авито, сайты и контент

**Яндекс Директ, Яндекс Метрика, Яндекс Вордстат, Яндекс Вебмастер, Яндекс Аудитории, AppMetrica, VK Реклама (VK Ads), сообщества ВКонтакте, каналы и группы Telegram, мессенджер MAX, профиль продавца Авито и Авито Реклама, сайты, интернет-магазины и базы знаний LidFly, ИИ-консультант, договоры Word, бесплатная расшифровка больших видео и аудио, статьи на Хабр / VC.ru и YouTube SEO** — в одном официальном плагине и приложении-установщике **[LidFly](https://lidfly.ru/)** (`https://lidfly.ru/mcp/v3`) для **OpenAI Codex** и **Claude Desktop (Cowork)** (macOS и Windows).

LidFly подключает Codex и Claude Desktop к рекламе, веб-аналитике, SEO, соцсетям, мессенджерам, классифайдам, сайтам и рабочим проектам через единый защищённый MCP-сервер `https://lidfly.ru/mcp/v3` и добавляет **27 специализированных скиллов**. После установки можно просить ИИ проверить статистику, собрать семантику, найти проблемы в кампаниях, опубликовать или запланировать посты в ВКонтакте, Telegram и MAX, разобрать объявления и чаты Авито, превратить длинное видео в статью или подготовить изменения на сайте — без ручного копирования API-ключей в конфигурацию.

Плагин устанавливается без терминала через официальное приложение `LidFly Plugin Lapki` для macOS или Windows. Codex CLI остаётся альтернативным способом установки. То же приложение умеет подготовить LidFly для **Claude Desktop**: создаёт рабочую папку-проект для **Claude Cowork** со всеми 27 скиллами и показывает, как подключить MCP-коннектор.

## Что можно делать

После подключения Codex и Claude Desktop работают с теми сервисами и проектами, к которым у вашего аккаунта LidFly открыт доступ:

- **Яндекс Директ, VK Реклама (VK Ads) и Авито Реклама:** аудировать и собирать кампании (включая ЕПК), управлять группами, объявлениями, ключами, минус-словами, ставками, бюджетами и лид-формами, проверять совместимость целей и выгружать отчёты в Google Sheets / Google Docs;
- **Яндекс Метрика, AppMetrica и Яндекс Аудитории:** анализировать посещаемость, цели, конверсии, UTM-метки, CPA и события мобильных приложений, загружать сегменты клиентов (CSV) и настраивать ретаргетинг и look-alike;
- **Яндекс Вордстат и Яндекс Вебмастер:** исследовать спрос и сезонность, собирать и кластеризовать семантическое ядро, проверять индексацию, поисковые запросы, позиции, CTR, `sitemap` и отправлять страницы на переобход;
- **ВКонтакте (`vk_social`), Telegram и мессенджер MAX:** вести сообщества и каналы в одном окне — публиковать и планировать посты, истории, альбомы и кнопки, смотреть безопасный предпросмотр в личном чате с ботом до публикации, анализировать охваты, ленту и комментарии, модерировать обсуждения и отвечать в сообщениях сообществ ВК;
- **Профиль продавца Авито и Avito Promo (`avito`):** управлять объявлениями, автозагрузкой (`Autoload`), остатками и ценами, отвечать в чатах и на отзывы, генерировать карточки и фото товаров с ИИ-продавцом;
- **Сайты, магазины (Commerce), базы знаний, ИИ-консультант и договоры Word:** создавать и обновлять лендинги, многостраничные сайты, каталоги товаров и самообновляемые базы знаний LidFly, обучать ИИ-консультанта и генерировать договоры, счета и акты в `.docx` по вашим шаблонам;
- **Видео → статья, YouTube SEO и редактура для Хабр / VC.ru:** автоматически извлекать аудиодорожку из больших видеофайлов (`ffmpeg`), бесплатно расшифровывать запись в LidFly, упаковывать ролики для YouTube и писать глубокие экспертные статьи с независимой ревизией и русскоязычной «гуманизацией» без нейросетевых штампов;
- **Пространства и память проектов (`Workspace`):** хранить брифы, решения, слепки аудитов и задачи по каждому клиенту или направлению (`workspace_project_id`), ставить напоминания и настраивать AI-автозапуски по расписанию.

Набор возможностей зависит от подключённых кабинетов, прав пользователя и тарифа LidFly. Любые изменения ставок, бюджетов, объявлений, постов или настроек сайта выполняются только после вашего явного подтверждения.

## Встроенные скиллы (27 навыков)

Плагин включает **27 специализированных скиллов** с проверенными рабочими сценариями, включая диагностику подключения LidFly. Codex и Claude выбирают их автоматически по задаче, поэтому отдельно настраивать или копировать инструкции не нужно:

- **Реклама и классифайды:** `yandex-direct-campaign-builder`, `vk-ads-campaign-builder`, `avito-ads`, `avito-business`;
- **Соцсети и мессенджеры:** `telegram-posting`, `max-posting` (плюс инструменты сообществ ВКонтакте `vk_social_*`);
- **Веб-аналитика, SEO и спрос:** `yandex-metrika`, `yandex-webmaster`, `demand-research`, `semantic-core`, `seo-optimizer`, `serp-monitor`;
- **Сайты, магазины, базы знаний и Яндекс Бизнес:** `lidfly-site-commerce`, `lidfly-page-migration`, `lidfly-knowledge-maintainer`, `restaurant-yandex`;
- **Видео, YouTube и редактура статей:** `video-article-writer`, `youtube-video-seo`, `article-writer`, `article-reviser`, `human-editorial-polish` (и алиас `ai-markers-remove`);
- **Память проектов, отчёты и диагностика MCP:** `workspace-project-manager`, `export-ad-reports`, `mcp-v3-provider-context`, `lidfly-connection-doctor`, `lidfly-support-escalation`.

Если сценарию нужен дополнительный внешний сервис, например подключённый Google Sheets, ИИ-клиент сообщит об этом отдельно.

## Как это работает

1. Вы устанавливаете плагин LidFly в Codex.
2. Плагин добавляет встроенные скиллы и подключение к `https://lidfly.ru/mcp/v3`.
3. Codex открывает вход LidFly в браузере.
4. Вы входите по email и подтверждаете подключение.
5. В новом чате Codex использует подходящие скиллы и получает только те инструменты и проекты, которые доступны вашему аккаунту.

В самом репозитории нет пользовательских API-ключей, паролей или токенов рекламных кабинетов. Плагин хранит только публичное описание, инструкции скиллов и адрес MCP-сервера; авторизация выполняется через OAuth LidFly.

## Установка без терминала

Скачайте приложение LidFly только по подходящей стабильной ссылке:

- [macOS universal DMG](https://lidfly.ru/downloads/codex-plugin/macos-universal.dmg) — для Mac с Apple Silicon и Intel;
- [Windows x64 installer](https://lidfly.ru/downloads/codex-plugin/windows-x64-setup.exe) — для 64-битной Windows.

На macOS откройте DMG и запустите `LidFly Plugin Lapki`. Приложение подписано Developer ID, notarized и проверяется Gatekeeper. Если macOS не может подтвердить разработчика, не обходите защиту: заново скачайте DMG по ссылке выше.

В Windows-сборке нет Authenticode-подписи, поэтому Windows SmartScreen может показать «Неизвестный издатель». Продолжайте запуск только если EXE скачан по ссылке выше: откройте «Подробнее» и выберите «Выполнить в любом случае».

Дальше сценарий одинаков для обеих систем:

1. В блоке «Установка плагина в Codex» нажмите «Начать установку». Приложение проверит официальный bundle и сохранит локальную копию marketplace в своём пользовательском каталоге.
2. Нажмите «Продолжить в Codex» и отдельно подтвердите штатную установку плагина.
3. Войдите в LidFly по email, полностью перезапустите Codex и начните новый чат.

Приложение LidFly не меняет конфигурацию или кэш Codex и не считает плагин установленным до вашего подтверждения в Codex.

## Обновление

### Через приложение LidFly

При каждом запуске приложение автоматически проверяет подписанные обновления. Пока оно открыто, проверка повторяется каждые 15 минут. Если опубликована новая версия, в верхней части окна появляется крупная кнопка **«Обновить до …»**.

После нажатия приложение:

1. скачивает и проверяет подписанное обновление;
2. перезапускается;
3. автоматически синхронизирует официальный пакет плагина той же версии;
4. открывает карточку LidFly в Codex.

В Codex остаётся нажать штатную кнопку установки или обновления. Это обязательное системное подтверждение: приложение LidFly не обходит защиту Codex и не меняет его кэш скрыто. После подтверждения полностью перезапустите Codex и начните новый чат — новые скиллы загружаются именно в новой сессии.

Закрытое приложение не работает фоновым сервисом и не запускается вместе с системой. Чтобы проверить обновление, достаточно иногда открывать его; отдельный фоновый агент для этого не требуется.

Переход с версии 1.0.1 — единственное исключение: в уже выпущенной 1.0.1 автоматической проверки при запуске ещё нет. Один раз нажмите в ней **«Проверить обновления»**. После установки 1.1.0 все следующие версии будут обнаруживаться автоматически.

### Переход с версии 1.3.0 на 1.4.0

В версии 1.4.0 приложение переименовано из `LidFly Codex Plugin Installer` в `LidFly Plugin Lapki`. Из-за системных правил macOS и Windows новое имя не всегда заменяет старое приложение автоматически.

- На macOS обновление внутри приложения сохраняет прежнее имя `.app`. Чтобы перейти на новое имя, установите `LidFly Plugin Lapki` из актуального DMG, запустите его и удалите старое `LidFly Codex Plugin Installer.app`.
- В Windows версия 1.4.0 устанавливается как отдельное приложение для текущего пользователя. После запуска и проверки новой версии удалите `LidFly Codex Plugin Installer` через **Параметры → Приложения → Установленные приложения**.

### Через GitHub Marketplace и Codex CLI

Публикация новой версии на GitHub не заменяет уже установленный экземпляр плагина автоматически. Обновите snapshot marketplace и переустановите LidFly из него:

```sh
codex plugin marketplace upgrade lidfly
codex plugin add lidfly@lidfly
```

Затем полностью перезапустите Codex и начните новый чат.

## Установка через Codex CLI

Это альтернативный способ для тех, кто работает в терминале:

```sh
codex plugin marketplace add awaik/lidfly-plugins
codex plugin add lidfly@lidfly
```

После выполнения команд перезапустите Codex, пройдите вход LidFly и начните новый чат.

Проверить подключение можно так:

```sh
codex plugin marketplace list
codex plugin list --json
codex mcp list
```

В списке должен появиться плагин `lidfly`, а для MCP-сервера — адрес `https://lidfly.ru/mcp/v3`.

## Подключение Claude Desktop (Cowork)

Тем же приложением LidFly можно подготовить Claude Desktop. Результат: в Claude появляется MCP-подключение LidFly, а на диске — рабочая папка `LidFly` с инструкциями и теми же скиллами, которую Claude Cowork использует как проект.

Что понадобится: установленный Claude Desktop и план Claude Pro или выше (Cowork не входит в бесплатный план).

1. В блоке «Установка для Claude Desktop» нажмите «Установить папку». Папка со скиллами появится в домашнем каталоге: `~/LidFly` на macOS, `C:\Users\<имя>\LidFly` на Windows.
2. Подключите MCP: в Claude Desktop откройте Settings → Connectors → «Add custom connector», скопируйте из приложения адрес `https://lidfly.ru/mcp/v3` и войдите в LidFly по email.
3. Нажмите «Открыть в Claude» и подтвердите открытие папки LidFly в Cowork. При необходимости папку можно добавить вручную через Projects → «+» → «Use existing folder».

**Важно про папку `LidFly`.** Она остаётся на диске и нужна для работы: в ней инструкции CLAUDE.md, скиллы и ваши рабочие материалы. Не удаляйте и не переносите её вручную. Приложение обновляет в ней только собственные служебные файлы — документы, которые вы или Claude создаёте в папке, не изменяются и не удаляются. Если служебные файлы окажутся изменены или пропадут, приложение покажет это и предложит «Восстановить папку» с сохранением резервной копии.

Папка обновляется автоматически вместе с обновлением плагина. Кнопка «Удалить файлы LidFly» убирает из папки только служебные файлы приложения: ваши документы и сама папка остаются.

Приложение LidFly не меняет настройки Claude Desktop: коннектор и проект Cowork вы добавляете и подтверждаете в самом Claude. Доступ OAuth при необходимости отзывается в LidFly: **Настройки → Подключённые ИИ-клиенты**.

## С чего начать

Попробуйте написать в новом чате:

- «Покажи доступные аккаунты и проекты во всех подключённых площадках»;
- «Проанализируй мои кампании в Яндекс Директе, VK Ads и Авито Рекламе за последние 30 дней и сравни со счётчиком Метрики»;
- «Проверь сайт в Яндекс Вебмастере и собери семантическое ядро через Вордстат»;
- «Подготовь пост для канала в Telegram, канала в мессенджере MAX и сообщества ВКонтакте и пришли мне предпросмотр в бота перед публикацией»;
- «Покажи активные объявления и непрочитанные сообщения покупателей в профиле Авито»;
- «Извлеки аудио из видеофайла вебинара, бесплатно расшифруй в LidFly, напиши статью на Хабр / VC.ru и подготовь упаковку для YouTube».

Codex и Claude Desktop сами запросят нужные инструменты у LidFly через `search_tools`. Подключать отдельный MCP-сервер для каждого рекламного кабинета, мессенджера или соцсети не требуется.

## Если плагин не появился

1. В приложении LidFly нажмите «Проверить файлы». При изменённых файлах используйте «Восстановить»: перед заменой будет создана резервная копия.
2. Снова нажмите «Продолжить в Codex». Если обработчик `codex://` не открывается, убедитесь, что desktop-приложение Codex установлено.
3. При установке через CLI убедитесь, что marketplace виден в `codex plugin marketplace list`, затем проверьте `codex plugin list --json`.
4. Полностью закройте Codex, откройте его снова и создайте новый чат.
5. Если LidFly раньше подключался вручную, старый custom MCP может дублировать сервер из плагина. Отключайте его только после успешной проверки нового подключения.
6. В корпоративном Workspace установка персональных marketplaces может быть запрещена администратором. Плагин не обходит эти ограничения.

Если установлена старая версия, используйте обе команды из раздела «Обновление»: одного обновления marketplace недостаточно, чтобы новая версия загрузилась в уже установленный экземпляр плагина.

## Удаление

Удалить плагин можно командой:

```sh
codex plugin remove lidfly@lidfly
```

Чтобы также убрать marketplace LidFly из локальной конфигурации:

```sh
codex plugin marketplace remove lidfly
```

Доступ выданного OAuth-подключения при необходимости можно отдельно отозвать в LidFly: **Настройки → Подключённые ИИ-клиенты**.

## Что находится в репозитории

```text
.
├── .agents/plugins/marketplace.json          каталог marketplace LidFly
├── claude-project/                           снапшот проекта для Claude Desktop (Cowork)
├── claude-project-source.lock.json           commit и digest снапшота claude-project
├── docs/RUNBOOK-CODEX-PLUGIN-RELEASE.md      порядок выпуска новых версий
├── docs/INSTALLER-*.md                       устройство, разработка и release installer
├── installer/                                Tauri 2 приложение и тесты
├── plugins/lidfly/
│   ├── .codex-plugin/plugin.json             описание плагина
│   ├── .mcp.json                             подключение к LidFly MCP
│   ├── assets/                               иконки и логотипы
│   ├── skills-source.lock.json               commit и digest канонического source
│   └── skills/                               встроенные скиллы и их ресурсы
├── releases/<version>.json                   metadata релизов установщика
├── plugin-releases/<version>.json            metadata content-релизов плагина
├── scripts/build-plugin-bundle.mjs           воспроизводимый embedded bundle
├── scripts/sync-claude-project.mjs           синхронизация снапшота claude-project
├── scripts/verify-release-artifacts.mjs      fail-closed проверка релизных файлов
├── scripts/manage-release-metadata.mjs       проверка и promotion metadata
└── LICENSE                                   лицензия MIT
```

Плагин не запускает отдельный локальный сервер и не устанавливает зависимости: он подключает Codex и Claude Desktop к удалённому MCP LidFly по HTTPS.

Релизный процесс и правила публикации установщиков описаны в [runbook](docs/RUNBOOK-CODEX-PLUGIN-RELEASE.md).

## English Overview: LidFly Plugin & Desktop Installer for OpenAI Codex and Claude Desktop (MCP v3)

**LidFly Plugin Lapki** and the `awaik/lidfly-plugins` marketplace repository provide a one-click desktop installer (macOS universal DMG & Windows x64) and official plugin bundle for **OpenAI Codex** and **Claude Desktop (Cowork)**, connecting them to **LidFly MCP (`https://lidfly.ru/mcp/v3`)** with **27 specialized skills**:

- **Yandex Direct MCP, Yandex Metrika MCP, Wordstat MCP, Webmaster MCP, Yandex Audience MCP & AppMetrica MCP:** full campaign lifecycle, web analytics, search demand research, site indexing diagnostics, and CRM audience segments.
- **VK Ads MCP & VKontakte MCP (`vk_social`):** ad campaigns, lead forms, retargeting, and VKontakte community wall posts, stories, comments moderation, messages, and statistics.
- **Telegram MCP (`telegram`) & MAX Messenger MCP (`max`):** channel and group publishing, scheduled posts, inline buttons, bot DM previews, MAX channel feed history, views, and comments.
- **Avito MCP (`avito`) & Avito Ads MCP (`avito_ads`):** seller profile listings, Autoload feeds, customer chats, reviews, orders, AI product photos, Avito Promo, and ad campaigns.
- **LidFly Sites, Commerce, AI Consultant, Word Docs (`business_docs`), Video-to-Article & Editorial Skills:** websites, online stores, knowledge bases, `.docx` document generation, free audio/video transcription (`ffmpeg` + LidFly ASR), YouTube SEO, and Russian editorial workflows for Habr / VC.ru.

## Полезные ссылки

- [LidFly — официальный сайт](https://lidfly.ru)
- [Установка плагина для Codex](https://lidfly.ru/codex/)
- [Установка для Claude Desktop (Cowork)](https://lidfly.ru/claude/)
- [Универсальный шаблон проекта и 27 skills для всех ИИ-клиентов (`awaik/direct-mcp-ai-project`)](https://github.com/awaik/direct-mcp-ai-project)
- [Документация возможностей LidFly](https://lidfly.ru/docs)
- [Общий быстрый старт LidFly](https://lidfly.ru/docs/quickstart)
- [Политика конфиденциальности](https://lidfly.ru/privacy)
- [Условия использования](https://lidfly.ru/offer)

**Темы и теги репозитория (GitHub Topics):** `yandex-direct`, `vk-ads`, `vkontakte`, `telegram`, `max-messenger`, `mcp`, `claude`, `chatgpt`, `yandex-metrika`, `yandex-webmaster`, `wordstat`, `avito`, `openai-codex`, `claude-desktop`, `model-context-protocol`.
