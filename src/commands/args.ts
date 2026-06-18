import type { CommandOptions } from "../domain/types.js";

/**
 * Split a command argument string while preserving quoted segments.
 *
 * @param input Raw command argument string.
 */
export function splitArgs(input: string): string[] {
  return (
    input
      .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
      ?.map((arg) => arg.replace(/^["']|["']$/g, "")) ?? []
  );
}

/**
 * Parse command flags and positional arguments.
 *
 * @param args Tokenized command arguments.
 */
export function parseOptions(args: string[]): CommandOptions {
  return {
    yes: args.includes("--yes") || args.includes("-y"),
    force: args.includes("--force"),
    stale: args.includes("--stale"),
    silent: false,
    verbose: args.includes("--verbose") || args.includes("-v"),
    reload: true,
    args: args.filter((arg) => !arg.startsWith("-")),
  };
}

/**
 * Return help text for the /pisync command.
 */
export function usage(): string {
  return [
    "Usage: /pisync <command>",
    "Commands: init, config, status [--verbose], diff, doctor, push, pull, sync, history, checkout <commit-ish>, unlock --stale",
    "Config: set PI_SYNC_REPOSITORY plus optional PI_SYNC_BRANCH/profile, or edit ~/.pi/agent/pi-sync.local.json.",
  ].join("\n");
}

/**
 * Interpret boolean-like configuration values.
 *
 * @param value Optional boolean or string value.
 * @param defaultValue Value to use when the setting is missing.
 */
export function isEnabled(
  value: boolean | string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}
