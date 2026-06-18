import fs from "node:fs/promises";
import path from "node:path";

import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { loadConfig } from "../config/config.js";
import { ACTIVITY_STATUS_KEY } from "../domain/constants.js";
import type { CommandOptions, Snapshot, SyncConfig } from "../domain/types.js";
import { GitStore } from "../git/store.js";
import { applySnapshot } from "../snapshot/apply.js";
import { formatGitTextDiff } from "../snapshot/diff.js";
import {
  createSnapshot,
  fileHashMap,
  scanSnapshot,
} from "../snapshot/snapshot.js";
import {
  hasLocalChanges,
  remoteChangedSinceState,
  sameHashes,
  writeSyncState,
} from "../state/state.js";
import { agentDir, stateDir } from "../utils/path-utils.js";
import { type SyncInputs, syncInputs } from "./context.js";
import {
  refreshSyncFooter,
  setSyncFooter,
  syncDrift,
} from "./footer-status.js";

type SyncOperationSettings = {
  notifyAutoSyncWarnings: boolean;
};

/**
 * Coordinates push, pull, sync, and checkout flows for one command invocation.
 */
export class SyncOperations {
  /**
   * Create a sync operation runner.
   *
   * @param ctx Pi context used for UI and optional reloads.
   * @param options Parsed command options.
   * @param settings Runtime behavior toggles for operation notifications.
   */
  constructor(
    private readonly ctx: ExtensionCommandContext | ExtensionContext,
    private readonly options: CommandOptions,
    private readonly settings: SyncOperationSettings = {
      notifyAutoSyncWarnings: true,
    },
  ) {}

  /**
   * Push local Pi config into the Git repository.
   */
  async push(): Promise<void> {
    this.ctx.ui.setStatus(ACTIVITY_STATUS_KEY, "🔄 pushing");
    const { config, local, remote, state } = await syncInputs();

    setSyncFooter(this.ctx, local, remote, state);
    const secrets = scanSnapshot(local);

    if (secrets.length > 0) {
      throw new Error(
        `Refusing to push possible secrets:\n${secrets.map((s) => `- ${s}`).join("\n")}`,
      );
    }

    if (remoteChangedSinceState(remote, state) && !this.options.force) {
      throw new Error(
        formatConflictGuidance(
          local,
          remote,
          state,
          "Remote changed since last sync. Run /pisync pull first or /pisync push --force.",
        ),
      );
    }

    const confirmed = this.options.yes
      ? true
      : await this.ctx.ui.confirm(
          "Push pi settings?",
          formatPushSummary(local, remote),
        );

    if (!confirmed) {
      setSyncFooter(this.ctx, local, remote, state);
      this.ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);
      this.ctx.ui.notify("Push cancelled.", "info");

      return;
    }

    await this.pushSnapshot(config, local);
  }

  /**
   * Pull remote Git config into the local Pi config directory.
   */
  async pull(): Promise<void> {
    this.ctx.ui.setStatus(ACTIVITY_STATUS_KEY, "🔄 pulling");
    const { config, local, remote, state } = await syncInputs();

    setSyncFooter(this.ctx, local, remote, state);

    if (remote == null) {
      throw new Error(
        "Remote is empty. Run /pisync push from a configured machine first.",
      );
    }

    if (hasDiverged(local, remote, state) && !this.options.force) {
      throw new Error(
        formatConflictGuidance(
          local,
          remote,
          state,
          "Both local and remote changed since last sync. Run /pisync diff, then choose /pisync pull --force or /pisync push --force.",
        ),
      );
    }

    const diffOutput = await formatGitTextDiff(local, remote);

    const confirmed = this.options.yes
      ? true
      : await this.ctx.ui.confirm("Pull pi settings?", diffOutput);

    if (!confirmed) {
      setSyncFooter(this.ctx, local, remote, state);
      this.ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);
      this.ctx.ui.notify("Pull cancelled.", "info");

      return;
    }

    await this.applyRemoteSnapshot(config, remote);
  }

  /**
   * Reconcile local and remote config using conservative sync rules.
   */
  async syncBoth(): Promise<void> {
    const { config, local, remote, state } = await syncInputs();

    setSyncFooter(this.ctx, local, remote, state);
    const localChanged = hasLocalChanges(local, state);
    const remoteChanged = remoteChangedSinceState(remote, state);
    const firstSync = state.lastAppliedSnapshot == null;

    if (firstSync && remote != null && local.files.length > 0) {
      await this.initializeMatchingState(config, local, remote);

      return;
    }

    if (localChanged && remoteChanged && state.lastAppliedSnapshot != null) {
      throw new Error(
        formatConflictGuidance(
          local,
          remote,
          state,
          "Both local and remote changed. Run /pisync diff and resolve with push --force or pull --force.",
        ),
      );
    }

    if (remoteChanged) {
      await this.pull();

      return;
    }

    if (localChanged || remote == null) {
      await this.push();

      return;
    }

    if (!this.options.silent) {
      this.ctx.ui.notify("pi-sync is already up to date.", "info");
    }
  }

  /**
   * Pull remote changes during auto-sync, but never push local changes automatically.
   */
  async autoSync(): Promise<void> {
    const { config, local, remote, state } = await syncInputs();

    setSyncFooter(this.ctx, local, remote, state);
    const localChanged = hasLocalChanges(local, state);
    const remoteChanged = remoteChangedSinceState(remote, state);
    const firstSync = state.lastAppliedSnapshot == null;

    if (firstSync && remote != null && local.files.length > 0) {
      await this.initializeMatchingState(config, local, remote);

      return;
    }

    if (localChanged && remoteChanged && state.lastAppliedSnapshot != null) {
      throw new Error(
        formatConflictGuidance(
          local,
          remote,
          state,
          "Both local and remote changed. Run /pisync diff and resolve with push --force or pull --force.",
        ),
      );
    }

    if (remoteChanged) {
      await this.pull();

      return;
    }

    if (localChanged) {
      if (this.settings.notifyAutoSyncWarnings) {
        this.ctx.ui.notify(
          "Local pi-sync changes detected. Auto-sync will not push them automatically; run /pisync push when ready.",
          "warning",
        );
      }

      return;
    }

    if (remote == null && this.settings.notifyAutoSyncWarnings) {
      this.ctx.ui.notify(
        "pi-sync remote is empty. Auto-sync will not push automatically; run /pisync push to initialize it.",
        "warning",
      );
    }
  }

  /**
   * Check out a previous Git commit-ish into local Pi config without changing remote.
   */
  async checkout(): Promise<void> {
    const target = this.options.args[0];

    if (target === "") {
      throw new Error("Usage: /pisync checkout <commit-ish> [--yes]");
    }

    const config = await loadConfig();
    const local = await createSnapshot();
    const gitStore = new GitStore(config);

    await gitStore.prepare();
    const remote = await gitStore.readSnapshot(target);

    if (remote == null) {
      throw new Error(`Snapshot not found at commit-ish: ${target}`);
    }

    const diffOutput = await formatGitTextDiff(local, remote);

    const confirmed = this.options.yes
      ? true
      : await this.ctx.ui.confirm("Check out pi settings locally?", diffOutput);

    if (!confirmed) {
      await refreshSyncFooter(this.ctx);
      this.ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);
      this.ctx.ui.notify("Checkout cancelled.", "info");

      return;
    }

    await this.checkoutSnapshot(config, remote);
  }

  private async applyRemoteSnapshot(
    config: SyncConfig,
    remote: Snapshot,
  ): Promise<void> {
    const backup = await backupLocal();

    await applySnapshot(remote);
    await writeSyncState(remote, await new GitStore(config).currentCommit());
    await refreshSyncFooter(this.ctx);
    this.ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);

    if (!this.options.silent) {
      this.ctx.ui.notify(
        `Pulled ${remote.files.length} files from ${remote.id}. Backup: ${backup}`,
        "info",
      );
    }

    if (this.options.reload) {
      await this.maybeReload();
    }
  }

  private async initializeMatchingState(
    config: SyncConfig,
    local: Snapshot,
    remote: Snapshot,
  ): Promise<void> {
    if (!sameHashes(fileHashMap(local), fileHashMap(remote))) {
      throw new Error(
        "Remote settings exist and this machine has different local Pi settings. Run /pisync diff, then manually choose /pisync pull or /pisync push.",
      );
    }

    await writeSyncState(remote, await new GitStore(config).currentCommit());
    await refreshSyncFooter(this.ctx);
    this.ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);

    if (!this.options.silent) {
      this.ctx.ui.notify(
        "pi-sync state initialized; local settings already match remote.",
        "info",
      );
    }
  }

  private async pushSnapshot(
    config: SyncConfig,
    local: Snapshot,
  ): Promise<void> {
    const gitStore = new GitStore(config);

    await gitStore.writeSnapshot(local);
    const before = await gitStore.currentCommit();
    const committed = await gitStore.commitAndPush(`pi-sync: ${local.id}`);
    const after = await gitStore.currentCommit();

    await writeSyncState(local, after !== "" ? after : before);
    await refreshSyncFooter(this.ctx);
    this.ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);

    if (!this.options.silent) {
      this.ctx.ui.notify(
        committed
          ? `Pushed ${local.files.length} files as ${local.id}.`
          : "No Git changes to push.",
        "info",
      );
    }
  }

  private async checkoutSnapshot(
    config: SyncConfig,
    remote: Snapshot,
  ): Promise<void> {
    const backup = await backupLocal();

    await applySnapshot(remote);
    await refreshSyncFooter(this.ctx);
    this.ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);
    this.ctx.ui.notify(
      `Checked out ${remote.id} locally. Remote was not changed. Backup: ${backup}\nLocal files now differ from latest remote; auto-sync will not push them. Run /pisync pull to return to remote latest, or /pisync push to publish this state.`,
      "info",
    );
    await this.maybeReload();
  }

  private async maybeReload(): Promise<void> {
    if (!("reload" in this.ctx)) {
      return;
    }

    const confirmed = await this.ctx.ui.confirm(
      "Reload Pi resources now?",
      "This reloads extensions, skills, prompts, themes, and context files.",
    );

    if (this.ctx.hasUI && confirmed) {
      await this.ctx.reload();
    }
  }
}

function formatConflictGuidance(
  local: Snapshot,
  remote: Snapshot | undefined,
  state: SyncInputs["state"],
  message: string,
): string {
  const drift = syncDrift(local, remote, state);

  return `${message}\nStatus: PI-SYNC: ↑${drift.local} ↓${drift.remote}`;
}

function hasDiverged(
  local: Snapshot,
  remote: Snapshot,
  state: SyncInputs["state"],
): boolean {
  return (
    hasLocalChanges(local, state) &&
    remote.id !== state.lastAppliedSnapshot &&
    state.lastAppliedSnapshot != null
  );
}

async function backupLocal(): Promise<string> {
  const snapshot = await createSnapshot();
  const backupDirectory = path.join(stateDir(), "backups");

  await fs.mkdir(backupDirectory, { recursive: true });
  const backupPath = path.join(backupDirectory, `${snapshot.id}.json`);

  await fs.writeFile(backupPath, JSON.stringify(snapshot, null, "\t"));

  return backupPath;
}

function formatPushSummary(
  local: Snapshot,
  remote: Snapshot | undefined,
): string {
  return [
    `Upload ${local.files.length} files from ${agentDir()}.`,
    remote != null ? `Remote latest: ${remote.id}` : "Remote latest: empty",
    "Possible secrets were scanned before this prompt.",
  ].join("\n");
}
