import type { AutocompleteItem } from "@earendil-works/pi-tui";

const MAX_COMPLETIONS = 20;

type SubcommandCompletion = AutocompleteItem & {
  keywords: string[];
};

const SUBCOMMAND_COMPLETIONS: SubcommandCompletion[] = [
  {
    value: "help",
    label: "help",
    description: "Show /pisync command usage.",
    keywords: ["usage", "docs"],
  },
  {
    value: "init",
    label: "init",
    description: "Create the local pi-sync config file if it does not exist.",
    keywords: ["config", "setup"],
  },
  {
    value: "config",
    label: "config",
    description: "Show the effective repository, branch, and local paths.",
    keywords: ["settings", "repository"],
  },
  {
    value: "status",
    label: "status [--verbose]",
    description:
      "Compare local files, remote Git state, and last synced state.",
    keywords: ["state", "changes"],
  },
  {
    value: "diff",
    label: "diff",
    description:
      "Show a textual Git diff between local files and remote files.",
    keywords: ["changes", "compare"],
  },
  {
    value: "doctor",
    label: "doctor",
    description:
      "Check config, Git access, secret scan, and local lock status.",
    keywords: ["diagnostics", "check"],
  },
  {
    value: "push",
    label: "push",
    description:
      "Upload local Pi settings to Git after safety checks and confirmation.",
    keywords: ["upload", "commit"],
  },
  {
    value: "pull",
    label: "pull",
    description:
      "Apply remote Git settings locally after diff confirmation and backup.",
    keywords: ["download", "apply"],
  },
  {
    value: "sync",
    label: "sync",
    description: "Conservatively push or pull when only one side changed.",
    keywords: ["reconcile", "auto"],
  },
  {
    value: "history",
    label: "history",
    description: "Show recent Git commits that touched synced Pi settings.",
    keywords: ["log", "commits"],
  },
  {
    value: "checkout",
    label: "checkout <commit-ish>",
    description:
      "Restore a previous commit locally without changing the remote branch.",
    keywords: ["restore", "previous", "commit"],
  },
  {
    value: "unlock",
    label: "unlock --stale",
    description:
      "Remove a stale local pi-sync lock after verifying no sync is running.",
    keywords: ["lock", "stale"],
  },
  {
    value: "secrets",
    label: "secrets <command>",
    description: "Sync API keys as age-encrypted GitHub repository variables.",
    keywords: ["api", "keys", "tokens", "encrypted", "age", "variables"],
  },
];

const SECRETS_SUBCOMMAND_COMPLETIONS: SubcommandCompletion[] = [
  {
    value: "setup",
    label: "setup",
    description:
      "Enter your passphrase once, derive and cache the local secrets key.",
    keywords: ["init", "passphrase", "age", "key", "enable"],
  },
  {
    value: "push",
    label: "push",
    description: "Encrypt and publish every auth.json provider key now.",
    keywords: ["upload", "refresh"],
  },
  {
    value: "pull",
    label: "pull",
    description: "Decrypt every provider key into auth.json (backed up first).",
    keywords: ["download", "restore"],
  },
  {
    value: "list",
    label: "list",
    description: "Show tracked providers and local/remote presence.",
    keywords: ["show", "status"],
  },
  {
    value: "doctor",
    label: "doctor",
    description: "Diagnose age, gh, identity, and recipient setup.",
    keywords: ["check", "diagnostics"],
  },
];

/**
 * Complete /pisync subcommands with descriptions.
 *
 * @param argumentPrefix Text after `/pisync ` before the cursor.
 */
export function completePisyncArguments(
  argumentPrefix: string,
): AutocompleteItem[] | null {
  const trimmedStart = argumentPrefix.trimStart();

  if (trimmedStart.startsWith("secrets")) {
    const afterSecrets = trimmedStart.slice("secrets".length);

    if (afterSecrets.startsWith(" ") || afterSecrets === "") {
      return completeSecretsSubcommand(afterSecrets.trimStart());
    }
  }

  const token = firstArgumentToken(argumentPrefix);

  if (token == null) {
    return null;
  }

  const normalized = token.toLowerCase();
  const matches = SUBCOMMAND_COMPLETIONS.filter((item) =>
    matchesSubcommand(item, normalized),
  )
    .slice(0, MAX_COMPLETIONS)
    .map(toAutocompleteItem);

  return matches.length > 0 ? matches : null;
}

function completeSecretsSubcommand(
  argumentPrefix: string,
): AutocompleteItem[] | null {
  const normalized = argumentPrefix.toLowerCase();
  const matches = SECRETS_SUBCOMMAND_COMPLETIONS.filter((item) =>
    matchesSubcommand(item, normalized),
  )
    .slice(0, MAX_COMPLETIONS)
    .map(toAutocompleteItem);

  return matches.length > 0 ? matches : null;
}

function toAutocompleteItem(item: SubcommandCompletion): AutocompleteItem {
  return {
    value: item.value,
    label: item.label,
    description: item.description,
  };
}

function firstArgumentToken(argumentPrefix: string): string | undefined {
  const trimmedStart = argumentPrefix.trimStart();

  if (/\s/.test(trimmedStart)) {
    return undefined;
  }

  return trimmedStart;
}

function matchesSubcommand(item: SubcommandCompletion, token: string): boolean {
  if (token === "") {
    return true;
  }

  return (
    item.value.includes(token) ||
    item.keywords.some((keyword) => keyword.includes(token))
  );
}
