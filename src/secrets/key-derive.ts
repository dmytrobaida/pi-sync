import { execFile } from "node:child_process";
import { scryptSync } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { bech32Encode } from "./bech32.js";

const execFileAsync = promisify(execFile);

const DERIVATION_SALT = Buffer.from(
  "pi-sync age passphrase derivation v1",
  "utf8",
);
const SCRYPT_OPTIONS = {
  N: 1 << 17,
  r: 8,
  p: 1,
  maxmem: 256 * 1024 * 1024,
};

/**
 * Derive a deterministic age identity line from a passphrase.
 *
 * The same passphrase always yields the same X25519 identity, so every machine
 * that enters the same passphrase shares one key — no identity file to copy.
 *
 * @param passphrase User passphrase.
 * @returns Uppercase `AGE-SECRET-KEY-1...` identity line.
 */
export function deriveIdentityLine(passphrase: string): string {
  const secret = scryptSync(passphrase, DERIVATION_SALT, 32, SCRYPT_OPTIONS);

  return bech32Encode("age-secret-key-", new Uint8Array(secret)).toUpperCase();
}

/**
 * Derive an identity from a passphrase, write it to a file, and return the
 * matching recipient (public key) via `age-keygen -y`.
 *
 * @param passphrase User passphrase.
 * @param identityPath Destination identity file path.
 * @returns The `age1...` recipient string.
 */
export async function deriveIdentityFile(
  passphrase: string,
  identityPath: string,
): Promise<string> {
  const identityLine = deriveIdentityLine(passphrase);

  await fs.mkdir(path.dirname(identityPath), { recursive: true });

  // age-keygen derives the recipient from an identity file, so write the bare
  // secret first, extract the recipient, then rewrite with the standard
  // `# public key:` header so readRecipient can parse it back without re-running age.
  await fs.writeFile(identityPath, `${identityLine}\n`, { mode: 0o600 });

  let recipient: string;

  try {
    const { stdout } = await execFileAsync("age-keygen", ["-y", identityPath]);

    recipient = stdout.trim();
  } catch (error) {
    throw new Error(
      `Failed to derive age recipient from passphrase: ${(error as Error).message}`,
    );
  }

  const created = new Date().toISOString();
  const fileBody = [
    `# created: ${created}`,
    `# public key: ${recipient}`,
    identityLine,
    "",
  ].join("\n");

  await fs.writeFile(identityPath, fileBody, { mode: 0o600 });

  try {
    await fs.chmod(identityPath, 0o600);
  } catch {
    // Permissions are best-effort on some platforms/filesystems.
  }

  return recipient;
}
