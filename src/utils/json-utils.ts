import fs from "node:fs/promises";
import path from "node:path";

/**
 * Read a JSON file when it exists.
 *
 * @param filePath Path to read.
 */
export async function readJsonIfExists<T>(
  filePath: string,
): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

/**
 * Write a value as pretty JSON, creating parent directories as needed.
 *
 * @param filePath Destination path.
 * @param value Value to serialize.
 */
export async function writeJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, "\t")}\n`);
}

/**
 * Convert an unknown thrown value into a displayable message.
 *
 * @param error Thrown value.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Return the first non-empty string from a list.
 *
 * @param values Candidate strings.
 */
export function firstNonEmpty(...values: (string | undefined)[]): string {
  return values.find((value) => value != null && value !== "") ?? "";
}
