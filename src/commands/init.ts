import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { DEFAULT_BRANCH } from "../domain/constants.js";
import type { PartialConfig } from "../domain/types.js";
import { writeJson } from "../utils/json-utils.js";
import { localConfigPath } from "../utils/path-utils.js";
import {
  githubCliStatus,
  isGithubHttpsRepository,
  setupGithubGitAuth,
} from "./auth.js";

const DEFAULT_REPOSITORY = "https://github.com/<user>/<repo>.git";

/**
 * Create the local pi-sync configuration file through an interactive setup flow.
 *
 * @param ctx Pi command context used for prompts and notifications.
 */
export async function initConfig(ctx: ExtensionCommandContext): Promise<void> {
  const configPath = localConfigPath();
  const configExists = await fileExists(configPath);

  if (configExists) {
    const overwrite = await ctx.ui.confirm(
      "pi-sync config already exists",
      `Overwrite ${configPath}?`,
    );

    if (!overwrite) {
      ctx.ui.notify(`Config already exists: ${configPath}`, "info");

      return;
    }
  }

  const config = await promptConfig(ctx);

  await writeJson(configPath, config);
  await maybeSetupGithubAuth(ctx, config.repository);
  ctx.ui.notify(
    `Created ${configPath}. Run /pisync doctor to verify repository access.`,
    "info",
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.F_OK);

    return true;
  } catch {
    return false;
  }
}

async function promptConfig(
  ctx: ExtensionCommandContext,
): Promise<PartialConfig & { repository: string }> {
  const repository = await promptRequired(
    ctx,
    "Git repository URL",
    DEFAULT_REPOSITORY,
  );
  const branch = await promptOptional(ctx, "Git branch", DEFAULT_BRANCH);
  const autoSync = await ctx.ui.confirm(
    "Enable auto-sync?",
    "Auto-sync pulls safe remote changes on session start but never pushes local changes automatically.",
  );

  return {
    repository,
    branch: branch === "" ? DEFAULT_BRANCH : branch,
    autoSync,
  };
}

async function promptRequired(
  ctx: ExtensionCommandContext,
  title: string,
  placeholder: string,
): Promise<string> {
  const value = await ctx.ui.input(title, placeholder);
  const trimmed = value?.trim() ?? "";

  if (trimmed === "") {
    throw new Error(`${title} is required.`);
  }

  return trimmed;
}

async function promptOptional(
  ctx: ExtensionCommandContext,
  title: string,
  placeholder: string,
): Promise<string> {
  return (await ctx.ui.input(title, placeholder))?.trim() ?? "";
}

async function maybeSetupGithubAuth(
  ctx: ExtensionCommandContext,
  repository: string,
): Promise<void> {
  if (!isGithubHttpsRepository(repository)) {
    return;
  }

  const status = await githubCliStatus();

  if (!status.ok) {
    ctx.ui.notify(
      "GitHub HTTPS repo configured. To reuse GitHub CLI credentials, run `gh auth login`, then `gh auth setup-git`.",
      "warning",
    );

    return;
  }

  const setup = await ctx.ui.confirm(
    "Use existing GitHub CLI login for Git HTTPS auth?",
    "This runs `gh auth setup-git` and may update your global Git credential configuration.",
  );

  if (!setup) {
    return;
  }

  const result = await setupGithubGitAuth();

  ctx.ui.notify(
    result.ok
      ? "GitHub CLI Git credential setup completed."
      : `GitHub CLI Git credential setup failed: ${result.output}`,
    result.ok ? "info" : "warning",
  );
}
