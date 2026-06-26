import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { errorMessage, firstNonEmpty } from "../utils/json-utils.js";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 2 * 1024 * 1024;

export type GhVariable = {
  name: string;
  value: string;
};

/**
 * Parse a GitHub repository URL into an `owner/name` slug.
 *
 * @param repository Git remote URL.
 * @returns owner/name slug, or undefined when not a GitHub repository.
 */
export function parseGithubRepo(repository: string): string | undefined {
  const https =
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/)?$/u.exec(
      repository,
    );

  if (https !== null) {
    return `${https[1]}/${https[2]}`;
  }

  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u.exec(
    repository,
  );

  if (ssh !== null) {
    return `${ssh[1]}/${ssh[2]}`;
  }

  return undefined;
}

/**
 * Require a parseable GitHub repository slug from a remote URL.
 *
 * @param repository Git remote URL.
 * @throws {Error} When the URL is not a GitHub repository.
 */
export function requireGithubRepo(repository: string): string {
  const slug = parseGithubRepo(repository);

  if (slug === undefined) {
    throw new Error(
      "Encrypted secrets require a GitHub repository. Configure a GitHub HTTPS or SSH URL via /pisync init.",
    );
  }

  return slug;
}

/**
 * Create or update a GitHub repository variable.
 *
 * @param repo owner/name slug.
 * @param name Variable name.
 * @param value Variable value.
 */
export async function setVariable(
  repo: string,
  name: string,
  value: string,
): Promise<void> {
  await runGh(repo, ["variable", "set", name, "--body", value]);
}

/**
 * Read a GitHub repository variable value.
 *
 * @param repo owner/name slug.
 * @param name Variable name.
 * @returns Variable value, or undefined when it does not exist.
 */
export async function getVariable(
  repo: string,
  name: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await runGh(repo, ["variable", "get", name]);

    // `gh variable get` appends a trailing newline to the value; drop it so
    // ciphertext and recipients round-trip byte-for-byte.
    return stdout.replace(/\r?\n$/u, "");
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

/**
 * List all GitHub repository variables.
 *
 * @param repo owner/name slug.
 */
export async function listVariables(repo: string): Promise<GhVariable[]> {
  const { stdout } = await runGh(repo, ["variable", "list", "--json", "name"]);

  const parsed = JSON.parse(stdout === "" ? "[]" : stdout) as Pick<
    GhVariable,
    "name"
  >[];

  return parsed.map((entry) => ({ name: entry.name, value: "" }));
}

/**
 * Delete a GitHub repository variable if it exists.
 *
 * @param repo owner/name slug.
 * @param name Variable name.
 */
export async function deleteVariable(
  repo: string,
  name: string,
): Promise<boolean> {
  try {
    await runGh(repo, ["variable", "delete", name]);

    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

async function runGh(
  repo: string,
  args: string[],
): Promise<{
  stdout: string;
  stderr: string;
}> {
  try {
    return await execFileAsync("gh", [...args, "--repo", repo], {
      maxBuffer: MAX_BUFFER,
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };

    if (err.code === "ENOENT") {
      throw new Error(
        "GitHub CLI (gh) is required for encrypted secrets but was not found. Install it from https://cli.github.com and run `gh auth login`.",
      );
    }

    throw new Error(
      `gh ${args.join(" ")} failed: ${firstNonEmpty(err.stderr, err.stdout, err.message)}`.trim(),
    );
  }
}

function isNotFoundError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();

  return message.includes("not found") || message.includes("http 404");
}
