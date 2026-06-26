import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { loadConfig } from "../config/config.js";
import { AGE_RECIPIENT_VARIABLE } from "../domain/constants.js";
import { ageIdentityPath } from "../utils/path-utils.js";
import { readRecipient } from "./age.js";
import { getVariable, requireGithubRepo, setVariable } from "./github.js";
import { deriveIdentityFile } from "./key-derive.js";

export type ResolvedKey = {
  identityPath: string;
  recipient: string;
};

/**
 * Error raised when a key is needed but none is cached and prompting is not
 * allowed (e.g. background auto-sync). Callers catch this to skip gracefully.
 */
export class NoCachedKeyError extends Error {
  /**
   *
   */
  constructor() {
    super(
      "No cached secrets key. Run /pisync secrets setup to enter your passphrase.",
    );
    this.name = "NoCachedKeyError";
  }
}

/**
 * Return the local secrets key, deriving it from a prompted passphrase when no
 * cached identity exists yet. Used by interactive push/pull/init.
 *
 * @param ctx Pi context used for the passphrase prompt.
 */
export async function getOrPromptKey(
  ctx: ExtensionCommandContext | ExtensionContext,
): Promise<ResolvedKey> {
  const cached = await getCachedKey();

  if (cached !== undefined) {
    return cached;
  }

  const passphrase = await ctx.ui.input(
    "Secrets passphrase",
    "Enter the passphrase used on your other machine, or pick a new one for your first machine.",
  );

  if (passphrase === undefined || passphrase === "") {
    throw new Error("A passphrase is required to enable secrets sync.");
  }

  const identityPath = ageIdentityPath();
  const recipient = await deriveIdentityFile(passphrase, identityPath);

  await ensureRecipientPublished(recipient);

  return { identityPath, recipient };
}

/**
 * Return the local secrets key only when one is already cached, without
 * prompting. Used by background auto-sync so it never blocks on input.
 */
export async function getCachedKey(): Promise<ResolvedKey | undefined> {
  const identityPath = ageIdentityPath();

  try {
    const recipient = await readRecipient(identityPath);

    return { identityPath, recipient };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

/**
 * Set up the key from a passphrase without prompting (used by /pisync init and
 * /pisync secrets setup, which already collected the passphrase).
 *
 * @param passphrase User passphrase.
 */
export async function setupKeyFromPassphrase(
  passphrase: string,
): Promise<ResolvedKey> {
  const identityPath = ageIdentityPath();
  const recipient = await deriveIdentityFile(passphrase, identityPath);

  await ensureRecipientPublished(recipient);

  return { identityPath, recipient };
}

/**
 * Publish the age recipient to the GitHub variable if it is missing, so every
 * machine encrypts to the same key.
 *
 * @param recipient age1... public key.
 */
export async function ensureRecipientPublished(
  recipient: string,
): Promise<void> {
  const config = await loadConfig();
  const repo = requireGithubRepo(config.repository);
  const existing = await getVariable(repo, AGE_RECIPIENT_VARIABLE);

  if (existing === undefined) {
    await setVariable(repo, AGE_RECIPIENT_VARIABLE, recipient);
  }
}

/**
 * Check whether the locally cached recipient matches the one published to
 * GitHub. A mismatch means this machine used a different passphrase.
 */
export async function recipientMatchesPublished(): Promise<
  boolean | undefined
> {
  try {
    const cached = await getCachedKey();

    if (cached === undefined) {
      return undefined;
    }

    const config = await loadConfig();
    const repo = requireGithubRepo(config.repository);
    const published = await getVariable(repo, AGE_RECIPIENT_VARIABLE);

    return published === undefined ? true : published === cached.recipient;
  } catch {
    return undefined;
  }
}
