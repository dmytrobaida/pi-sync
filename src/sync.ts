import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { isEnabled } from "./commands/args.js";
import { handleCommand } from "./commands/commands.js";
import { completePisyncArguments } from "./commands/completions.js";
import { SyncOperations } from "./commands/operations.js";
import {
  isMissingConfigError,
  loadConfig,
  loadPartialConfig,
} from "./config/config.js";
import { AUTO_SYNC_OPTIONS, STATUS_KEY } from "./domain/constants.js";
import { ensureStateDir, withLock } from "./state/lock.js";
import { errorMessage } from "./utils/json-utils.js";

export { isEnabled, parseOptions, splitArgs } from "./commands/args.js";
export { preflightSnapshotApply } from "./snapshot/apply.js";
export { isDeniedPath, scanSnapshot } from "./snapshot/snapshot.js";
export { posixJoin, safeJoin, safeName } from "./utils/path-utils.js";

/**
 * Register the Git-backed Pi settings sync extension.
 *
 * @param pi Pi extension API used to register commands and lifecycle hooks.
 */
export default function sync(pi: ExtensionAPI): void {
  pi.registerCommand("pisync", {
    description: "Sync Pi settings through a Git repository",
    getArgumentCompletions: completePisyncArguments,
    handler: async (args, ctx) => {
      await handleCommand(args, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    await autoSync(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

async function autoSync(ctx: ExtensionContext): Promise<void> {
  try {
    const partial = await loadPartialConfig();

    if (!isEnabled(partial.autoSync ?? process.env.PI_SYNC_AUTO_SYNC, true)) {
      return;
    }

    await ensureStateDir();
    await loadConfig();
    await withLock("auto-sync", async () => {
      await new SyncOperations(ctx, AUTO_SYNC_OPTIONS).autoSync();
    });
  } catch (error) {
    if (isMissingConfigError(error)) {
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.notify(
      `pi-sync auto sync skipped: ${errorMessage(error)}`,
      "warning",
    );
  }
}
