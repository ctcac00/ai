/**
 * Night Owl Footer Extension
 *
 * Custom footer styled with Night Owl colors.
 *
 * LEFT:  10.3k (0.9%) · $0.34
 * RIGHT: ○ <model> · <thinking>
 *
 * Session cost (rightmost LEFT segment) shows only when > 0.
 *
 * Session title lives in the editor's top border (Night-Owl blue pill/tag,
 * right-aligned with ~5% right padding, uncapped except by terminal width,
 * first-message fallback) — see SessionTitleEditor below.
 */

import type { ContextUsage, ExtensionAPI, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
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

// ── Tag/pill helpers ─────────────────────────────────────────────────────────
/** Parse "#rrggbb" → [r,g,b]. */
function rgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Single SGR with combined fg + bg. (Nested ansi() resets would cancel the bg.) */
function tag(fgHex: string, bgHex: string, text: string): string {
  const [fr, fg, fb] = rgb(fgHex);
  const [br, bg, bb] = rgb(bgHex);
  return `\x1b[38;2;${fr};${fg};${fb};48;2;${br};${bg};${bb}m${text}\x1b[0m`;
}

// Session title pill: Night-Owl periwinkle tag, dark navy text.
const PILL_FG = "#0d1f3c";
const PILL_BG = NO_BLUE;
const pill = (text: string) => tag(PILL_FG, PILL_BG, text);

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

/** Extract plain text from a message content (string or parts array). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
      .join(" ")
      .trim();
  }
  return "";
}

/** First user message text, whitespace collapsed (uncapped — render() truncates). */
function firstMessageTitle(entries: ReadonlyArray<{ type: string; message?: any }>): string {
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg?.role !== "user") continue;
    const text = contentText(msg.content).replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return "";
}

/** Strip ANSI SGR escape sequences. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Editor that splices the session title into the top border line, right-aligned
 * against the right edge. Works for both the plain dash border and the scroll
 * indicator ("─── ↑ N more ───") so the title never disappears while composing
 * long input. Inherits all input behavior (history, undo, paste, autocomplete,
 * slash menus) from CustomEditor.
 */
class SessionTitleEditor extends CustomEditor {
  private title = "";

  setTitle(title: string): void {
    this.title = title;
  }

  render(width: number): string[] {
    const lines = super.render(width);
    const title = this.title;
    if (!title || lines.length === 0) return lines;
    const top = lines[0];
    const topPlain = stripAnsi(top);
    // Top border is either a plain dash run, or the scroll indicator
    // ("─── ↑ N more ───") when the input is scrolled. Splice the title in
    // both cases so it stays visible while composing long input.
    const scrollMatch = /^(─── [↑↓] \d+ more )─*$/.exec(topPlain);
    if (!scrollMatch && !/^─+$/.test(topPlain)) return lines;
    // Right padding: ~2% of width so the title isn't flush against the edge.
    const padRight = Math.max(1, Math.floor(width * 0.02));
    // No fixed char limit — truncate only by terminal width so the border
    // never overflows (2 cols reserved for the surrounding spaces).
    const label = pill(` ${truncateToWidth(title, Math.max(1, width - padRight - 2), "…")} `);
    const labelWidth = visibleWidth(label);
    if (labelWidth + padRight > width) return lines; // too narrow — keep original border
    if (scrollMatch) {
      // Keep the indicator on the left: indicator, dash run, title, padding.
      const indicator = scrollMatch[1];
      const rest = width - visibleWidth(indicator) - labelWidth - padRight;
      if (rest < 0) return lines;
      const coloredIdx = top.indexOf(topPlain);
      lines[0] =
        top.slice(0, coloredIdx) +
        indicator +
        this.borderColor("─".repeat(rest)) +
        label +
        this.borderColor("─".repeat(padRight)) +
        top.slice(coloredIdx + topPlain.length);
    } else {
      lines[0] =
        this.borderColor("─".repeat(width - labelWidth - padRight)) +
        label +
        this.borderColor("─".repeat(padRight));
    }
    return lines;
  }
}

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
  let titleEditor: SessionTitleEditor | null = null;
  // requestRender handle — set once footer is registered
  let requestRender: (() => void) | null = null;

  /** Session name, or first-user-message fallback, uncapped — render() truncates. */
  function refreshTitle(ctx: any) {
    const named = ctx.sessionManager.getSessionName();
    const title = named || firstMessageTitle(ctx.sessionManager.getEntries() as any);
    titleEditor?.setTitle(title);
  }

  // ── Event handlers (registered once at load) ─────────────────────────────

  pi.on("thinking_level_select", (event) => {
    thinkingLevel = event.level as string;
    requestRender?.();
  });

  // Session renamed via /name, pi.setSessionName(), or pi-sessions /title
  pi.on("session_info_changed", (_event, ctx) => {
    refreshTitle(ctx);
    requestRender?.();
  });

  pi.on("turn_end", async (_event, ctx) => {
    sessionCost = computeSessionCost(ctx.sessionManager.getEntries() as any);
    refreshTitle(ctx);
    requestRender?.();
  });

  // ── Session start: init state + register footer ───────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    thinkingLevel = (pi.getThinkingLevel() ?? "off") as string;

    // Initial session cost + title
    sessionCost = computeSessionCost(ctx.sessionManager.getEntries() as any);

    // Replace editor with one that carries the title in its top border.
    // All input behavior is inherited; pi re-wires callbacks, autocomplete,
    // and the live borderColor closure on creation.
    ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
      titleEditor = new SessionTitleEditor(tui, theme, keybindings);
      return titleEditor;
    });

    refreshTitle(ctx); // after editor exists, so the border shows it immediately

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
