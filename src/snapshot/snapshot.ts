import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  EXTERNAL_FILES,
  SECRET_PATTERNS,
  VERSION,
} from "../domain/constants.js";
import {
  isExcludedByManifest,
  resolveManifest,
  shouldDescend,
  type SyncManifest,
} from "../config/manifest.js";
import type { Snapshot, SnapshotFile } from "../domain/types.js";
import {
  agentDir,
  plannotatorConfigPath,
  posixJoin,
  safeJoin,
  toPosix,
} from "../utils/path-utils.js";

/**
 * Create a snapshot from the local Pi agent configuration.
 */
export async function createSnapshot(): Promise<Snapshot> {
  const files = await collectFiles(agentDir());

  await addExternalFiles(files);
  files.sort((left, right) => left.path.localeCompare(right.path));

  return {
    version: VERSION,
    id: snapshotId(),
    createdAt: new Date().toISOString(),
    machine: os.hostname(),
    files,
  };
}

/**
 * Check whether a relative Pi config path should be excluded from sync.
 *
 * @param relativePath Relative path under the Pi agent config directory.
 */
export function isDeniedPath(relativePath: string): boolean {
  const normalized = toPosix(relativePath);
  const base = path.posix.basename(normalized).toLowerCase();

  return (
    normalized.includes("/node_modules/") ||
    normalized.includes("/.git/") ||
    normalized.includes("/.pisync/") ||
    base === ".env" ||
    base.startsWith(".env.") ||
    base.endsWith(".env") ||
    base.includes("secret") ||
    base.includes("token") ||
    base === "pi-sync.json"
  );
}

/**
 * Scan a snapshot for common secret patterns before allowing upload.
 *
 * @param snapshot Snapshot to inspect.
 */
export function scanSnapshot(snapshot: Snapshot): string[] {
  const findings: string[] = [];

  for (const file of snapshot.files) {
    const content = Buffer.from(file.contentBase64, "base64");

    if (content.includes(0)) {
      continue;
    }

    if (
      SECRET_PATTERNS.some((pattern) => pattern.test(content.toString("utf8")))
    ) {
      findings.push(file.path);
    }
  }

  return findings;
}

/**
 * Write snapshot files into a target directory.
 *
 * @param snapshot Snapshot to write.
 * @param root Target root directory.
 */
export async function materializeSnapshot(
  snapshot: Snapshot,
  root: string,
): Promise<void> {
  await fs.mkdir(root, { recursive: true });

  for (const file of snapshot.files) {
    await materializeFile(root, file);
  }
}

/**
 * Decode base64 snapshot content after validating its shape.
 *
 * @param value Base64 content string.
 * @param filePath File path used in error messages.
 */
export function decodeBase64Strict(value: string, filePath: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`Invalid base64 content in snapshot file: ${filePath}`);
  }

  return Buffer.from(value, "base64");
}

/**
 * Hash a buffer with SHA-256.
 *
 * @param value Buffer to hash.
 */
export function hashBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Hash a snapshot file list by path and hash.
 *
 * @param files Snapshot files to summarize.
 */
export function hashFiles(files: SnapshotFile[]): string {
  return hashBuffer(
    Buffer.from(JSON.stringify(files.map((file) => [file.path, file.sha256]))),
  );
}

/**
 * Convert a snapshot to a path-to-hash map.
 *
 * @param snapshot Snapshot to convert.
 */
export function fileHashMap(snapshot: Snapshot): Record<string, string> {
  return Object.fromEntries(
    snapshot.files.map((file) => [file.path, file.sha256]),
  );
}

async function collectFiles(root: string): Promise<SnapshotFile[]> {
  const results: SnapshotFile[] = [];
  const manifest = resolveManifest();

  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (isExcludedByManifest(entry.name, manifest)) {
      continue;
    }

    if (entry.isFile() && isIncluded(entry.name, manifest)) {
      await addFile(results, root, entry.name);
    } else if (entry.isDirectory() && shouldDescend(entry.name, manifest)) {
      await collectDirectory(results, root, entry.name);
    }
  }

  return results.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Check whether a path is in the manifest, using the include patterns only.
 *
 * @param syncPath Path relative to the agent directory.
 * @param manifest Resolved manifest.
 */
function isIncluded(syncPath: string, manifest: SyncManifest): boolean {
  return manifest.includeMatchers.some((pattern) => pattern.test(syncPath));
}

async function collectDirectory(
  results: SnapshotFile[],
  root: string,
  relativeDirectory: string,
): Promise<void> {
  const absoluteDirectory = path.join(root, relativeDirectory);

  const manifest = resolveManifest();

  for (const entry of await fs.readdir(absoluteDirectory, {
    withFileTypes: true,
  })) {
    const relativePath = posixJoin(relativeDirectory, entry.name);

    if (isDeniedPath(relativePath) || isExcludedByManifest(relativePath, manifest)) {
      continue;
    }

    if (entry.isDirectory()) {
      if (shouldDescend(relativePath, manifest)) {
        await collectDirectory(results, root, relativePath);
      }
    } else if (entry.isFile() && isIncluded(relativePath, manifest)) {
      await addFile(results, root, relativePath);
    }
  }
}

async function addFile(
  results: SnapshotFile[],
  root: string,
  relativePath: string,
): Promise<void> {
  if (
    isDeniedPath(relativePath) ||
    isExcludedByManifest(relativePath)
  ) {
    return;
  }

  await addAbsoluteFile(results, safeJoin(root, relativePath), relativePath);
}

async function addExternalFiles(results: SnapshotFile[]): Promise<void> {
  for (const syncPath of EXTERNAL_FILES) {
    await addOptionalAbsoluteFile(
      results,
      localPathForExternalSyncPath(syncPath),
      syncPath,
    );
  }
}

async function addOptionalAbsoluteFile(
  results: SnapshotFile[],
  filePath: string,
  syncPath: string,
): Promise<void> {
  try {
    await addAbsoluteFile(results, filePath, syncPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function addAbsoluteFile(
  results: SnapshotFile[],
  filePath: string,
  syncPath: string,
): Promise<void> {
  if (isDeniedPath(syncPath) || isExcludedByManifest(syncPath)) {
    return;
  }

  const content = await fs.readFile(filePath);

  results.push({
    path: syncPath,
    contentBase64: content.toString("base64"),
    sha256: hashBuffer(content),
  });
}

function localPathForExternalSyncPath(syncPath: string): string {
  if (syncPath === ".plannotator/config.json") {
    return plannotatorConfigPath();
  }

  throw new Error(`Unsupported external sync path: ${syncPath}`);
}

async function materializeFile(
  root: string,
  file: SnapshotFile,
): Promise<void> {
  const target = safeJoin(root, file.path);
  const content = decodeBase64Strict(file.contentBase64, file.path);

  if (hashBuffer(content) !== file.sha256) {
    throw new Error(`Checksum mismatch in snapshot file: ${file.path}`);
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

function snapshotId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}
