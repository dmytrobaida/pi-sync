import type { CommandOptions } from "./types.js";

export const STATUS_KEY = "pisync";
export const VERSION = 1;
export const DEFAULT_PROFILE = "default";
export const DEFAULT_PREFIX = "pi-sync";
export const DEFAULT_BRANCH = "main";
export const LOCK_STALE_MS = 30 * 60 * 1000;
export const NO_DIFF_MESSAGE = "No file differences.";

export const TOP_LEVEL_FILES = new Set([
  "settings.json",
  "keybindings.json",
  "models.json",
  "AGENTS.md",
]);

export const TOP_LEVEL_DIRS = new Set([
  "skills",
  "prompts",
  "themes",
  "extensions",
]);

export const SECRET_PATTERNS = [
  /AWS_SECRET_ACCESS_KEY\s*[=:]\s*['"]?[A-Za-z0-9/+]{35,}/i,
  /(ANTHROPIC|OPENAI|GEMINI|GOOGLE|FIRECRAWL|GITHUB|CLOUDFLARE|R2|S3)_[A-Z0-9_]*(KEY|TOKEN|SECRET)\s*[=:]\s*['"]?[^\s'"]{12,}/i,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
];

export const AUTO_SYNC_OPTIONS: CommandOptions = {
  yes: true,
  force: false,
  stale: false,
  silent: true,
  reload: false,
  args: [],
};
