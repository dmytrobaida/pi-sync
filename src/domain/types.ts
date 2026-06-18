export type SyncConfig = {
  repository: string;
  branch: string;
  autoSync: boolean | string;
};

export type PartialConfig = {
  repository?: string;
  branch?: string;
  autoSync?: boolean | string;
};

export type SnapshotFile = {
  path: string;
  contentBase64: string;
  sha256: string;
};

export type Snapshot = {
  version: number;
  id: string;
  createdAt: string;
  machine: string;
  files: SnapshotFile[];
};

export type SyncState = {
  version: number;
  lastAppliedSnapshot?: string;
  lastAppliedCommit?: string;
  lastFileHashes: Record<string, string>;
};

export type LockFile = {
  id: string;
  pid: number;
  command: string;
  startedAt: string;
};

export type CommandOptions = {
  yes: boolean;
  force: boolean;
  stale: boolean;
  silent: boolean;
  verbose: boolean;
  reload: boolean;
  args: string[];
};
