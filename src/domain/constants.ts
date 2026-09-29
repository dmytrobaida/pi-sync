import type { CommandOptions } from "./types.js";

export const STATUS_KEY = "pisync";
export const ACTIVITY_STATUS_KEY = "pisync-activity";
export const VERSION = 1;
export const DEFAULT_BRANCH = "main";
export const LOCK_STALE_MS = 30 * 60 * 1000;
export const NO_DIFF_MESSAGE = "No file differences.";

/**
 * Paths pi-sync manages when pi-sync.json lists nothing. The fork keeps
 * upstream's set as the default and lets the config add to it, so an existing
 * install behaves the same until `include` is set.
 *
 * settings.json IS synced, as upstream has it, which means defaultProvider,
 * defaultModel and enabledModels travel between machines. Take it out through
 * `exclude` on a machine that needs its own choices.
 */
export const DEFAULT_INCLUDE = [
  "settings.json",
  "keybindings.json",
  "models.json",
  "AGENTS.md",
  "plannotator.json",
  "skills/**",
  "prompts/**",
  "themes/**",
  "extensions/**",
];

/**
 * Extra excludes applied on top of the built-in deny rules. The deny rules
 * already cover node_modules, .git, .pisync, dotenv files and secrets by name.
 */
export const DEFAULT_EXCLUDE = [
  "**/.DS_Store",
  "**/*.tmp",
  "**/*.log",
];

export const EXTERNAL_FILES = new Set([".plannotator/config.json"]);

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
  verbose: false,
  reload: false,
  args: [],
};
