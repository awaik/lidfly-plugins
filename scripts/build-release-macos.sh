#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS release must be built on a local Mac" >&2
  exit 1
fi

if [[ "$(node -p 'process.versions.node.split(`.`)[0]')" != "22" ]]; then
  echo "macOS release requires Node 22" >&2
  exit 1
fi

VERSION="${1:-}"
ARTIFACTS_DIR="${2:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || [[ -z "$ARTIFACTS_DIR" ]]; then
  echo "Usage: build-release-macos.sh X.Y.Z /empty/artifacts/directory" >&2
  exit 1
fi

for name in APPLE_SIGNING_IDENTITY APPLE_TEAM_ID TAURI_SIGNING_PRIVATE_KEY_PATH TAURI_UPDATER_PUBLIC_KEY_PATH; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing local release setting: $name" >&2
    exit 1
  fi
done

NOTARYTOOL_PROFILE="${NOTARYTOOL_PROFILE:-glas-notary}"
REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER_ROOT="$REPOSITORY_ROOT/installer"
ARTIFACTS_DIR="$(mkdir -p "$ARTIFACTS_DIR" && cd "$ARTIFACTS_DIR" && pwd)"
RELEASE_TEMP_DIR="$(mktemp -d)"
RELEASE_CONFIG="$RELEASE_TEMP_DIR/tauri-release.json"
MACOS_BUNDLE_DIR="$INSTALLER_ROOT/src-tauri/target/universal-apple-darwin/release/bundle/macos"
DMG_BUNDLE_DIR="$INSTALLER_ROOT/src-tauri/target/universal-apple-darwin/release/bundle/dmg"
APP_NAME="LidFly Codex Plugin Installer.app"
APP_PATH="$MACOS_BUNDLE_DIR/$APP_NAME"
DMG_NAME="LidFly Codex Plugin Installer_${VERSION}_universal.dmg"
UPDATER_NAME="LidFly Codex Plugin Installer_${VERSION}_universal.app.tar.gz"
DMG_OUTPUT="$ARTIFACTS_DIR/$DMG_NAME"
UPDATER_OUTPUT="$ARTIFACTS_DIR/$UPDATER_NAME"
UPDATER_SIGNATURE_OUTPUT="$UPDATER_OUTPUT.sig"

for output in "$DMG_OUTPUT" "$UPDATER_OUTPUT" "$UPDATER_SIGNATURE_OUTPUT" \
  "$ARTIFACTS_DIR/apple-evidence.json" \
  "$ARTIFACTS_DIR/plugin-bundle-files.json"; do
  if [[ -e "$output" ]]; then
    echo "Refusing to overwrite existing release output: $output" >&2
    exit 1
  fi
done

if ! security find-identity -v -p codesigning | grep -F "$APPLE_SIGNING_IDENTITY" >/dev/null; then
  echo "APPLE_SIGNING_IDENTITY is not available in the local Keychain" >&2
  exit 1
fi
xcrun notarytool history --keychain-profile "$NOTARYTOOL_PROFILE" >/dev/null

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]]; then
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password \
    -s ru.lidfly.codex-plugin-installer.updater-key \
    -a "$(id -un)" -w)"
fi
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
export TAURI_SIGNING_PRIVATE_KEY="$(<"$TAURI_SIGNING_PRIVATE_KEY_PATH")"
unset TAURI_SIGNING_PRIVATE_KEY_PATH
export TAURI_UPDATER_PUBLIC_KEY="$(<"$TAURI_UPDATER_PUBLIC_KEY_PATH")"
export APPLE_SIGNING_IDENTITY

cd "$INSTALLER_ROOT"
npm ci
npm run bundle:plugin
npm run bundle:plugin:verify
npm run version:check
test "$(node -p "require('./package.json').version")" = "$VERSION"
node ../scripts/write-release-tauri-config.mjs "$RELEASE_CONFIG"

# The initial DMG is disposable. It makes Tauri generate its tested DMG helper;
# the final DMG below is rebuilt from the notarized and stapled app.
npx tauri build --bundles app,dmg --target universal-apple-darwin --config "$RELEASE_CONFIG"

APP_ZIP="$RELEASE_TEMP_DIR/LidFly Codex Plugin Installer.zip"
ditto -c -k --keepParent "$APP_PATH" "$APP_ZIP"
xcrun notarytool submit "$APP_ZIP" \
  --keychain-profile "$NOTARYTOOL_PROFILE" \
  --wait \
  --timeout 30m
xcrun stapler staple "$APP_PATH"
xcrun stapler validate "$APP_PATH"

# Recreate and sign the updater payload after stapling, so the released archive
# contains exactly the app verified above.
COPYFILE_DISABLE=1 tar -czf "$UPDATER_OUTPUT" -C "$MACOS_BUNDLE_DIR" "$APP_NAME"
npx tauri signer sign "$UPDATER_OUTPUT"

DMG_SOURCE="$RELEASE_TEMP_DIR/dmg-source"
mkdir -p "$DMG_SOURCE"
ditto "$APP_PATH" "$DMG_SOURCE/$APP_NAME"
"$DMG_BUNDLE_DIR/bundle_dmg.sh" \
  --volname "LidFly Codex Plugin Installer" \
  --volicon "$DMG_BUNDLE_DIR/icon.icns" \
  --window-size 660 400 \
  --icon-size 128 \
  --icon "$APP_NAME" 180 170 \
  --hide-extension "$APP_NAME" \
  --app-drop-link 480 170 \
  --codesign "$APPLE_SIGNING_IDENTITY" \
  --notarize "$NOTARYTOOL_PROFILE" \
  "$DMG_OUTPUT" "$DMG_SOURCE"

codesign --verify --deep --strict --verbose=2 "$APP_PATH"
codesign --verify --strict --verbose=2 "$DMG_OUTPUT"
SIGNING_DETAILS="$(codesign -dv --verbose=4 "$APP_PATH" 2>&1)"
grep -F "Authority=Developer ID Application:" <<<"$SIGNING_DETAILS"
grep -F "TeamIdentifier=$APPLE_TEAM_ID" <<<"$SIGNING_DETAILS"
grep -F "Runtime Version" <<<"$SIGNING_DETAILS"
spctl --assess --type execute --verbose=4 "$APP_PATH"
xcrun stapler validate "$APP_PATH"
xcrun stapler validate "$DMG_OUTPUT"

ARCHITECTURES="$(lipo -archs "$APP_PATH/Contents/MacOS/lidfly-codex-plugin-installer")"
[[ "$ARCHITECTURES" == *x86_64* && "$ARCHITECTURES" == *arm64* ]]

EXTRACTED_DIR="$RELEASE_TEMP_DIR/updater-app"
mkdir -p "$EXTRACTED_DIR"
tar -xzf "$UPDATER_OUTPUT" -C "$EXTRACTED_DIR"
EXTRACTED_APP="$EXTRACTED_DIR/$APP_NAME"
codesign --verify --deep --strict --verbose=2 "$EXTRACTED_APP"
spctl --assess --type execute --verbose=4 "$EXTRACTED_APP"
EXTRACTED_ARCHITECTURES="$(lipo -archs "$EXTRACTED_APP/Contents/MacOS/lidfly-codex-plugin-installer")"
[[ "$EXTRACTED_ARCHITECTURES" == *x86_64* && "$EXTRACTED_ARCHITECTURES" == *arm64* ]]

MOUNT_POINT="$RELEASE_TEMP_DIR/dmg-mount"
mkdir -p "$MOUNT_POINT"
hdiutil attach -readonly -noautoopen -nobrowse -mountpoint "$MOUNT_POINT" "$DMG_OUTPUT" >/dev/null
detach_dmg() {
  hdiutil detach "$MOUNT_POINT" >/dev/null 2>&1 || true
}
trap detach_dmg EXIT
MOUNTED_APP="$MOUNT_POINT/$APP_NAME"
codesign --verify --deep --strict --verbose=2 "$MOUNTED_APP"
spctl --assess --type execute --verbose=4 "$MOUNTED_APP"
DMG_ARCHITECTURES="$(lipo -archs "$MOUNTED_APP/Contents/MacOS/lidfly-codex-plugin-installer")"
[[ "$DMG_ARCHITECTURES" == *x86_64* && "$DMG_ARCHITECTURES" == *arm64* ]]
hdiutil detach "$MOUNT_POINT" >/dev/null
trap - EXIT

cargo run --quiet --manifest-path src-tauri/Cargo.toml \
  --example verify-updater-signature -- \
  "$UPDATER_OUTPUT" "$UPDATER_SIGNATURE_OUTPUT"

CERTIFICATE_PREFIX="$RELEASE_TEMP_DIR/signing-cert-"
codesign -d --extract-certificates="$CERTIFICATE_PREFIX" "$APP_PATH"
SIGNING_IDENTITY_SHA1="$(openssl x509 -inform DER -in "${CERTIFICATE_PREFIX}0" \
  -noout -fingerprint -sha1 | cut -d= -f2 | tr -d ':' | tr '[:upper:]' '[:lower:]')"
EXPECTED_IDENTITY_SHA1="$(tr '[:upper:]' '[:lower:]' <<<"$APPLE_SIGNING_IDENTITY")"
test "$SIGNING_IDENTITY_SHA1" = "$EXPECTED_IDENTITY_SHA1"
SIGNING_TEAM_ID="$(sed -n 's/^TeamIdentifier=//p' <<<"$SIGNING_DETAILS")"
export VERSION DMG_OUTPUT UPDATER_OUTPUT SIGNING_IDENTITY_SHA1 SIGNING_TEAM_ID
node --input-type=module - <<'NODE'
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sha256 = (filePath) =>
  crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
fs.writeFileSync(
  path.join(path.dirname(process.env.DMG_OUTPUT), "apple-evidence.json"),
  `${JSON.stringify(
    {
      schema_version: 1,
      release_version: process.env.VERSION,
      apple: {
        developer_id: true,
        hardened_runtime: true,
        notarized: true,
        stapled: true,
        gatekeeper_accepted: true,
        team_id: process.env.SIGNING_TEAM_ID,
        signing_identity_sha1: process.env.SIGNING_IDENTITY_SHA1,
        architectures: ["x86_64", "arm64"],
        dmg_sha256: sha256(process.env.DMG_OUTPUT),
        updater_sha256: sha256(process.env.UPDATER_OUTPUT),
      },
    },
    null,
    2,
  )}\n`,
  { encoding: "utf8", mode: 0o600 },
);
NODE
cp src-tauri/resources/plugin-bundle-files.json "$ARTIFACTS_DIR/plugin-bundle-files.json"

echo "Local macOS release is ready: $ARTIFACTS_DIR"
