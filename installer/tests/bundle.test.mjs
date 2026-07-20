import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  BUNDLE_PATHS,
  inspectSourceBundle,
  isSafeRelativePath,
} from "../../scripts/lib/plugin-bundle.mjs";
import {
  releaseFilenames,
  verifyReleaseArtifacts,
} from "../../scripts/lib/release-contract.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const resourcesRoot = path.join(
  repositoryRoot,
  "installer/src-tauri/resources",
);

async function fakeReleaseDirectory() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "lidfly-release-test-"),
  );
  await cp(
    path.join(resourcesRoot, "plugin-bundle"),
    path.join(directory, "plugin-bundle"),
    {
      recursive: true,
    },
  );
  await cp(
    path.join(resourcesRoot, "plugin-bundle-files.json"),
    path.join(directory, "plugin-bundle-files.json"),
  );
  for (const filename of releaseFilenames("1.0.0")) {
    await writeFile(path.join(directory, filename), `test ${filename}`);
  }
  return directory;
}

describe("plugin bundle contract", () => {
  it("uses the exact stable allowlist and produces a deterministic digest", async () => {
    const first = await inspectSourceBundle(repositoryRoot);
    const second = await inspectSourceBundle(repositoryRoot);
    expect(first.metadata.files.map((file) => file.path)).toEqual(BUNDLE_PATHS);
    expect(first.metadata.plugin_bundle_sha256).toBe(
      second.metadata.plugin_bundle_sha256,
    );
    expect(first.metadata.files).toEqual(second.metadata.files);
  });

  it("rejects traversal, absolute paths and Windows separators", () => {
    expect(isSafeRelativePath("plugins/lidfly/.mcp.json")).toBe(true);
    expect(isSafeRelativePath("../secret")).toBe(false);
    expect(isSafeRelativePath("/tmp/secret")).toBe(false);
    expect(isSafeRelativePath("plugins\\lidfly\\.mcp.json")).toBe(false);
  });

  it("rejects unknown files in a built bundle", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "lidfly-bundle-test-"),
    );
    const bundleRoot = path.join(directory, "plugin-bundle");
    await cp(path.join(resourcesRoot, "plugin-bundle"), bundleRoot, {
      recursive: true,
    });
    await mkdir(path.join(bundleRoot, "unknown"));
    await writeFile(path.join(bundleRoot, "unknown/file.txt"), "not allowed");
    await expect(
      execFileAsync(
        process.execPath,
        [
          path.join(repositoryRoot, "scripts/verify-plugin-bundle.mjs"),
          bundleRoot,
          path.join(resourcesRoot, "plugin-bundle-files.json"),
        ],
        { cwd: repositoryRoot },
      ),
    ).rejects.toThrow();
  });
});

describe("release artifact contract", () => {
  it("requires exactly the five versioned filenames", () => {
    expect(releaseFilenames("1.0.0")).toEqual([
      "LidFly Codex Plugin Installer_1.0.0_universal.dmg",
      "LidFly Codex Plugin Installer_1.0.0_universal.app.tar.gz",
      "LidFly Codex Plugin Installer_1.0.0_universal.app.tar.gz.sig",
      "LidFly Codex Plugin Installer_1.0.0_x64-setup.exe",
      "LidFly Codex Plugin Installer_1.0.0_x64-setup.exe.sig",
    ]);
  });

  it("accepts a complete local fixture when platform/signature checks are explicitly skipped", async () => {
    const directory = await fakeReleaseDirectory();
    const result = await verifyReleaseArtifacts({
      version: "1.0.0",
      artifactsDir: directory,
      pluginMetadataPath: path.join(directory, "plugin-bundle-files.json"),
      repositoryRoot,
      skipPlatformSignatures: true,
      skipUpdaterSignatures: true,
    });
    expect(result.artifacts).toHaveLength(5);
  });

  it("fails closed when an artifact is missing or an unexpected alias exists", async () => {
    const missingDirectory = await fakeReleaseDirectory();
    const required = releaseFilenames("1.0.0");
    await import("node:fs/promises").then(({ unlink }) =>
      unlink(path.join(missingDirectory, required[0])),
    );
    await expect(
      verifyReleaseArtifacts({
        version: "1.0.0",
        artifactsDir: missingDirectory,
        pluginMetadataPath: path.join(
          missingDirectory,
          "plugin-bundle-files.json",
        ),
        repositoryRoot,
        skipPlatformSignatures: true,
        skipUpdaterSignatures: true,
      }),
    ).rejects.toThrow(/Missing required release artifact/u);

    const aliasedDirectory = await fakeReleaseDirectory();
    await writeFile(
      path.join(
        aliasedDirectory,
        "LidFly Codex Plugin Installer_1.0.0_universal (1).dmg",
      ),
      "alias",
    );
    await expect(
      verifyReleaseArtifacts({
        version: "1.0.0",
        artifactsDir: aliasedDirectory,
        pluginMetadataPath: path.join(
          aliasedDirectory,
          "plugin-bundle-files.json",
        ),
        repositoryRoot,
        skipPlatformSignatures: true,
        skipUpdaterSignatures: true,
      }),
    ).rejects.toThrow(/Unexpected release artifact filenames/u);
  });

  it("fails closed when an updater signature file is empty", async () => {
    const directory = await fakeReleaseDirectory();
    await writeFile(path.join(directory, releaseFilenames("1.0.0")[2]), "");
    await expect(
      verifyReleaseArtifacts({
        version: "1.0.0",
        artifactsDir: directory,
        pluginMetadataPath: path.join(directory, "plugin-bundle-files.json"),
        repositoryRoot,
        skipPlatformSignatures: true,
        skipUpdaterSignatures: true,
      }),
    ).rejects.toThrow(/Release artifact is empty/u);
  });
});
