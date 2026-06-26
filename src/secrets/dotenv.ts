import fs from "node:fs/promises";
import path from "node:path";

import { agentEnvPath } from "../utils/path-utils.js";

/**
 * Read the local Pi agent .env file as an ordered key/value map.
 *
 * @param filePath .env file path (defaults to ~/.pi/agent/.env).
 */
export async function readDotenv(
  filePath: string = agentEnvPath(),
): Promise<Map<string, string>> {
  const entries = new Map<string, string>();

  for (const entry of await readEntries(filePath)) {
    entries.set(entry.key, entry.value);
  }

  return entries;
}

/**
 * Read a single key from the local .env file.
 *
 * @param key Variable name.
 * @param filePath .env file path.
 */
export async function readDotenvKey(
  key: string,
  filePath: string = agentEnvPath(),
): Promise<string | undefined> {
  return (await readDotenv(filePath)).get(key);
}

/**
 * Insert or replace a key in the local .env file, preserving other lines.
 *
 * @param key Variable name.
 * @param value Variable value.
 * @param filePath .env file path.
 */
export async function writeDotenvKey(
  key: string,
  value: string,
  filePath: string = agentEnvPath(),
): Promise<void> {
  const lines = await readLines(filePath);
  const quote = needsQuoting(value) ? '"' : "";
  const rendered = `${key}=${quote}${value.replaceAll('"', '\\"')}${quote}`;
  let replaced = false;

  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseLine(lines[index]);

    if (parsed?.key === key) {
      lines[index] = rendered;
      replaced = true;

      break;
    }
  }

  if (!replaced) {
    lines.push(rendered);
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, ensureTrailingNewline(lines.join("\n")));
}

/**
 * Remove a key from the local .env file.
 *
 * @param key Variable name.
 * @param filePath .env file path.
 */
export async function removeDotenvKey(
  key: string,
  filePath: string = agentEnvPath(),
): Promise<boolean> {
  const lines = await readLines(filePath);
  const filtered = lines.filter((line) => parseLine(line)?.key !== key);

  if (filtered.length === lines.length) {
    return false;
  }

  await fs.writeFile(filePath, ensureTrailingNewline(filtered.join("\n")));

  return true;
}

type DotenvEntry = {
  key: string;
  value: string;
};

async function readEntries(filePath: string): Promise<DotenvEntry[]> {
  const entries: DotenvEntry[] = [];

  for (const line of await readLines(filePath)) {
    const parsed = parseLine(line);

    if (parsed !== undefined) {
      entries.push(parsed);
    }
  }

  return entries;
}

async function readLines(filePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, "utf8");

    return content.split("\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

function parseLine(line: string): DotenvEntry | undefined {
  const trimmed = line.trim();

  if (trimmed === "" || trimmed.startsWith("#")) {
    return undefined;
  }

  const separator = trimmed.indexOf("=");

  if (separator <= 0) {
    return undefined;
  }

  const key = trimmed.slice(0, separator).trim();

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return undefined;
  }

  return { key, value: unquote(trimmed.slice(separator + 1).trim()) };
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    const inner = value.slice(1, -1);

    return inner.replaceAll('\\"', '"').replaceAll("\\'", "'");
  }

  return value;
}

function needsQuoting(value: string): boolean {
  return /[\s#"']/u.test(value);
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
