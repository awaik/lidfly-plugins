import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";

import "./styles.css";
import type {
  BundleSyncOutcome,
  ClaudeProjectStatusPayload,
  ClientError,
  InstallerStatus,
  OperationOutcome,
  PluginContentInstallOutcome,
  PluginContentUpdateStatus,
} from "./types";
import {
  CONTENT_RECHECK_INTERVAL_MS,
  shouldCheckForContentUpdates,
  shouldCheckForUpdates,
  UPDATE_RECHECK_INTERVAL_MS,
} from "./update-policy";
import { mapUpdaterError } from "./updater-errors";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root is missing");

app.innerHTML = `
  <main class="shell">
    <header class="brand">
      <div class="brand-mark" aria-hidden="true"><span>L</span></div>
      <div>
        <div class="eyebrow">Официальное приложение LidFly</div>
        <h1>LidFly Plugin Lapki</h1>
      </div>
      <div id="version" class="version"></div>
    </header>

    <section id="update-panel" class="update-panel" aria-live="polite" hidden>
      <div class="update-symbol" aria-hidden="true">↻</div>
      <div class="update-copy">
        <div class="eyebrow">Обновление приложения</div>
        <h2 id="update-title">Вышла новая версия LidFly Plugin Lapki</h2>
        <p id="update-message">
          Установите обновление, чтобы получить последние улучшения. Ваши настройки сохранятся.
        </p>
        <progress id="update-progress" class="update-progress" hidden></progress>
      </div>
      <button id="install-update" class="button button-update">
        Обновить приложение
      </button>
    </section>

    <section class="product-card" aria-labelledby="codex-heading" aria-live="polite">
      <div class="card-heading">
        <div class="product-icon codex-icon" aria-hidden="true">C</div>
        <div>
          <div class="eyebrow">Codex</div>
          <h2 id="codex-heading">Установка плагина в Codex</h2>
          <p>Установите LidFly без терминала, затем подтвердите установку в Codex.</p>
        </div>
      </div>

      <div class="status-summary">
        <span id="status-dot" class="status-dot is-loading"></span>
        <div>
          <h3 id="status-title">Проверяем установку…</h3>
          <p id="status-message">Это займёт несколько секунд.</p>
        </div>
      </div>

      <section id="plugin-update-panel" class="plugin-update-panel" aria-live="polite" hidden>
        <div class="update-symbol" aria-hidden="true">↓</div>
        <div class="update-copy">
          <div class="eyebrow">Обновление плагина для Codex</div>
          <h3 id="plugin-update-title">Доступна новая версия плагина</h3>
          <p id="plugin-update-message">Обновление займёт несколько секунд.</p>
          <progress id="plugin-update-progress" class="update-progress" hidden></progress>
        </div>
        <button id="install-plugin-update" class="button button-light">
          Обновить плагин
        </button>
      </section>

      <section id="codex-update-panel" class="codex-update-panel" aria-live="polite" hidden>
        <div>
          <div class="eyebrow">Остался один шаг</div>
          <h3 id="codex-update-title">Новая версия плагина готова</h3>
          <p id="codex-update-message">
            Подтвердите обновление в Codex, затем начните новый чат.
          </p>
        </div>
        <button id="finish-update" class="button button-dark">
          Открыть Codex
        </button>
      </section>

      <div id="notice" class="notice" hidden></div>
      <div id="details" class="details" hidden></div>
      <div class="primary-actions">
        <button id="prepare" class="button button-primary">Начать установку</button>
        <button id="open-codex" class="button button-dark" disabled>Продолжить в Codex</button>
        <button id="repair" class="button button-warning" hidden>Восстановить</button>
      </div>
    </section>

    <section class="product-card" aria-labelledby="claude-heading" aria-live="polite">
      <div class="card-heading">
        <div class="product-icon claude-icon" aria-hidden="true">A</div>
        <div>
          <div class="eyebrow">Claude Desktop · Cowork</div>
          <h2 id="claude-heading">Установка для Claude Desktop</h2>
          <p>Выполните три шага по порядку. Приложение подскажет, что нажимать.</p>
        </div>
      </div>

      <ol class="setup-steps">
        <li class="setup-step">
          <span class="step-number">1</span>
          <div class="step-content">
            <h3>Установите папку со скиллами на диск</h3>
            <div class="step-status">
              <span id="claude-dot" class="status-dot is-loading"></span>
              <div>
                <strong id="claude-title">Проверяем папку LidFly…</strong>
                <p id="claude-message">Это займёт несколько секунд.</p>
              </div>
            </div>
            <div id="claude-folder" class="folder-path" hidden>
              Папка: <code id="claude-folder-path"></code>
            </div>
            <div class="step-actions">
              <button id="claude-prepare" class="button button-primary">Установить папку</button>
              <button id="claude-repair" class="button button-warning" hidden>Восстановить папку</button>
            </div>
          </div>
        </li>
        <li class="setup-step">
          <span class="step-number">2</span>
          <div class="step-content">
            <h3>Подключите MCP в Claude Desktop</h3>
            <p>Откройте Settings → Connectors → «Add custom connector», вставьте адрес и войдите в LidFly по email.</p>
            <div class="mcp-row">
              <code id="claude-mcp-url">https://lidfly.ru/mcp/v3</code>
              <button id="copy-mcp" class="button button-secondary">Скопировать адрес</button>
            </div>
          </div>
        </li>
        <li class="setup-step">
          <span class="step-number">3</span>
          <div class="step-content">
            <h3>Добавьте папку LidFly как проект</h3>
            <p>Нажмите кнопку ниже. В Claude подтвердите открытие папки LidFly в Cowork.</p>
            <div class="step-actions">
              <button id="claude-open" class="button button-dark" disabled>Открыть в Claude</button>
            </div>
          </div>
        </li>
      </ol>

      <div id="claude-notice" class="notice" hidden></div>
      <div class="secondary-actions">
        <button id="claude-remove" class="button button-ghost" disabled>Удалить файлы LidFly</button>
      </div>
      <p class="claude-fineprint">
        Папка LidFly остаётся на компьютере и нужна для работы — не удаляйте и не переносите её.
        Приложение меняет только служебные файлы LidFly, а ваши документы сохраняет.
        Для Cowork нужен план Claude Pro или выше. Подключение подтверждается внутри Claude Desktop.
      </p>
    </section>

    <section class="tools" aria-label="Дополнительные действия">
      <button id="verify" class="tool-button"><span>✓</span><b>Проверить файлы</b><small>Сверить SHA-256</small></button>
      <button id="update" class="tool-button"><span>↻</span><b>Проверить обновления</b><small id="update-caption">Версия приложения</small></button>
      <button id="logs" class="tool-button"><span>≡</span><b>Открыть журнал</b><small>Без токенов и email</small></button>
      <button id="remove" class="tool-button tool-danger"><span>×</span><b>Удалить файлы</b><small>Codex не изменяется</small></button>
    </section>

    <footer>
      Приложение не получает данные вашего аккаунта и не меняет настройки Codex или Claude Desktop.
      <a href="https://lidfly.ru/privacy" target="_blank" rel="noreferrer">Конфиденциальность</a>
    </footer>
  </main>
`;

const elements = {
  version: required("version"),
  statusDot: required("status-dot"),
  statusTitle: required("status-title"),
  statusMessage: required("status-message"),
  notice: required("notice"),
  details: required("details"),
  updatePanel: required("update-panel"),
  updateTitle: required("update-title"),
  updateMessage: required("update-message"),
  updateProgress: requiredProgress("update-progress"),
  installUpdate: requiredButton("install-update"),
  pluginUpdatePanel: required("plugin-update-panel"),
  pluginUpdateTitle: required("plugin-update-title"),
  pluginUpdateMessage: required("plugin-update-message"),
  pluginUpdateProgress: requiredProgress("plugin-update-progress"),
  installPluginUpdate: requiredButton("install-plugin-update"),
  codexUpdatePanel: required("codex-update-panel"),
  codexUpdateTitle: required("codex-update-title"),
  codexUpdateMessage: required("codex-update-message"),
  finishUpdate: requiredButton("finish-update"),
  prepare: requiredButton("prepare"),
  openCodex: requiredButton("open-codex"),
  repair: requiredButton("repair"),
  verify: requiredButton("verify"),
  update: requiredButton("update"),
  updateCaption: required("update-caption"),
  logs: requiredButton("logs"),
  remove: requiredButton("remove"),
  claudeDot: required("claude-dot"),
  claudeTitle: required("claude-title"),
  claudeMessage: required("claude-message"),
  claudeFolder: required("claude-folder"),
  claudeFolderPath: required("claude-folder-path"),
  claudeMcpUrl: required("claude-mcp-url"),
  claudeNotice: required("claude-notice"),
  claudePrepare: requiredButton("claude-prepare"),
  claudeOpen: requiredButton("claude-open"),
  claudeRepair: requiredButton("claude-repair"),
  claudeRemove: requiredButton("claude-remove"),
  copyMcp: requiredButton("copy-mcp"),
};

let currentStatus: InstallerStatus | null = null;
let claudeStatus: ClaudeProjectStatusPayload | null = null;
let availableUpdate: Update | null = null;
let pluginContentStatus: PluginContentUpdateStatus | null = null;
let busy = false;
let lastUpdateCheckAt: number | null = null;
let lastContentCheckAt: number | null = null;
let updateCheckInFlight: Promise<void> | null = null;
let contentCheckInFlight: Promise<void> | null = null;

function required(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element;
}

function requiredButton(id: string): HTMLButtonElement {
  const element = required(id);
  if (!(element instanceof HTMLButtonElement))
    throw new Error(`#${id} is not a button`);
  return element;
}

function requiredProgress(id: string): HTMLProgressElement {
  const element = required(id);
  if (!(element instanceof HTMLProgressElement))
    throw new Error(`#${id} is not a progress element`);
  return element;
}

function asClientError(error: unknown): ClientError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error
  ) {
    const candidate = error as Partial<ClientError>;
    return {
      code: String(candidate.code),
      message: String(candidate.message),
      details: Array.isArray(candidate.details)
        ? candidate.details.map(String)
        : [],
    };
  }
  return {
    code: "unknown",
    message: error instanceof Error ? error.message : String(error),
    details: [],
  };
}

function setBusy(value: boolean): void {
  busy = value;
  for (const button of [
    elements.prepare,
    elements.openCodex,
    elements.repair,
    elements.installUpdate,
    elements.installPluginUpdate,
    elements.finishUpdate,
    elements.verify,
    elements.update,
    elements.logs,
    elements.remove,
    elements.claudePrepare,
    elements.claudeOpen,
    elements.claudeRepair,
    elements.claudeRemove,
  ]) {
    button.disabled =
      value ||
      (button === elements.openCodex && !currentStatus?.canOpenCodex) ||
      (button === elements.claudeOpen && !claudeStatus?.status.canOpenCodex) ||
      (button === elements.claudeRemove &&
        claudeStatus?.status.phase === "not_prepared");
  }
  document.body.classList.toggle("is-busy", value);
}

function resetUpdateTool(): void {
  const label = elements.update.querySelector("b");
  if (label) label.textContent = "Проверить обновления";
  elements.updateCaption.textContent = currentStatus
    ? `Приложение ${currentStatus.appVersion} · плагин ${currentStatus.embeddedPluginVersion}`
    : "Версии приложения и плагина";
}

function renderPluginContentStatus(status: PluginContentUpdateStatus): void {
  pluginContentStatus = status;
  const release = status.release;
  if (status.state === "up_to_date" || !release) {
    elements.pluginUpdatePanel.hidden = true;
    if (!availableUpdate) resetUpdateTool();
    return;
  }
  elements.pluginUpdatePanel.hidden = false;
  elements.pluginUpdatePanel.classList.remove("is-downloading");
  elements.pluginUpdateProgress.hidden = true;
  elements.pluginUpdateTitle.textContent =
    status.state === "requires_installer_update"
      ? "Сначала обновите приложение"
      : `Доступна версия ${release.pluginVersion}`;
  elements.pluginUpdateMessage.textContent =
    status.state === "requires_installer_update"
      ? `Для новой версии плагина нужно приложение ${release.minInstallerVersion} или новее. Текущая версия продолжит работать.`
      : "Установим новые скиллы LidFly. После этого останется подтвердить обновление в Codex.";
  elements.installPluginUpdate.textContent =
    status.state === "requires_installer_update"
      ? "Сначала обновите приложение"
      : `Обновить плагин до ${release.pluginVersion}`;
  elements.installPluginUpdate.disabled = busy || status.state !== "available";
}

function showAvailableUpdate(update: Update): void {
  elements.updatePanel.hidden = false;
  elements.updatePanel.classList.remove("is-downloading");
  elements.updateProgress.hidden = true;
  elements.updateProgress.removeAttribute("value");
  elements.updateTitle.textContent = `Вышла новая версия ${update.version}`;
  elements.updateMessage.textContent =
    update.body?.trim() ||
    "Обновите LidFly Plugin Lapki, чтобы получить последние улучшения. Ваши настройки и подключения сохранятся.";
  elements.installUpdate.textContent = `Обновить до ${update.version}`;
  const label = elements.update.querySelector("b");
  if (label) label.textContent = `Установить ${update.version}`;
  elements.updateCaption.textContent = "Новая версия готова";
}

function showCodexUpdateReady(
  pluginVersion: string,
  codexOpened: boolean,
): void {
  elements.codexUpdatePanel.hidden = false;
  elements.codexUpdateTitle.textContent = codexOpened
    ? "Codex открыт — подтвердите обновление"
    : `Плагин ${pluginVersion} готов к обновлению`;
  elements.codexUpdateMessage.textContent = codexOpened
    ? "На карточке LidFly нажмите штатную кнопку установки или обновления. Затем полностью перезапустите Codex и начните новый чат."
    : "Откройте карточку LidFly, подтвердите обновление, полностью перезапустите Codex и начните новый чат.";
  elements.finishUpdate.textContent = codexOpened
    ? "Открыть Codex снова"
    : "Открыть Codex и завершить";
}

function showNotice(
  message: string,
  kind: "success" | "warning" | "error" = "success",
): void {
  elements.notice.hidden = false;
  elements.notice.className = `notice notice-${kind}`;
  elements.notice.textContent = message;
}

function clearNotice(): void {
  elements.notice.hidden = true;
  elements.notice.textContent = "";
}

function renderDetails(status: InstallerStatus): void {
  const noteworthy = status.files.filter(
    (file) => file.condition !== "unchanged",
  );
  const rows = [
    ...noteworthy.map(
      (file) =>
        `<li><code>${escapeHtml(file.path)}</code> — ${conditionLabel(file.condition)}</li>`,
    ),
    ...status.unknownFiles.map(
      (path) =>
        `<li><code>${escapeHtml(path)}</code> — неизвестный файл сохранён</li>`,
    ),
  ];
  elements.details.hidden = rows.length === 0;
  elements.details.innerHTML =
    rows.length > 0
      ? `<strong>Подробности</strong><ul>${rows.join("")}</ul>`
      : "";
}

function conditionLabel(condition: string): string {
  return (
    {
      missing: "отсутствует",
      unchanged: "проверен",
      outdated: "нужно обновить",
      modified: "изменён",
      unsafe: "небезопасный тип файла",
    }[condition] ?? condition
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderStatus(status: InstallerStatus): void {
  currentStatus = status;
  elements.version.textContent = `v${status.appVersion}`;
  if (!availableUpdate) resetUpdateTool();
  elements.statusDot.className = "status-dot";
  const statusCopy: Record<
    InstallerStatus["phase"],
    readonly [string, string, string]
  > = {
    not_prepared: [
      "Плагин ещё не установлен",
      "Нажмите «Начать установку». Терминал и ручная настройка не понадобятся.",
      "idle",
    ],
    ready_for_codex: [
      "Осталось подтвердить установку в Codex",
      "Нажмите «Продолжить в Codex», затем подтвердите установку на карточке LidFly.",
      "success",
    ],
    installed_bundle: [
      `Файлы плагина версии ${status.installedPluginVersion ?? status.embeddedPluginVersion} готовы`,
      "Откройте Codex и подтвердите установку или обновление LidFly.",
      "success",
    ],
    modified_files: [
      "Нужна проверка файлов",
      "Некоторые файлы отличаются от официальной версии. Нажмите «Восстановить», чтобы продолжить безопасно.",
      "warning",
    ],
    incomplete_state: [
      "Установка не завершена",
      "Предыдущая рабочая версия сохранена. Нажмите «Восстановить», чтобы продолжить.",
      "warning",
    ],
  };
  const copy = statusCopy[status.phase];
  elements.statusTitle.textContent = copy[0];
  elements.statusMessage.textContent = copy[1];
  elements.statusDot.classList.add(`is-${copy[2]}`);
  elements.openCodex.disabled = busy || !status.canOpenCodex;
  elements.prepare.hidden = status.canOpenCodex && !status.updateRequired;
  elements.prepare.textContent = status.updateRequired
    ? "Обновить файлы плагина"
    : "Начать установку";
  elements.repair.hidden = !status.needsRepair;
  elements.remove.disabled = busy || status.phase === "not_prepared";
  renderDetails(status);
}

async function refreshStatus(): Promise<void> {
  const status = await invoke<InstallerStatus>("get_status");
  renderStatus(status);
}

function showClaudeNotice(
  message: string,
  kind: "success" | "warning" | "error" = "success",
): void {
  elements.claudeNotice.hidden = false;
  elements.claudeNotice.className = `notice notice-${kind}`;
  elements.claudeNotice.textContent = message;
}

function clearClaudeNotice(): void {
  elements.claudeNotice.hidden = true;
  elements.claudeNotice.textContent = "";
}

function renderClaudeStatus(payload: ClaudeProjectStatusPayload): void {
  claudeStatus = payload;
  const status = payload.status;
  elements.claudeMcpUrl.textContent = payload.mcpUrl;
  elements.claudeFolder.hidden = false;
  elements.claudeFolderPath.textContent = payload.folderPath;
  elements.claudeDot.className = "status-dot";
  const statusCopy: Record<
    InstallerStatus["phase"],
    readonly [string, string, string]
  > = {
    not_prepared: [
      "Папка ещё не установлена",
      "Нажмите «Установить папку». Ваши скиллы и инструкции LidFly сохранятся на этом компьютере.",
      "idle",
    ],
    ready_for_codex: [
      "Папка установлена",
      "Готово. Переходите к шагу 2 — подключению MCP.",
      "success",
    ],
    installed_bundle: [
      "Папка установлена и обновлена",
      "Готово. Переходите к шагу 2 — подключению MCP.",
      "success",
    ],
    modified_files: [
      "Папку нужно восстановить",
      "Нажмите «Восстановить папку». Ваши документы сохранятся, изменённые служебные файлы попадут в резервную копию.",
      "warning",
    ],
    incomplete_state: [
      "Установка папки не завершена",
      "Нажмите «Восстановить папку», чтобы безопасно завершить установку.",
      "warning",
    ],
  };
  const copy = statusCopy[status.phase];
  elements.claudeTitle.textContent = copy[0];
  elements.claudeMessage.textContent = copy[1];
  elements.claudeDot.classList.add(`is-${copy[2]}`);
  elements.claudeOpen.disabled = busy || !status.canOpenCodex;
  elements.claudePrepare.hidden = status.canOpenCodex && !status.updateRequired;
  elements.claudePrepare.textContent = status.updateRequired
    ? "Обновить папку LidFly"
    : "Установить папку";
  elements.claudeRepair.hidden = !status.needsRepair;
  elements.claudeRemove.disabled = busy || status.phase === "not_prepared";
}

async function refreshClaudeStatus(): Promise<void> {
  const payload = await invoke<ClaudeProjectStatusPayload>("get_claude_status");
  renderClaudeStatus(payload);
}

async function runClaudeOperation(
  operation: () => Promise<OperationOutcome>,
  successMessage: string,
): Promise<void> {
  if (busy) return;
  clearClaudeNotice();
  setBusy(true);
  try {
    const outcome = await operation();
    await refreshClaudeStatus();
    const backup = outcome.backupDirectory
      ? ` Резервная копия: ${outcome.backupDirectory}.`
      : "";
    showClaudeNotice(`${successMessage}${backup}`);
  } catch (error) {
    const clientError = asClientError(error);
    showClaudeNotice(
      `${clientError.message}${clientError.details.length > 0 ? ` ${clientError.details.join(", ")}` : ""}`,
      "error",
    );
    await refreshClaudeStatus().catch(() => undefined);
  } finally {
    setBusy(false);
  }
}

async function runOperation(
  operation: () => Promise<OperationOutcome>,
): Promise<void> {
  if (busy) return;
  const wasBundleUpdate = currentStatus?.updateRequired ?? false;
  clearNotice();
  setBusy(true);
  try {
    const outcome = await operation();
    renderStatus(outcome.status);
    if (wasBundleUpdate && outcome.status.canOpenCodex)
      showCodexUpdateReady(outcome.status.embeddedPluginVersion, false);
    const backup = outcome.backupDirectory
      ? ` Резервная копия: ${outcome.backupDirectory}.`
      : "";
    showNotice(
      `${outcome.message}${backup}`,
      outcome.preservedFiles.length > 0 ? "warning" : "success",
    );
  } catch (error) {
    const clientError = asClientError(error);
    showNotice(
      `${clientError.message}${clientError.details.length > 0 ? ` ${clientError.details.join(", ")}` : ""}`,
      "error",
    );
    await refreshStatus().catch(() => undefined);
  } finally {
    setBusy(false);
  }
}

elements.prepare.addEventListener("click", () => {
  void runOperation(async () => {
    let allowDowngrade = false;
    if (currentStatus?.downgradeDetected) {
      allowDowngrade = window.confirm(
        "На компьютере уже есть более новая версия плагина. Установить более раннюю и сохранить резервную копию?",
      );
      if (!allowDowngrade) throw new Error("Понижение версии отменено.");
    }
    return invoke<OperationOutcome>("prepare_plugin", {
      allowModified: false,
      allowDowngrade,
    });
  });
});

elements.repair.addEventListener("click", () => {
  if (
    !window.confirm(
      "Изменённые файлы будут сохранены в резервную копию и заменены официальными. Продолжить?",
    )
  )
    return;
  void runOperation(() =>
    invoke<OperationOutcome>("prepare_plugin", {
      allowModified: true,
      allowDowngrade: false,
    }),
  );
});

elements.verify.addEventListener("click", () => {
  if (busy) return;
  clearNotice();
  setBusy(true);
  void refreshStatus()
    .then(() =>
      showNotice(
        "Проверка завершена. Контрольные суммы файлов сверены.",
        "success",
      ),
    )
    .catch((error: unknown) =>
      showNotice(asClientError(error).message, "error"),
    )
    .finally(() => setBusy(false));
});

elements.openCodex.addEventListener("click", () => {
  void openCodex(false);
});

elements.remove.addEventListener("click", () => {
  if (
    !window.confirm(
      "Удалить только неизменённые файлы, подготовленные этим приложением? Плагин и OAuth в Codex не изменятся.",
    )
  )
    return;
  void runOperation(() => invoke<OperationOutcome>("remove_prepared_files"));
});

elements.logs.addEventListener("click", () => {
  void invoke("open_logs").catch((error: unknown) =>
    showNotice(asClientError(error).message, "error"),
  );
});

elements.claudePrepare.addEventListener("click", () => {
  const isUpdate = claudeStatus?.status.updateRequired ?? false;
  void runClaudeOperation(
    async () => {
      let allowDowngrade = false;
      if (claudeStatus?.status.downgradeDetected) {
        allowDowngrade = window.confirm(
          "В папке уже есть более новая версия файлов LidFly. Установить более раннюю и сохранить резервную копию?",
        );
        if (!allowDowngrade) throw new Error("Понижение версии отменено.");
      }
      return invoke<OperationOutcome>("prepare_claude_folder", {
        allowModified: false,
        allowDowngrade,
      });
    },
    isUpdate
      ? "Папка LidFly обновлена до официальной версии. Ваши документы не изменялись."
      : "Папка LidFly установлена. Теперь переходите к шагу 2 — подключите MCP в Claude Desktop.",
  );
});

elements.claudeRepair.addEventListener("click", () => {
  if (
    !window.confirm(
      "Изменённые служебные файлы LidFly будут сохранены в резервную копию и заменены официальными. Ваши собственные документы в папке не изменятся. Продолжить?",
    )
  )
    return;
  void runClaudeOperation(
    () =>
      invoke<OperationOutcome>("prepare_claude_folder", {
        allowModified: true,
        allowDowngrade: false,
      }),
    "Папка LidFly восстановлена: служебные файлы заменены официальными.",
  );
});

elements.claudeOpen.addEventListener("click", () => {
  if (busy) return;
  clearClaudeNotice();
  setBusy(true);
  void invoke<string>("open_in_claude")
    .then(() =>
      showClaudeNotice(
        "Claude открыт на папке LidFly. Подтвердите промпт в Cowork; чтобы папка осталась в списке, добавьте её как проект через «Use existing folder».",
      ),
    )
    .catch((error: unknown) =>
      showClaudeNotice(asClientError(error).message, "error"),
    )
    .finally(() => setBusy(false));
});

elements.claudeRemove.addEventListener("click", () => {
  if (
    !window.confirm(
      "Удалить из папки LidFly только неизменённые служебные файлы приложения? Ваши собственные документы и сама папка останутся на месте.",
    )
  )
    return;
  void runClaudeOperation(
    () => invoke<OperationOutcome>("remove_claude_folder"),
    "Служебные файлы LidFly удалены. Ваши документы и сама папка сохранены.",
  );
});

elements.copyMcp.addEventListener("click", () => {
  const url = claudeStatus?.mcpUrl ?? elements.claudeMcpUrl.textContent ?? "";
  void navigator.clipboard
    .writeText(url)
    .then(() =>
      showClaudeNotice(
        "Адрес MCP скопирован. Вставьте его в Claude: Settings → Connectors → «Add custom connector».",
      ),
    )
    .catch(() =>
      showClaudeNotice(
        `Не удалось скопировать автоматически. Выделите адрес ${url} и скопируйте вручную.`,
        "warning",
      ),
    );
});

elements.update.addEventListener("click", () => {
  if (busy) return;
  clearNotice();
  setBusy(true);
  if (availableUpdate) {
    void installAvailableUpdate(availableUpdate).finally(() => setBusy(false));
  } else {
    void requestAllUpdateChecks(true).finally(() => setBusy(false));
  }
});

elements.installUpdate.addEventListener("click", () => {
  if (busy || !availableUpdate) return;
  clearNotice();
  setBusy(true);
  void installAvailableUpdate(availableUpdate).finally(() => setBusy(false));
});

elements.installPluginUpdate.addEventListener("click", () => {
  if (busy || pluginContentStatus?.state !== "available") return;
  void installPluginContentUpdate();
});

elements.finishUpdate.addEventListener("click", () => {
  void openCodex(true);
});

async function openCodex(forUpdate: boolean): Promise<boolean> {
  if (busy) return false;
  clearNotice();
  setBusy(true);
  try {
    await invoke<string>("open_in_codex");
    if (forUpdate && currentStatus)
      showCodexUpdateReady(currentStatus.embeddedPluginVersion, true);
    showNotice(
      forUpdate
        ? "Codex открыт. Подтвердите обновление LidFly, полностью перезапустите Codex и начните новый чат."
        : "Codex открыт. Нажмите кнопку установки, войдите в LidFly по email, затем полностью перезапустите Codex и начните новый чат.",
    );
    return true;
  } catch (error) {
    showNotice(asClientError(error).message, "error");
    return false;
  } finally {
    setBusy(false);
  }
}

function requestUpdateCheck(announceResult: boolean): Promise<void> {
  if (updateCheckInFlight) return updateCheckInFlight;
  updateCheckInFlight = checkForUpdates(announceResult).finally(() => {
    updateCheckInFlight = null;
  });
  return updateCheckInFlight;
}

function requestContentCheck(announceResult: boolean): Promise<void> {
  if (contentCheckInFlight) return contentCheckInFlight;
  contentCheckInFlight = checkPluginContentUpdates(announceResult).finally(
    () => {
      contentCheckInFlight = null;
    },
  );
  return contentCheckInFlight;
}

async function requestAllUpdateChecks(announceResult: boolean): Promise<void> {
  await Promise.all([
    requestUpdateCheck(announceResult),
    requestContentCheck(announceResult),
  ]);
}

async function checkForUpdates(announceResult: boolean): Promise<void> {
  lastUpdateCheckAt = Date.now();
  if (!availableUpdate) elements.updateCaption.textContent = "Проверяем…";
  try {
    const update = await check({ allowDowngrades: false, timeout: 15_000 });
    if (!update) {
      availableUpdate = null;
      elements.updatePanel.hidden = true;
      resetUpdateTool();
      if (announceResult)
        showNotice("У вас установлена актуальная версия приложения.");
      return;
    }
    availableUpdate = update;
    showAvailableUpdate(update);
    if (announceResult) showNotice(`Доступно обновление ${update.version}.`);
  } catch (error) {
    const mapped = mapUpdaterError(error);
    resetUpdateTool();
    if (
      announceResult ||
      mapped.kind === "invalid_signature" ||
      mapped.kind === "unknown"
    )
      showNotice(
        `${mapped.title}. ${mapped.message}`,
        mapped.kind === "not_found" ? "warning" : "error",
      );
  }
}

async function checkPluginContentUpdates(
  announceResult: boolean,
): Promise<void> {
  lastContentCheckAt = Date.now();
  try {
    const status = await invoke<PluginContentUpdateStatus>(
      announceResult
        ? "retry_plugin_content_update"
        : "check_plugin_content_update",
    );
    renderPluginContentStatus(status);
    if (announceResult) {
      if (status.state === "available" && status.release) {
        showNotice(
          `Доступен плагин ${status.release.pluginVersion}. Установщик обновлять не нужно.`,
        );
      } else if (status.state === "requires_installer_update") {
        showNotice(
          "Для новой версии плагина сначала обновите приложение.",
          "warning",
        );
      } else if (!availableUpdate) {
        showNotice("Приложение и плагин обновлены до актуальных версий.");
      }
    }
  } catch (error) {
    const clientError = asClientError(error);
    const securityFailure = [
      "content_signature_mismatch",
      "invalid_content_signature",
      "invalid_content_manifest",
      "invalid_content_public_key",
    ].includes(clientError.code);
    if (announceResult || securityFailure) {
      showNotice(
        `Проверка обновления плагина не выполнена. ${clientError.message} Установленная версия продолжит работать.`,
        securityFailure ? "error" : "warning",
      );
    }
  }
}

async function installPluginContentUpdate(): Promise<void> {
  if (busy || pluginContentStatus?.state !== "available") return;
  clearNotice();
  setBusy(true);
  elements.pluginUpdatePanel.classList.add("is-downloading");
  elements.pluginUpdateProgress.hidden = false;
  elements.pluginUpdateProgress.removeAttribute("value");
  elements.pluginUpdateMessage.textContent =
    "Скачиваем обновление и проверяем его безопасность…";
  try {
    let outcome: PluginContentInstallOutcome;
    try {
      outcome = await invoke<PluginContentInstallOutcome>(
        "install_plugin_content_update",
        { allowModified: false },
      );
    } catch (error) {
      const clientError = asClientError(error);
      if (
        clientError.code !== "modified_files_confirmation_required" ||
        !window.confirm(
          "Некоторые файлы плагина изменены. Сохранить резервную копию и заменить их официальной версией?",
        )
      ) {
        throw error;
      }
      outcome = await invoke<PluginContentInstallOutcome>(
        "install_plugin_content_update",
        { allowModified: true },
      );
    }
    renderStatus(outcome.operation.status);
    pluginContentStatus = {
      state: "up_to_date",
      installerVersion: outcome.operation.status.appVersion,
      currentPluginVersion: outcome.release.pluginVersion,
      release: outcome.release,
    };
    elements.pluginUpdatePanel.hidden = true;
    showCodexUpdateReady(outcome.release.pluginVersion, outcome.codexOpened);
    await refreshClaudeStatus().catch(() => undefined);
    if (outcome.claudeOperation) {
      showClaudeNotice(
        "Папка LidFly обновлена вместе с плагином. Ваши документы не изменялись.",
      );
    } else if (outcome.claudeSyncError) {
      showClaudeNotice(
        `Папка LidFly не обновлена автоматически: ${outcome.claudeSyncError.message} Нажмите «Восстановить папку», чтобы обновить её с сохранением резервной копии.`,
        "warning",
      );
    }
    const backup = outcome.operation.backupDirectory
      ? ` Резервная копия: ${outcome.operation.backupDirectory}.`
      : "";
    showNotice(
      `Плагин ${outcome.release.pluginVersion} подготовлен.${outcome.codexOpened ? " Подтвердите обновление в Codex" : " Откройте Codex вручную и подтвердите обновление"}, затем полностью перезапустите Codex.${backup}`,
    );
  } catch (error) {
    const clientError = asClientError(error);
    elements.pluginUpdatePanel.classList.remove("is-downloading");
    elements.pluginUpdateProgress.hidden = true;
    elements.pluginUpdateMessage.textContent =
      "Обновление не применено. Текущая проверенная версия сохранена.";
    showNotice(clientError.message, "error");
    await refreshStatus().catch(() => undefined);
  } finally {
    setBusy(false);
    if (pluginContentStatus) renderPluginContentStatus(pluginContentStatus);
  }
}

async function installAvailableUpdate(update: Update): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;
  try {
    elements.updatePanel.classList.add("is-downloading");
    elements.updateProgress.hidden = false;
    elements.installUpdate.textContent = "Скачиваем обновление…";
    await update.downloadAndInstall((event: DownloadEvent) => {
      if (event.event === "Started") {
        downloaded = 0;
        total = event.data.contentLength ?? null;
        if (total) {
          elements.updateProgress.max = total;
          elements.updateProgress.value = 0;
        } else {
          elements.updateProgress.removeAttribute("value");
        }
        elements.updateMessage.textContent =
          "Скачиваем подписанное обновление. Приложение перезапустится автоматически.";
        elements.updateCaption.textContent = "Загрузка обновления…";
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        if (total) elements.updateProgress.value = downloaded;
        elements.updateMessage.textContent = total
          ? `Загружено ${Math.min(100, Math.round((downloaded / total) * 100))}%`
          : `Загружено ${Math.max(1, Math.round(downloaded / 1024))} КБ`;
        elements.updateCaption.textContent = `Загружено ${Math.max(1, Math.round(downloaded / 1024))} КБ`;
      } else if (event.event === "Finished") {
        if (total) elements.updateProgress.value = total;
        elements.updateMessage.textContent =
          "Обновление установлено. Сейчас приложение перезапустится.";
        elements.updateCaption.textContent =
          "Обновление проверено и установлено";
      }
    });
    showNotice("Обновление установлено. Сейчас приложение перезапустится.");
    await relaunch();
  } catch (error) {
    const mapped = mapUpdaterError(error);
    elements.updatePanel.classList.remove("is-downloading");
    elements.updateProgress.hidden = true;
    elements.installUpdate.textContent = `Повторить обновление до ${update.version}`;
    showNotice(`${mapped.title}. ${mapped.message}`, "error");
  }
}

async function initialize(): Promise<void> {
  setBusy(true);
  let synced: BundleSyncOutcome | null = null;
  try {
    synced = await invoke<BundleSyncOutcome>("sync_bundle_after_update");
    await refreshStatus();
    if (synced.marketplace) {
      showCodexUpdateReady(
        synced.marketplace.status.embeddedPluginVersion,
        false,
      );
      showNotice(
        "Установщик и пакет плагина обновлены. Открываем Codex для штатного подтверждения.",
      );
    }
  } catch (error) {
    const clientError = asClientError(error);
    elements.statusTitle.textContent =
      "Операция не выполнена, предыдущая версия сохранена";
    elements.statusMessage.textContent = clientError.message;
    elements.statusDot.className = "status-dot is-error";
    showNotice(clientError.message, "error");
  } finally {
    setBusy(false);
  }
  try {
    await refreshClaudeStatus();
    if (synced?.claude) {
      showClaudeNotice(
        "Папка LidFly обновлена вместе с плагином. Ваши документы не изменялись.",
      );
    } else if (synced?.claudeSyncError) {
      showClaudeNotice(
        `Папка LidFly не обновлена автоматически: ${synced.claudeSyncError.message}`,
        "warning",
      );
    }
  } catch (error) {
    elements.claudeTitle.textContent = "Не удалось проверить папку LidFly";
    elements.claudeMessage.textContent = asClientError(error).message;
    elements.claudeDot.className = "status-dot is-error";
  }
  if (synced?.marketplace) await openCodex(true);
  void requestAllUpdateChecks(false);
}

window.addEventListener("focus", () => {
  if (busy) return;
  const now = Date.now();
  if (shouldCheckForUpdates(lastUpdateCheckAt, now))
    void requestUpdateCheck(false);
  if (shouldCheckForContentUpdates(lastContentCheckAt, now))
    void requestContentCheck(false);
});

window.setInterval(() => {
  if (!busy && document.visibilityState === "visible")
    void requestAllUpdateChecks(false);
}, UPDATE_RECHECK_INTERVAL_MS);

void initialize();
