import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { ACTIVITY_STATUS_KEY } from "../domain/constants.js";
import type { CommandOptions } from "../domain/types.js";
import { SecretsOperations } from "../secrets/operations.js";
import { withLock } from "../state/lock.js";
import { errorMessage } from "../utils/json-utils.js";

const SECRETS_ACTIVITY = "🔐 secrets";

/**
 * Parse and execute a /pisync secrets subcommand.
 *
 * @param options Parsed command options (args[0] is the secrets action).
 * @param ctx Pi command context used for UI and session operations.
 */
export async function handleSecretsCommand(
  options: CommandOptions,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const [action = "list", ...rest] = options.args;
  const opsOptions = {
    yes: options.yes,
    verbose: options.verbose,
    silent: options.silent,
  };

  try {
    await runSecretsAction(action, rest, opsOptions, ctx);
  } catch (error) {
    ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);
    ctx.ui.notify(errorMessage(error), "error");
  }
}

async function runSecretsAction(
  action: string,
  positional: string[],
  options: { yes: boolean; verbose: boolean; silent: boolean },
  ctx: ExtensionCommandContext,
): Promise<void> {
  const ops = (): SecretsOperations => new SecretsOperations(ctx, options);

  switch (action) {
    case "help":
      ctx.ui.notify(secretsUsage(), "info");

      return;
    case "init":
      ctx.ui.setStatus(ACTIVITY_STATUS_KEY, SECRETS_ACTIVITY);
      await ops().init();
      ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);

      return;
    case "doctor":
      await ops().doctor();

      return;
    case "list":
      await ops().list();

      return;

    case "add":
      await runNameAction(ops, positional, "add", ctx);

      return;

    case "remove":
      await runNameAction(ops, positional, "remove", ctx);

      return;

    case "push":
      await withLock("secrets-push", async () => {
        await ops().push();
      });

      return;
    case "pull":
      await withLock("secrets-pull", async () => {
        await ops().pull();
      });

      return;
    default:
      ctx.ui.notify(
        `Unknown /pisync secrets command: ${action}\n\n${secretsUsage()}`,
        "warning",
      );
  }
}

async function runNameAction(
  ops: () => SecretsOperations,
  positional: string[],
  kind: "add" | "remove",
  ctx: ExtensionCommandContext,
): Promise<void> {
  const name = positional[0];

  if (name === "") {
    ctx.ui.notify(
      `Usage: /pisync secrets ${kind} <NAME>\n<NAME> is an env key present in ~/.pi/agent/.env.`,
      "warning",
    );

    return;
  }

  await withLock(`secrets-${kind}`, async () => {
    if (kind === "add") {
      await ops().add(name);
    } else {
      await ops().remove(name);
    }
  });
}

/**
 * Return help text for the /pisync secrets command group.
 */
export function secretsUsage(): string {
  return [
    "Usage: /pisync secrets <command>",
    "Commands: init, add <NAME>, remove <NAME>, push, pull, list, doctor",
    "Values are read from and written to ~/.pi/agent/.env.",
    "Encrypted with age and stored as GitHub repository variables (PISYNC_SECRET_*).",
  ].join("\n");
}
