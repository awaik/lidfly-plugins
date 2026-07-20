import { describe, expect, it } from "vitest";

import { mapUpdaterError } from "../src/updater-errors";

describe("mapUpdaterError", () => {
  it("maps offline and timeout errors without treating bundle installation as failed", () => {
    expect(
      mapUpdaterError(new Error("network connection timed out")),
    ).toMatchObject({ kind: "offline" });
  });

  it("maps missing updater metadata", () => {
    expect(mapUpdaterError(new Error("HTTP 404 Not Found"))).toMatchObject({
      kind: "not_found",
    });
  });

  it("maps invalid signature as a security failure", () => {
    const mapped = mapUpdaterError(
      new Error("Updater signature could not be verified"),
    );
    expect(mapped.kind).toBe("invalid_signature");
    expect(mapped.message).toContain("не установлено");
  });

  it("maps a missing updater configuration explicitly", () => {
    expect(
      mapUpdaterError(new Error("updater endpoint is not configured")),
    ).toMatchObject({ kind: "not_configured" });
  });

  it("keeps unknown updater failures distinct", () => {
    expect(
      mapUpdaterError(new Error("unexpected updater response")),
    ).toMatchObject({ kind: "unknown" });
  });
});
