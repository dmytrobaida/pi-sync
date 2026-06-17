import fs from "node:fs/promises";
import path from "node:path";
import { agentDir, safeJoin, toPosix } from "../utils/path-utils.js";
import { createSnapshot, decodeBase64Strict, hashBuffer } from "./snapshot.js";
import type { Snapshot } from "../domain/types.js";

/**
 *
 * @param snapshot
 */
export async function applySnapshot(snapshot: Snapshot): Promise<void> {
  const root = agentDir();
  const current = await createSnapshot(snapshot.profile);
  const plan = preflightSnapshotApply(root, snapshot, current);

  await preflightSnapshotMutations(root, plan);

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
): { writes: { target: string; content: Buffer }[]; deletes: string[] } {
  const remotePaths = new Set<string>();
  const writes = snapshot.files.map((file) => {
    const normalized = validateSnapshotPath(file.path, remotePaths);
    const content = decodeBase64Strict(file.contentBase64, normalized);

    if (hashBuffer(content) !== file.sha256) {
      throw new Error(`Checksum mismatch in snapshot file: ${normalized}`);
    }

    return { target: safeJoin(root, normalized), content };
  });

  return { writes, deletes: staleLocalPaths(root, current, remotePaths) };
}

async function preflightSnapshotMutations(
  root: string,
  plan: { deletes: string[]; writes: { target: string; content: Buffer }[] },
): Promise<void> {
  const deletePaths = new Set(plan.deletes);

  for (const target of plan.deletes) {
    await assertNoSymlinkParents(root, target);
  }

  for (const item of plan.writes) {
    await prepareSnapshotWrite(root, item.target, deletePaths);
  }
}

function validateSnapshotPath(pathValue: string, seenPaths: Set<string>): string {
  const normalized = toPosix(pathValue);

  if (
    normalized === "" ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
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

  for (const file of current.files) {
    const normalized = toPosix(file.path);

    if (!remotePaths.has(normalized)) {
      deletePaths.add(safeJoin(root, normalized));
    }

    for (const remotePath of remotePaths) {
      if (normalized.startsWith(`${remotePath}/`)) {
        deletePaths.add(safeJoin(root, remotePath));
      }
    }
  }

  return [...deletePaths];
}

async function prepareSnapshotWrite(
  root: string,
  target: string,
  deletePaths: Set<string>,
): Promise<void> {
  await ensureSafeDirectory(root, path.dirname(target));

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

async function ensureSafeDirectory(root: string, directory: string): Promise<void> {
  const rootPath = path.resolve(root);
  const relative = path.relative(rootPath, path.resolve(directory));
  let current = rootPath;

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
      throw new Error(`Refusing to follow symlink during snapshot apply: ${current}`);
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

async function assertNoSymlinkParents(root: string, target: string): Promise<void> {
  const rootPath = path.resolve(root);
  const relative = path.relative(rootPath, path.resolve(target));
  let current = rootPath;

  safeJoin(root, relative);

  for (const part of relative.split(path.sep).filter((item) => item !== "").slice(0, -1)) {
    current = path.join(current, part);

    try {
      const stat = await fs.lstat(current);

      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to follow symlink during snapshot apply: ${current}`);
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
