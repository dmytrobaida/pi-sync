import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type CommandResult = {
  ok: boolean;
  output: string;
};

type RepositoryKind = "github-https" | "github-ssh" | "https" | "ssh" | "other";

/**
 * Check whether the configured repository can be accessed and return setup guidance.
 *
 * @param repository Git remote URL to check.
 */
export async function repositoryAccessReport(
  repository: string,
): Promise<string[]> {
  const result = await runCommand("git", ["ls-remote", "--heads", repository]);

  if (result.ok) {
    return ["repository access: ok"];
  }

  return [
    `repository access: failed (${result.output})`,
    ...authGuidance(repository),
  ];
}

/**
 * Return guidance for configuring Git authentication for a repository URL.
 *
 * @param repository Git remote URL to inspect.
 */
export function authGuidance(repository: string): string[] {
  switch (repositoryKind(repository)) {
    case "github-https":
      return [
        "auth: GitHub HTTPS repository detected.",
        "auth: if GitHub CLI is already logged in, run `gh auth setup-git` to let Git reuse it.",
        "auth: otherwise run `gh auth login`, then `gh auth setup-git`.",
      ];
    case "github-ssh":
      return [
        "auth: GitHub SSH repository detected.",
        "auth: SSH uses keys, not GitHub CLI HTTPS credentials.",
        "auth: run `ssh -T git@github.com` and ensure a registered key is loaded in ssh-agent.",
      ];
    case "https":
      return [
        "auth: HTTPS repository detected.",
        "auth: configure your Git credential helper or use a provider-specific CLI credential setup.",
      ];
    case "ssh":
      return [
        "auth: SSH repository detected.",
        "auth: ensure the private key is loaded and the public key is registered with the Git host.",
      ];
    case "other":
      return [
        "auth: unsupported repository URL shape; ensure `git ls-remote` works in your shell.",
      ];
  }
}

/**
 * Check whether GitHub CLI can configure Git HTTPS credentials.
 */
export async function githubCliStatus(): Promise<CommandResult> {
  return runCommand("gh", ["auth", "status"]);
}

/**
 * Configure Git to use the current GitHub CLI login for HTTPS credentials.
 */
export async function setupGithubGitAuth(): Promise<CommandResult> {
  return runCommand("gh", ["auth", "setup-git"]);
}

/**
 * Check whether a repository is a GitHub HTTPS URL.
 *
 * @param repository Git remote URL to inspect.
 */
export function isGithubHttpsRepository(repository: string): boolean {
  return repositoryKind(repository) === "github-https";
}

function repositoryKind(repository: string): RepositoryKind {
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?$/u.test(repository)) {
    return "github-https";
  }

  if (/^git@github\.com:[^/]+\/[^/]+(?:\.git)?$/u.test(repository)) {
    return "github-ssh";
  }

  if (/^https?:\/\//u.test(repository)) {
    return "https";
  }

  if (
    /^[^@\s]+@[^:\s]+:/u.test(repository) ||
    repository.startsWith("ssh://")
  ) {
    return "ssh";
  }

  return "other";
}

async function runCommand(
  command: string,
  args: string[],
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
    });

    return { ok: true, output: firstOutput(stdout, stderr, "ok") };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };

    return {
      ok: false,
      output: firstOutput(err.stderr, err.stdout, err.message),
    };
  }
}

function firstOutput(...values: (string | undefined)[]): string {
  return (
    values.find((value) => value != null && value.trim() !== "")?.trim() ??
    "unknown error"
  );
}
