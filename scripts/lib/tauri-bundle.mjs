import { lstat } from "node:fs/promises";
import path from "node:path";

export function macosDmgLayoutArgs(configPath, dmg, appName) {
  const {
    background,
    windowPosition,
    windowSize,
    appPosition,
    applicationFolderPosition,
  } = dmg;
  const args = [
    "--window-size",
    String(windowSize.width),
    String(windowSize.height),
    "--icon",
    appName,
    String(appPosition.x),
    String(appPosition.y),
    "--app-drop-link",
    String(applicationFolderPosition.x),
    String(applicationFolderPosition.y),
  ];
  if (windowPosition) {
    args.push(
      "--window-pos",
      String(windowPosition.x),
      String(windowPosition.y),
    );
  }
  if (background) {
    args.push(
      "--background",
      path.resolve(path.dirname(configPath), background),
    );
  }
  return args;
}

export async function verifyTauriBundleAssets(configPath, bundle) {
  const nsis = bundle.windows?.nsis;
  const assets = [
    ...(bundle.icon ?? []),
    bundle.licenseFile,
    bundle.macOS?.dmg?.background,
    nsis?.installerIcon,
    nsis?.headerImage,
    nsis?.sidebarImage,
  ];
  for (const asset of new Set(assets)) {
    if (asset == null) continue;
    const assetPath = path.resolve(path.dirname(configPath), asset);
    const metadata = await lstat(assetPath).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!metadata?.isFile() || metadata.size === 0) {
      throw new Error(
        `Tauri bundle asset must be a non-empty regular file: ${asset}`,
      );
    }
  }
}
