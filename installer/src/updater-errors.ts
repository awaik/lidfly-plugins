export type UpdaterErrorKind =
  "offline" | "not_found" | "invalid_signature" | "not_configured" | "unknown";

export interface UpdaterErrorMessage {
  kind: UpdaterErrorKind;
  title: string;
  message: string;
}

export function mapUpdaterError(error: unknown): UpdaterErrorMessage {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.toLowerCase();
  if (
    normalized.includes("network") ||
    normalized.includes("offline") ||
    normalized.includes("dns") ||
    normalized.includes("timed out") ||
    normalized.includes("connection")
  ) {
    return {
      kind: "offline",
      title: "Нет связи с сервером обновлений",
      message:
        "Проверьте интернет-соединение и повторите позже. Подготовленные файлы плагина не изменены.",
    };
  }
  if (normalized.includes("404") || normalized.includes("not found")) {
    return {
      kind: "not_found",
      title: "Обновление пока не опубликовано",
      message:
        "Сервер обновлений не вернул подписанный релиз. Текущая версия продолжит работать.",
    };
  }
  if (
    normalized.includes("not configured") ||
    normalized.includes("configuration") ||
    normalized.includes("pubkey")
  ) {
    return {
      kind: "not_configured",
      title: "Обновления отключены в этой сборке",
      message:
        "Development-сборка не содержит production public key. Установленный plugin bundle не изменён.",
    };
  }
  if (
    normalized.includes("signature") ||
    normalized.includes("minisign") ||
    normalized.includes("public key")
  ) {
    return {
      kind: "invalid_signature",
      title: "Подпись обновления не прошла проверку",
      message:
        "Обновление не установлено. Не скачивайте его из другого источника; сообщите об ошибке поддержке LidFly.",
    };
  }
  return {
    kind: "unknown",
    title: "Не удалось проверить обновления",
    message: `Текущая версия и plugin bundle сохранены. Техническая причина: ${raw}`,
  };
}
