import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NO_DIFF_MESSAGE } from "../domain/constants.js";
import { materializeSnapshot } from "./snapshot.js";
import type { Snapshot } from "../domain/types.js";

const execFileAsync = promisify(execFile);

/**
 * Format a textual Git diff between local and remote snapshots.
 *
 * @param local Local Pi config snapshot.
 * @param remote Remote Git snapshot, or undefined when remote is empty.
 */
export async function formatGitTextDiff(
  local: Snapshot,
  remote: Snapshot | undefined,
): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-diff-"));
  const localRoot = path.join(tempRoot, "local");
  const remoteRoot = path.join(tempRoot, "remote");

  try {
    await materializeSnapshot(local, localRoot);
    await materializeRemoteSnapshot(remote, remoteRoot);

    const diffOutput = await gitNoIndexDiff(tempRoot, remoteRoot, localRoot);

    if (diffOutput.trim().length === 0) {
      return NO_DIFF_MESSAGE;
    }

    return [diffHeader(local, remote), diffOutput.trimEnd()].join("\n");
  } finally {
    await fs.rm(tempRoot, { force: true, recursive: true });
  }
}

async function materializeRemoteSnapshot(
  remote: Snapshot | undefined,
  remoteRoot: string,
): Promise<void> {
  if (remote != null) {
    await materializeSnapshot(remote, remoteRoot);
  } else {
    await fs.mkdir(remoteRoot, { recursive: true });
  }
}

async function gitNoIndexDiff(
  cwd: string,
  remoteRoot: string,
  localRoot: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "diff",
        "--no-index",
        "--src-prefix=remote/",
        "--dst-prefix=local/",
        path.relative(cwd, remoteRoot),
        path.relative(cwd, localRoot),
      ],
      { cwd, maxBuffer: 20 * 1024 * 1024 },
    );

    return stdout;
  } catch (error) {
    const diffError = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };

    if (diffError.code === 1) {
      return diffError.stdout ?? "";
    }

    throw new Error(
      `git diff --no-index failed: ${diffError.stderr ?? diffError.message}`,
    );
  }
}

function diffHeader(local: Snapshot, remote: Snapshot | undefined): string {
  return [
    `remote: ${remote != null ? `${remote.id} (${remote.files.length} files)` : "empty"}`,
    `local: ${local.files.length} files`,
    "",
  ].join("\n");
}
