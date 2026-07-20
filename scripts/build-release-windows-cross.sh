#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This cross-build script is for a local Mac" >&2
  exit 1
fi
if [[ "$(node -p 'process.versions.node.split(`.`)[0]')" != "22" ]]; then
  echo "Windows cross-build requires Node 22" >&2
  exit 1
fi

VERSION="${1:-}"
ARTIFACTS_DIR="${2:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || [[ -z "$ARTIFACTS_DIR" ]]; then
  echo "Usage: build-release-windows-cross.sh X.Y.Z /empty/artifacts/directory" >&2
  exit 1
fi

for name in TAURI_SIGNING_PRIVATE_KEY_PATH TAURI_UPDATER_PUBLIC_KEY_PATH; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing local release setting: $name" >&2
    exit 1
  fi
done

for command_name in brew cargo-xwin makensis; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing local cross-build dependency: $command_name" >&2
    exit 1
  fi
done
LLVM_BIN="$(brew --prefix llvm)/bin"
if [[ ! -x "$LLVM_BIN/llvm-rc" ]]; then
  echo "Missing llvm-rc in $LLVM_BIN" >&2
  exit 1
fi
export PATH="$LLVM_BIN:$PATH"

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER_ROOT="$REPOSITORY_ROOT/installer"
ARTIFACTS_DIR="$(mkdir -p "$ARTIFACTS_DIR" && cd "$ARTIFACTS_DIR" && pwd)"
RELEASE_TEMP_DIR="$(mktemp -d)"
RELEASE_CONFIG="$RELEASE_TEMP_DIR/tauri-release.json"
XWIN_CACHE_DIR="${XWIN_CACHE_DIR:-$(getconf DARWIN_USER_CACHE_DIR)lidfly-cargo-xwin}"
export XWIN_CACHE_DIR
mkdir -p "$XWIN_CACHE_DIR"

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]]; then
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password \
    -s ru.lidfly.codex-plugin-installer.updater-key \
    -a "$(id -un)" -w)"
fi
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
export TAURI_SIGNING_PRIVATE_KEY="$(<"$TAURI_SIGNING_PRIVATE_KEY_PATH")"
unset TAURI_SIGNING_PRIVATE_KEY_PATH
export TAURI_UPDATER_PUBLIC_KEY="$(<"$TAURI_UPDATER_PUBLIC_KEY_PATH")"

INSTALLER_NAME="LidFly Codex Plugin Installer_${VERSION}_x64-setup.exe"
INSTALLER_OUTPUT="$ARTIFACTS_DIR/$INSTALLER_NAME"
SIGNATURE_OUTPUT="$INSTALLER_OUTPUT.sig"
EVIDENCE_OUTPUT="$ARTIFACTS_DIR/windows-evidence.json"
METADATA_OUTPUT="$ARTIFACTS_DIR/plugin-bundle-files.json"
for output in "$INSTALLER_OUTPUT" "$SIGNATURE_OUTPUT" "$EVIDENCE_OUTPUT" "$METADATA_OUTPUT"; do
  if [[ -e "$output" ]]; then
    echo "Refusing to overwrite existing release output: $output" >&2
    exit 1
  fi
done

cd "$INSTALLER_ROOT"
npm ci
npm run bundle:plugin
npm run bundle:plugin:verify
npm run version:check
test "$(node -p "require('./package.json').version")" = "$VERSION"
node ../scripts/write-release-tauri-config.mjs "$RELEASE_CONFIG"
npx tauri build \
  --bundles nsis \
  --runner cargo-xwin \
  --target x86_64-pc-windows-msvc \
  --config "$RELEASE_CONFIG"

TARGET_DIR="src-tauri/target/x86_64-pc-windows-msvc/release"
SOURCE_INSTALLER="$TARGET_DIR/bundle/nsis/$INSTALLER_NAME"
APPLICATION="$TARGET_DIR/lidfly-codex-plugin-installer.exe"
cp "$SOURCE_INSTALLER" "$INSTALLER_OUTPUT"
cp "$SOURCE_INSTALLER.sig" "$SIGNATURE_OUTPUT"
node ../scripts/verify-pe-machine.mjs "$APPLICATION"
node ../scripts/verify-pe-authenticode.mjs "$INSTALLER_OUTPUT"
cargo run --quiet --manifest-path src-tauri/Cargo.toml \
  --example verify-updater-signature -- \
  "$INSTALLER_OUTPUT" "$SIGNATURE_OUTPUT"

export VERSION INSTALLER_OUTPUT
node --input-type=module - <<'NODE'
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const installerSha256 = crypto
  .createHash("sha256")
  .update(fs.readFileSync(process.env.INSTALLER_OUTPUT))
  .digest("hex");
fs.writeFileSync(
  path.join(path.dirname(process.env.INSTALLER_OUTPUT), "windows-evidence.json"),
  `${JSON.stringify(
    {
      schema_version: 1,
      release_version: process.env.VERSION,
      windows: {
        authenticode_status: "NotSigned",
        release_policy: "tauri_updater_signature_only",
        architecture: "x86_64",
        installer_sha256: installerSha256,
        updater_signature_verified: true,
      },
    },
    null,
    2,
  )}\n`,
  { encoding: "utf8", mode: 0o600 },
);
NODE
cp src-tauri/resources/plugin-bundle-files.json "$METADATA_OUTPUT"

echo "Local cross-built Windows release is ready: $ARTIFACTS_DIR"
