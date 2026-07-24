import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";

import "./styles.css";
import type { ClientError, InstallerStatus, OperationOutcome } from "./types";
import {
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
        <div class="eyebrow">Официальный установщик</div>
        <h1>Плагин LidFly для Codex</h1>
      </div>
      <div id="version" class="version"></div>
    </header>

    <section class="intro" aria-labelledby="intro-title">
      <div class="intro-copy">
        <p class="kicker">Без терминала и ручной настройки</p>
        <h2 id="intro-title">Три шага — и LidFly появится в новом чате Codex</h2>
      </div>
      <ol class="steps">
        <li><span>1</span><p>Приложение безопасно сохранит официальный плагин LidFly на этом компьютере.</p></li>
        <li><span>2</span><p>Откроется Codex — там нужно нажать штатную кнопку установки и войти по email.</p></li>
        <li><span>3</span><p>Полностью перезапустите Codex и начните новый чат.</p></li>
      </ol>
    </section>

    <section id="update-panel" class="update-panel" aria-live="polite" hidden>
      <div class="update-symbol" aria-hidden="true">↻</div>
      <div class="update-copy">
        <div class="eyebrow">Доступна новая версия</div>
        <h2 id="update-title">Обновление установщика LidFly</h2>
        <p id="update-message">
          Обновим приложение и официальный пакет плагина, не затрагивая ваши настройки.
        </p>
        <progress id="update-progress" class="update-progress" hidden></progress>
      </div>
      <button id="install-update" class="button button-update">
        Обновить установщик
      </button>
    </section>

    <section id="codex-update-panel" class="codex-update-panel" aria-live="polite" hidden>
      <div>
        <div class="eyebrow">Последний безопасный шаг</div>
        <h2 id="codex-update-title">Новая версия плагина готова</h2>
        <p id="codex-update-message">
          Подтвердите обновление на открывшейся карточке Codex, затем начните новый чат.
        </p>
      </div>
      <button id="finish-update" class="button button-dark">
        Открыть Codex
      </button>
    </section>

    <section class="status-card" aria-live="polite">
      <div class="status-topline">
        <span id="status-dot" class="status-dot is-loading"></span>
        <div>
          <div class="eyebrow">Состояние</div>
          <h2 id="status-title">Проверяем файлы…</h2>
        </div>
      </div>
      <p id="status-message" class="status-message">Это займёт несколько секунд.</p>
      <div id="notice" class="notice" hidden></div>
      <div id="details" class="details" hidden></div>
      <div class="primary-actions">
        <button id="prepare" class="button button-primary">Подготовить плагин</button>
        <button id="open-codex" class="button button-dark" disabled>Открыть в Codex</button>
        <button id="repair" class="button button-warning" hidden>Восстановить</button>
      </div>
    </section>

    <section class="tools" aria-label="Дополнительные действия">
      <button id="verify" class="tool-button"><span>✓</span><b>Проверить файлы</b><small>Сверить SHA-256</small></button>
      <button id="update" class="tool-button"><span>↻</span><b>Проверить обновления</b><small id="update-caption">Версия приложения</small></button>
      <button id="logs" class="tool-button"><span>≡</span><b>Открыть журнал</b><small>Без токенов и email</small></button>
      <button id="remove" class="tool-button tool-danger"><span>×</span><b>Удалить файлы</b><small>Codex не изменяется</small></button>
    </section>

    <footer>
      Установщик не меняет конфигурацию или cache Codex и не получает данные вашего аккаунта.
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
};

let currentStatus: InstallerStatus | null = null;
let availableUpdate: Update | null = null;
let busy = false;
let lastUpdateCheckAt: number | null = null;
let updateCheckInFlight: Promise<void> | null = null;

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
    elements.finishUpdate,
    elements.verify,
    elements.update,
    elements.logs,
    elements.remove,
  ]) {
    button.disabled =
      value || (button === elements.openCodex && !currentStatus?.canOpenCodex);
  }
  document.body.classList.toggle("is-busy", value);
}

function resetUpdateTool(): void {
  const label = elements.update.querySelector("b");
  if (label) label.textContent = "Проверить обновления";
  elements.updateCaption.textContent = currentStatus
    ? `Установлена ${currentStatus.appVersion}`
    : "Версия приложения";
}

function showAvailableUpdate(update: Update): void {
  elements.updatePanel.hidden = false;
  elements.updatePanel.classList.remove("is-downloading");
  elements.updateProgress.hidden = true;
  elements.updateProgress.removeAttribute("value");
  elements.updateTitle.textContent = `Доступна версия ${update.version}`;
  elements.updateMessage.textContent =
    update.body?.trim() ||
    "Обновим установщик и официальный пакет плагина. После перезапуска откроется Codex для штатного подтверждения.";
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
  if (!availableUpdate)
    elements.updateCaption.textContent = `Установлена ${status.appVersion}`;
  elements.statusDot.className = "status-dot";
  const statusCopy: Record<
    InstallerStatus["phase"],
    readonly [string, string, string]
  > = {
    not_prepared: [
      "Плагин ещё не подготовлен",
      "Нажмите «Подготовить плагин». Codex CLI не потребуется.",
      "idle",
    ],
    ready_for_codex: [
      "Готов к установке в Codex",
      "Файлы проверены. Откройте Codex и подтвердите установку.",
      "success",
    ],
    installed_bundle: [
      `Установлен bundle версии ${status.installedPluginVersion ?? status.embeddedPluginVersion}`,
      "Файлы прошли проверку. Можно открыть карточку LidFly в Codex.",
      "success",
    ],
    modified_files: [
      "Найдены изменённые файлы",
      "Установщик ничего не перезаписал. Проверьте список и запустите восстановление.",
      "warning",
    ],
    incomplete_state: [
      "Подготовка не завершена",
      "Предыдущая консистентная версия сохранена. Запустите проверку или восстановление.",
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
    ? "Обновить plugin bundle"
    : "Подготовить плагин";
  elements.repair.hidden = !status.needsRepair;
  elements.remove.disabled = busy || status.phase === "not_prepared";
  renderDetails(status);
}

async function refreshStatus(): Promise<void> {
  const status = await invoke<InstallerStatus>("get_status");
  renderStatus(status);
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
        "На компьютере подготовлена более новая версия. Установить более ранний bundle и сохранить backup?",
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
      "Изменённые файлы будут сохранены в backup и заменены официальными. Продолжить?",
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

elements.update.addEventListener("click", () => {
  if (busy) return;
  clearNotice();
  setBusy(true);
  if (availableUpdate) {
    void installAvailableUpdate(availableUpdate).finally(() => setBusy(false));
  } else {
    void requestUpdateCheck(true).finally(() => setBusy(false));
  }
});

elements.installUpdate.addEventListener("click", () => {
  if (busy || !availableUpdate) return;
  clearNotice();
  setBusy(true);
  void installAvailableUpdate(availableUpdate).finally(() => setBusy(false));
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
          "Обновление проверено. Перезапускаем приложение и готовим новую версию плагина.";
        elements.updateCaption.textContent =
          "Обновление проверено и установлено";
      }
    });
    showNotice(
      "Обновление установлено. Приложение перезапустится и синхронизирует plugin bundle той же версии.",
    );
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
  let synced: OperationOutcome | null = null;
  try {
    synced = await invoke<OperationOutcome | null>("sync_bundle_after_update");
    await refreshStatus();
    if (synced) {
      showCodexUpdateReady(synced.status.embeddedPluginVersion, false);
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
  if (synced) await openCodex(true);
  void requestUpdateCheck(false);
}

window.addEventListener("focus", () => {
  if (!busy && shouldCheckForUpdates(lastUpdateCheckAt, Date.now()))
    void requestUpdateCheck(false);
});

window.setInterval(() => {
  if (!busy && document.visibilityState === "visible")
    void requestUpdateCheck(false);
}, UPDATE_RECHECK_INTERVAL_MS);

void initialize();
