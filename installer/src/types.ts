export type FileCondition =
  "missing" | "unchanged" | "outdated" | "modified" | "unsafe";

export type InstallerPhase =
  | "not_prepared"
  | "ready_for_codex"
  | "installed_bundle"
  | "modified_files"
  | "incomplete_state";

export interface FileStatus {
  path: string;
  condition: FileCondition;
  expectedSha256: string;
  actualSha256: string | null;
}

export interface InstallerStatus {
  appVersion: string;
  embeddedPluginVersion: string;
  installedPluginVersion: string | null;
  pluginBundleSha256: string;
  marketplacePath: string;
  phase: InstallerPhase;
  files: FileStatus[];
  unknownFiles: string[];
  canOpenCodex: boolean;
  needsRepair: boolean;
  updateRequired: boolean;
  downgradeDetected: boolean;
}

export interface OperationOutcome {
  status: InstallerStatus;
  message: string;
  changedFiles: string[];
  preservedFiles: string[];
  backupDirectory: string | null;
}

export interface ClientError {
  code: string;
  message: string;
  details: string[];
}
