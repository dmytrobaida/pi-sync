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
import {
  ageIdentityPath,
  authJsonPath,
  secretsBackupDir,
} from "../utils/path-utils.js";
import {
  decryptWithIdentity,
  encryptForRecipient,
  ensureAgeCli,
  readRecipient,
} from "./age.js";
import {
  readAuthApiKeyProviders,
  readAuthProviderKey,
  writeAuthProviderKey,
} from "./auth-storage.js";
import {
  getVariable,
  listVariables,
  requireGithubRepo,
  setVariable,
} from "./github.js";
import {
  getCachedKey,
  getOrPromptKey,
  recipientMatchesPublished,
  type ResolvedKey,
  setupKeyFromPassphrase,
} from "./key-manager.js";

type SecretsSettings = {
  yes: boolean;
  silent: boolean;
};

/**
 * Coordinate encrypted-secret sync between local auth.json provider keys and
 * age-encrypted GitHub repository Variables, driven by a single toggle.
 *
 * When the `secrets` config toggle is on, {@link pushAll} and {@link pullAll}
 * run automatically as part of the normal `/pisync push` and `/pisync pull`.
 * The decryption key is derived once from a passphrase and cached locally, so
 * day-to-day sync is silent.
 */
export class SecretsOperations {
  /**
   * Create a secrets operation runner.
   *
   * @param ctx Pi context used for UI and the one-time passphrase prompt.
   * @param settings Runtime behavior toggles.
   */
  constructor(
    private readonly ctx: ExtensionCommandContext | ExtensionContext,
    private readonly settings: SecretsSettings = { yes: false, silent: false },
  ) {}

  /**
   * Enter the passphrase once, derive and cache the local key, publish the
   * recipient. Called from `/pisync init` (when the toggle is on) and from
   * `/pisync secrets setup`.
   *
   * @param passphrase Pre-collected passphrase. When omitted the caller has
   *   already arranged prompting.
   */
  async setup(passphrase: string): Promise<void> {
    await ensureAgeCli();
    requireGithubRepo((await loadConfig()).repository);
    const { recipient } = await setupKeyFromPassphrase(passphrase);

    this.notify(
      [
        "Encrypted secrets are ready.",
        `age recipient: ${recipient}`,
        `local identity: ${ageIdentityPath()} (passphrase-derived; never synced)`,
        `recipient stored in GitHub variable: ${AGE_RECIPIENT_VARIABLE}`,
        "Secrets will now ride along with /pisync push and /pisync pull.",
      ].join("\n"),
      "info",
    );
  }

  /**
   * Encrypt every local auth.json api_key provider and store it as a GitHub
   * variable. Used by `/pisync push` when the toggle is on.
   */
  async pushAll(): Promise<void> {
    const { repo, recipient } = await this.prepareWrite();
    const providers = readAuthApiKeyProviders();

    if (providers.length === 0) {
      this.notify("No api_key providers in auth.json to sync.", "info");

      return;
    }

    let pushed = 0;

    for (const provider of providers) {
      const value = readAuthProviderKey(provider);

      if (value === undefined) {
        continue;
      }

      const ciphertext = await encryptForRecipient(recipient, value);

      await setVariable(repo, this.variableName(provider), ciphertext);
      pushed += 1;
    }

    this.notify(`Synced ${pushed} encrypted provider key(s).`, "info");
  }

  /**
   * Decrypt every tracked provider key into auth.json after a backup.
   * Used by `/pisync pull` when the toggle is on.
   *
   * @param key Pre-resolved key. When omitted the interactive prompt is used.
   */
  async pullAll(key?: ResolvedKey): Promise<void> {
    const { repo } = await this.prepareRead();
    const resolved = key ?? (await this.resolveKey());
    const variables = (await listVariables(repo))
      .filter((entry) => entry.name.startsWith(SECRETS_VARIABLE_PREFIX))
      .map((entry) => entry.name);

    if (variables.length === 0) {
      this.notify("No secret variables to pull yet.", "info");

      return;
    }

    const backup = await backupAuthJson();
    let pulled = 0;
    const failures: string[] = [];

    for (const variable of variables) {
      const ciphertext = await getVariable(repo, variable);

      if (ciphertext === undefined) {
        continue;
      }

      try {
        const plaintext = await decryptWithIdentity(
          ciphertext,
          resolved.identityPath,
        );

        writeAuthProviderKey(this.providerFromVariable(variable), plaintext);
        pulled += 1;
      } catch (error) {
        failures.push(
          `${this.providerFromVariable(variable)}: ${(error as Error).message}`,
        );
      }
    }

    this.notify(
      [
        `Pulled ${pulled} provider key(s) into auth.json.`,
        `Backup: ${backup}`,
        ...(failures.length > 0
          ? [`Failed to decrypt: ${failures.join(", ")}`]
          : []),
      ].join("\n"),
      failures.length > 0 ? "warning" : "info",
    );
  }

  /**
   * Decrypt secrets using only a cached key, skipping silently when no key is
   * cached. Used by background auto-sync so it never blocks on a prompt.
   */
  async pullAllIfCached(): Promise<void> {
    const cached = await getCachedKey();

    if (cached === undefined) {
      return;
    }

    await this.pullAll(cached);
  }

  /**
   * Show tracked providers, local/remote presence, and addable local keys.
   */
  async list(): Promise<void> {
    const { repo } = await this.prepareRead();
    const variables = (await listVariables(repo))
      .filter((entry) => entry.name.startsWith(SECRETS_VARIABLE_PREFIX))
      .map((entry) => entry.name);
    const localProviders = readAuthApiKeyProviders();

    const lines: string[] = [];

    if (variables.length > 0) {
      lines.push("Tracked encrypted secrets:");

      for (const variable of variables) {
        const name = this.providerFromVariable(variable);
        const local = readAuthProviderKey(name) !== undefined;

        lines.push(
          `- ${name} (remote: yes, local auth.json: ${local ? "yes" : "no"})`,
        );
      }
    } else {
      lines.push("Tracked encrypted secrets: none yet.");
    }

    const tracked = new Set(
      variables.map((variable) => this.providerFromVariable(variable)),
    );
    const untracked = localProviders.filter((name) => !tracked.has(name));

    if (untracked.length > 0) {
      lines.push("");
      lines.push("Local providers that will sync on next /pisync push:");
      lines.push(...untracked.map((name) => `- ${name}`));
    }

    this.notify(
      lines.length > 0 ? lines.join("\n") : "No secrets configured.",
      "info",
    );
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
          `age recipient: missing (${AGE_RECIPIENT_VARIABLE}). Run /pisync secrets setup.`,
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
      messages.push(`age identity: cached (${ageIdentityPath()})`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        messages.push(
          `age identity: not cached. Run /pisync secrets setup (or /pisync init) to enter your passphrase.`,
        );
      } else {
        level = "warning";
        messages.push(`age identity: ${(error as Error).message}`);
      }
    }

    const match = await recipientMatchesPublished();

    if (match === false) {
      level = "warning";
      messages.push(
        "recipient mismatch: this machine's passphrase differs from the one published to GitHub. Re-run /pisync secrets setup with the correct passphrase.",
      );
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
    const key = await this.resolveKey();

    return { repo, recipient: key.recipient };
  }

  private async prepareRead(): Promise<{ repo: string }> {
    const config = await loadConfig();

    return { repo: requireGithubRepo(config.repository) };
  }

  private async resolveKey(): Promise<ResolvedKey> {
    return getOrPromptKey(this.ctx);
  }

  private variableName(provider: string): string {
    // GitHub repository variables are forced to UPPERCASE; provider names are
    // restored to lowercase on pull (all Pi provider names are lowercase).
    return `${SECRETS_VARIABLE_PREFIX}${provider.toUpperCase()}`;
  }

  private providerFromVariable(variable: string): string {
    return variable.slice(SECRETS_VARIABLE_PREFIX.length).toLowerCase();
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
