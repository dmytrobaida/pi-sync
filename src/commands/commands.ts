import fs from "node:fs/promises";
import path from "node:path";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { loadConfig, loadPartialConfig } from "../config/config.js";
import {
  ACTIVITY_STATUS_KEY,
  DEFAULT_BRANCH,
  NO_DIFF_MESSAGE,
} from "../domain/constants.js";
import type { CommandOptions, Snapshot, SyncState } from "../domain/types.js";
import { GitStore, syncPathspecs } from "../git/store.js";
import { formatGitTextDiff } from "../snapshot/diff.js";
import {
  createSnapshot,
  fileHashMap,
  scanSnapshot,
} from "../snapshot/snapshot.js";
import {
  ensureStateDir,
  isStaleLock,
  readLock,
  withLock,
} from "../state/lock.js";
import {
  changedPaths,
  hasLocalChanges,
  remoteChangedSinceState,
} from "../state/state.js";
import { errorMessage } from "../utils/json-utils.js";
import { localConfigPath, repoDir, stateDir } from "../utils/path-utils.js";
import { isEnabled, parseOptions, splitArgs, usage } from "./args.js";
import { repositoryAccessReport } from "./auth.js";
import { syncInputs } from "./context.js";
import { setSyncFooter, syncDrift } from "./footer-status.js";
import { initConfig } from "./init.js";
import { SyncOperations } from "./operations.js";

/**
 * Parse and execute a /pisync command invocation.
 *
 * @param rawArgs Raw argument string after /pisync.
 * @param ctx Pi command context used for UI and session operations.
 */
export async function handleCommand(
  rawArgs: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const [subcommand = "status", ...rest] = splitArgs(rawArgs);
  const options = parseOptions(rest);

  try {
    await ensureStateDir();
    await runCommand(subcommand, options, ctx);
  } catch (error) {
    ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);
    ctx.ui.notify(errorMessage(error), "error");
  }
}

async function runCommand(
  subcommand: string,
  options: CommandOptions,
  ctx: ExtensionCommandContext,
): Promise<void> {
  switch (subcommand) {
    case "help":
      ctx.ui.notify(usage(), "info");

      return;
    case "init":
      await initConfig(ctx);

      return;
    case "config":
      await showConfig(ctx);

      return;
    case "status":
      await status(ctx, options);

      return;
    case "diff":
      await diff(ctx);

      return;
    case "doctor":
      await doctor(ctx);

      return;
    case "push":
      await withLock("push", async () => {
        await new SyncOperations(ctx, options).push();
      });

      return;
    case "pull":
      await withLock("pull", async () => {
        await new SyncOperations(ctx, options).pull();
      });

      return;
    case "sync":
      await withLock("sync", async () => {
        await new SyncOperations(ctx, options).syncBoth();
      });

      return;
    case "history":
      await history(ctx);

      return;
    case "checkout":
      await withLock("checkout", async () => {
        await new SyncOperations(ctx, options).checkout();
      });

      return;
    case "unlock":
      await unlock(ctx, options);

      return;
    default:
      ctx.ui.notify(
        `Unknown /pisync command: ${subcommand}\n\n${usage()}`,
        "warning",
      );
  }
}

async function showConfig(ctx: ExtensionCommandContext): Promise<void> {
  const partial = await loadPartialConfig();

  ctx.ui.notify(
    [
      "pi-sync config:",
      `repository: ${partial.repository ?? "missing"}`,
      `branch: ${partial.branch ?? DEFAULT_BRANCH}`,
      `autoSync: ${isEnabled(partial.autoSync ?? process.env.PI_SYNC_AUTO_SYNC, true) ? "enabled" : "disabled"}`,
      `local config: ${localConfigPath()}`,
      `local clone: ${repoDir()}`,
    ].join("\n"),
    "info",
  );
}

async function status(
  ctx: ExtensionCommandContext,
  options: CommandOptions,
): Promise<void> {
  ctx.ui.setStatus(ACTIVITY_STATUS_KEY, "🔄 checking");
  const { config, local, remote, state } = await syncInputs();

  setSyncFooter(ctx, local, remote, state);
  const localChanged = hasLocalChanges(local, state);
  const remoteChanged = remoteChangedSinceState(remote, state);
  const remoteCommit = await new GitStore(config).currentCommit();
  const drift = syncDrift(local, remote, state);
  const messages = [
    remote != null
      ? `remote: ${remote.id} at ${remoteCommit}`
      : "remote: empty",
    `local files: ${local.files.length}`,
    `local changed since last sync: ${localChanged ? "yes" : "no"} (${drift.local} paths)`,
    `remote changed since last sync: ${remoteChanged ? "yes" : "no"} (${drift.remote} paths)`,
    nextAction(localChanged, remoteChanged),
  ];

  if (options.verbose) {
    messages.push(...verboseStatusLines(local, remote, state));
  }

  ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);
  ctx.ui.notify(
    messages.join("\n"),
    localChanged || remoteChanged ? "warning" : "info",
  );
}

function nextAction(localChanged: boolean, remoteChanged: boolean): string {
  if (localChanged && remoteChanged) {
    return "next: run /pisync diff, then resolve with /pisync pull --force or /pisync push --force";
  }

  if (remoteChanged) {
    return "next: run /pisync pull";
  }

  if (localChanged) {
    return "next: run /pisync push when ready";
  }

  return "next: no action needed";
}

function verboseStatusLines(
  local: Snapshot,
  remote: Snapshot | undefined,
  state: SyncState,
): string[] {
  const localPaths = changedPaths(fileHashMap(local), state.lastFileHashes);
  const remotePaths = changedPaths(
    remote != null ? fileHashMap(remote) : {},
    state.lastFileHashes,
  );

  return [
    "local changed paths:",
    ...formatPathList(localPaths),
    "remote changed paths:",
    ...formatPathList(remotePaths),
  ];
}

function formatPathList(paths: string[]): string[] {
  if (paths.length === 0) {
    return ["- none"];
  }

  return paths.map((item) => `- ${item}`);
}

async function diff(ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.setStatus(ACTIVITY_STATUS_KEY, "🔄 diff");
  const { local, remote, state } = await syncInputs();

  setSyncFooter(ctx, local, remote, state);
  const output = await formatGitTextDiff(local, remote);

  ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);
  ctx.ui.notify(output, output === NO_DIFF_MESSAGE ? "info" : "warning");
}

async function doctor(ctx: ExtensionCommandContext): Promise<void> {
  const messages: string[] = [];
  let level: "info" | "warning" = "info";

  try {
    const config = await loadConfig();

    messages.push(
      `config: ok (${config.repository}#${config.branch}/repo-root)`,
    );
    const accessReport = await repositoryAccessReport(config.repository);

    messages.push(...accessReport);

    if (
      accessReport.some((line) => line.startsWith("repository access: failed"))
    ) {
      level = "warning";
    } else {
      const gitStore = new GitStore(config);

      await gitStore.prepare();
      messages.push(`git: ok (${await gitStore.currentCommit()})`);
    }
  } catch (error) {
    level = "warning";
    messages.push(`config/git: ${errorMessage(error)}`);
  }

  await appendLocalChecks(messages);
  ctx.ui.notify(messages.join("\n"), level);
}

async function history(ctx: ExtensionCommandContext): Promise<void> {
  const config = await loadConfig();

  const gitStore = new GitStore(config);

  await gitStore.prepare();
  const output = await gitStore.run([
    "log",
    "--oneline",
    "--decorate",
    "--max-count=20",
    "--",
    ...syncPathspecs(),
  ]);
  const historyText = output.trim();

  ctx.ui.notify(
    historyText.length > 0 ? historyText : "No pi-sync history found.",
    "info",
  );
}

async function unlock(
  ctx: ExtensionCommandContext,
  options: CommandOptions,
): Promise<void> {
  const lock = await readLock();

  if (lock == null) {
    ctx.ui.notify("No pi-sync lock is present.", "info");

    return;
  }

  if (!options.stale && !isStaleLock(lock)) {
    ctx.ui.notify(
      "Lock is not stale. Use /pisync unlock --stale only after verifying no sync is running.",
      "warning",
    );

    return;
  }

  await fs.rm(path.join(stateDir(), "lock"), { force: true });
  ctx.ui.notify("Removed stale pi-sync lock.", "info");
}

async function appendLocalChecks(messages: string[]): Promise<void> {
  const local = await createSnapshot();
  const secrets = scanSnapshot(local);
  const lock = await readLock();

  if (secrets.length > 0) {
    messages.push("secret scan: possible secrets found:");
    messages.push(...secrets.map((secret) => `- ${secret}`));
  } else {
    messages.push(`secret scan: ok (${local.files.length} files checked)`);
  }

  messages.push(
    lock != null
      ? `lock: held by pid ${lock.pid} since ${lock.startedAt}`
      : "lock: free",
  );
}
