#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  CLAUDE_PROJECT_LOCK_PATH,
  CLAUDE_PROJECT_MANIFEST_PATH,
  CLAUDE_PROJECT_REPOSITORY,
  CLAUDE_PROJECT_ROOT,
  assertNoForbiddenText,
  isSafeClaudeProjectSourcePath,
  stableJson,
} from "./lib/plugin-bundle.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptRoot, "..");
const snapshotRoot = path.join(repositoryRoot, CLAUDE_PROJECT_ROOT);
const manifestPath = path.join(repositoryRoot, CLAUDE_PROJECT_MANIFEST_PATH);
const lockPath = path.join(repositoryRoot, CLAUDE_PROJECT_LOCK_PATH);
const excludedSourcePaths = new Set([
  ".claude/notify.mp3",
  ".claude/settings.json",
  ".codex/hooks.json",
  ".codex/notify.mp3",
  ".codex/notify_project.py",
  ".mcp.json",
]);
const excludedSourcePrefixes = [".github/"];

export function isIncludedClaudeProjectSourcePath(relativePath) {
  return (
    !excludedSourcePaths.has(relativePath) &&
    !excludedSourcePrefixes.some((prefix) => relativePath.startsWith(prefix))
  );
}

function git(sourceRoot, args) {
  return execFileSync("git", ["-C", sourceRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function resolveSourceRoot() {
  const flagIndex = process.argv.indexOf("--source");
  const provided =
    flagIndex >= 0
      ? process.argv[flagIndex + 1]
      : process.env.CLAUDE_PROJECT_SOURCE;
  const candidate = provided
    ? path.resolve(provided)
    : path.resolve(repositoryRoot, "../direct-mcp-ai-project");
  return candidate;
}

function assertExpectedOrigin(sourceRoot) {
  const origin = git(sourceRoot, ["remote", "get-url", "origin"]).trim();
  const normalized = origin
    .replace(/^git@github\.com:/u, "https://github.com/")
    .replace(/\.git$/u, "");
  if (normalized !== CLAUDE_PROJECT_REPOSITORY) {
    throw new Error(
      `Source origin must be ${CLAUDE_PROJECT_REPOSITORY}, got: ${origin}`,
    );
  }
}

function warnAboutSourceDrift(sourceRoot, commit) {
  const status = git(sourceRoot, ["status", "--porcelain"]).trim();
  if (status.length > 0) {
    console.warn(
      `Warning: source working tree has uncommitted changes; the snapshot uses committed HEAD ${commit} and does not include them.`,
    );
  }
  const remoteBranches = git(sourceRoot, [
    "branch",
    "-r",
    "--contains",
    commit,
  ]).trim();
  if (remoteBranches.length === 0) {
    console.warn(
      `Warning: commit ${commit} is not on any remote branch yet; push it so the lock references a public commit.`,
    );
  }
}

function listCommittedFiles(sourceRoot) {
  const entries = git(sourceRoot, [
    "ls-tree",
    "-r",
    "HEAD",
    "--name-only",
    "-z",
  ])
    .split("\0")
    .filter((entry) => entry.length > 0)
    .sort();
  if (entries.length === 0) {
    throw new Error("Source repository has no tracked files");
  }
  return entries;
}

async function extractCommittedTree(sourceRoot) {
  const extractRoot = await mkdtemp(
    path.join(os.tmpdir(), "lidfly-claude-project-"),
  );
  const archivePath = path.join(extractRoot, "source.tar");
  git(sourceRoot, ["archive", "--format=tar", "-o", archivePath, "HEAD"]);
  execFileSync("tar", ["-xf", archivePath, "-C", extractRoot]);
  await rm(archivePath, { force: true });
  return extractRoot;
}

function assertSnapshotRelativePath(relativePath) {
  if (!isSafeClaudeProjectSourcePath(relativePath)) {
    throw new Error(`Unsafe or conflicting source path: ${relativePath}`);
  }
}

async function readSourceFile(sourceRoot, relativePath) {
  const absolutePath = path.join(sourceRoot, ...relativePath.split("/"));
  const fileLstat = await lstat(absolutePath);
  if (!fileLstat.isFile() || fileLstat.isSymbolicLink()) {
    throw new Error(`${relativePath} must be a regular file, not a symlink`);
  }
  if (fileLstat.size <= 0) throw new Error(`${relativePath} is empty`);
  const bytes = await readFile(absolutePath);
  assertNoForbiddenText(relativePath, bytes);
  return { absolutePath, bytes };
}

async function readPreviousSnapshotPaths() {
  let previousPaths = [];
  try {
    const metadata = await lstat(manifestPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(
        "Previous claude-project manifest must be a regular file",
      );
    }
    const previous = JSON.parse(await readFile(manifestPath, "utf8"));
    if (
      previous?.version !== 1 ||
      !previous.files ||
      typeof previous.files !== "object" ||
      Array.isArray(previous.files)
    ) {
      throw new Error("Previous claude-project manifest is invalid");
    }
    previousPaths = Object.keys(previous.files);
    for (const relativePath of previousPaths)
      assertSnapshotRelativePath(relativePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return previousPaths;
}

export async function assertSnapshotContainsOnly(root, allowedRelativePaths) {
  const allowedFiles = new Set(allowedRelativePaths);
  const allowedDirectories = new Set(
    allowedRelativePaths.flatMap((relativePath) => {
      const parts = relativePath.split("/").slice(0, -1);
      return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
    }),
  );
  const unknown = [];

  async function visit(relativeDirectory = "") {
    const absoluteDirectory = relativeDirectory
      ? path.join(root, ...relativeDirectory.split("/"))
      : root;
    let entries;
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT" && relativeDirectory === "") return;
      throw error;
    }
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        if (allowedDirectories.has(relativePath)) await visit(relativePath);
        else unknown.push(`${relativePath}/`);
      } else if (!allowedFiles.has(relativePath)) {
        unknown.push(relativePath);
      }
    }
  }

  await visit();
  if (unknown.length > 0) {
    throw new Error(
      `Unknown files remain in ${CLAUDE_PROJECT_ROOT}/ and will not be removed automatically: ${unknown.sort().join(", ")}. Review and delete them manually.`,
    );
  }
}

async function removePreviousSnapshot(previousPaths) {
  for (const relativePath of previousPaths) {
    await rm(path.join(snapshotRoot, ...relativePath.split("/")), {
      force: true,
    });
  }
  await rm(manifestPath, { force: true });
  const directories = new Set(
    previousPaths.flatMap((relativePath) => {
      const parts = relativePath.split("/").slice(0, -1);
      return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
    }),
  );
  for (const relativeDirectory of [...directories].sort(
    (a, b) => b.length - a.length,
  )) {
    const absoluteDirectory = path.join(
      snapshotRoot,
      ...relativeDirectory.split("/"),
    );
    try {
      if ((await readdir(absoluteDirectory)).length === 0)
        await rmdir(absoluteDirectory);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function main() {
  const sourceRoot = resolveSourceRoot();
  assertExpectedOrigin(sourceRoot);
  const commit = git(sourceRoot, ["rev-parse", "HEAD"]).trim();
  if (!/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error(`Unexpected source commit: ${commit}`);
  }
  warnAboutSourceDrift(sourceRoot, commit);

  const sourceFiles = listCommittedFiles(sourceRoot);
  for (const relativePath of sourceFiles)
    assertSnapshotRelativePath(relativePath);
  const committedFiles = sourceFiles.filter(isIncludedClaudeProjectSourcePath);
  if (committedFiles.length === 0) {
    throw new Error("Source repository has no distributable snapshot files");
  }

  const previousPaths = await readPreviousSnapshotPaths();
  await assertSnapshotContainsOnly(snapshotRoot, [
    ...previousPaths,
    path.posix.basename(CLAUDE_PROJECT_MANIFEST_PATH),
  ]);

  const extractRoot = await extractCommittedTree(sourceRoot);
  const files = [];
  try {
    for (const relativePath of committedFiles) {
      const file = await readSourceFile(extractRoot, relativePath);
      files.push({
        relativePath,
        absolutePath: file.absolutePath,
        size: file.bytes.byteLength,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
      });
    }

    await removePreviousSnapshot(previousPaths);

    for (const file of files) {
      const destination = path.join(
        snapshotRoot,
        ...file.relativePath.split("/"),
      );
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(file.absolutePath, destination);
    }
  } finally {
    await rm(extractRoot, { recursive: true, force: true });
  }

  const manifestFiles = {};
  const treeDigest = createHash("sha256");
  for (const file of files) {
    manifestFiles[file.relativePath] = file.sha256;
    treeDigest.update(file.relativePath, "utf8");
    treeDigest.update("\0");
    treeDigest.update(String(file.size), "ascii");
    treeDigest.update("\0");
    treeDigest.update(file.sha256, "ascii");
    treeDigest.update("\0");
  }
  await writeFile(
    manifestPath,
    stableJson({ version: 1, files: manifestFiles }),
    "utf8",
  );
  await writeFile(
    lockPath,
    stableJson({
      schema_version: 1,
      source: {
        repository: CLAUDE_PROJECT_REPOSITORY,
        commit,
      },
      project_tree_sha256: treeDigest.digest("hex"),
      file_count: files.length,
    }),
    "utf8",
  );

  console.log(`Claude project snapshot: ${commit}`);
  console.log(
    `Files: ${files.length}; excluded: ${sourceFiles.length - files.length}; manifest: ${CLAUDE_PROJECT_MANIFEST_PATH}; lock: ${CLAUDE_PROJECT_LOCK_PATH}`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
