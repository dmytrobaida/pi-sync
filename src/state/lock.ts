import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";

import { LOCK_STALE_MS } from "../domain/constants.js";
import type { LockFile } from "../domain/types.js";
import { readJsonIfExists } from "../utils/json-utils.js";
import { lockPath, stateDir } from "../utils/path-utils.js";

/**
 * Run a sync operation while holding the local pi-sync lock.
 *
 * @param command Lock owner command label.
 * @param fn Operation to execute under the lock.
 */
export async function withLock<T>(
  command: string,
  fn: () => Promise<T>,
): Promise<T> {
  await ensureStateDir();
  const lock: LockFile = {
    id: randomUUID(),
    pid: process.pid,
    command,
    startedAt: new Date().toISOString(),
  };
  let handle: fs.FileHandle | undefined;

  try {
    handle = await fs.open(lockPath(), "wx");
    await handle.writeFile(JSON.stringify(lock, null, "\t"));
    await handle.close();
    handle = undefined;

    return await fn();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw await lockError();
    }

    throw error;
  } finally {
    await handle?.close();
    await removeOwnLock(lock.id);
  }
}

/**
 * Ensure the local pi-sync state directory exists.
 */
export async function ensureStateDir(): Promise<void> {
  await fs.mkdir(stateDir(), { recursive: true });
}

/**
 * Read the current lock file if present.
 */
export async function readLock(): Promise<LockFile | undefined> {
  return readJsonIfExists<LockFile>(lockPath());
}

/**
 * Check whether a lock is stale or belongs to a dead process.
 *
 * @param lock Lock metadata to inspect.
 */
export function isStaleLock(lock: LockFile): boolean {
  if (!Number.isInteger(lock.pid) || lock.pid <= 0) {
    return true;
  }

  try {
    process.kill(lock.pid, 0);

    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return true;
    }

    return Date.now() - Date.parse(lock.startedAt) > LOCK_STALE_MS;
  }
}

async function lockError(): Promise<Error> {
  const current = await readLock();

  if (current != null && isStaleLock(current)) {
    return new Error(
      `pi-sync lock is stale (pid ${current.pid}). Run /pisync unlock --stale, then retry.`,
    );
  }

  return new Error(
    `pi-sync is already running${current != null ? ` (${current.command}, pid ${current.pid}, started ${current.startedAt})` : ""}.`,
  );
}

async function removeOwnLock(lockId: string): Promise<void> {
  const current = await readLock();

  if (current?.id === lockId) {
    await fs.rm(lockPath(), { force: true });
  }
}
