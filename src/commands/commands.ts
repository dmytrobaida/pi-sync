import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isEnabled, parseOptions, splitArgs, usage } from "./args.js";
import { loadConfig, loadPartialConfig } from "../config/config.js";
import { DEFAULT_BRANCH, DEFAULT_PROFILE, NO_DIFF_MESSAGE, STATUS_KEY } from "../domain/constants.js";
import { formatGitTextDiff } from "../snapshot/diff.js";
import { GitStore, syncPathspecs } from "../git/store.js";
import { errorMessage, writeJson } from "../utils/json-utils.js";
import { ensureStateDir, isStaleLock, readLock, withLock } from "../state/lock.js";
import { localConfigPath, repoDir, stateDir } from "../utils/path-utils.js";
import { createSnapshot, scanSnapshot } from "../snapshot/snapshot.js";
import { remoteChangedSinceState, hasLocalChanges } from "../state/state.js";
import { SyncOperations } from "./operations.js";
import { syncInputs } from "./context.js";
import type { CommandOptions } from "../domain/types.js";

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
    ctx.ui.setStatus(STATUS_KEY, undefined);
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
      await status(ctx);

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
    case "rollback":
      await withLock("rollback", async () => {
        await new SyncOperations(ctx, options).rollback();
      });

      return;
    case "unlock":
      await unlock(ctx, options);

      return;
    default:
      ctx.ui.notify(`Unknown /pisync command: ${subcommand}\n\n${usage()}`, "warning");
  }
}

async function initConfig(ctx: ExtensionCommandContext): Promise<void> {
  const configPath = localConfigPath();

  try {
    await fs.access(configPath, fsConstants.F_OK);
    ctx.ui.notify(`Config already exists: ${configPath}`, "info");

    return;
  } catch {
    // Create below.
  }

  await writeJson(configPath, {
    repository: "git@github.com:<user>/<repo>.git",
    branch: DEFAULT_BRANCH,
    profile: DEFAULT_PROFILE,
    autoSync: true,
  });
  ctx.ui.notify(`Created ${configPath}. Fill in the Git repository, then run /pisync doctor.`, "info");
}

async function showConfig(ctx: ExtensionCommandContext): Promise<void> {
  const partial = await loadPartialConfig();

  ctx.ui.notify(
    [
      "pi-sync config:",
      `repository: ${partial.repository ?? "missing"}`,
      `branch: ${partial.branch ?? DEFAULT_BRANCH}`,
      `profile: ${partial.profile ?? DEFAULT_PROFILE}`,
      `autoSync: ${isEnabled(partial.autoSync ?? process.env.PI_SYNC_AUTO_SYNC, true) ? "enabled" : "disabled"}`,
      `local config: ${localConfigPath()}`,
      `local clone: ${repoDir(partial.profile ?? DEFAULT_PROFILE)}`,
    ].join("\n"),
    "info",
  );
}

async function status(ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.setStatus(STATUS_KEY, "🔄 checking");
  const { config, local, remote, state } = await syncInputs();
  const localChanged = hasLocalChanges(local, state);
  const remoteChanged = remoteChangedSinceState(remote, state);
  const remoteCommit = await new GitStore(config).currentCommit();

  ctx.ui.setStatus(STATUS_KEY, undefined);
  ctx.ui.notify(
    [
      `profile: ${config.profile}`,
      remote != null ? `remote: ${remote.id} at ${remoteCommit}` : "remote: empty",
      `local files: ${local.files.length}`,
      `local changed since last sync: ${localChanged ? "yes" : "no"}`,
      `remote changed since last sync: ${remoteChanged ? "yes" : "no"}`,
    ].join("\n"),
    localChanged || remoteChanged ? "warning" : "info",
  );
}

async function diff(ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.setStatus(STATUS_KEY, "🔄 diff");
  const { local, remote } = await syncInputs();
  const output = await formatGitTextDiff(local, remote);

  ctx.ui.setStatus(STATUS_KEY, undefined);
  ctx.ui.notify(output, output === NO_DIFF_MESSAGE ? "info" : "warning");
}

async function doctor(ctx: ExtensionCommandContext): Promise<void> {
  const messages: string[] = [];
  let level: "info" | "warning" = "info";

  try {
    const config = await loadConfig();

    messages.push(`config: ok (${config.repository}#${config.branch}/repo-root)`);
    const gitStore = new GitStore(config);

    await gitStore.prepare();
    messages.push(`git: ok (${await gitStore.currentCommit()})`);
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

  ctx.ui.notify(historyText.length > 0 ? historyText : "No pi-sync history found.", "info");
}

async function unlock(ctx: ExtensionCommandContext, options: CommandOptions): Promise<void> {
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
  const local = await createSnapshot(DEFAULT_PROFILE);
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
