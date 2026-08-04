import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";

import type { RenderedDiff } from "../snapshot/parse-diff.js";
import {
  renderGitDiff,
  renderGitDiffSideBySide,
} from "../snapshot/parse-diff.js";

/** Subset of the TUI the viewer needs (keeps the type looser than the full TUI). */
type TuiLike = {
  requestRender(): void;
  terminal: { rows: number };
};

const HELP =
  "j/k scroll · n/N file · {/} hunk · s split · space/b page · g/G top/bottom · q close";

/**
 * Scrollable, keyboard-navigable diff viewer shown as a Pi overlay.
 *
 * Renders a viewport slice of the pre-colored diff lines and updates a scroll
 * offset in response to keys. Height is derived from the terminal so the
 * overlay always fits. Supports a unified↔side-by-side toggle (`s`).
 */
export class DiffViewer implements Component {
  private rendered: RenderedDiff | null = null;
  private renderedKey = "";
  private splitMode = false;
  private offset = 0;

  /**
   * @param tui       Pi TUI, used to read terminal height and request redraws.
   * @param theme     Pi theme used to color the diff.
   * @param done      Close callback from `ctx.ui.custom()`.
   * @param title     Heading shown at the top of the viewer.
   * @param diffText  Raw git unified diff to render.
   */
  constructor(
    private readonly tui: TuiLike,
    private readonly theme: Theme,
    private readonly done: () => void,
    private readonly title: string,
    private readonly diffText: string,
  ) {}

  /**
   * Number of diff lines that fit between the title and the help bar.
   * Sized to the overlay's `95%` maxHeight (see `showDiffViewer`) so the help
   * bar is never clipped on tall terminals.
   */
  private get viewportHeight(): number {
    return Math.max(6, Math.floor(this.tui.terminal.rows * 0.95) - 2);
  }

  /**
   * Render the diff for the current mode, caching by (mode, width).
   * @param width
   */
  private getRendered(width: number): RenderedDiff {
    const key = `${this.splitMode ? "split" : "unified"}:${width}`;

    if (this.rendered !== null && this.renderedKey === key) {
      return this.rendered;
    }

    this.rendered = this.splitMode
      ? renderGitDiffSideBySide(this.diffText, this.theme, width)
      : renderGitDiff(this.diffText, this.theme);
    this.renderedKey = key;

    return this.rendered;
  }

  /** @param data Raw keypress from the focused component. */
  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q" || data === "Q") {
      this.done();

      return;
    }

    if (data === "s" || data === "S") {
      this.splitMode = !this.splitMode;
      this.rendered = null;
      this.renderedKey = "";
      this.tui.requestRender();

      return;
    }

    const h = this.viewportHeight;
    const max = Math.max(0, (this.rendered?.lines.length ?? 0) - h);

    if (data === "j" || data === "J" || matchesKey(data, "down")) {
      this.offset = Math.min(this.offset + 1, max);
    } else if (data === "k" || data === "K" || matchesKey(data, "up")) {
      this.offset = Math.max(this.offset - 1, 0);
    } else if (
      matchesKey(data, "pageDown") ||
      data === " " ||
      data === "f"
    ) {
      this.offset = Math.min(this.offset + h - 1, max);
    } else if (matchesKey(data, "pageUp") || data === "b") {
      this.offset = Math.max(this.offset - (h - 1), 0);
    } else if (data === "g") {
      this.offset = 0;
    } else if (data === "G") {
      this.offset = max;
    } else if (data === "n") {
      this.offset = this.nextAnchor(this.rendered?.fileAnchors ?? [], 1);
    } else if (data === "N") {
      this.offset = this.nextAnchor(this.rendered?.fileAnchors ?? [], -1);
    } else if (data === "}") {
      this.offset = this.nextAnchor(this.rendered?.hunkAnchors ?? [], 1);
    } else if (data === "{") {
      this.offset = this.nextAnchor(this.rendered?.hunkAnchors ?? [], -1);
    }

    this.tui.requestRender();
  }

  /**
   * Jump to the next/previous anchor relative to the current offset.
   *
   * @param anchors   Rendered-line indices of file or hunk boundaries.
   * @param direction `1` for next, `-1` for previous.
   * @returns The new scroll offset.
   */
  private nextAnchor(anchors: number[], direction: 1 | -1): number {
    if (anchors.length === 0) {
      return this.offset;
    }

    if (direction === 1) {
      return anchors.find((a) => a > this.offset) ?? this.offset;
    }

    return [...anchors].reverse().find((a) => a < this.offset) ?? 0;
  }

  /** Invalidate cached rendering state (none beyond the keyed render cache). */
  invalidate(): void {
    this.rendered = null;
    this.renderedKey = "";
  }

  /** @param width Current viewport width (sizes the split columns). */
  render(width: number): string[] {
    const { lines, stats } = this.getRendered(width);
    const h = this.viewportHeight;

    // Clamp offset if the line count shrank (e.g. after toggling modes).
    const max = Math.max(0, lines.length - h);

    if (this.offset > max) {
      this.offset = max;
    }

    const end = Math.min(this.offset + h, lines.length);

    const out: string[] = [];

    out.push(
      this.theme.fg("accent", this.theme.bold(this.title)) +
        "  " +
        this.theme.fg(
          "dim",
          `${stats.files} files  +${stats.added} -${stats.removed}  (${this.splitMode ? "split" : "unified"})`,
        ),
    );
    out.push(...lines.slice(this.offset, end));

    const position =
      lines.length === 0
        ? "0-0/0"
        : `${this.offset + 1}-${end}/${lines.length}`;

    out.push(this.theme.fg("muted", `${HELP}   [${position}]`));

    return out;
  }
}

/**
 * Open a scrollable diff viewer overlay. Falls back to a plain notification
 * when the session is not running in the interactive TUI or there is no diff.
 *
 * @param diffText     Raw git unified diff, or `noDiffMessage` when identical.
 * @param title        Heading shown at the top of the viewer.
 * @param ctx          Pi command context used for UI access.
 * @param noDiffMessage Sentinel string meaning "no changes".
 */
export async function showDiffViewer(
  diffText: string,
  title: string,
  ctx: ExtensionCommandContext,
  noDiffMessage: string,
): Promise<void> {
  const isEmpty = diffText === noDiffMessage;

  if (isEmpty || ctx.mode !== "tui") {
    ctx.ui.notify(diffText, isEmpty ? "info" : "warning");

    return;
  }

  await ctx.ui.custom(
    (tui, theme, _keybindings, done) =>
      new DiffViewer(
        tui as TuiLike,
        theme,
        () => {
          done(undefined);
        },
        title,
        diffText,
      ),
    {
      overlay: true,
      overlayOptions: {
        width: "100%",
        maxHeight: "95%",
        anchor: "top-center",
        margin: { top: 0 },
      },
    },
  );
}
