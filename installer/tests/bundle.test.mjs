import { execFile } from "node:child_process";
import {
  appendFile,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
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
  sha256File,
  verifyReleaseArtifacts,
} from "../../scripts/lib/release-contract.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const resourcesRoot = path.join(
  repositoryRoot,
  "installer/src-tauri/resources",
);
const tauriCli = path.join(
  repositoryRoot,
  "installer/node_modules/@tauri-apps/cli/tauri.js",
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

async function signingEvidence(directory) {
  const names = releaseFilenames("1.0.0");
  const hashes = new Map(
    await Promise.all(
      names.map(async (filename) => [
        filename,
        await sha256File(path.join(directory, filename)),
      ]),
    ),
  );
  return {
    schema_version: 1,
    release_version: "1.0.0",
    apple: {
      developer_id: true,
      hardened_runtime: true,
      notarized: true,
      stapled: true,
      gatekeeper_accepted: true,
      team_id: "HV66937AWS",
      signing_identity_sha1: "a".repeat(40),
      architectures: ["x86_64", "arm64"],
      dmg_sha256: hashes.get(names[0]),
      updater_sha256: hashes.get(names[1]),
    },
    windows: {
      authenticode_status: "NotSigned",
      release_policy: "tauri_updater_signature_only",
      architecture: "x86_64",
      installer_sha256: hashes.get(names[3]),
      updater_signature_verified: true,
    },
  };
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

  it("writes updater config without Windows certificate credentials", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "lidfly-release-config-test-"),
    );
    const output = path.join(directory, "tauri-release.json");
    const environment = {
      ...process.env,
      LIDFLY_RELEASE_PLATFORM: "windows",
      TAURI_UPDATER_PUBLIC_KEY: Buffer.from(
        "untrusted comment: test public key\nRWQtest-public-key",
      ).toString("base64"),
    };
    await execFileAsync(
      process.execPath,
      [
        path.join(repositoryRoot, "scripts/write-release-tauri-config.mjs"),
        output,
      ],
      { cwd: repositoryRoot, env: environment },
    );
    const config = JSON.parse(await readFile(output, "utf8"));
    expect(config.plugins.updater.pubkey).toBe(
      environment.TAURI_UPDATER_PUBLIC_KEY,
    );
    expect(config).not.toHaveProperty("bundle.windows.certificateThumbprint");
    expect(config).not.toHaveProperty("bundle.windows.timestampUrl");
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

  it("verifies real temporary updater signatures and rejects changed final bytes", async () => {
    const directory = await fakeReleaseDirectory();
    const keyDirectory = await mkdtemp(
      path.join(os.tmpdir(), "lidfly-updater-key-test-"),
    );
    const privateKey = path.join(keyDirectory, "test-updater.key");
    await execFileAsync(
      process.execPath,
      [
        tauriCli,
        "signer",
        "generate",
        "--write-keys",
        privateKey,
        "--password",
        "test-only-password",
        "--ci",
      ],
      { cwd: repositoryRoot },
    );
    const names = releaseFilenames("1.0.0");
    for (const artifactIndex of [1, 3]) {
      const artifact = path.join(directory, names[artifactIndex]);
      await unlink(`${artifact}.sig`);
      await execFileAsync(
        process.execPath,
        [
          tauriCli,
          "signer",
          "sign",
          "--private-key-path",
          privateKey,
          "--password",
          "test-only-password",
          artifact,
        ],
        { cwd: repositoryRoot },
      );
    }
    const updaterPublicKey = (
      await readFile(`${privateKey}.pub`, "utf8")
    ).trim();
    await expect(
      verifyReleaseArtifacts({
        version: "1.0.0",
        artifactsDir: directory,
        pluginMetadataPath: path.join(directory, "plugin-bundle-files.json"),
        repositoryRoot,
        updaterPublicKey,
        skipPlatformSignatures: true,
      }),
    ).resolves.toMatchObject({ version: "1.0.0" });

    await appendFile(path.join(directory, names[3]), "changed after signing");
    await expect(
      verifyReleaseArtifacts({
        version: "1.0.0",
        artifactsDir: directory,
        pluginMetadataPath: path.join(directory, "plugin-bundle-files.json"),
        repositoryRoot,
        updaterPublicKey,
        skipPlatformSignatures: true,
      }),
    ).rejects.toThrow(/signature verification failed/iu);
  }, 120_000);

  it("accepts complete platform evidence and rejects stale or failed signing checks", async () => {
    const directory = await fakeReleaseDirectory();
    const evidencePath = path.join(directory, "signing-evidence.json");
    const evidence = await signingEvidence(directory);
    await writeFile(evidencePath, JSON.stringify(evidence));
    await expect(
      verifyReleaseArtifacts({
        version: "1.0.0",
        artifactsDir: directory,
        pluginMetadataPath: path.join(directory, "plugin-bundle-files.json"),
        repositoryRoot,
        evidencePath,
        skipUpdaterSignatures: true,
      }),
    ).resolves.toMatchObject({ version: "1.0.0" });

    evidence.windows.authenticode_status = "Valid";
    await writeFile(evidencePath, JSON.stringify(evidence));
    await expect(
      verifyReleaseArtifacts({
        version: "1.0.0",
        artifactsDir: directory,
        pluginMetadataPath: path.join(directory, "plugin-bundle-files.json"),
        repositoryRoot,
        evidencePath,
        skipUpdaterSignatures: true,
      }),
    ).rejects.toThrow(/updater-signature-only/iu);

    evidence.windows.authenticode_status = "NotSigned";
    evidence.windows.certificate_thumbprint = "b".repeat(40);
    await writeFile(evidencePath, JSON.stringify(evidence));
    await expect(
      verifyReleaseArtifacts({
        version: "1.0.0",
        artifactsDir: directory,
        pluginMetadataPath: path.join(directory, "plugin-bundle-files.json"),
        repositoryRoot,
        evidencePath,
        skipUpdaterSignatures: true,
      }),
    ).rejects.toThrow(/updater-signature-only/iu);

    delete evidence.windows.certificate_thumbprint;
    evidence.apple.stapled = false;
    await writeFile(evidencePath, JSON.stringify(evidence));
    await expect(
      verifyReleaseArtifacts({
        version: "1.0.0",
        artifactsDir: directory,
        pluginMetadataPath: path.join(directory, "plugin-bundle-files.json"),
        repositoryRoot,
        evidencePath,
        skipUpdaterSignatures: true,
      }),
    ).rejects.toThrow(/Apple signing/iu);

    evidence.apple.stapled = true;
    evidence.windows.architecture = "arm64";
    await writeFile(evidencePath, JSON.stringify(evidence));
    await expect(
      verifyReleaseArtifacts({
        version: "1.0.0",
        artifactsDir: directory,
        pluginMetadataPath: path.join(directory, "plugin-bundle-files.json"),
        repositoryRoot,
        evidencePath,
        skipUpdaterSignatures: true,
      }),
    ).rejects.toThrow(/updater-signature-only/iu);
  });

  it("rejects a built bundle whose bytes no longer match its metadata", async () => {
    const directory = await fakeReleaseDirectory();
    await appendFile(
      path.join(directory, "plugin-bundle/plugins/lidfly/.mcp.json"),
      "\n",
    );
    await expect(
      verifyReleaseArtifacts({
        version: "1.0.0",
        artifactsDir: directory,
        pluginMetadataPath: path.join(directory, "plugin-bundle-files.json"),
        repositoryRoot,
        skipPlatformSignatures: true,
        skipUpdaterSignatures: true,
      }),
    ).rejects.toThrow(/bundle SHA-256 mismatch|bundle file mismatch/iu);
  });

  it("rejects artifact names for one version paired with another plugin version", async () => {
    const directory = await fakeReleaseDirectory();
    for (const [oldName, newName] of releaseFilenames("1.0.0").map(
      (oldName, index) => [oldName, releaseFilenames("1.0.1")[index]],
    )) {
      await cp(path.join(directory, oldName), path.join(directory, newName));
      await unlink(path.join(directory, oldName));
    }
    await expect(
      verifyReleaseArtifacts({
        version: "1.0.1",
        artifactsDir: directory,
        pluginMetadataPath: path.join(directory, "plugin-bundle-files.json"),
        repositoryRoot,
        skipPlatformSignatures: true,
        skipUpdaterSignatures: true,
      }),
    ).rejects.toThrow(/does not match release/iu);
  });
});
