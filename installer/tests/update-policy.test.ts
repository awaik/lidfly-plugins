import { describe, expect, it } from "vitest";

import {
  shouldCheckForUpdates,
  UPDATE_RECHECK_INTERVAL_MS,
} from "../src/update-policy";

describe("automatic updater checks", () => {
  it("checks immediately on the first application launch", () => {
    expect(shouldCheckForUpdates(null, 1_000)).toBe(true);
  });

  it("does not repeat a recent check", () => {
    expect(
      shouldCheckForUpdates(1_000, 1_000 + UPDATE_RECHECK_INTERVAL_MS - 1),
    ).toBe(false);
  });

  it("checks again after the recheck interval", () => {
    expect(
      shouldCheckForUpdates(1_000, 1_000 + UPDATE_RECHECK_INTERVAL_MS),
    ).toBe(true);
  });

  it("checks when the system clock moved backwards", () => {
    expect(shouldCheckForUpdates(2_000, 1_000)).toBe(true);
  });
});
