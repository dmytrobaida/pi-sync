import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { authJsonPath } from "../utils/path-utils.js";

export type AuthProviderEntry = {
  type?: string;
  key?: string;
} & Record<string, unknown>;

export type AuthFile = Partial<Record<string, AuthProviderEntry>>;

/**
 * Coerce an unknown parsed value into a typed auth file, dropping anything that
 * is not a provider-to-object mapping.
 *
 * @param parsed Value parsed from auth.json.
 */
function coerceAuthFile(parsed: unknown): AuthFile {
  if (parsed === null || typeof parsed !== "object") {
    return {};
  }

  const result: AuthFile = {};

  for (const [provider, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (value !== null && typeof value === "object") {
      result[provider] = value as AuthProviderEntry;
    }
  }

  return result;
}

/**
 * Read and parse the Pi auth.json credential store.
 *
 * @param filePath auth.json path.
 */
export function readAuthFile(filePath: string = authJsonPath()): AuthFile {
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    return coerceAuthFile(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return {};
  }
}

/**
 * List provider names that store an API key (`type: "api_key"`) in auth.json.
 *
 * @param filePath auth.json path.
 */
export function readAuthApiKeyProviders(
  filePath: string = authJsonPath(),
): string[] {
  const file = readAuthFile(filePath);

  return Object.entries(file)
    .filter(([, entry]) => entry?.type === "api_key" && entry.key !== "")
    .map(([provider]) => provider)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Read one provider's API key from auth.json.
 *
 * @param provider Provider name (e.g. "zai", "xai").
 * @param filePath auth.json path.
 * @returns The key value, or undefined when the provider has no api_key entry.
 */
export function readAuthProviderKey(
  provider: string,
  filePath: string = authJsonPath(),
): string | undefined {
  const entry = readAuthFile(filePath)[provider];

  if (entry?.type !== "api_key") {
    return undefined;
  }

  return entry.key;
}

/**
 * Insert or replace a provider API key in auth.json, preserving every other
 * entry and the 0600 file mode Pi relies on.
 *
 * @param provider Provider name (e.g. "zai", "xai").
 * @param value API key value.
 * @param filePath auth.json path.
 */
export function writeAuthProviderKey(
  provider: string,
  value: string,
  filePath: string = authJsonPath(),
): void {
  writeAuthFile(filePath, (file) => {
    const previous = file[provider];
    const preservedType =
      previous?.type !== undefined ? previous.type : "api_key";

    return {
      ...file,
      [provider]: { ...previous, type: preservedType, key: value },
    };
  });
}

/**
 * Remove a provider entry from auth.json.
 *
 * @param provider Provider name.
 * @param filePath auth.json path.
 * @returns true when an entry was removed.
 */
export function removeAuthProvider(
  provider: string,
  filePath: string = authJsonPath(),
): boolean {
  let removed = false;

  writeAuthFile(filePath, (file) => {
    const next: AuthFile = {};

    for (const [key, value] of Object.entries(file)) {
      if (key === provider) {
        removed = true;

        continue;
      }

      next[key] = value;
    }

    return next;
  });

  return removed;
}

/**
 * Atomically rewrite auth.json from a producer, preserving mode 0600.
 *
 * Pi guards auth.json with a file lock; this performs a read-modify-write and
 * keeps the restricted permissions Pi expects.
 *
 * @param filePath auth.json path.
 * @param produce Callback returning the next auth file from the current one.
 */
function writeAuthFile(
  filePath: string,
  produce: (file: AuthFile) => AuthFile,
): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });

  const next = produce(readAuthFile(filePath));

  const serialized = `${JSON.stringify(next, null, "\t")}\n`;
  const tmp = `${filePath}.pisync-tmp`;

  writeFileSync(tmp, serialized, { encoding: "utf-8", mode: 0o600 });

  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Permissions are best-effort on some platforms/filesystems.
  }

  try {
    renameSync(tmp, filePath);
  } catch {
    // Rename can fail when replacing an existing file on some volumes; fall
    // back to a direct write while keeping the restricted mode.
    writeFileSync(filePath, serialized, { encoding: "utf-8", mode: 0o600 });

    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Permissions are best-effort.
    }
  }
}
