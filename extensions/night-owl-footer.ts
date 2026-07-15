/**
 * Night Owl Footer Extension
 *
 * Custom footer styled with Night Owl colors.
 *
 * LEFT:  <repo/dir> · <branch> +N -N !N ?N ↑N ↓N · ▓▓░░ 45%
 * RIGHT: ○ <model> · <thinking>
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── Night Owl palette ────────────────────────────────────────────────────────
const NO_BLUE   = "#82aaff";
const NO_PURPLE = "#c792ea";
const NO_GREEN  = "#22da6e";
const NO_YELLOW = "#addb67";
const NO_CYAN   = "#7efcff";
const NO_RED    = "#ef5350";
const NO_DIM    = "#637777";

function ansi(hex: string, text: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

const dim    = (t: string) => ansi(NO_DIM,    t);
const blue   = (t: string) => ansi(NO_BLUE,   t);
const green  = (t: string) => ansi(NO_GREEN,  t);
const yellow = (t: string) => ansi(NO_YELLOW, t);
const cyan   = (t: string) => ansi(NO_CYAN,   t);
const red    = (t: string) => ansi(NO_RED,    t);
const purple = (t: string) => ansi(NO_PURPLE, t);

const SEP = dim(" · ");

// ── Thinking level ───────────────────────────────────────────────────────────
// Render the raw pi level string verbatim (off/minimal/low/medium/high/xhigh/max
// and anything pi adds later). Each known level gets a Night-Owl color; unknown
// levels fall back to dim so the footer never prints `undefined`.
const THINKING_COLORS: Record<string, (t: string) => string> = {
  off:     dim,
  minimal: dim,
  low:     blue,
  medium:  yellow,
  high:    purple,
  xhigh:   cyan,
  max:     red,
};

function thinkingLabel(level: string): string {
  const color = THINKING_COLORS[level] ?? dim;
  return color(level);
}

// ── Git status ───────────────────────────────────────────────────────────────
interface GitStatus {
  added: number;
  modified: number;
  deleted: number;
  untracked: number;
  ahead: number;
  behind: number;
}

const EMPTY_STATUS: GitStatus = {
  added: 0, modified: 0, deleted: 0, untracked: 0, ahead: 0, behind: 0,
};

/**
 * Parse `git status --porcelain` output into working-tree change counts.
 * Each file is counted once, bucketed by its most significant change:
 *   +  added        (A)
 *   -  deleted      (D)
 *   !  modified     (M, R, C, or unmerged U)
 *   ?  untracked    (??)
 */
function parsePorcelain(output: string): Pick<GitStatus, "added" | "modified" | "deleted" | "untracked"> {
  let added = 0, modified = 0, deleted = 0, untracked = 0;
  for (const raw of output.split("\n")) {
    if (raw.length < 2) continue;
    const x = raw[0]!;
    const y = raw[1]!;
    if (x === "?" && y === "?") { untracked++; continue; }
    if (x === "A" || y === "A") { added++; continue; }
    if (x === "D" || y === "D") { deleted++; continue; }
    if (
      x === "M" || y === "M" ||
      x === "R" || y === "R" ||
      x === "C" || y === "C" ||
      x === "U" || y === "U"
    ) {
      modified++;
    }
  }
  return { added, modified, deleted, untracked };
}

async function fetchGitStatus(cwd: string, pi: ExtensionAPI): Promise<GitStatus> {
  try {
    const [statusResult, aheadBehindResult] = await Promise.all([
      pi.exec("git", ["status", "--porcelain"], { cwd }),
      pi.exec("git", ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], { cwd }),
    ]);
    const counts = parsePorcelain(statusResult.stdout);
    let ahead = 0, behind = 0;
    const parts = aheadBehindResult.stdout.trim().split(/\s+/);
    if (parts.length === 2) {
      behind = parseInt(parts[0] ?? "0", 10) || 0;
      ahead  = parseInt(parts[1] ?? "0", 10) || 0;
    }
    return { ...counts, ahead, behind };
  } catch {
    return { ...EMPTY_STATUS };
  }
}

function gitStatusStr(branch: string | null, status: GitStatus): string {
  const branchStr = branch ? blue(branch) : dim("detached");
  const indicators: string[] = [];
  if (status.added > 0)     indicators.push(green(`+${status.added}`));
  if (status.deleted > 0)   indicators.push(red(`-${status.deleted}`));
  if (status.modified > 0)  indicators.push(yellow(`!${status.modified}`));
  if (status.untracked > 0) indicators.push(dim(`?${status.untracked}`));
  if (status.ahead > 0)     indicators.push(cyan(`↑${status.ahead}`));
  if (status.behind > 0)    indicators.push(red(`↓${status.behind}`));
  return indicators.length > 0 ? `${branchStr} ${indicators.join(" ")}` : branchStr;
}

// ── Formatting helpers ───────────────────────────────────────────────────────
function fmtCost(cost: number): string {
  const str = `$${cost.toFixed(1)}`;
  return cost === 0 ? green(str) : yellow(str);
}

function contextBar(percent: number | null | undefined): string {
  if (percent == null) return dim("▕░░░░░░░░░▏");
  const width = 10;
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const label = `${percent.toFixed(1)}%`;
  // color by usage level
  const colored = percent < 50 ? green(bar) : percent < 80 ? yellow(bar) : red(bar);
  return colored + dim(" ") + (percent < 50 ? dim(label) : percent < 80 ? yellow(label) : red(label));
}

// ── Extension ────────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  let thinkingLevel: string = "off";
  let gitStatus: GitStatus = { ...EMPTY_STATUS };
  // requestRender handle — set once footer is registered
  let requestRender: (() => void) | null = null;

  // ── Event handlers (registered once at load) ─────────────────────────────

  pi.on("thinking_level_select", (event) => {
    thinkingLevel = event.level as string;
    requestRender?.();
  });

  pi.on("turn_end", async (_event, ctx) => {
    gitStatus = await fetchGitStatus(ctx.cwd, pi);
    requestRender?.();
  });

  // ── Session start: init state + register footer ───────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    thinkingLevel = (pi.getThinkingLevel() ?? "off") as string;

    // Initial git status
    gitStatus = await fetchGitStatus(ctx.cwd, pi);

    ctx.ui.setFooter((tui, _theme, footerData) => {
      // Wire up render handle
      requestRender = () => tui.requestRender();

      // Re-render + refresh git status on branch changes
      const unsub = footerData.onBranchChange(async () => {
        gitStatus = await fetchGitStatus(ctx.cwd, pi);
        tui.requestRender();
      });

      return {
        dispose: () => {
          unsub();
          requestRender = null;
        },

        invalidate() {},

        render(width: number): string[] {


          // ── Context usage ──
          const usage = ctx.getContextUsage();

          // ── LEFT: repo · branch +N -N !N ?N ↑N ↓N · ▓▓░░ 45% · $cost ──
          const branch  = footerData.getGitBranch();
          const repoDir = ctx.cwd.split("/").pop() ?? ctx.cwd;
          const left    = cyan(repoDir)
            + SEP + gitStatusStr(branch, gitStatus)
            + SEP + contextBar(usage?.percent);

          // ── RIGHT: ○ model · thinking ──
          const modelStr = ctx.model?.id ? blue(`○ ${ctx.model.id}`) : dim("○ no model");
          const right = [
            modelStr,
            thinkingLabel(thinkingLevel),
          ].join(SEP);

          // ── Compose with padding ──
          const leftW  = visibleWidth(left);
          const rightW = visibleWidth(right);
          const gap    = width - leftW - rightW;

          const mainLine = gap < 1
            ? truncateToWidth(left, width)
            : truncateToWidth(left + " ".repeat(gap) + right, width);

          const lines = [mainLine];

          // ── Extension statuses (2nd line, only if any) ──
          const statuses = footerData.getExtensionStatuses();
          if (statuses.size > 0) {
            const statusLine = Array.from(statuses.values())
              .sort()
              .join(" ");
            lines.push(truncateToWidth(statusLine, width, "..."));
          }

          return lines;
        },
      };
    });
  });
}
