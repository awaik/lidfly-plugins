import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import {
  macosDmgLayoutArgs,
  verifyTauriBundleAssets,
} from "../../scripts/lib/tauri-bundle.mjs";

it("uses the configured DMG background, dimensions and icon positions", () => {
  const configDir = path.resolve("fixture with spaces", "src-tauri");
  const background = "installer-assets/background with spaces.tiff";
  const appName = "Test App.app";
  const args = macosDmgLayoutArgs(
    path.join(configDir, "tauri.conf.json"),
    {
      background,
      windowSize: { width: 760, height: 450 },
      appPosition: { x: 200, y: 215 },
      applicationFolderPosition: { x: 560, y: 220 },
    },
    appName,
  );
  expect(args).toEqual([
    "--window-size",
    "760",
    "450",
    "--icon",
    appName,
    "200",
    "215",
    "--app-drop-link",
    "560",
    "220",
    "--background",
    path.resolve(configDir, background),
  ]);
});

it("rejects missing, empty and non-file installer assets", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "lidfly-tauri-assets-"));
  const configDir = path.join(fixture, "src-tauri");
  const configPath = path.join(configDir, "tauri.conf.json");
  const bundle = {
    icon: ["icon.ico"],
    licenseFile: "../LICENSE",
    macOS: { dmg: { background: "background.tiff" } },
    windows: {
      nsis: {
        installerIcon: "icon.ico",
        headerImage: "header.bmp",
        sidebarImage: "sidebar.bmp",
      },
    },
  };
  await mkdir(configDir);
  await writeFile(path.join(configDir, "icon.ico"), "fixture");
  await writeFile(path.join(fixture, "LICENSE"), "fixture");
  await expect(verifyTauriBundleAssets(configPath, bundle)).rejects.toThrow(
    "background.tiff",
  );
  await writeFile(path.join(configDir, "background.tiff"), "fixture");
  await writeFile(path.join(configDir, "header.bmp"), "");
  await expect(verifyTauriBundleAssets(configPath, bundle)).rejects.toThrow(
    "header.bmp",
  );
  await writeFile(path.join(configDir, "header.bmp"), "fixture");
  await mkdir(path.join(configDir, "sidebar.bmp"));
  await expect(verifyTauriBundleAssets(configPath, bundle)).rejects.toThrow(
    "sidebar.bmp",
  );
  bundle.windows.nsis.sidebarImage = "existing-sidebar.bmp";
  await writeFile(path.join(configDir, "existing-sidebar.bmp"), "fixture");
  await expect(
    verifyTauriBundleAssets(configPath, bundle),
  ).resolves.toBeUndefined();
});
