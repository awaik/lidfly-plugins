import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  inspectBuiltBundle,
  validateBundleMetadata,
} from "./plugin-bundle.mjs";

export const APP_NAME = "LidFly Codex Plugin Installer";

export function assertVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    throw new Error("--version is required and must use X.Y.Z");
  }
}

export function releaseFilenames(version) {
  assertVersion(version);
  const macosDmg = `${APP_NAME}_${version}_universal.dmg`;
  const macosUpdater = `${APP_NAME}_${version}_universal.app.tar.gz`;
  const windowsInstaller = `${APP_NAME}_${version}_x64-setup.exe`;
  return [
    macosDmg,
    macosUpdater,
    `${macosUpdater}.sig`,
    windowsInstaller,
    `${windowsInstaller}.sig`,
  ];
}

export async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("end", () => resolve(digest.digest("hex")));
  });
}

async function fileMetadata(directory, filename) {
  const filePath = path.resolve(directory, filename);
  const metadata = await stat(filePath).catch(() => null);
  if (!metadata?.isFile()) {
    throw new Error(`Missing required release artifact: ${filename}`);
  }
  if (metadata.size <= 0) {
    throw new Error(`Release artifact is empty: ${filename}`);
  }
  return {
    filename,
    sha256: await sha256File(filePath),
    size: metadata.size,
    path: filePath,
  };
}

function parseEvidence(evidence, version, artifacts) {
  if (evidence?.schema_version !== 1 || evidence?.release_version !== version) {
    throw new Error(
      "Platform signing evidence has the wrong schema or release version",
    );
  }
  const byName = new Map(
    artifacts.map((artifact) => [artifact.filename, artifact]),
  );
  const macosDmg = byName.get(`${APP_NAME}_${version}_universal.dmg`);
  const macosUpdater = byName.get(
    `${APP_NAME}_${version}_universal.app.tar.gz`,
  );
  const windows = byName.get(`${APP_NAME}_${version}_x64-setup.exe`);
  const apple = evidence.apple;
  if (
    apple?.developer_id !== true ||
    apple?.hardened_runtime !== true ||
    apple?.notarized !== true ||
    apple?.stapled !== true ||
    apple?.gatekeeper_accepted !== true ||
    !/^[A-Z0-9]{10}$/u.test(apple?.team_id ?? "") ||
    !/^[a-f0-9]{40}$/u.test(apple?.signing_identity_sha1 ?? "") ||
    apple?.dmg_sha256 !== macosDmg.sha256 ||
    apple?.updater_sha256 !== macosUpdater.sha256 ||
    JSON.stringify([...apple.architectures].sort()) !==
      JSON.stringify(["arm64", "x86_64"])
  ) {
    throw new Error(
      "Apple signing/notarization/stapling evidence is incomplete or stale",
    );
  }
  const windowsEvidence = evidence.windows;
  if (
    windowsEvidence?.authenticode_status !== "NotSigned" ||
    windowsEvidence?.release_policy !== "tauri_updater_signature_only" ||
    windowsEvidence?.architecture !== "x86_64" ||
    windowsEvidence?.installer_sha256 !== windows.sha256 ||
    windowsEvidence?.updater_signature_verified !== true ||
    Object.hasOwn(windowsEvidence, "certificate_thumbprint") ||
    Object.hasOwn(windowsEvidence, "digest_algorithm") ||
    Object.hasOwn(windowsEvidence, "timestamped") ||
    Object.hasOwn(windowsEvidence, "updater_signature_after_authenticode")
  ) {
    throw new Error(
      "Windows updater-signature-only evidence is incomplete or stale",
    );
  }
  return { apple, windows: windowsEvidence };
}

function runSignatureVerifier(repositoryRoot, artifact, signature, publicKey) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "cargo",
      [
        "run",
        "--quiet",
        "--manifest-path",
        path.join(repositoryRoot, "installer/src-tauri/Cargo.toml"),
        "--example",
        "verify-updater-signature",
        "--",
        artifact,
        signature,
      ],
      {
        cwd: repositoryRoot,
        env: { ...process.env, TAURI_UPDATER_PUBLIC_KEY: publicKey },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(output.trim());
      else {
        reject(
          new Error(
            output.trim() || `Updater signature verifier exited with ${code}`,
          ),
        );
      }
    });
  });
}

export async function verifyReleaseArtifacts({
  version,
  artifactsDir,
  pluginMetadataPath,
  repositoryRoot,
  updaterPublicKey,
  evidencePath,
  skipPlatformSignatures = false,
  skipUpdaterSignatures = false,
}) {
  assertVersion(version);
  const required = releaseFilenames(version);
  const directoryEntries = await readdir(artifactsDir);
  const releaseLike = directoryEntries.filter(
    (filename) =>
      filename.startsWith(`${APP_NAME}_`) && !required.includes(filename),
  );
  if (releaseLike.length > 0) {
    throw new Error(
      `Unexpected release artifact filenames: ${releaseLike.join(", ")}`,
    );
  }
  const artifacts = [];
  for (const filename of required) {
    artifacts.push(await fileMetadata(artifactsDir, filename));
  }

  const pluginMetadata = JSON.parse(await readFile(pluginMetadataPath, "utf8"));
  validateBundleMetadata(pluginMetadata);
  if (pluginMetadata.plugin_version !== version) {
    throw new Error(
      `Plugin bundle version ${pluginMetadata.plugin_version} does not match release ${version}`,
    );
  }
  const bundleRoot = path.join(
    path.dirname(pluginMetadataPath),
    "plugin-bundle",
  );
  await inspectBuiltBundle(bundleRoot, pluginMetadataPath);

  if (!skipUpdaterSignatures) {
    if (!updaterPublicKey?.trim()) {
      throw new Error("TAURI_UPDATER_PUBLIC_KEY is required");
    }
    const pairs = [
      [required[1], required[2]],
      [required[3], required[4]],
    ];
    for (const [artifactName, signatureName] of pairs) {
      await runSignatureVerifier(
        repositoryRoot,
        path.join(artifactsDir, artifactName),
        path.join(artifactsDir, signatureName),
        updaterPublicKey,
      );
    }
  }

  let signing = null;
  if (!skipPlatformSignatures) {
    if (!evidencePath) {
      throw new Error(
        "--evidence is required for platform release policy verification",
      );
    }
    signing = parseEvidence(
      JSON.parse(await readFile(evidencePath, "utf8")),
      version,
      artifacts,
    );
  }
  return {
    version,
    artifacts: artifacts.map(({ path: _path, ...artifact }) => artifact),
    pluginMetadata,
    signing,
  };
}
