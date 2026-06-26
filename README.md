# pi-sync — Sync Pi settings through Git

`@dbaida/pi-sync` syncs your Pi agent settings across machines using a Git repository.

Use it when you want the same Pi skills, prompts, themes, extensions, keybindings, models, and global instructions on multiple machines without copying files manually. Your configuration is stored as normal Git-tracked files, so you can inspect changes, review history, and restore earlier versions with familiar Git workflows.

## When to use this

Use pi-sync when you want to:

- set up a new machine with your existing Pi configuration
- keep prompts, skills, themes, extensions, and global instructions consistent across machines
- back up Pi agent config in a private Git repo
- review Pi configuration changes through Git history and diffs
- restore an older config version locally without changing the remote repo

## Prerequisites

- Pi coding agent installed.
- `git` installed and available in your shell.
- A **private** Git repository for synced Pi configuration.
- For GitHub HTTPS repositories, GitHub CLI (`gh`) is recommended so Git can reuse your existing GitHub login.

Install GitHub CLI if needed:

```bash
brew install gh
```

Then authenticate and configure Git HTTPS credentials:

```bash
gh auth login
gh auth setup-git
```

SSH repository URLs are also supported, but they require normal SSH key and `ssh-agent` setup.

## Install

Install as a Pi package:

```bash
pi install npm:@dbaida/pi-sync
```

For local development from this repository root:

```bash
pi -e .
```

## Quick start

1. Create a private Git repository for your Pi config.
2. Install the extension:

   ```bash
   pi install npm:@dbaida/pi-sync
   ```

3. In Pi, run:

   ```text
   /pisync init
   ```

4. Enter your repository URL. HTTPS GitHub URLs are recommended if you already use `gh auth login`.
5. Verify setup:

   ```text
   /pisync doctor
   ```

6. On your first machine, publish current config:

   ```text
   /pisync push
   ```

7. On another machine, use the same repository and run:

   ```text
   /pisync pull
   ```

When everything matches, the footer should show:

```text
PI-SYNC: ↑0 ↓0
```

## Configuration

Run inside Pi:

```text
/pisync init
```

The init flow asks for a Git repository URL, branch, and whether auto-sync should be enabled. HTTPS GitHub URLs are recommended because they can reuse an existing GitHub CLI login or Git credential helper without SSH key setup.

The generated local-only file is stored at:

```text
~/.pi/agent/pi-sync.json
```

Example:

```json
{
  "repository": "https://github.com/<user>/<repo>.git",
  "branch": "main",
  "autoSync": true
}
```

For GitHub HTTPS repositories, `/pisync init` can optionally run `gh auth setup-git` after confirming with you. This lets Git reuse your existing GitHub CLI login. SSH URLs still require normal SSH key and ssh-agent setup.

Environment overrides are also supported: `PI_SYNC_REPOSITORY` (or `PI_SYNC_REPO`), `PI_SYNC_BRANCH`, and `PI_SYNC_AUTO_SYNC`. Run `/pisync doctor` after setup to verify repository access and get auth-specific guidance.

## Commands

```text
/pisync config
/pisync doctor
/pisync status [--verbose]
/pisync diff
/pisync push
/pisync pull
/pisync sync
/pisync history
/pisync checkout <commit-ish>
/pisync unlock --stale
/pisync secrets <init|add|remove|push|pull|list|doctor>
```

Command guide:

| Command                         | Use it when                                                           |
| ------------------------------- | --------------------------------------------------------------------- |
| `/pisync init`                  | Configure pi-sync for this machine.                                   |
| `/pisync doctor`                | Verify config, Git access, secret scan, and lock status.              |
| `/pisync status [--verbose]`    | Check local/remote drift and optionally list changed paths.           |
| `/pisync diff`                  | Review textual differences before pushing or pulling.                 |
| `/pisync push`                  | Publish local Pi settings to the Git repo.                            |
| `/pisync pull`                  | Apply remote Git settings locally after backup and confirmation.      |
| `/pisync sync`                  | Conservatively push or pull when only one side changed.               |
| `/pisync history`               | Show recent synced Git commits.                                       |
| `/pisync checkout <commit-ish>` | Restore a previous commit locally without changing the remote branch. |
| `/pisync unlock --stale`        | Remove a stale local lock after confirming no sync is running.        |
| `/pisync secrets <command>`     | Sync auth.json provider API keys as age-encrypted GitHub variables.   |

Useful flags:

- `--yes` / `-y`: skip confirmation prompts.
- `--force`: allow push/pull when both local and remote state changed.
- `--verbose` / `-v`: show changed paths for `/pisync status`.
- `--stale`: remove a stale local lock.

Press Tab after `/pisync ` to autocomplete subcommands with short descriptions.

## Footer status

pi-sync shows drift in the footer:

```text
PI-SYNC: ↑1 ↓0
```

- `↑` means local output changes that are not pushed.
- `↓` means remote input changes that are not pulled.

Common states:

| Status  | Meaning                | Next step                                                                    |
| ------- | ---------------------- | ---------------------------------------------------------------------------- |
| `↑0 ↓0` | Local and remote match | Nothing                                                                      |
| `↑1 ↓0` | Local files changed    | `/pisync diff`, then `/pisync push`                                          |
| `↑0 ↓1` | Remote changed         | `/pisync pull`                                                               |
| `↑1 ↓1` | Both changed           | `/pisync diff`, then choose `/pisync pull --force` or `/pisync push --force` |

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

It excludes `.env*`, `node_modules`, `.git`, `.pisync`, `pi-sync.json`, and paths containing `secret` or `token`, and it refuses to push common API-key patterns. `/pisync diff` and confirmation prompts use textual `git diff --no-index` output between remote files and local files.

## Safety

- Use a private Git repository for synced Pi config.
- Local state, clone cache, locks, and backups live under `~/.pi/agent/.pisync/`.
- Pull and checkout create local backups before changing files.
- Pull and checkout apply normal Git-tracked files while still preflighting paths and refusing symlink escapes.
- Checkout restores a previous commit locally without changing the remote branch; use `/pisync push` afterwards only if you want to publish that checked-out state as a new commit.
- Auto-sync is enabled by default but never pushes local changes automatically; it only pulls safe remote changes or asks you to resolve conflicts manually.
- Secret scanning is best-effort. Do not intentionally store API keys or tokens in synced Pi config.

## Encrypted secrets (optional)

Enable a single **`secrets` toggle** and your API keys sync automatically — encrypted — alongside the normal `/pisync push` and `/pisync pull`. No per-key commands, no identity files to copy: you set one **passphrase** once per machine, and the same passphrase derives the same key everywhere.

Keys are encrypted locally with [age](https://age-encryption.org) and stored as **GitHub repository Variables** (`PISYNC_SECRET_*`). Only ciphertext ever touches GitHub; `auth.json` is not part of the synced snapshot, so provider keys are never committed.

### Prerequisites

- A **GitHub** repository (HTTPS or SSH URL) configured via `/pisync init`.
- [GitHub CLI](https://cli.github.com) (`gh`) installed and authenticated with `repo` scope.
- [age](https://age-encryption.org) installed: macOS `brew install age`, Windows `scoop install age` / `winget install FiloSottile.age`, Linux `sudo apt install age`.

### How it works

- You enable secrets in your pi-sync config (or during `/pisync init`) and choose a passphrase.
- The passphrase is deterministically derived (scrypt) into an age identity, cached locally at `~/.pi/agent/.pisync/age-identity.txt`. The passphrase itself is never stored or synced.
- The derived recipient (public key) is published to GitHub Variable `PISYNC_AGE_RECIPIENT` so every machine encrypts to the same key.
- Every provider key in `~/.pi/agent/auth.json` with `type: "api_key"` (e.g. `zai`, `xai`) is encrypted into `PISYNC_SECRET_<PROVIDER>` on push and decrypted back into `auth.json` on pull — exactly where Pi reads them.

### Quick start

1. Install `age` and ensure `gh auth login` works for your repository.
2. Run init and say yes to encrypted secrets, then pick a passphrase:

   ```text
   /pisync init
   ```

   (Or toggle it on later by setting `"secrets": true` in `~/.pi/agent/pi-sync.json`, then `/pisync secrets setup`.)

3. Publish your keys — they ride along with a normal push:

   ```text
   /pisync push
   ```

4. On another machine, run `/pisync init` (or `/pisync secrets setup`) and enter the **same** passphrase, then:

   ```text
   /pisync pull
   ```

   Your provider keys are decrypted back into `auth.json` (a backup is saved under `~/.pi/agent/.pisync/secrets-backups/` first).

That's the whole day-to-day flow: keep using `/pisync push` and `/pisync pull`, and secrets are handled automatically. Background auto-sync pulls secrets silently too, as long as the passphrase was already entered on that machine.

### Configuration

```json
{
  "repository": "https://github.com/<user>/<repo>.git",
  "branch": "main",
  "secrets": true
}
```

Environment override: `PI_SYNC_SECRETS=true`.

### Commands (optional, manual control)

The toggle does everything automatically. These are only for manual control or diagnostics.

| Command                  | Use it when                                                    |
| ------------------------ | -------------------------------------------------------------- |
| `/pisync secrets setup`  | Enter/refresh your passphrase and cache the local key.         |
| `/pisync secrets push`   | Re-encrypt and publish every provider key now.                 |
| `/pisync secrets pull`   | Decrypt every provider key into `auth.json` (backed up first). |
| `/pisync secrets list`   | Show tracked providers and local/remote presence.              |
| `/pisync secrets doctor` | Diagnose age, gh, recipient match, and local providers.        |

### Security notes

- GitHub Variables are visible to anyone with repository access — but only as **ciphertext**.
- The passphrase is the single secret that protects everything. Choose a strong one; it is never stored or synced.
- The same passphrase derives the same key on every machine. A wrong passphrase is detected as a recipient mismatch (`/pisync secrets doctor`).
- GitHub repository **Secrets** (`gh secret`) are write-only and cannot be read back, so they are intentionally **not** used; round-trip sync needs readable storage, which age-encrypted Variables provide safely.
- Only `auth.json` entries with `type: "api_key"` are synced; OAuth/token entries are left untouched.

## Troubleshooting

| Symptom                                        | Likely cause                                                   | Suggested fix                                                                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `/pisync doctor` says repository access failed | Git auth is not configured for the repo URL                    | For GitHub HTTPS, run `gh auth login` and `gh auth setup-git`. For SSH, run `ssh -T git@github.com` and configure your SSH key. |
| `Permission denied (publickey)`                | SSH repository URL without working SSH key setup               | Use an HTTPS repository URL, or add/load an SSH key registered with GitHub.                                                     |
| `gh: command not found`                        | GitHub CLI is not installed                                    | Install it with `brew install gh`, then run `gh auth login` and `gh auth setup-git`.                                            |
| Footer shows `PI-SYNC: ↑1 ↓0`                  | Local config differs from the last synced state                | Run `/pisync diff`, then `/pisync push` if you want to publish local changes.                                                   |
| Footer shows `PI-SYNC: ↑0 ↓1`                  | Remote config changed                                          | Run `/pisync pull`.                                                                                                             |
| Footer shows both local and remote changes     | Local and remote diverged                                      | Run `/pisync diff`, then choose `/pisync pull --force` or `/pisync push --force`.                                               |
| Push is refused due to possible secrets        | A synced file path or content matched secret heuristics        | Remove the secret/token from synced config or rename/exclude the sensitive file.                                                |
| A lock is stale                                | A previous sync was interrupted                                | After verifying no sync is running, run `/pisync unlock --stale`.                                                               |
| Checkout restored older local files            | `/pisync checkout` is local-only by design                     | Run `/pisync pull` to return to remote latest, or `/pisync push` to publish the checked-out state.                              |
| `/pisync secrets` says age/gh not found        | Required tooling is missing                                    | Install `age` (see Encrypted secrets) and `gh` (`brew install gh`), then run `/pisync secrets doctor`.                          |
| `/pisync secrets add <PROVIDER>` says no entry | Provider has no `api_key` entry in `auth.json`                 | Run `/pisync secrets list` to see local providers, or add the key via `/login` first.                                           |
| `/pisync secrets pull` cannot decrypt          | The passphrase on this machine differs from the encrypting one | Re-run `/pisync secrets setup` with the correct passphrase. `/pisync secrets doctor` reports a recipient mismatch.              |
