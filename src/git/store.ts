import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  TOP_LEVEL_DIRS,
  TOP_LEVEL_FILES,
  VERSION,
} from "../domain/constants.js";
import type { Snapshot, SnapshotFile, SyncConfig } from "../domain/types.js";
import {
  hashBuffer,
  hashFiles,
  isDeniedPath,
  materializeSnapshot,
} from "../snapshot/snapshot.js";
import { firstNonEmpty } from "../utils/json-utils.js";
import {
  repoDir,
  safeJoin,
  toPosix,
  trimSlashes,
} from "../utils/path-utils.js";

const execFileAsync = promisify(execFile);

export { execFileAsync };

/**
 * Git-backed storage for synced Pi configuration.
 */
export class GitStore {
  /**
   * Create a Git storage adapter.
   *
   * @param config Sync configuration shared by all Git operations.
   */
  constructor(private readonly config: SyncConfig) {}

  /**
   * Ensure the local clone exists and is checked out to the configured branch.
   */
  async prepare(): Promise<void> {
    const dir = repoDir(this.config.profile);

    try {
      await fs.access(path.join(dir, ".git"), fsConstants.F_OK);
    } catch {
      await fs.rm(dir, { force: true, recursive: true });
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await execFileAsync("git", ["clone", this.config.repository, dir], {
        maxBuffer: 10 * 1024 * 1024,
      });
    }

    await this.run(["remote", "set-url", "origin", this.config.repository]);

    const remoteBranchExists = await this.remoteBranchExists();

    if (remoteBranchExists) {
      await this.run(["fetch", "origin", this.config.branch]);
      await this.run([
        "checkout",
        "-B",
        this.config.branch,
        `origin/${this.config.branch}`,
      ]);
      await this.run(["pull", "--ff-only", "origin", this.config.branch]);

      return;
    }

    await this.run(["checkout", "-B", this.config.branch]);
  }

  /**
   * Run a Git command inside the profile clone.
   *
   * @param args Git CLI arguments.
   */
  async run(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: repoDir(this.config.profile),
        maxBuffer: 10 * 1024 * 1024,
      });

      return stdout;
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
      };

      throw new Error(
        `git ${args.join(" ")} failed: ${firstNonEmpty(err.stderr, err.stdout, err.message)}`.trim(),
      );
    }
  }

  /**
   * Read the current short commit hash from the clone.
   */
  async currentCommit(): Promise<string> {
    try {
      return (await this.run(["rev-parse", "--short", "HEAD"])).trim();
    } catch {
      return "unborn";
    }
  }

  /**
   * Commit staged sync changes and push them to the configured branch.
   *
   * @param message Commit message.
   */
  async commitAndPush(message: string): Promise<boolean> {
    await this.run(["add", "-A"]);
    const status = await this.run(["status", "--porcelain"]);

    if (status.trim().length === 0) {
      return false;
    }

    await this.run(["commit", "-m", message]);
    await this.run(["push", "origin", `HEAD:${this.config.branch}`]);

    return true;
  }

  /**
   * Read a snapshot from tracked files at a Git commit-ish.
   *
   * @param commitish Commit, branch, or tag to read.
   */
  async readSnapshot(commitish = "HEAD"): Promise<Snapshot | undefined> {
    const files = await this.collectFiles(commitish);

    if (files.length === 0) {
      return undefined;
    }

    return {
      version: VERSION,
      id: await this.commitId(commitish, files),
      createdAt: await this.commitCreatedAt(commitish),
      machine: "git",
      profile: this.config.profile,
      files,
    };
  }

  /**
   * Write a snapshot into the root of the local Git clone.
   *
   * @param snapshot Snapshot to materialize.
   */
  async writeSnapshot(snapshot: Snapshot): Promise<void> {
    const root = repoDir(this.config.profile);

    await this.removeSyncedRepoPaths();
    await materializeSnapshot(snapshot, root);
  }

  private async remoteBranchExists(): Promise<boolean> {
    const output = await this.run([
      "ls-remote",
      "--heads",
      "origin",
      this.config.branch,
    ]);

    return output.trim().length > 0;
  }

  private async collectFiles(commitish: string): Promise<SnapshotFile[]> {
    let listing: string;

    try {
      listing = await this.run([
        "ls-tree",
        "-r",
        "--name-only",
        commitish,
        "--",
        ...syncPathspecs(),
      ]);
    } catch {
      return [];
    }

    const files = await Promise.all(
      listing
        .split("\n")
        .filter((repoPath) => repoPath !== "")
        .map((repoPath) => this.readSnapshotFile(commitish, repoPath)),
    );

    return files.flatMap((file) => (file == null ? [] : [file]));
  }

  private async readSnapshotFile(
    commitish: string,
    repoPath: string,
  ): Promise<SnapshotFile | undefined> {
    const relativePath = toPosix(repoPath);

    if (relativePath === "" || isDeniedPath(relativePath)) {
      return undefined;
    }

    const { stdout } = await execFileAsync(
      "git",
      ["show", `${commitish}:${repoPath}`],
      {
        cwd: repoDir(this.config.profile),
        encoding: "buffer",
        maxBuffer: 50 * 1024 * 1024,
      },
    );
    const content = Buffer.from(stdout);

    return {
      path: relativePath,
      contentBase64: content.toString("base64"),
      sha256: hashBuffer(content),
    };
  }

  private async commitId(
    commitish: string,
    files: SnapshotFile[],
  ): Promise<string> {
    try {
      return (await this.run(["rev-parse", "--short", commitish])).trim();
    } catch {
      return `${commitish.replace(/[^A-Za-z0-9._-]/g, "_")}-${hashFiles(files).slice(0, 8)}`;
    }
  }

  private async commitCreatedAt(commitish: string): Promise<string> {
    try {
      return (await this.run(["show", "-s", "--format=%cI", commitish])).trim();
    } catch {
      return new Date().toISOString();
    }
  }

  private syncPathspecsWithLegacy(): string[] {
    const legacyPrefix = trimSlashes(this.config.prefix);

    if (legacyPrefix === "") {
      return syncPathspecs();
    }

    return [...syncPathspecs(), legacyPrefix];
  }

  private async removeSyncedRepoPaths(): Promise<void> {
    const root = repoDir(this.config.profile);

    for (const relativePath of this.syncPathspecsWithLegacy()) {
      await fs.rm(safeJoin(root, relativePath), {
        force: true,
        recursive: true,
      });
    }
  }
}

/**
 * Return root-level Git pathspecs managed by pi-sync.
 */
export function syncPathspecs(): string[] {
  return [...TOP_LEVEL_FILES, ...TOP_LEVEL_DIRS];
}
