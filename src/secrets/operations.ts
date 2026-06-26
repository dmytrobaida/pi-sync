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
  authJsonPath,
  secretsBackupDir,
} from "../utils/path-utils.js";
import {
  decryptWithIdentity,
  encryptForRecipient,
  ensureAgeCli,
  ensureIdentity,
  readRecipient,
} from "./age.js";
import {
  readAuthApiKeyProviders,
  readAuthProviderKey,
  writeAuthProviderKey,
} from "./auth-storage.js";
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
 * Coordinate encrypted-secret sync between local auth.json provider keys and
 * age-encrypted GitHub repository Variables.
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
        `Add a provider key with /pisync secrets add <PROVIDER> (e.g. zai, xai).`,
      ].join("\n"),
      "info",
    );
  }

  /**
   * Encrypt one local auth.json provider key and store it as a GitHub variable.
   *
   * @param provider Provider name (e.g. "zai", "xai").
   */
  async add(provider: string): Promise<void> {
    const { repo, recipient } = await this.prepareWrite();
    const value = readAuthProviderKey(provider);

    if (value === undefined) {
      throw new Error(
        `No api_key entry for provider "${provider}" in ~/.pi/agent/auth.json. Local providers: ${this.localProviderList()}.`,
      );
    }

    const ciphertext = await encryptForRecipient(recipient, value);
    const variable = this.variableName(provider);

    await setVariable(repo, variable, ciphertext);

    this.notify(
      `Encrypted and stored provider key ${provider} (${variable}).`,
      "info",
    );
  }

  /**
   * Remove a tracked provider secret variable.
   *
   * @param provider Provider name.
   */
  async remove(provider: string): Promise<void> {
    const { repo } = await this.prepareRead();
    const variable = this.variableName(provider);
    const removed = await deleteVariable(repo, variable);

    this.notify(
      removed
        ? `Removed secret variable ${variable}.`
        : `Secret variable ${variable} was not present.`,
      removed ? "info" : "warning",
    );
  }

  /**
   * Re-encrypt every tracked provider key from local auth.json and refresh it.
   */
  async push(): Promise<void> {
    const { repo, recipient } = await this.prepareWrite();
    const tracked = await this.trackedProviders(repo);

    if (tracked.length === 0) {
      this.notify(
        "No tracked secrets. Use /pisync secrets add <PROVIDER> first.",
        "warning",
      );

      return;
    }

    const confirmed = this.settings.yes
      ? true
      : await this.ctx.ui.confirm(
          `Push ${tracked.length} encrypted provider key(s)?`,
          tracked.map((name) => `- ${name}`).join("\n"),
        );

    if (!confirmed) {
      this.notify("Secret push cancelled.", "info");

      return;
    }

    const missing: string[] = [];

    for (const provider of tracked) {
      const value = readAuthProviderKey(provider);

      if (value === undefined) {
        missing.push(provider);

        continue;
      }

      const ciphertext = await encryptForRecipient(recipient, value);

      await setVariable(repo, this.variableName(provider), ciphertext);
    }

    const pushed = tracked.length - missing.length;

    this.notify(
      [
        `Pushed ${pushed} encrypted provider key(s).`,
        ...(missing.length > 0
          ? [`Skipped (not in local auth.json): ${missing.join(", ")}`]
          : []),
      ].join("\n"),
      missing.length > 0 ? "warning" : "info",
    );
  }

  /**
   * Decrypt every tracked provider key into local auth.json after a backup.
   */
  async pull(): Promise<void> {
    const { repo } = await this.prepareRead();
    const variables = (await listVariables(repo))
      .filter((entry) => entry.name.startsWith(SECRETS_VARIABLE_PREFIX))
      .map((entry) => entry.name);

    if (variables.length === 0) {
      this.notify(
        "No secret variables found. Use /pisync secrets add <PROVIDER> on a machine that has the keys.",
        "warning",
      );

      return;
    }

    const providers = variables.map((variable) =>
      variable.slice(SECRETS_VARIABLE_PREFIX.length),
    );

    const confirmed = this.settings.yes
      ? true
      : await this.ctx.ui.confirm(
          `Pull ${providers.length} encrypted provider key(s) into ~/.pi/agent/auth.json?`,
          `A backup of auth.json is created first.\n${providers.map((name) => `- ${name}`).join("\n")}`,
        );

    if (!confirmed) {
      this.notify("Secret pull cancelled.", "info");

      return;
    }

    const backup = await backupAuthJson();
    const failures: string[] = [];

    for (const variable of variables) {
      const ciphertext = await getVariable(repo, variable);

      if (ciphertext === undefined) {
        continue;
      }

      try {
        const plaintext = await decryptWithIdentity(ciphertext);

        writeAuthProviderKey(
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
        `Pulled ${providers.length - failures.length} provider key(s) into ~/.pi/agent/auth.json.`,
        `Backup: ${backup}`,
        ...(failures.length > 0
          ? [`Failed to decrypt: ${failures.join(", ")}`]
          : []),
      ].join("\n"),
      failures.length > 0 ? "warning" : "info",
    );
  }

  /**
   * Show tracked provider secrets, their remote/local presence, and which local
   * providers are available to add.
   */
  async list(): Promise<void> {
    const { repo } = await this.prepareRead();
    const variables = (await listVariables(repo))
      .filter((entry) => entry.name.startsWith(SECRETS_VARIABLE_PREFIX))
      .map((entry) => entry.name);
    const localProviders = readAuthApiKeyProviders();

    if (variables.length === 0 && localProviders.length === 0) {
      this.notify(
        "No encrypted secrets tracked and no local api_key providers in auth.json.",
        "info",
      );

      return;
    }

    const lines: string[] = [];

    if (variables.length > 0) {
      lines.push("Tracked encrypted secrets:");

      for (const variable of variables) {
        const name = variable.slice(SECRETS_VARIABLE_PREFIX.length);
        const local = readAuthProviderKey(name) !== undefined;

        lines.push(
          `- ${name} (remote: yes, local auth.json: ${local ? "yes" : "no"})`,
        );
      }
    } else {
      lines.push("Tracked encrypted secrets: none yet.");
    }

    const tracked = new Set(
      variables.map((variable) =>
        variable.slice(SECRETS_VARIABLE_PREFIX.length),
      ),
    );
    const untracked = localProviders.filter((name) => !tracked.has(name));

    if (untracked.length > 0) {
      lines.push("");
      lines.push(
        "Local providers you can add (auth.json, not yet tracked remote):",
      );
      lines.push(...untracked.map((name) => `- ${name}`));
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

    const localProviders = readAuthApiKeyProviders();

    messages.push(
      `local auth.json api_key providers: ${localProviders.length > 0 ? localProviders.join(", ") : "none"}`,
    );

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

  private async trackedProviders(repo: string): Promise<string[]> {
    const variables = await listVariables(repo);

    return variables
      .filter((entry) => entry.name.startsWith(SECRETS_VARIABLE_PREFIX))
      .map((entry) => entry.name.slice(SECRETS_VARIABLE_PREFIX.length));
  }

  private variableName(provider: string): string {
    return `${SECRETS_VARIABLE_PREFIX}${provider}`;
  }

  private localProviderList(): string {
    const providers = readAuthApiKeyProviders();

    return providers.length > 0 ? providers.join(", ") : "(none)";
  }

  private notify(message: string, level: "info" | "warning" | "error"): void {
    if (this.settings.silent) {
      return;
    }

    this.ctx.ui.notify(message, level);
  }
}

/**
 * Copy auth.json into the pi-sync secrets backup directory before a pull.
 *
 * @returns The backup file path.
 */
export async function backupAuthJson(): Promise<string> {
  const source = authJsonPath();
  const dir = secretsBackupDir();

  await fs.mkdir(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const digest = createHash("sha256")
    .update(`${stamp}-${source}`)
    .digest("hex")
    .slice(0, 8);
  const backup = path.join(dir, `${stamp}-${digest}.auth.json`);

  try {
    await fs.copyFile(source, backup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    await fs.writeFile(backup, "{}\n");
  }

  try {
    await fs.chmod(backup, 0o600);
  } catch {
    // Permissions are best-effort.
  }

  return backup;
}
