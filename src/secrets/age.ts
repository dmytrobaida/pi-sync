import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { errorMessage, firstNonEmpty } from "../utils/json-utils.js";
import { ageIdentityPath } from "../utils/path-utils.js";

const execFileAsync = promisify(execFile);

const RECIPIENT_PREFIX = "# public key:";

/**
 * Ensure the age and age-keygen binaries are available.
 *
 * @throws {Error} When age is not installed or not runnable.
 */
export async function ensureAgeCli(): Promise<void> {
  try {
    await execFileAsync("age", ["--version"]);
  } catch (error) {
    throw new Error(
      `age is required for encrypted secrets but was not found. Install it and retry.\n  ${installHint()}\n  Detail: ${errorMessage(error)}`,
    );
  }
}

/**
 * Return a short, platform-aware install hint for age.
 */
export function installHint(): string {
  return "Install age: macOS `brew install age`, Windows `scoop install age`, Linux `sudo apt install age` or https://age-encryption.org";
}

/**
 * Read the age public-key recipient from an identity file.
 *
 * @param identityPath Identity file produced by age-keygen.
 * @returns The age1... recipient string.
 * @throws {Error} When the recipient line cannot be found.
 */
export async function readRecipient(
  identityPath: string = ageIdentityPath(),
): Promise<string> {
  const content = await fs.readFile(identityPath, "utf8");
  const recipientLine = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(RECIPIENT_PREFIX));

  if (recipientLine === undefined) {
    throw new Error(
      `Could not read age recipient from ${identityPath}. Run /pisync secrets init to regenerate it.`,
    );
  }

  const recipient = recipientLine.slice(RECIPIENT_PREFIX.length).trim();

  if (recipient === "" || !recipient.startsWith("age1")) {
    throw new Error(`Invalid age recipient in ${identityPath}.`);
  }

  return recipient;
}

/**
 * Generate a new age identity file if one does not exist yet.
 *
 * @param identityPath Destination identity file path.
 * @returns The recipient (public key) extracted from the new identity.
 */
export async function ensureIdentity(
  identityPath: string = ageIdentityPath(),
): Promise<string> {
  try {
    return await readRecipient(identityPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(path.dirname(identityPath), { recursive: true });
  await execFileAsync("age-keygen", ["-o", identityPath]);

  try {
    await fs.chmod(identityPath, 0o600);
  } catch {
    // File permissions are best-effort on some platforms/filesystems.
  }

  return readRecipient(identityPath);
}

/**
 * Encrypt a plaintext value for an age recipient.
 *
 * @param recipient age1... public key.
 * @param plaintext Secret value to encrypt.
 * @returns ASCII-armored ciphertext.
 */
export async function encryptForRecipient(
  recipient: string,
  plaintext: string,
): Promise<string> {
  const stdout = await pipeExec(
    "age",
    ["--armor", "--encrypt", "--recipient", recipient],
    plaintext,
  );

  return stdout.trim();
}

/**
 * Decrypt an age ciphertext using a local identity file.
 *
 * @param ciphertext ASCII-armored ciphertext.
 * @param identityPath Identity file produced by age-keygen.
 * @returns Decrypted plaintext.
 */
export async function decryptWithIdentity(
  ciphertext: string,
  identityPath: string = ageIdentityPath(),
): Promise<string> {
  return pipeExec("age", ["--decrypt", "--identity", identityPath], ciphertext);
}

/**
 * Run a binary, feed `input` to its stdin, and resolve its stdout string.
 *
 * @param command Binary to run.
 * @param args Arguments for the binary.
 * @param input Stdin payload.
 */
function pipeExec(
  command: string,
  args: string[],
  input: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      if (code === 0) {
        resolve(stdout);

        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} failed (exit ${code}): ${firstNonEmpty(stderr, stdout)}`.trim(),
        ),
      );
    });
    child.stdin.end(input);
  });
}
