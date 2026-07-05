/**
 * Night Owl Footer Extension
 *
 * Custom footer styled with Night Owl colors.
 *
 * LEFT:  🌿 <branch> <git-status> · <repo/dir>
 * RIGHT: 🧠 <thinking> · ○ <model> · 💰 $cost · ⏱ Xm Xs · X tokens
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
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
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

function thinkingLabel(level: ThinkingLevel): string {
  switch (level) {
    case "off":     return dim("🧠 off");
    case "minimal": return dim("🧠 minimal");
    case "low":     return blue("🧠 low");
    case "medium":  return yellow("🧠 medium");
    case "high":    return purple("🧠 high");
    case "xhigh":   return cyan("🧠 max");
  }
}

// ── Git status ───────────────────────────────────────────────────────────────
interface GitStatus {
  dirty: boolean;
  ahead: number;
  behind: number;
}

async function fetchGitStatus(cwd: string, pi: ExtensionAPI): Promise<GitStatus> {
  try {
    const [statusResult, aheadBehindResult] = await Promise.all([
      pi.exec("git", ["status", "--porcelain"], { cwd }),
      pi.exec("git", ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], { cwd }),
    ]);
    const dirty = statusResult.stdout.trim().length > 0;
    let ahead = 0, behind = 0;
    const parts = aheadBehindResult.stdout.trim().split(/\s+/);
    if (parts.length === 2) {
      behind = parseInt(parts[0] ?? "0", 10) || 0;
      ahead  = parseInt(parts[1] ?? "0", 10) || 0;
    }
    return { dirty, ahead, behind };
  } catch {
    return { dirty: false, ahead: 0, behind: 0 };
  }
}

function gitStatusStr(branch: string | null, status: GitStatus): string {
  const branchStr = branch ? blue(`🌿 ${branch}`) : dim("🌿 detached");
  const dot = status.dirty ? yellow("●") : green("●");
  const indicators: string[] = [dot];
  if (status.ahead  > 0) indicators.push(cyan(`↑${status.ahead}`));
  if (status.behind > 0) indicators.push(red(`↓${status.behind}`));
  return branchStr + " " + indicators.join(" ");
}

// ── Formatting helpers ───────────────────────────────────────────────────────
function fmtTokens(n: number): string {
  if (n === 0) return "0.0k";
  return `${(n / 1000).toFixed(1)}k`;
}

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function fmtCost(cost: number): string {
  const str = `💰 $${cost.toFixed(1)}`;
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
  let thinkingLevel: ThinkingLevel = "off";
  let gitStatus: GitStatus = { dirty: false, ahead: 0, behind: 0 };
  let agentStartTime: number | null = null;
  let elapsedMs = 0;
  // requestRender handle — set once footer is registered
  let requestRender: (() => void) | null = null;

  // ── Event handlers (registered once at load) ─────────────────────────────

  pi.on("thinking_level_select", (event) => {
    thinkingLevel = event.level as ThinkingLevel;
    requestRender?.();
  });

  pi.on("agent_start", () => {
    agentStartTime = Date.now();
  });

  pi.on("agent_end", () => {
    if (agentStartTime !== null) {
      elapsedMs += Date.now() - agentStartTime;
      agentStartTime = null;
    }
    requestRender?.();
  });

  pi.on("turn_end", async (_event, ctx) => {
    gitStatus = await fetchGitStatus(ctx.cwd, pi);
    requestRender?.();
  });

  // ── Session start: init state + register footer ───────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    thinkingLevel = (pi.getThinkingLevel() ?? "off") as ThinkingLevel;
    elapsedMs = 0;
    agentStartTime = null;

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
          // ── Session stats ──
          let inputTokens = 0;
          let outputTokens = 0;
          let totalCost   = 0;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && e.message.role === "assistant") {
              const m = e.message as AssistantMessage;
              inputTokens  += m.usage.input ?? 0;
              outputTokens += m.usage.output ?? 0;
              totalCost   += m.usage.cost?.total ?? 0;
            }
          }

          // ── Elapsed time ──
          const elapsed = elapsedMs + (agentStartTime !== null ? Date.now() - agentStartTime : 0);

          // ── Context usage ──
          const usage = ctx.getContextUsage();

          // ── LEFT: repo · 🌿 branch ● [↑↓] · ▓▓░░ 45% · 💰 cost · ⏱ time · tokens ──
          const branch  = footerData.getGitBranch();
          const repoDir = ctx.cwd.split("/").pop() ?? ctx.cwd;
          const leftExtra = [
            fmtCost(totalCost),
            dim(`⏱ ${fmtTime(elapsed)}`),
            dim(`↓${fmtTokens(inputTokens)} ↑${fmtTokens(outputTokens)}`),
          ].join(SEP);
          const left    = cyan(repoDir) + SEP + gitStatusStr(branch, gitStatus) + SEP + contextBar(usage?.percent) + SEP + leftExtra;

          // ── RIGHT: ○ model · 🧠 thinking ──
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
