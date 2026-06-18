import { VERSION } from "../domain/constants.js";
import type { Snapshot, SyncState } from "../domain/types.js";
import { fileHashMap } from "../snapshot/snapshot.js";
import { readJsonIfExists, writeJson } from "../utils/json-utils.js";
import { statePath } from "../utils/path-utils.js";

/**
 * Read persisted local sync state.
 */
export async function readState(): Promise<SyncState> {
  return (
    (await readJsonIfExists<SyncState>(statePath())) ?? {
      version: VERSION,
      lastFileHashes: {},
    }
  );
}

/**
 * Persist local sync state after applying or pushing a snapshot.
 *
 * @param snapshot Snapshot represented by the commit.
 * @param commit Git commit ID associated with the state.
 */
export async function writeSyncState(
  snapshot: Snapshot,
  commit: string,
): Promise<void> {
  await writeJson(statePath(), {
    version: VERSION,
    lastAppliedSnapshot: commit,
    lastAppliedCommit: commit,
    lastFileHashes: fileHashMap(snapshot),
  });
}

/**
 * Check whether local file hashes differ from last synced state.
 *
 * @param local Current local snapshot.
 * @param state Persisted sync state.
 */
export function hasLocalChanges(local: Snapshot, state: SyncState): boolean {
  return !sameHashes(fileHashMap(local), state.lastFileHashes);
}

/**
 * Check whether remote state differs from last synced state.
 *
 * @param remote Current remote snapshot, if any.
 * @param state Persisted sync state.
 */
export function remoteChangedSinceState(
  remote: Snapshot | undefined,
  state: SyncState,
): boolean {
  return remote != null
    ? remote.id !== state.lastAppliedSnapshot
    : state.lastAppliedSnapshot != null;
}

/**
 * List paths whose hashes differ between two snapshots or state maps.
 *
 * @param left First hash map.
 * @param right Second hash map.
 */
export function changedPaths(
  left: Record<string, string>,
  right: Record<string, string>,
): string[] {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);

  return [...keys].filter((key) => left[key] !== right[key]).sort();
}

/**
 * Count paths whose hashes differ between two snapshots or state maps.
 *
 * @param left First hash map.
 * @param right Second hash map.
 */
export function changedPathCount(
  left: Record<string, string>,
  right: Record<string, string>,
): number {
  return changedPaths(left, right).length;
}

/**
 * Compare two path-to-hash maps for exact equality.
 *
 * @param left First hash map.
 * @param right Second hash map.
 */
export function sameHashes(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  return changedPathCount(left, right) === 0;
}
