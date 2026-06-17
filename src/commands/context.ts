import { loadConfig } from "../config/config.js";
import type { Snapshot, SyncConfig, SyncState } from "../domain/types.js";
import { GitStore } from "../git/store.js";
import { createSnapshot } from "../snapshot/snapshot.js";
import { readState } from "../state/state.js";

export type SyncInputs = {
  config: SyncConfig;
  local: Snapshot;
  remote: Snapshot | undefined;
  state: SyncState;
};

/**
 * Load config, prepare the repo, and collect local/remote/state inputs.
 */
export async function syncInputs(): Promise<SyncInputs> {
  const config = await loadConfig();

  const gitStore = new GitStore(config);

  await gitStore.prepare();

  return {
    config,
    local: await createSnapshot(config.profile),
    remote: await gitStore.readSnapshot(),
    state: await readState(config.profile),
  };
}
