import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { diffWords } from "diff";

/**
 * Result of rendering a git unified diff into theme-colored terminal lines.
 *
 * `fileAnchors` / `hunkAnchors` hold indices into `lines` so a viewer can
 * jump between files or hunks without re-parsing.
 */
export type RenderedDiff = {
  lines: string[];
  fileAnchors: number[];
  hunkAnchors: number[];
  stats: { files: number; added: number; removed: number };
};

/** Structural kind of a single parsed diff line. */
export type DiffLineKind =
  | "file"
  | "hunk"
  | "path"
  | "meta"
  | "header"
  | "noeol"
  | "context"
  | "added"
  | "removed";

/** One parsed line of a git unified diff. */
export type ParsedLine = {
  kind: DiffLineKind;
  /** Original line text. */
  raw: string;
  /** Content without the `+`/`-` prefix (added/removed) or the dst path (file). */
  content: string;
};

/** Flat, ordered parse of a git unified diff. */
export type ParsedDiff = {
  lines: ParsedLine[];
  stats: { files: number; added: number; removed: number };
};

type ThemeColor = Parameters<Theme["fg"]>[0];
type ColorFn = (color: ThemeColor, text: string) => string;

/**
 * Color for non-content, non-anchor diff lines, or `undefined` for context.
 * @param kind
 */
function metaColor(kind: DiffLineKind): ThemeColor | undefined {
  if (kind === "path") {
    return "muted";
  }

  if (kind === "meta" || kind === "noeol") {
    return "dim";
  }

  if (kind === "header") {
    return "accent";
  }

  return undefined;
}

const META_PREFIXES = [
  "index ",
  "old mode ",
  "new mode ",
  "new file mode ",
  "deleted file mode ",
  "similarity index ",
  "dissimilarity index ",
  "rename from ",
  "rename to ",
  "copy from ",
  "copy to ",
  "Binary files ",
  "GIT binary patch",
];

/**
 * Parse a git unified diff (as produced by `git diff --no-index`) into a flat
 * list of typed lines plus aggregate stats. Pure: no coloring or theme access.
 *
 * @param diffText Raw unified diff text (may include a leading summary header).
 */
export function parseGitDiff(diffText: string): ParsedDiff {
  const raw = diffText.split("\n");
  const lines: ParsedLine[] = [];
  let files = 0;
  let added = 0;
  let removed = 0;

  for (const line of raw) {
    if (line.startsWith("diff --git ")) {
      files++;
      lines.push({ kind: "file", raw: line, content: extractPath(line) });
    } else if (line.startsWith("@@")) {
      lines.push({ kind: "hunk", raw: line, content: line });
    } else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      lines.push({ kind: "path", raw: line, content: line });
    } else if (META_PREFIXES.some((prefix) => line.startsWith(prefix))) {
      lines.push({ kind: "meta", raw: line, content: line });
    } else if (line === "\\ No newline at end of file") {
      lines.push({ kind: "noeol", raw: line, content: line });
    } else if (line.startsWith("remote:") || line.startsWith("local:")) {
      lines.push({ kind: "header", raw: line, content: line });
    } else if (line.startsWith("-")) {
      removed++;
      lines.push({ kind: "removed", raw: line, content: line.slice(1) });
    } else if (line.startsWith("+")) {
      added++;
      lines.push({ kind: "added", raw: line, content: line.slice(1) });
    } else {
      lines.push({ kind: "context", raw: line, content: line });
    }
  }

  return { lines, stats: { files, added, removed } };
}

/**
 * Extract the destination path from a `diff --git remote/X local/X` header.
 * pi-sync uses `--src-prefix=remote/ --dst-prefix=local/`, so the dst token is
 * `local/X`.
 *
 * @param diffGitLine A `diff --git ...` header line.
 */
function extractPath(diffGitLine: string): string {
  const parts = diffGitLine.split(/\s+/u);
  const dst = parts.length > 3 ? parts[3] : parts[2] ?? diffGitLine;

  return dst.replace(/^(remote|local)\//u, "");
}

/**
 * Render a git unified diff into ANSI-colored lines using Pi's theme, mirroring
 * the look of Pi's built-in edit-tool diff: context lines dim, removed lines
 * red, added lines green, with word-level intra-line highlighting on
 * single-line modifications.
 *
 * @param diffText Raw unified diff text (may include a leading summary header).
 * @param theme    Pi theme used for colors.
 */
export function renderGitDiff(diffText: string, theme: Theme): RenderedDiff {
  const { lines, stats } = parseGitDiff(diffText);
  const out: string[] = [];
  const fileAnchors: number[] = [];
  const hunkAnchors: number[] = [];
  const fg: ColorFn = (color, text) => theme.fg(color, text);

  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    switch (line.kind) {
      case "file":
        fileAnchors.push(out.length);
        out.push(fg("accent", theme.bold(line.raw)));
        i++;
        break;
      case "hunk":
        hunkAnchors.push(out.length);
        out.push(fg("borderAccent", line.raw));
        i++;
        break;
      case "path":
      case "meta":
      case "noeol":
      case "header":
        out.push(fg(metaColor(line.kind) ?? "toolDiffContext", line.raw));
        i++;
        break;
      case "removed":
        i = appendChangeRun(lines, i, out, theme, fg);
        break;
      case "added":
        out.push(fg("toolDiffAdded", `+${line.content}`));
        i++;
        break;
      default:
        out.push(fg("toolDiffContext", line.raw));
        i++;
        break;
    }
  }

  return { lines: out, fileAnchors, hunkAnchors, stats };
}

/** Builds a two-column row string with ANSI-aware truncation and padding. */
type RowFn = (left: string, right: string) => string;

/**
 * Render a git unified diff side-by-side (old | new) using Pi's theme. Removed
 * lines fill the left column, added lines the right; single-line modifications
 * are paired on one row with the same word-level highlighting as the unified
 * view. Context lines appear in both columns.
 *
 * @param diffText Raw unified diff text.
 * @param theme    Pi theme used for colors.
 * @param width    Total viewport width used to size the two columns.
 */
export function renderGitDiffSideBySide(
  diffText: string,
  theme: Theme,
  width: number,
): RenderedDiff {
  const { lines, stats } = parseGitDiff(diffText);
  const out: string[] = [];
  const fileAnchors: number[] = [];
  const hunkAnchors: number[] = [];
  const fg: ColorFn = (color, text) => theme.fg(color, text);

  const gutter = theme.fg("borderMuted", " │ ");
  const gutterWidth = visibleWidth(gutter);
  const colWidth = Math.max(8, Math.floor((width - gutterWidth) / 2));
  const row: RowFn = (left, right) =>
    truncateToWidth(left, colWidth, "", true) +
    gutter +
    truncateToWidth(right, colWidth, "", true);

  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.kind === "file") {
      fileAnchors.push(out.length);
      out.push(fg("accent", theme.bold(line.raw)));
      i++;
    } else if (line.kind === "hunk") {
      hunkAnchors.push(out.length);
      out.push(fg("borderAccent", line.raw));
      i++;
    } else if (line.kind === "meta" || line.kind === "noeol" || line.kind === "header" || line.kind === "path") {
      out.push(fg(metaColor(line.kind) ?? "toolDiffContext", line.raw));
      i++;
    } else if (line.kind === "removed") {
      i = appendSideBySideRun(lines, i, out, theme, fg, row);
    } else if (line.kind === "added") {
      out.push(row("", fg("toolDiffAdded", `+${line.content}`)));
      i++;
    } else {
      out.push(
        row(
          fg("toolDiffContext", line.content),
          fg("toolDiffContext", line.content),
        ),
      );
      i++;
    }
  }

  return { lines: out, fileAnchors, hunkAnchors, stats };
}

/**
 * Build a compact plain-text summary of a diff for confirmation dialogs (which
 * only render plain text): a `N files: +A -R` header followed by a per-file
 * breakdown. Returns an empty string when there are no file changes.
 *
 * @param diffText Raw unified diff text.
 */
export function formatDiffSummary(diffText: string): string {
  const { lines, stats } = parseGitDiff(diffText);

  if (stats.files === 0) {
    return "";
  }

  const files: FileBreakdown[] = [];
  let current: FileBreakdown | null = null;

  for (const line of lines) {
    if (line.kind === "file") {
      current = { path: line.content, added: 0, removed: 0 };
      files.push(current);
    } else if (current !== null && line.kind === "added") {
      current.added++;
    } else if (current !== null && line.kind === "removed") {
      current.removed++;
    }
  }

  const noun = stats.files === 1 ? "file" : "files";
  const header = `${stats.files} ${noun}: +${stats.added} -${stats.removed}`;
  const width = files.reduce((max, f) => Math.max(max, f.path.length), 0);
  const rows = files.map(
    (f) => `  ${f.path.padEnd(width)}  +${f.added} -${f.removed}`,
  );

  return [header, ...rows].join("\n");
}

type FileBreakdown = { path: string; added: number; removed: number };

/**
 * Consume a run of removed lines (and any immediately following added lines),
 * pushing the colored output. Single removed→added pairs get intra-line word
 * highlighting.
 *
 * @param lines Parsed diff lines.
 * @param start Index of the first removed line.
 * @param out   Accumulator for rendered lines.
 * @param theme Pi theme used for inverse highlighting.
 * @param fg    Color helper.
 * @returns The index past the consumed run.
 */
function appendChangeRun(
  lines: ParsedLine[],
  start: number,
  out: string[],
  theme: Theme,
  fg: ColorFn,
): number {
  const removed: string[] = [];
  const added: string[] = [];
  let i = start;

  while (i < lines.length && lines[i].kind === "removed") {
    removed.push(lines[i].content);
    i++;
  }

  while (i < lines.length && lines[i].kind === "added") {
    added.push(lines[i].content);
    i++;
  }

  if (removed.length === 1 && added.length === 1) {
    const { removedLine, addedLine } = renderIntraLineDiff(
      removed[0],
      added[0],
      theme,
    );

    out.push(fg("toolDiffRemoved", `-${removedLine}`));
    out.push(fg("toolDiffAdded", `+${addedLine}`));
  } else {
    removed.forEach((content) => out.push(fg("toolDiffRemoved", `-${content}`)));
    added.forEach((content) => out.push(fg("toolDiffAdded", `+${content}`)));
  }

  return i;
}

/**
 * Consume a run of removed lines (and any immediately following added lines)
 * and emit paired two-column rows. Removed and added lines are zipped so a
 * modification lands on one row; leftover removed lines are left-only, leftover
 * added lines right-only. Each paired row reuses the word-level highlighting.
 *
 * @param lines Parsed diff lines.
 * @param start Index of the first removed line.
 * @param out   Accumulator for rendered rows.
 * @param theme Pi theme used for inverse highlighting.
 * @param fg    Color helper.
 * @param row   Two-column row builder.
 * @returns The index past the consumed run.
 */
function appendSideBySideRun(
  lines: ParsedLine[],
  start: number,
  out: string[],
  theme: Theme,
  fg: ColorFn,
  row: RowFn,
): number {
  const removed: string[] = [];
  const added: string[] = [];
  let i = start;

  while (i < lines.length && lines[i].kind === "removed") {
    removed.push(lines[i].content);
    i++;
  }

  while (i < lines.length && lines[i].kind === "added") {
    added.push(lines[i].content);
    i++;
  }

  const count = Math.max(removed.length, added.length);

  for (let r = 0; r < count; r++) {
    const hasRemoved = r < removed.length;
    const hasAdded = r < added.length;
    let left = "";
    let right = "";

    if (hasRemoved && hasAdded) {
      const { removedLine, addedLine } = renderIntraLineDiff(
        removed[r],
        added[r],
        theme,
      );

      left = fg("toolDiffRemoved", removedLine);
      right = fg("toolDiffAdded", addedLine);
    } else if (hasRemoved) {
      left = fg("toolDiffRemoved", removed[r]);
    } else {
      right = fg("toolDiffAdded", added[r]);
    }

    out.push(row(left, right));
  }

  return i;
}

/**
 * Compute a word-level diff between two line contents and render the changed
 * tokens with `theme.inverse()`, matching Pi's edit-tool diff highlighting.
 * Leading whitespace is kept unhighlighted so indentation isn't marked as a
 * change.
 *
 * @param oldContent The removed line content.
 * @param newContent The added line content.
 * @param theme      Pi theme used for inverse highlighting.
 */
function renderIntraLineDiff(
  oldContent: string,
  newContent: string,
  theme: Theme,
): { removedLine: string; addedLine: string } {
  const parts = diffWords(oldContent, newContent);
  let removedLine = "";
  let addedLine = "";
  let isFirstRemoved = true;
  let isFirstAdded = true;

  for (const part of parts) {
    if (part.removed) {
      const { styled, rest } = stripLeadingAndInverse(part.value, theme);

      if (isFirstRemoved) {
        removedLine += rest;
        isFirstRemoved = false;
      }

      removedLine += styled;
    } else if (part.added) {
      const { styled, rest } = stripLeadingAndInverse(part.value, theme);

      if (isFirstAdded) {
        addedLine += rest;
        isFirstAdded = false;
      }

      addedLine += styled;
    } else {
      removedLine += part.value;
      addedLine += part.value;
    }
  }

  return { removedLine, addedLine };
}

/**
 * Strip leading whitespace from `value` (returning it untouched) and apply
 * `theme.inverse()` to the remainder, unless it is empty.
 *
 * @param value The word-diff part value.
 * @param theme Pi theme used for inverse highlighting.
 */
function stripLeadingAndInverse(
  value: string,
  theme: Theme,
): { styled: string; rest: string } {
  const leading = (/^\s*/u.exec(value))?.[0] ?? "";
  const rest = value.slice(leading.length);

  return { styled: rest !== "" ? theme.inverse(rest) : "", rest: leading };
}
