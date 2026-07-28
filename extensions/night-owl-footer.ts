/**
 * Night Owl Footer Extension
 *
 * Custom footer styled with Night Owl colors.
 *
 * LEFT:  10.3k (0.9%) · $0.34
 * RIGHT: ○ <model> · <thinking>
 *
 * Session cost (rightmost LEFT segment) shows only when > 0.
 */

import type { ContextUsage, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── Night Owl palette ────────────────────────────────────────────────────────
const NO_BLUE   = "#82aaff";
const NO_PURPLE = "#c792ea";
const NO_CYAN   = "#7efcff";
const NO_YELLOW = "#addb67";
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
const cyan   = (t: string) => ansi(NO_CYAN,   t);
const yellow = (t: string) => ansi(NO_YELLOW, t);
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

// ── Formatting helpers ───────────────────────────────────────────────────────
/** Defensive total-cost extraction (handles number/string/object legacy shapes). */
function extractCostTotal(usage: unknown): number {
  if (!usage) return 0;
  const c = (usage as any)?.cost;
  if (typeof c === "number") return Number.isFinite(c) ? c : 0;
  if (typeof c === "string") { const n = Number(c); return Number.isFinite(n) ? n : 0; }
  const t = (c as any)?.total;
  if (typeof t === "number") return Number.isFinite(t) ? t : 0;
  if (typeof t === "string") { const n = Number(t); return Number.isFinite(n) ? n : 0; }
  return 0;
}

/** Sum session cost across assistant messages in the session entry list. */
function computeSessionCost(entries: ReadonlyArray<{ type: string; message?: any }>): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg?.role !== "assistant") continue;
    total += extractCostTotal(msg?.usage);
  }
  return total;
}

/** Session cost: hidden at 0; dim <$1, yellow <$5, red >=$5. Mirrors context-% rule. */
function fmtCost(cost: number): string {
  const str = `$${cost.toFixed(2)}`;
  if (cost < 1) return dim(str);
  if (cost < 5) return yellow(str);
  return red(str);
}

function fmtTokens(tokens: number | null | undefined): string {
  if (tokens == null) return dim("—");
  if (tokens < 1000) return dim(`${tokens}`);
  if (tokens < 1_000_000) return dim(`${(tokens / 1000).toFixed(1)}k`);
  return dim(`${(tokens / 1_000_000).toFixed(1)}M`);
}

/** Render context usage as `10.3k (0.9%)`. Tokens dim; percent colored by level. */
function contextUsageStr(usage: ContextUsage | undefined): string {
  const tokensStr = fmtTokens(usage?.tokens);
  const percent = usage?.percent;
  if (percent == null) return tokensStr;
  const label = `${percent.toFixed(1)}%`;
  const colored = percent < 50 ? dim(label) : percent < 80 ? yellow(label) : red(label);
  return `${tokensStr} ${dim("(")}${colored}${dim(")")}`;
}

// ── Extension ────────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  let thinkingLevel: string = "off";
  let sessionCost: number = 0;
  // requestRender handle — set once footer is registered
  let requestRender: (() => void) | null = null;

  // ── Event handlers (registered once at load) ─────────────────────────────

  pi.on("thinking_level_select", (event) => {
    thinkingLevel = event.level as string;
    requestRender?.();
  });

  pi.on("turn_end", async (_event, ctx) => {
    sessionCost = computeSessionCost(ctx.sessionManager.getEntries() as any);
    requestRender?.();
  });

  // ── Session start: init state + register footer ───────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    thinkingLevel = (pi.getThinkingLevel() ?? "off") as string;

    // Initial session cost
    sessionCost = computeSessionCost(ctx.sessionManager.getEntries() as any);

    ctx.ui.setFooter((tui, _theme, footerData) => {
      // Wire up render handle
      requestRender = () => tui.requestRender();

      return {
        dispose: () => {
          requestRender = null;
        },

        invalidate() {},

        render(width: number): string[] {
          // ── Context usage ──
          const usage = ctx.getContextUsage();

          // ── LEFT: ctx % · $cost (cost only when > 0) ──
          const left = contextUsageStr(usage)
            + (sessionCost > 0 ? SEP + fmtCost(sessionCost) : "");

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
