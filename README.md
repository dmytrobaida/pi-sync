# pi-sync — Git-backed Pi settings sync

`@dbaida/pi-sync` is a Pi coding-agent extension based on the original `@narumitw/pi-sync` command set, but it stores Pi configuration as normal Git-tracked files instead of R2/S3 gzip snapshots.

## Install / try locally

From this repository root:

```bash
pi -e .
```

Or install as a Pi package once published/available:

```bash
pi install npm:@dbaida/pi-sync
```

## Configure

Run inside Pi:

```text
/pisync init
```

Then edit the generated local-only file:

```text
~/.pi/agent/pi-sync.local.json
```

Example:

```json
{
  "repository": "git@github.com:<user>/<repo>.git",
  "branch": "main",
  "profile": "default",
  "autoSync": true
}
```

Environment overrides are also supported: `PI_SYNC_REPOSITORY` (or `PI_SYNC_REPO`), `PI_SYNC_BRANCH`, `PI_SYNC_PROFILE`, and `PI_SYNC_AUTO_SYNC`.

## Commands

```text
/pisync config
/pisync doctor
/pisync status
/pisync diff
/pisync push
/pisync pull
/pisync sync
/pisync history
/pisync rollback <commit-ish>
/pisync unlock --stale
```

Useful flags:

- `--yes` / `-y`: skip confirmation prompts.
- `--force`: allow push/pull when both local and remote state changed.
- `--stale`: remove a stale local lock.

## What is synced

The extension syncs allowlisted files from `~/.pi/agent` into the root of the configured Git repo:

```text
settings.json
keybindings.json
models.json
AGENTS.md
skills/
prompts/
themes/
extensions/
```

It excludes `.env*`, `node_modules`, `.git`, `.pisync`, `pi-sync.local.json`, and paths containing `secret` or `token`, and it refuses to push common API-key patterns. `/pisync diff` and confirmation prompts use textual `git diff --no-index` output between remote files and local files.

## Safety

- Local state, clone cache, locks, and backups live under `~/.pi/agent/.pisync/`.
- Pull and rollback create local backups before changing files.
- Pull and rollback apply normal Git-tracked files while still preflighting paths and refusing symlink escapes.
- Auto-sync is enabled by default but uses conservative conflict checks and will ask you to resolve divergent local/remote changes manually.
