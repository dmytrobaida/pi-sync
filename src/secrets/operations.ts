import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { loadConfig } from "../config/config.js";
import {
  AGE_RECIPIENT_VARIABLE,
  SECRETS_VARIABLE_PREFIX,
} from "../domain/constants.js";
import type { SyncConfig } from "../domain/types.js";
import {
  ageIdentityPath,
  agentEnvPath,
  secretsBackupDir,
} from "../utils/path-utils.js";
import {
  decryptWithIdentity,
  encryptForRecipient,
  ensureAgeCli,
  ensureIdentity,
  readRecipient,
} from "./age.js";
import { readDotenvKey, writeDotenvKey } from "./dotenv.js";
import {
  deleteVariable,
  getVariable,
  listVariables,
  requireGithubRepo,
  setVariable,
} from "./github.js";

type SecretsSettings = {
  yes: boolean;
  verbose: boolean;
  silent: boolean;
};

/**
 * Coordinate encrypted-secret sync between the local .env and GitHub Variables.
 */
export class SecretsOperations {
  /**
   * Create a secrets operation runner.
   *
   * @param ctx Pi context used for UI.
   * @param settings Runtime behavior toggles.
   */
  constructor(
    private readonly ctx: ExtensionCommandContext | ExtensionContext,
    private readonly settings: SecretsSettings = {
      yes: false,
      verbose: false,
      silent: false,
    },
  ) {}

  /**
   * Generate or load the local age identity and publish its recipient.
   */
  async init(): Promise<void> {
    await ensureAgeCli();
    const config = await loadConfig();
    const repo = requireGithubRepo(config.repository);
    const identityPath = ageIdentityPath();
    const recipient = await ensureIdentity(identityPath);

    await setVariable(repo, AGE_RECIPIENT_VARIABLE, recipient);

    this.notify(
      [
        "Encrypted secrets are ready.",
        `age recipient: ${recipient}`,
        `local identity: ${identityPath} (private — install the same file on every machine, never sync it)`,
        `recipient stored in GitHub variable: ${AGE_RECIPIENT_VARIABLE}`,
        "Add a secret with /pisync secrets add <NAME>.",
      ].join("\n"),
      "info",
    );
  }

  /**
   * Encrypt one local .env key and store it as a GitHub variable.
   *
   * @param name Secret name (env key).
   */
  async add(name: string): Promise<void> {
    const { repo, recipient } = await this.prepareWrite();
    const value = await readDotenvKey(name);

    if (value === undefined) {
      throw new Error(
        `No local value found for ${name} in ~/.pi/agent/.env. Set it there first.`,
      );
    }

    const ciphertext = await encryptForRecipient(recipient, value);
    const variable = this.variableName(name);

    await setVariable(repo, variable, ciphertext);

    this.notify(`Encrypted and stored secret ${name} (${variable}).`, "info");
  }

  /**
   * Remove a tracked secret variable.
   *
   * @param name Secret name (env key).
   */
  async remove(name: string): Promise<void> {
    const { repo } = await this.prepareRead();
    const variable = this.variableName(name);
    const removed = await deleteVariable(repo, variable);

    this.notify(
      removed
        ? `Removed secret variable ${variable}.`
        : `Secret variable ${variable} was not present.`,
      removed ? "info" : "warning",
    );
  }

  /**
   * Re-encrypt every tracked secret from local .env and update the variables.
   */
  async push(): Promise<void> {
    const { repo, recipient } = await this.prepareWrite();
    const tracked = await this.trackedNames(repo);

    if (tracked.length === 0) {
      this.notify(
        "No tracked secrets. Use /pisync secrets add <NAME> first.",
        "warning",
      );

      return;
    }

    const confirmed = this.settings.yes
      ? true
      : await this.ctx.ui.confirm(
          `Push ${tracked.length} encrypted secret(s)?`,
          tracked.map((name) => `- ${name}`).join("\n"),
        );

    if (!confirmed) {
      this.notify("Secret push cancelled.", "info");

      return;
    }

    const missing: string[] = [];

    for (const name of tracked) {
      const value = await readDotenvKey(name);

      if (value === undefined) {
        missing.push(name);

        continue;
      }

      const ciphertext = await encryptForRecipient(recipient, value);

      await setVariable(repo, this.variableName(name), ciphertext);
    }

    const pushed = tracked.length - missing.length;

    this.notify(
      [
        `Pushed ${pushed} encrypted secret(s).`,
        ...(missing.length > 0
          ? [`Skipped (not in local .env): ${missing.join(", ")}`]
          : []),
      ].join("\n"),
      missing.length > 0 ? "warning" : "info",
    );
  }

  /**
   * Decrypt every tracked secret into the local .env file after a backup.
   */
  async pull(): Promise<void> {
    const { repo } = await this.prepareRead();
    const variables = (await listVariables(repo))
      .filter((entry) => entry.name.startsWith(SECRETS_VARIABLE_PREFIX))
      .map((entry) => entry.name);

    if (variables.length === 0) {
      this.notify(
        "No secret variables found. Use /pisync secrets add <NAME> on a machine that has the values.",
        "warning",
      );

      return;
    }

    const names = variables.map((variable) =>
      variable.slice(SECRETS_VARIABLE_PREFIX.length),
    );

    const confirmed = this.settings.yes
      ? true
      : await this.ctx.ui.confirm(
          `Pull ${names.length} encrypted secret(s) into ~/.pi/agent/.env?`,
          `A backup of the current .env is created first.\n${names.map((name) => `- ${name}`).join("\n")}`,
        );

    if (!confirmed) {
      this.notify("Secret pull cancelled.", "info");

      return;
    }

    const backup = await backupDotenv();
    const failures: string[] = [];

    for (const variable of variables) {
      const ciphertext = await getVariable(repo, variable);

      if (ciphertext === undefined) {
        continue;
      }

      try {
        const plaintext = await decryptWithIdentity(ciphertext);

        await writeDotenvKey(
          variable.slice(SECRETS_VARIABLE_PREFIX.length),
          plaintext,
        );
      } catch (error) {
        failures.push(
          `${variable.slice(SECRETS_VARIABLE_PREFIX.length)}: ${(error as Error).message}`,
        );
      }
    }

    this.notify(
      [
        `Pulled ${names.length - failures.length} secret(s) into ~/.pi/agent/.env.`,
        `Backup: ${backup}`,
        ...(failures.length > 0
          ? [`Failed to decrypt: ${failures.join(", ")}`]
          : []),
      ].join("\n"),
      failures.length > 0 ? "warning" : "info",
    );
  }

  /**
   * Show tracked secret names and their local/remote presence.
   */
  async list(): Promise<void> {
    const { repo } = await this.prepareRead();
    const variables = (await listVariables(repo))
      .filter((entry) => entry.name.startsWith(SECRETS_VARIABLE_PREFIX))
      .map((entry) => entry.name);

    if (variables.length === 0) {
      this.notify("No encrypted secrets are tracked yet.", "info");

      return;
    }

    const lines: string[] = ["Tracked encrypted secrets:"];

    for (const variable of variables) {
      const name = variable.slice(SECRETS_VARIABLE_PREFIX.length);
      const local = (await readDotenvKey(name)) !== undefined;

      lines.push(
        `- ${name} (remote: yes, local .env: ${local ? "yes" : "no"})`,
      );
    }

    this.notify(lines.join("\n"), "info");
  }

  /**
   * Run diagnostics for the encrypted-secrets subsystem.
   */
  async doctor(): Promise<void> {
    const messages: string[] = [];
    let level: "info" | "warning" = "info";

    try {
      await ensureAgeCli();
      messages.push("age: ok");
    } catch (error) {
      level = "warning";
      messages.push(`age: ${(error as Error).message}`);
    }

    try {
      const config = await loadConfig();
      const repo = requireGithubRepo(config.repository);

      messages.push(`github repo: ${repo}`);

      const recipient = await getVariable(repo, AGE_RECIPIENT_VARIABLE);

      if (recipient === undefined) {
        level = "warning";
        messages.push(
          `age recipient: missing (${AGE_RECIPIENT_VARIABLE}). Run /pisync secrets init.`,
        );
      } else {
        messages.push(`age recipient: published (${AGE_RECIPIENT_VARIABLE})`);
      }

      const tracked = (await listVariables(repo)).filter((entry) =>
        entry.name.startsWith(SECRETS_VARIABLE_PREFIX),
      ).length;

      messages.push(`tracked secrets: ${tracked}`);
    } catch (error) {
      level = "warning";
      messages.push(`config/github: ${(error as Error).message}`);
    }

    try {
      await readRecipient();
      messages.push(`age identity: present (${ageIdentityPath()})`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        level = "warning";
        messages.push(
          `age identity: missing. Run /pisync secrets init on a machine that already has it, or copy the shared identity to ${ageIdentityPath()}.`,
        );
      } else {
        level = "warning";
        messages.push(`age identity: ${(error as Error).message}`);
      }
    }

    this.ctx.ui.notify(messages.join("\n"), level);
  }

  private async prepareWrite(): Promise<{
    repo: string;
    recipient: string;
  }> {
    await ensureAgeCli();
    const config = await loadConfig();
    const repo = requireGithubRepo(config.repository);
    const remoteRecipient = await getVariable(repo, AGE_RECIPIENT_VARIABLE);

    let recipient: string;

    if (remoteRecipient === undefined) {
      recipient = await ensureIdentity();
      await setVariable(repo, AGE_RECIPIENT_VARIABLE, recipient);
    } else {
      recipient = remoteRecipient;
    }

    return { repo, recipient };
  }

  private async prepareRead(): Promise<{ repo: string; config: SyncConfig }> {
    const config = await loadConfig();

    return { repo: requireGithubRepo(config.repository), config };
  }

  private async trackedNames(repo: string): Promise<string[]> {
    const variables = await listVariables(repo);

    return variables
      .filter((entry) => entry.name.startsWith(SECRETS_VARIABLE_PREFIX))
      .map((entry) => entry.name.slice(SECRETS_VARIABLE_PREFIX.length));
  }

  private variableName(name: string): string {
    return `${SECRETS_VARIABLE_PREFIX}${name}`;
  }

  private notify(message: string, level: "info" | "warning" | "error"): void {
    if (this.settings.silent) {
      return;
    }

    this.ctx.ui.notify(message, level);
  }
}

async function backupDotenv(): Promise<string> {
  const source = agentEnvPath();
  const dir = secretsBackupDir();

  await fs.mkdir(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const digest = createHash("sha256")
    .update(`${stamp}-${source}`)
    .digest("hex")
    .slice(0, 8);
  const backup = path.join(dir, `${stamp}-${digest}.env`);

  try {
    await fs.copyFile(source, backup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    await fs.writeFile(backup, "");
  }

  return backup;
}
