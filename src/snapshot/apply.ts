import fs from "node:fs/promises";
import path from "node:path";

import { isExcludedByManifest, isInManifest } from "../config/manifest.js";
import type { Snapshot } from "../domain/types.js";
import {
  agentDir,
  plannotatorConfigPath,
  safeJoin,
  toPosix,
} from "../utils/path-utils.js";
import { createSnapshot, decodeBase64Strict, hashBuffer } from "./snapshot.js";

type SnapshotWrite = {
  target: string;
  content: Buffer;
};

type SnapshotMutationPlan = {
  writes: SnapshotWrite[];
  deletes: string[];
};

/**
 * Apply a validated snapshot to all local pi-sync managed paths.
 *
 * @param snapshot Snapshot to apply locally.
 */
export async function applySnapshot(snapshot: Snapshot): Promise<void> {
  const current = await createSnapshot();
  const plan = preflightSnapshotApply(agentDir(), snapshot, current);

  await preflightSnapshotMutations(plan);

  for (const target of plan.deletes) {
    await fs.rm(target, { force: true, recursive: true });
  }

  for (const item of plan.writes) {
    await fs.writeFile(item.target, item.content);
  }
}

/**
 * Build and validate the mutation plan required to apply a snapshot.
 *
 * @param root Local Pi agent config directory.
 * @param snapshot Remote snapshot that should be applied.
 * @param current Current local snapshot used to compute stale deletes.
 */
export function preflightSnapshotApply(
  root: string,
  snapshot: Snapshot,
  current: Snapshot,
): SnapshotMutationPlan {
  const remotePaths = new Set<string>();
  const writes = snapshot.files.map((file) => {
    const normalized = validateSnapshotPath(file.path, remotePaths);
    const content = decodeBase64Strict(file.contentBase64, normalized);

    if (hashBuffer(content) !== file.sha256) {
      throw new Error(`Checksum mismatch in snapshot file: ${normalized}`);
    }

    return { target: syncPathToLocalPath(root, normalized), content };
  });

  return { writes, deletes: staleLocalPaths(root, current, remotePaths) };
}

async function preflightSnapshotMutations(
  plan: SnapshotMutationPlan,
): Promise<void> {
  const deletePaths = new Set(plan.deletes);

  for (const target of plan.deletes) {
    await assertNoSymlinkParents(target);
  }

  for (const item of plan.writes) {
    await prepareSnapshotWrite(item.target, deletePaths);
  }
}

function validateSnapshotPath(
  pathValue: string,
  seenPaths: Set<string>,
): string {
  const normalized = toPosix(pathValue);

  if (
    normalized === "" ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    !isManagedSyncPath(normalized)
  ) {
    throw new Error(`Unsafe path in snapshot: ${pathValue}`);
  }

  if (seenPaths.has(normalized)) {
    throw new Error(`Duplicate path in snapshot: ${normalized}`);
  }

  seenPaths.add(normalized);

  return normalized;
}

function staleLocalPaths(
  root: string,
  current: Snapshot,
  remotePaths: Set<string>,
): string[] {
  const deletePaths = new Set<string>();
  // A path whose top-level entry the remote snapshot does not manage at all is
  // not "removed", it is simply outside the synced set. Deleting it would make
  // dropping a path from `include` destroy the local file on the next pull,
  // which is how a working settings.json becomes an unconfigured one.
  const remoteRoots = new Set(
    [...remotePaths].map((remotePath) => remotePath.split("/")[0] ?? ""),
  );

  for (const file of current.files) {
    const normalized = toPosix(file.path);

    if (
      !remoteRoots.has(normalized.split("/")[0] ?? "") ||
      isExcludedByManifest(normalized)
    ) {
      continue;
    }

    if (!remotePaths.has(normalized)) {
      deletePaths.add(syncPathToLocalPath(root, normalized));
    }

    for (const remotePath of remotePaths) {
      if (normalized.startsWith(`${remotePath}/`)) {
        deletePaths.add(syncPathToLocalPath(root, remotePath));
      }
    }
  }

  return [...deletePaths];
}

async function prepareSnapshotWrite(
  target: string,
  deletePaths: Set<string>,
): Promise<void> {
  await ensureSafeDirectory(path.dirname(target));

  try {
    const stat = await fs.lstat(target);

    if (stat.isSymbolicLink()) {
      throw new Error(
        `Refusing to overwrite symlink during snapshot apply: ${target}`,
      );
    }

    if (stat.isDirectory() && !deletePaths.has(target)) {
      throw new Error(
        `Refusing to overwrite directory during snapshot apply: ${target}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function ensureSafeDirectory(directory: string): Promise<void> {
  const resolvedDirectory = path.resolve(directory);
  const root = managedRootForPath(resolvedDirectory);
  const relative = path.relative(root, resolvedDirectory);
  let current = root;

  safeJoin(root, relative);

  for (const part of relative.split(path.sep).filter((item) => item !== "")) {
    current = path.join(current, part);
    await ensureDirectorySegment(current);
  }
}

async function ensureDirectorySegment(current: string): Promise<void> {
  try {
    const stat = await fs.lstat(current);

    if (stat.isSymbolicLink()) {
      throw new Error(
        `Refusing to follow symlink during snapshot apply: ${current}`,
      );
    }

    if (!stat.isDirectory()) {
      throw new Error(`Snapshot path parent is not a directory: ${current}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    await fs.mkdir(current);
  }
}

async function assertNoSymlinkParents(target: string): Promise<void> {
  const resolvedTarget = path.resolve(target);
  const root = managedRootForPath(resolvedTarget);
  const relative = path.relative(root, resolvedTarget);
  let current = root;

  safeJoin(root, relative);

  for (const part of relative
    .split(path.sep)
    .filter((item) => item !== "")
    .slice(0, -1)) {
    current = path.join(current, part);

    try {
      const stat = await fs.lstat(current);

      if (stat.isSymbolicLink()) {
        throw new Error(
          `Refusing to follow symlink during snapshot apply: ${current}`,
        );
      }

      if (!stat.isDirectory()) {
        throw new Error(`Snapshot path parent is not a directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }

      throw error;
    }
  }
}

function syncPathToLocalPath(root: string, syncPath: string): string {
  if (
    syncPath === ".plannotator/config.json" &&
    path.resolve(root) === path.resolve(agentDir())
  ) {
    return plannotatorConfigPath();
  }

  return safeJoin(root, syncPath);
}

function isManagedSyncPath(syncPath: string): boolean {
  return isInManifest(syncPath);
}

function managedRootForPath(target: string): string {
  const roots = [agentDir(), path.dirname(plannotatorConfigPath())].map(
    (item) => path.resolve(item),
  );
  const root = roots.find(
    (item) => target === item || target.startsWith(`${item}${path.sep}`),
  );

  if (root == null) {
    throw new Error(`Unsafe path in snapshot: ${target}`);
  }

  return root;
}
