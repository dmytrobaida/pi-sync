import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { STATUS_KEY } from "../domain/constants.js";
import type { Snapshot, SyncState } from "../domain/types.js";
import { fileHashMap } from "../snapshot/snapshot.js";
import { changedPathCount } from "../state/state.js";
import { syncInputs } from "./context.js";

export type SyncDrift = {
  local: number;
  remote: number;
};

/**
 * Update the pi-sync footer status with local and remote change counts.
 *
 * @param ctx Pi context with UI status access.
 */
export async function refreshSyncFooter(
  ctx: ExtensionCommandContext | ExtensionContext,
): Promise<void> {
  const { local, remote, state } = await syncInputs();

  setSyncFooter(ctx, local, remote, state);
}

/**
 * Render already-loaded sync inputs into the pi-sync footer status.
 *
 * @param ctx Pi context with UI status access.
 * @param local Current local snapshot.
 * @param remote Current remote snapshot, if any.
 * @param state Last persisted sync state.
 */
export function setSyncFooter(
  ctx: ExtensionCommandContext | ExtensionContext,
  local: Snapshot,
  remote: Snapshot | undefined,
  state: SyncState,
): void {
  ctx.ui.setStatus(
    STATUS_KEY,
    formatStyledSyncFooter(ctx, local, remote, state),
  );
}

/**
 * Format local and remote change counts for the footer.
 *
 * @param local Current local snapshot.
 * @param remote Current remote snapshot, if any.
 * @param state Last persisted sync state.
 */
export function formatSyncFooter(
  local: Snapshot,
  remote: Snapshot | undefined,
  state: SyncState,
): string {
  const drift = syncDrift(local, remote, state);

  return `PI-SYNC: ↑${drift.local} ↓${drift.remote}`;
}

function formatStyledSyncFooter(
  ctx: ExtensionCommandContext | ExtensionContext,
  local: Snapshot,
  remote: Snapshot | undefined,
  state: SyncState,
): string {
  const drift = syncDrift(local, remote, state);
  const label = ctx.ui.theme.fg("muted", "PI-SYNC:");
  const output = ctx.ui.theme.fg("error", `↑${drift.local}`);
  const input = ctx.ui.theme.fg("success", `↓${drift.remote}`);

  return `${label} ${output} ${input}`;
}

/**
 * Count local and remote drift against the last synced state.
 *
 * @param local Current local snapshot.
 * @param remote Current remote snapshot, if any.
 * @param state Last persisted sync state.
 */
export function syncDrift(
  local: Snapshot,
  remote: Snapshot | undefined,
  state: SyncState,
): SyncDrift {
  return {
    local: changedPathCount(fileHashMap(local), state.lastFileHashes),
    remote: changedPathCount(
      remote != null ? fileHashMap(remote) : {},
      state.lastFileHashes,
    ),
  };
}
