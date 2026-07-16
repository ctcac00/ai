/**
 * /session-breakdown
 *
 * Interactive TUI that analyzes ~/.pi/agent/sessions (recursively, *.jsonl) and shows
 * last 7/30/90 days of:
 * - sessions/day
 * - messages/day
 * - tokens/day (if available)
 * - cost/day (if available)
 * - model breakdown (sessions/messages/tokens + cost)
 *
 * Graph:
 * - GitHub-contributions-style calendar (weeks x weekdays)
 * - Hue: weighted mix of popular model colors (weighted by the selected metric)
 * - Brightness: selected metric per day (log-scaled)
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  sliceByColumn,
  type Component,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream, type Dirent } from "node:fs";
import readline from "node:readline";

type ModelKey = string; // `${provider}/${model}`
type CwdKey = string; // normalized cwd path
type DowKey = string; // "Mon", "Tue", etc.
type TodKey = string; // "after-midnight", "morning", "afternoon", "evening", "night"
type BreakdownView = "model" | "cwd" | "dow" | "tod";

/**
 * Per-message token breakdown, parsed from session `usage` objects.
 * All five components are tracked independently so we can derive cache
 * health metrics (hit rate, leverage) alongside fresh/billed work.
 *
 *   prompt      = cacheRead + input + cacheWrite   (everything read into prompt)
 *   fresh prompt = input + cacheWrite              (billed input; cacheRead is the hit)
 *   fresh work  = input + output + cacheWrite      (billed tokens, cache hits excluded)
 *   cacheHitRate = cacheRead / prompt               (fraction served from cache)
 *   cacheLeverage = prompt / fresh prompt           (cache saved re-sending ~N×)
 */
interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

const ZERO_TB: TokenBreakdown = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
};

function addTb(into: TokenBreakdown, from: TokenBreakdown): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.reasoning += from.reasoning;
}

function tbTotal(tb: TokenBreakdown): number {
  return tb.input + tb.output + tb.cacheRead + tb.cacheWrite + tb.reasoning;
}

/** Everything the model read from the prompt, from cache or fresh. */
function tbPrompt(tb: TokenBreakdown): number {
  return tb.cacheRead + tb.input + tb.cacheWrite;
}

/** Billed input tokens: fresh input + cache writes (cache hits excluded). */
function tbFreshPrompt(tb: TokenBreakdown): number {
  return tb.input + tb.cacheWrite;
}

/** Billed tokens overall: fresh input + output + cache writes. */
function tbFresh(tb: TokenBreakdown): number {
  return tb.input + tb.output + tb.cacheWrite;
}

/** Fraction of prompt served from cache, 0..1. 0 when no prompt tokens. */
function cacheHitRate(tb: TokenBreakdown): number {
  const p = tbPrompt(tb);
  return p > 0 ? tb.cacheRead / p : 0;
}

/** How many × the cache avoided re-sending the prompt, ≥1, or 0 when no fresh prompt. */
function cacheLeverage(tb: TokenBreakdown): number {
  const fp = tbFreshPrompt(tb);
  return fp > 0 ? tbPrompt(tb) / fp : 0;
}

const DOW_NAMES: DowKey[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const TOD_BUCKETS: { key: TodKey; label: string; from: number; to: number }[] =
  [
    { key: "after-midnight", label: "After midnight (0–5)", from: 0, to: 5 },
    { key: "morning", label: "Morning (6–11)", from: 6, to: 11 },
    { key: "afternoon", label: "Afternoon (12–16)", from: 12, to: 16 },
    { key: "evening", label: "Evening (17–21)", from: 17, to: 21 },
    { key: "night", label: "Night (22–23)", from: 22, to: 23 },
  ];

function todBucketForHour(hour: number): TodKey {
  for (const b of TOD_BUCKETS) {
    if (hour >= b.from && hour <= b.to) return b.key;
  }
  return "after-midnight";
}

function todBucketLabel(key: TodKey): string {
  return TOD_BUCKETS.find((b) => b.key === key)?.label ?? key;
}

interface ParsedSession {
  filePath: string;
  startedAt: Date;
  dayKeyLocal: string; // YYYY-MM-DD (local)
  cwd: CwdKey | null;
  dow: DowKey;
  tod: TodKey;
  modelsUsed: Set<ModelKey>;
  primaryModel: ModelKey; // model with most tokens in the session (for top-sessions list)
  messages: number;
  tokens: number;
  totalCost: number;
  tb: TokenBreakdown; // per-component breakdown (cache health)
  costByModel: Map<ModelKey, number>;
  messagesByModel: Map<ModelKey, number>;
  tokensByModel: Map<ModelKey, number>;
  tbByModel: Map<ModelKey, TokenBreakdown>;
}

interface DayAgg {
  date: Date; // local midnight
  dayKeyLocal: string;
  sessions: number;
  messages: number;
  tokens: number;
  totalCost: number;
  tb: TokenBreakdown; // per-component breakdown (cache health)
  costByModel: Map<ModelKey, number>;
  sessionsByModel: Map<ModelKey, number>;
  messagesByModel: Map<ModelKey, number>;
  tokensByModel: Map<ModelKey, number>;
  tbByModel: Map<ModelKey, TokenBreakdown>;
  sessionsByCwd: Map<CwdKey, number>;
  messagesByCwd: Map<CwdKey, number>;
  tokensByCwd: Map<CwdKey, number>;
  tbByCwd: Map<CwdKey, TokenBreakdown>;
  costByCwd: Map<CwdKey, number>;
  sessionsByTod: Map<TodKey, number>;
  messagesByTod: Map<TodKey, number>;
  tokensByTod: Map<TodKey, number>;
  tbByTod: Map<TodKey, TokenBreakdown>;
  costByTod: Map<TodKey, number>;
}

interface RangeAgg {
  days: DayAgg[];
  dayByKey: Map<string, DayAgg>;
  sessions: number;
  totalMessages: number;
  totalTokens: number;
  totalCost: number;
  tb: TokenBreakdown; // per-component breakdown across the whole range
  modelCost: Map<ModelKey, number>;
  modelSessions: Map<ModelKey, number>; // number of sessions where model was used
  modelMessages: Map<ModelKey, number>;
  modelTokens: Map<ModelKey, number>;
  modelTb: Map<ModelKey, TokenBreakdown>;
  cwdCost: Map<CwdKey, number>;
  cwdSessions: Map<CwdKey, number>;
  cwdMessages: Map<CwdKey, number>;
  cwdTokens: Map<CwdKey, number>;
  cwdTb: Map<CwdKey, TokenBreakdown>;
  dowCost: Map<DowKey, number>;
  dowSessions: Map<DowKey, number>;
  dowMessages: Map<DowKey, number>;
  dowTokens: Map<DowKey, number>;
  dowTb: Map<DowKey, TokenBreakdown>;
  todCost: Map<TodKey, number>;
  todSessions: Map<TodKey, number>;
  todMessages: Map<TodKey, number>;
  todTokens: Map<TodKey, number>;
  todTb: Map<TodKey, TokenBreakdown>;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Lightweight totals for a time window — used for previous-period deltas. */
interface PeriodTotals {
  sessions: number;
  messages: number;
  tokens: number;
  tb: TokenBreakdown;
  cost: number;
}

/** Lightweight per-session record retained for the top-sessions list. */
interface SessionSummary {
  startedAt: Date;
  dayKeyLocal: string;
  cwd: CwdKey | null;
  primaryModel: ModelKey;
  messages: number;
  tokens: number;
  tb: TokenBreakdown;
  cost: number;
}

interface BreakdownData {
  generatedAt: Date;
  ranges: Map<number, RangeAgg>;
  prevTotals: Map<number, PeriodTotals>; // immediately-preceding window per range
  allSessions: SessionSummary[]; // every parsed session (for top-sessions list)
  palette: {
    modelColors: Map<ModelKey, RGB>;
    otherColor: RGB;
    orderedModels: ModelKey[];
  };
  cwdPalette: {
    cwdColors: Map<CwdKey, RGB>;
    otherColor: RGB;
    orderedCwds: CwdKey[];
  };
  dowPalette: {
    dowColors: Map<DowKey, RGB>;
    orderedDows: DowKey[];
  };
  todPalette: {
    todColors: Map<TodKey, RGB>;
    orderedTods: TodKey[];
  };
}

const SESSION_ROOT = path.join(os.homedir(), ".pi", "agent", "sessions");
const RANGE_DAYS = [7, 30, 90] as const;

type MeasurementMode = "sessions" | "messages" | "tokens";

type BreakdownProgressPhase = "scan" | "parse" | "finalize";

interface BreakdownProgressState {
  phase: BreakdownProgressPhase;
  foundFiles: number;
  parsedFiles: number;
  totalFiles: number;
  currentFile?: string;
}

function setBorderedLoaderMessage(loader: BorderedLoader, message: string) {
  // BorderedLoader wraps a (Cancellable)Loader which supports setMessage(),
  // but it doesn't expose it publicly. Access the inner loader for progress updates.
  const inner = (loader as any)["loader"]; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (inner && typeof inner.setMessage === "function") {
    inner.setMessage(message);
  }
}

// Dark-ish background and empty cell color (close to GitHub dark)
const DEFAULT_BG: RGB = { r: 13, g: 17, b: 23 };
const EMPTY_CELL_BG: RGB = { r: 22, g: 27, b: 34 };

// Default palette (assigned to top models)
const PALETTE: RGB[] = [
  { r: 64, g: 196, b: 99 }, // green
  { r: 47, g: 129, b: 247 }, // blue
  { r: 163, g: 113, b: 247 }, // purple
  { r: 255, g: 159, b: 10 }, // orange
  { r: 244, g: 67, b: 54 }, // red
];

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return {
    r: Math.round(lerp(a.r, b.r, t)),
    g: Math.round(lerp(a.g, b.g, t)),
    b: Math.round(lerp(a.b, b.b, t)),
  };
}

function weightedMix(colors: Array<{ color: RGB; weight: number }>): RGB {
  let total = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const c of colors) {
    if (!Number.isFinite(c.weight) || c.weight <= 0) continue;
    total += c.weight;
    r += c.color.r * c.weight;
    g += c.color.g * c.weight;
    b += c.color.b * c.weight;
  }
  if (total <= 0) return EMPTY_CELL_BG;
  return {
    r: Math.round(r / total),
    g: Math.round(g / total),
    b: Math.round(b / total),
  };
}

function ansiBg(rgb: RGB, text: string): string {
  return `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m${text}\x1b[0m`;
}

function ansiFg(rgb: RGB, text: string): string {
  return `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m${text}\x1b[0m`;
}

function dim(text: string): string {
  return `\x1b[2m${text}\x1b[0m`;
}

function bold(text: string): string {
  return `\x1b[1m${text}\x1b[0m`;
}

function formatCount(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

function formatUsd(cost: number): string {
  if (!Number.isFinite(cost)) return "$0.00";
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}

/** Format a 0..1 fraction as an integer percent, e.g. 0.863 -> "86%". */
function formatPct(frac: number): string {
  if (!Number.isFinite(frac) || frac <= 0) return "0%";
  if (frac >= 1) return "100%";
  return `${Math.round(frac * 100)}%`;
}

/** Format a leverage multiple, e.g. 7.3 -> "7.3×"; 0 -> "—". */
function formatLeverage(x: number): string {
  if (!Number.isFinite(x) || x <= 0) return "—";
  if (x >= 100) return `${Math.round(x)}×`;
  if (x >= 10) return `${x.toFixed(0)}×`;
  return `${x.toFixed(1)}×`;
}

/** Cache hit-rate cell: "86%" when prompt tokens exist, "—" otherwise. */
function hitCell(tb: TokenBreakdown): string {
  const p = tbPrompt(tb);
  return p > 0 ? formatPct(cacheHitRate(tb)) : "—";
}

/** Render a horizontal bar for a 0..1 fraction, width cells wide (filled/empty blocks). */
function fracBar(frac: number, width: number, fillRgb?: RGB): string {
  if (width <= 0) return "";
  const f = Math.max(0, Math.min(1, frac));
  let filled = f > 0 ? Math.max(1, Math.round(f * width)) : 0;
  filled = Math.min(width, filled);
  const empty = width - filled;
  const filledStr =
    filled > 0
      ? fillRgb
        ? ansiFg(fillRgb, "█".repeat(filled))
        : "█".repeat(filled)
      : "";
  const emptyStr = empty > 0 ? ansiFg(EMPTY_CELL_BG, "█".repeat(empty)) : "";
  return filledStr + emptyStr;
}

/** Format a signed percent delta, e.g. 0.12 -> "+12%", -0.05 -> "-5%". */
function formatDeltaPct(frac: number): string {
  if (!Number.isFinite(frac)) return "—";
  const pct = Math.round(frac * 100);
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct}%`;
}

/** Format a signed percentage-point delta, e.g. (-0.06) -> "-6pts". */
function formatDeltaPts(frac: number): string {
  if (!Number.isFinite(frac)) return "—";
  const pts = Math.round(frac * 100);
  const sign = pts > 0 ? "+" : "";
  return `${sign}${pts}pts`;
}

/**
 * Abbreviate a path for display. Strategy:
 * - Replace home dir with ~
 * - If still too long, keep first segment + last N segments with … in between
 * Examples:
 *   /Users/mitsuhiko/Development/agent-stuff  →  ~/Development/agent-stuff
 *   /Users/mitsuhiko/Development/minijinja/minijinja-go  →  ~/…/minijinja/minijinja-go
 */
function abbreviatePath(p: string, maxWidth = 40): string {
  const home = os.homedir();
  let display = p;
  if (display.startsWith(home)) {
    display = "~" + display.slice(home.length);
  }
  if (display.length <= maxWidth) return display;

  const parts = display.split("/").filter(Boolean);
  // Always keep the first part (~ or root indicator) and try to keep as many trailing parts as possible
  if (parts.length <= 2) return display;

  const prefix = parts[0]; // typically "~"
  // Try keeping last N parts, increasing until it fits
  for (let keep = parts.length - 1; keep >= 1; keep--) {
    const tail = parts.slice(parts.length - keep);
    const candidate = prefix + "/…/" + tail.join("/");
    if (candidate.length <= maxWidth || keep === 1) return candidate;
  }
  return display;
}

function padRight(s: string, n: number): string {
  const delta = n - s.length;
  return delta > 0 ? s + " ".repeat(delta) : s;
}

function padLeft(s: string, n: number): string {
  const delta = n - s.length;
  return delta > 0 ? " ".repeat(delta) + s : s;
}

function toLocalDayKey(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function localMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function addDaysLocal(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

function countDaysInclusiveLocal(start: Date, end: Date): number {
  // Avoid ms-based day math because DST transitions can make a “day” 23/25h in local time.
  let n = 0;
  for (let d = new Date(start); d <= end; d = addDaysLocal(d, 1)) n++;
  return n;
}

function mondayIndex(date: Date): number {
  // Mon=0 .. Sun=6
  return (date.getDay() + 6) % 7;
}

function modelKeyFromParts(
  provider?: unknown,
  model?: unknown,
): ModelKey | null {
  const p = typeof provider === "string" ? provider.trim() : "";
  const m = typeof model === "string" ? model.trim() : "";
  if (!p && !m) return null;
  if (!p) return m;
  if (!m) return p;
  return `${p}/${m}`;
}

function parseSessionStartFromFilename(name: string): Date | null {
  // Example: 2026-02-02T21-52-28-774Z_<uuid>.jsonl
  const m = name.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/,
  );
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

function extractProviderModelAndUsage(obj: any): {
  provider?: any;
  model?: any;
  modelId?: any;
  usage?: any;
} {
  // Session format varies across versions.
  // - Newer: { provider, model, usage } on the message wrapper
  // - Older: { message: { provider, model, usage } }
  const msg = obj?.message;
  return {
    provider: obj?.provider ?? msg?.provider,
    model: obj?.model ?? msg?.model,
    modelId: obj?.modelId ?? msg?.modelId,
    usage: obj?.usage ?? msg?.usage,
  };
}

function extractCostTotal(usage: any): number {
  if (!usage) return 0;
  const c = usage?.cost;
  if (typeof c === "number") return Number.isFinite(c) ? c : 0;
  if (typeof c === "string") {
    const n = Number(c);
    return Number.isFinite(n) ? n : 0;
  }
  const t = c?.total;
  if (typeof t === "number") return Number.isFinite(t) ? t : 0;
  if (typeof t === "string") {
    const n = Number(t);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function extractTokensTotal(usage: any): number {
  // Usage format varies across providers and pi versions.
  // We try a few common shapes:
  // - { totalTokens }
  // - { total_tokens }
  // - { promptTokens, completionTokens }
  // - { prompt_tokens, completion_tokens }
  // - { input_tokens, output_tokens }
  // - { inputTokens, outputTokens }
  // - { tokens: number | { total } }
  if (!usage) return 0;

  const readNum = (v: any): number => {
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  };

  let total = 0;
  // direct totals
  total =
    readNum(usage?.totalTokens) ||
    readNum(usage?.total_tokens) ||
    readNum(usage?.tokens) ||
    readNum(usage?.tokenCount) ||
    readNum(usage?.token_count);
  if (total > 0) return total;

  // nested tokens object
  total =
    readNum(usage?.tokens?.total) ||
    readNum(usage?.tokens?.totalTokens) ||
    readNum(usage?.tokens?.total_tokens);
  if (total > 0) return total;

  // sum of parts
  const a =
    readNum(usage?.promptTokens) ||
    readNum(usage?.prompt_tokens) ||
    readNum(usage?.inputTokens) ||
    readNum(usage?.input_tokens);
  const b =
    readNum(usage?.completionTokens) ||
    readNum(usage?.completion_tokens) ||
    readNum(usage?.outputTokens) ||
    readNum(usage?.output_tokens);
  const sum = a + b;
  return sum > 0 ? sum : 0;
}

/**
 * Extract the per-component token breakdown from a usage object.
 *
 * Pi's canonical shape (Anthropic / OpenAI / Google):
 *   { input, output, cacheRead, cacheWrite, reasoning, totalTokens }
 * We also accept snake_case and camelCase variants for robustness. Fields that
 * are absent default to 0; cache-health metrics gracefully degrade to "none"
 * when cacheRead / input are unavailable.
 */
function extractTokenBreakdown(usage: any): TokenBreakdown {
  if (!usage) return { ...ZERO_TB };
  const readNum = (v: any): number => {
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  };
  return {
    input: readNum(usage?.input) || readNum(usage?.inputTokens) || readNum(usage?.input_tokens),
    output: readNum(usage?.output) || readNum(usage?.outputTokens) || readNum(usage?.output_tokens),
    cacheRead: readNum(usage?.cacheRead) || readNum(usage?.cache_read) || readNum(usage?.cacheReadInputTokens) || readNum(usage?.cached_input_tokens),
    cacheWrite: readNum(usage?.cacheWrite) || readNum(usage?.cache_write) || readNum(usage?.cacheCreationInputTokens) || readNum(usage?.cache_creation_input_tokens),
    reasoning: readNum(usage?.reasoning) || readNum(usage?.reasoningTokens) || readNum(usage?.reasoning_tokens),
  };
}

async function walkSessionFiles(
  root: string,
  startCutoffLocal: Date,
  signal?: AbortSignal,
  onFound?: (found: number) => void,
): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    if (signal?.aborted) break;
    const dir = stack.pop()!;
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      if (signal?.aborted) break;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;

      // Prefer filename timestamp, else fall back to mtime.
      const startedAt = parseSessionStartFromFilename(ent.name);
      if (startedAt) {
        if (localMidnight(startedAt) >= startCutoffLocal) {
          out.push(p);
          if (onFound && out.length % 10 === 0) onFound(out.length);
        }
        continue;
      }

      try {
        const st = await fs.stat(p);
        const approx = new Date(st.mtimeMs);
        if (localMidnight(approx) >= startCutoffLocal) {
          out.push(p);
          if (onFound && out.length % 10 === 0) onFound(out.length);
        }
      } catch {
        // ignore
      }
    }
  }
  onFound?.(out.length);
  return out;
}

async function parseSessionFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<ParsedSession | null> {
  const fileName = path.basename(filePath);
  let startedAt = parseSessionStartFromFilename(fileName);
  let currentModel: ModelKey | null = null;
  let cwd: CwdKey | null = null;

  const modelsUsed = new Set<ModelKey>();
  let messages = 0;
  let tokens = 0;
  let totalCost = 0;
  const costByModel = new Map<ModelKey, number>();
  const messagesByModel = new Map<ModelKey, number>();
  const tokensByModel = new Map<ModelKey, number>();
  const tb: TokenBreakdown = { ...ZERO_TB };
  const tbByModel = new Map<ModelKey, TokenBreakdown>();

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (signal?.aborted) {
        rl.close();
        stream.destroy();
        return null;
      }
      if (!line) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (obj?.type === "session") {
        if (!startedAt && typeof obj?.timestamp === "string") {
          const d = new Date(obj.timestamp);
          if (Number.isFinite(d.getTime())) startedAt = d;
        }
        if (typeof obj?.cwd === "string" && obj.cwd.trim()) {
          cwd = obj.cwd.trim();
        }
        continue;
      }

      if (obj?.type === "model_change") {
        const mk = modelKeyFromParts(obj.provider, obj.modelId);
        if (mk) {
          currentModel = mk;
          modelsUsed.add(mk);
        }
        continue;
      }

      if (obj?.type !== "message") continue;

      const { provider, model, modelId, usage } =
        extractProviderModelAndUsage(obj);
      const mk =
        modelKeyFromParts(provider, model) ??
        modelKeyFromParts(provider, modelId) ??
        currentModel ??
        "unknown";
      modelsUsed.add(mk);

      messages += 1;
      messagesByModel.set(mk, (messagesByModel.get(mk) ?? 0) + 1);

      const tok = extractTokensTotal(usage);
      if (tok > 0) {
        tokens += tok;
        tokensByModel.set(mk, (tokensByModel.get(mk) ?? 0) + tok);
      }

      // Per-component token breakdown (cache health).
      const mtb = extractTokenBreakdown(usage);
      addTb(tb, mtb);
      const acc = tbByModel.get(mk) ?? { ...ZERO_TB };
      addTb(acc, mtb);
      tbByModel.set(mk, acc);

      const cost = extractCostTotal(usage);
      if (cost > 0) {
        totalCost += cost;
        costByModel.set(mk, (costByModel.get(mk) ?? 0) + cost);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (!startedAt) return null;
  const dayKeyLocal = toLocalDayKey(startedAt);
  const dow = DOW_NAMES[mondayIndex(startedAt)];
  const tod = todBucketForHour(startedAt.getHours());
  // Primary model = model with the most tokens in this session (for top-sessions list).
  let primaryModel: ModelKey = "unknown";
  let primaryTokens = -1;
  for (const [mk, n] of tokensByModel.entries()) {
    if (n > primaryTokens) {
      primaryTokens = n;
      primaryModel = mk;
    }
  }
  return {
    filePath,
    startedAt,
    dayKeyLocal,
    cwd,
    dow,
    tod,
    modelsUsed,
    primaryModel,
    messages,
    tokens,
    totalCost,
    tb,
    costByModel,
    messagesByModel,
    tokensByModel,
    tbByModel,
  };
}

function buildRangeAgg(days: number, now: Date): RangeAgg {
  const end = localMidnight(now);
  const start = addDaysLocal(end, -(days - 1));
  const outDays: DayAgg[] = [];
  const dayByKey = new Map<string, DayAgg>();

  for (let i = 0; i < days; i++) {
    const d = addDaysLocal(start, i);
    const dayKeyLocal = toLocalDayKey(d);
    const day: DayAgg = {
      date: d,
      dayKeyLocal,
      sessions: 0,
      messages: 0,
      tokens: 0,
      totalCost: 0,
      tb: { ...ZERO_TB },
      costByModel: new Map(),
      sessionsByModel: new Map(),
      messagesByModel: new Map(),
      tokensByModel: new Map(),
      tbByModel: new Map(),
      sessionsByCwd: new Map(),
      messagesByCwd: new Map(),
      tokensByCwd: new Map(),
      tbByCwd: new Map(),
      costByCwd: new Map(),
      sessionsByTod: new Map(),
      messagesByTod: new Map(),
      tokensByTod: new Map(),
      tbByTod: new Map(),
      costByTod: new Map(),
    };
    outDays.push(day);
    dayByKey.set(dayKeyLocal, day);
  }

  return {
    days: outDays,
    dayByKey,
    sessions: 0,
    totalMessages: 0,
    totalTokens: 0,
    totalCost: 0,
    tb: { ...ZERO_TB },
    modelCost: new Map(),
    modelSessions: new Map(),
    modelMessages: new Map(),
    modelTokens: new Map(),
    modelTb: new Map(),
    cwdCost: new Map(),
    cwdSessions: new Map(),
    cwdMessages: new Map(),
    cwdTokens: new Map(),
    cwdTb: new Map(),
    dowCost: new Map(),
    dowSessions: new Map(),
    dowMessages: new Map(),
    dowTokens: new Map(),
    dowTb: new Map(),
    todCost: new Map(),
    todSessions: new Map(),
    todMessages: new Map(),
    todTokens: new Map(),
    todTb: new Map(),
  };
}

function addSessionToRange(range: RangeAgg, session: ParsedSession): void {
  const day = range.dayByKey.get(session.dayKeyLocal);
  if (!day) return;

  range.sessions += 1;
  range.totalMessages += session.messages;
  range.totalTokens += session.tokens;
  range.totalCost += session.totalCost;
  addTb(range.tb, session.tb);
  day.sessions += 1;
  day.messages += session.messages;
  day.tokens += session.tokens;
  day.totalCost += session.totalCost;
  addTb(day.tb, session.tb);

  // Sessions-per-model (presence)
  for (const mk of session.modelsUsed) {
    day.sessionsByModel.set(mk, (day.sessionsByModel.get(mk) ?? 0) + 1);
    range.modelSessions.set(mk, (range.modelSessions.get(mk) ?? 0) + 1);
  }

  // Messages-per-model
  for (const [mk, n] of session.messagesByModel.entries()) {
    day.messagesByModel.set(mk, (day.messagesByModel.get(mk) ?? 0) + n);
    range.modelMessages.set(mk, (range.modelMessages.get(mk) ?? 0) + n);
  }

  // Tokens-per-model
  for (const [mk, n] of session.tokensByModel.entries()) {
    day.tokensByModel.set(mk, (day.tokensByModel.get(mk) ?? 0) + n);
    range.modelTokens.set(mk, (range.modelTokens.get(mk) ?? 0) + n);
  }

  // Per-component token breakdown per model
  mergeTbMaps(day.tbByModel, session.tbByModel);
  mergeTbMaps(range.modelTb, session.tbByModel);

  // Cost-per-model
  for (const [mk, cost] of session.costByModel.entries()) {
    day.costByModel.set(mk, (day.costByModel.get(mk) ?? 0) + cost);
    range.modelCost.set(mk, (range.modelCost.get(mk) ?? 0) + cost);
  }

  // CWD aggregation
  const cwd = session.cwd;
  if (cwd) {
    day.sessionsByCwd.set(cwd, (day.sessionsByCwd.get(cwd) ?? 0) + 1);
    range.cwdSessions.set(cwd, (range.cwdSessions.get(cwd) ?? 0) + 1);
    day.messagesByCwd.set(
      cwd,
      (day.messagesByCwd.get(cwd) ?? 0) + session.messages,
    );
    range.cwdMessages.set(
      cwd,
      (range.cwdMessages.get(cwd) ?? 0) + session.messages,
    );
    day.tokensByCwd.set(cwd, (day.tokensByCwd.get(cwd) ?? 0) + session.tokens);
    range.cwdTokens.set(cwd, (range.cwdTokens.get(cwd) ?? 0) + session.tokens);
    addSessionTbToKey(day.tbByCwd, cwd, session.tb);
    addSessionTbToKey(range.cwdTb, cwd, session.tb);
    day.costByCwd.set(cwd, (day.costByCwd.get(cwd) ?? 0) + session.totalCost);
    range.cwdCost.set(cwd, (range.cwdCost.get(cwd) ?? 0) + session.totalCost);
  }

  // Day-of-week aggregation
  const dow = session.dow;
  range.dowSessions.set(dow, (range.dowSessions.get(dow) ?? 0) + 1);
  range.dowMessages.set(
    dow,
    (range.dowMessages.get(dow) ?? 0) + session.messages,
  );
  range.dowTokens.set(dow, (range.dowTokens.get(dow) ?? 0) + session.tokens);
  addSessionTbToKey(range.dowTb, dow, session.tb);
  range.dowCost.set(dow, (range.dowCost.get(dow) ?? 0) + session.totalCost);

  // Time-of-day aggregation
  const tod = session.tod;
  day.sessionsByTod.set(tod, (day.sessionsByTod.get(tod) ?? 0) + 1);
  day.messagesByTod.set(
    tod,
    (day.messagesByTod.get(tod) ?? 0) + session.messages,
  );
  day.tokensByTod.set(tod, (day.tokensByTod.get(tod) ?? 0) + session.tokens);
  addSessionTbToKey(day.tbByTod, tod, session.tb);
  day.costByTod.set(tod, (day.costByTod.get(tod) ?? 0) + session.totalCost);
  range.todSessions.set(tod, (range.todSessions.get(tod) ?? 0) + 1);
  range.todMessages.set(
    tod,
    (range.todMessages.get(tod) ?? 0) + session.messages,
  );
  range.todTokens.set(tod, (range.todTokens.get(tod) ?? 0) + session.tokens);
  addSessionTbToKey(range.todTb, tod, session.tb);
  range.todCost.set(tod, (range.todCost.get(tod) ?? 0) + session.totalCost);
}

function sortMapByValueDesc<K extends string>(
  m: Map<K, number>,
): Array<{ key: K; value: number }> {
  return [...m.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value - a.value);
}

/** Merge a per-key token breakdown from `src` into `dst` (creating entries as needed). */
function mergeTbMaps<K extends string>(
  dst: Map<K, TokenBreakdown>,
  src: Map<K, TokenBreakdown>,
): void {
  for (const [k, tb] of src.entries()) {
    const acc = dst.get(k) ?? { ...ZERO_TB };
    addTb(acc, tb);
    dst.set(k, acc);
  }
}

/** Accumulate a whole-session token breakdown into a per-key map (scales session total by key). */
function addSessionTbToKey<K extends string>(
  dst: Map<K, TokenBreakdown>,
  key: K,
  sessionTb: TokenBreakdown,
): void {
  const acc = dst.get(key) ?? { ...ZERO_TB };
  addTb(acc, sessionTb);
  dst.set(key, acc);
}

function choosePaletteFromLast30Days(
  range30: RangeAgg,
  topN = 4,
): {
  modelColors: Map<ModelKey, RGB>;
  otherColor: RGB;
  orderedModels: ModelKey[];
} {
  // Prefer cost if any cost exists, else tokens, else messages, else sessions.
  const costSum = [...range30.modelCost.values()].reduce((a, b) => a + b, 0);
  const popularity =
    costSum > 0
      ? range30.modelCost
      : range30.totalTokens > 0
        ? range30.modelTokens
        : range30.totalMessages > 0
          ? range30.modelMessages
          : range30.modelSessions;

  const sorted = sortMapByValueDesc(popularity);
  const orderedModels = sorted.slice(0, topN).map((x) => x.key);
  const modelColors = new Map<ModelKey, RGB>();
  for (let i = 0; i < orderedModels.length; i++) {
    modelColors.set(orderedModels[i], PALETTE[i % PALETTE.length]);
  }
  return {
    modelColors,
    otherColor: { r: 160, g: 160, b: 160 },
    orderedModels,
  };
}

function chooseCwdPaletteFromLast30Days(
  range30: RangeAgg,
  topN = 4,
): {
  cwdColors: Map<CwdKey, RGB>;
  otherColor: RGB;
  orderedCwds: CwdKey[];
} {
  const costSum = [...range30.cwdCost.values()].reduce((a, b) => a + b, 0);
  const popularity =
    costSum > 0
      ? range30.cwdCost
      : range30.totalTokens > 0
        ? range30.cwdTokens
        : range30.totalMessages > 0
          ? range30.cwdMessages
          : range30.cwdSessions;

  const sorted = sortMapByValueDesc(popularity);
  const orderedCwds = sorted.slice(0, topN).map((x) => x.key);
  const cwdColors = new Map<CwdKey, RGB>();
  for (let i = 0; i < orderedCwds.length; i++) {
    cwdColors.set(orderedCwds[i], PALETTE[i % PALETTE.length]);
  }
  return {
    cwdColors,
    otherColor: { r: 160, g: 160, b: 160 },
    orderedCwds,
  };
}

// Fixed palette for day-of-week: weekdays get cool tones, weekend gets warm
const DOW_PALETTE: RGB[] = [
  { r: 47, g: 129, b: 247 }, // Mon – blue
  { r: 64, g: 196, b: 99 }, // Tue – green
  { r: 163, g: 113, b: 247 }, // Wed – purple
  { r: 47, g: 175, b: 200 }, // Thu – teal
  { r: 100, g: 200, b: 150 }, // Fri – mint
  { r: 255, g: 159, b: 10 }, // Sat – orange
  { r: 244, g: 67, b: 54 }, // Sun – red
];

function buildDowPalette(): {
  dowColors: Map<DowKey, RGB>;
  orderedDows: DowKey[];
} {
  const dowColors = new Map<DowKey, RGB>();
  for (let i = 0; i < DOW_NAMES.length; i++) {
    dowColors.set(DOW_NAMES[i], DOW_PALETTE[i]);
  }
  return { dowColors, orderedDows: [...DOW_NAMES] };
}

// Fixed palette for time-of-day buckets
const TOD_PALETTE: Map<TodKey, RGB> = new Map([
  ["after-midnight", { r: 100, g: 60, b: 180 }], // deep purple
  ["morning", { r: 255, g: 200, b: 50 }], // golden yellow
  ["afternoon", { r: 64, g: 196, b: 99 }], // green
  ["evening", { r: 47, g: 129, b: 247 }], // blue
  ["night", { r: 60, g: 40, b: 140 }], // dark indigo
]);

function buildTodPalette(): {
  todColors: Map<TodKey, RGB>;
  orderedTods: TodKey[];
} {
  const todColors = new Map<TodKey, RGB>();
  const orderedTods: TodKey[] = [];
  for (const b of TOD_BUCKETS) {
    const c = TOD_PALETTE.get(b.key);
    if (c) todColors.set(b.key, c);
    orderedTods.push(b.key);
  }
  return { todColors, orderedTods };
}

function dayMixedColor(
  day: DayAgg,
  colorMap: Map<string, RGB>,
  otherColor: RGB,
  mode: MeasurementMode,
  view: BreakdownView = "model",
): RGB {
  const parts: Array<{ color: RGB; weight: number }> = [];
  let otherWeight = 0;

  let map: Map<string, number>;
  if (view === "dow") {
    // For dow, each day IS a single dow – use the dow color directly
    const dowKey = DOW_NAMES[mondayIndex(day.date)];
    const c = colorMap.get(dowKey);
    return c ?? otherColor;
  } else if (view === "tod") {
    if (mode === "tokens") {
      map =
        day.tokens > 0
          ? day.tokensByTod
          : day.messages > 0
            ? day.messagesByTod
            : day.sessionsByTod;
    } else if (mode === "messages") {
      map = day.messages > 0 ? day.messagesByTod : day.sessionsByTod;
    } else {
      map = day.sessionsByTod;
    }
  } else if (view === "cwd") {
    if (mode === "tokens") {
      map =
        day.tokens > 0
          ? day.tokensByCwd
          : day.messages > 0
            ? day.messagesByCwd
            : day.sessionsByCwd;
    } else if (mode === "messages") {
      map = day.messages > 0 ? day.messagesByCwd : day.sessionsByCwd;
    } else {
      map = day.sessionsByCwd;
    }
  } else {
    if (mode === "tokens") {
      map =
        day.tokens > 0
          ? day.tokensByModel
          : day.messages > 0
            ? day.messagesByModel
            : day.sessionsByModel;
    } else if (mode === "messages") {
      map = day.messages > 0 ? day.messagesByModel : day.sessionsByModel;
    } else {
      map = day.sessionsByModel;
    }
  }

  for (const [mk, w] of map.entries()) {
    const c = colorMap.get(mk);
    if (c) parts.push({ color: c, weight: w });
    else otherWeight += w;
  }
  if (otherWeight > 0) parts.push({ color: otherColor, weight: otherWeight });
  return weightedMix(parts);
}

function graphMetricForRange(
  range: RangeAgg,
  mode: MeasurementMode,
): { kind: "sessions" | "messages" | "tokens"; max: number; denom: number } {
  if (mode === "tokens") {
    const maxTokens = Math.max(0, ...range.days.map((d) => d.tokens));
    if (maxTokens > 0)
      return { kind: "tokens", max: maxTokens, denom: Math.log1p(maxTokens) };
    // fall back if tokens aren't available
    mode = "messages";
  }

  if (mode === "messages") {
    const maxMessages = Math.max(0, ...range.days.map((d) => d.messages));
    if (maxMessages > 0)
      return {
        kind: "messages",
        max: maxMessages,
        denom: Math.log1p(maxMessages),
      };
    // fall back if messages aren't available
    mode = "sessions";
  }

  const maxSessions = Math.max(0, ...range.days.map((d) => d.sessions));
  return { kind: "sessions", max: maxSessions, denom: Math.log1p(maxSessions) };
}

function weeksForRange(range: RangeAgg): number {
  const days = range.days;
  const start = days[0].date;
  const end = days[days.length - 1].date;
  const gridStart = addDaysLocal(start, -mondayIndex(start));
  const gridEnd = addDaysLocal(end, 6 - mondayIndex(end));
  const totalGridDays = countDaysInclusiveLocal(gridStart, gridEnd);
  return Math.ceil(totalGridDays / 7);
}

function renderGraphLines(
  range: RangeAgg,
  colorMap: Map<string, RGB>,
  otherColor: RGB,
  mode: MeasurementMode,
  options?: { cellWidth?: number; gap?: number },
  view: BreakdownView = "model",
): string[] {
  const days = range.days;
  const start = days[0].date;
  const end = days[days.length - 1].date;

  const gridStart = addDaysLocal(start, -mondayIndex(start));
  const gridEnd = addDaysLocal(end, 6 - mondayIndex(end));
  const totalGridDays = countDaysInclusiveLocal(gridStart, gridEnd);
  const weeks = Math.ceil(totalGridDays / 7);

  const cellWidth = Math.max(1, Math.floor(options?.cellWidth ?? 1));
  const gap = Math.max(0, Math.floor(options?.gap ?? 1));
  const block = "█".repeat(cellWidth);
  const gapStr = " ".repeat(gap);

  const metric = graphMetricForRange(range, mode);
  const denom = metric.denom;

  // Label only Mon/Wed/Fri like GitHub (saves space)
  const labelByRow = new Map<number, string>([
    [0, "Mon"],
    [2, "Wed"],
    [4, "Fri"],
  ]);

  const lines: string[] = [];
  for (let row = 0; row < 7; row++) {
    const label = labelByRow.get(row);
    let line = label ? padRight(label, 3) + " " : "    ";

    for (let w = 0; w < weeks; w++) {
      const cellDate = addDaysLocal(gridStart, w * 7 + row);
      const inRange = cellDate >= start && cellDate <= end;
      const colGap = w < weeks - 1 ? gapStr : "";
      if (!inRange) {
        line += " ".repeat(cellWidth) + colGap;
        continue;
      }

      const key = toLocalDayKey(cellDate);
      const day = range.dayByKey.get(key);
      const value =
        metric.kind === "tokens"
          ? (day?.tokens ?? 0)
          : metric.kind === "messages"
            ? (day?.messages ?? 0)
            : (day?.sessions ?? 0);

      if (!day || value <= 0) {
        line += ansiFg(EMPTY_CELL_BG, block) + colGap;
        continue;
      }

      const hue = dayMixedColor(day, colorMap, otherColor, mode, view);
      let t = denom > 0 ? Math.log1p(value) / denom : 0;
      t = clamp01(t);
      const minVisible = 0.2;
      const intensity = minVisible + (1 - minVisible) * t;
      const rgb = mixRgb(DEFAULT_BG, hue, intensity);
      line += ansiFg(rgb, block) + colGap;
    }

    lines.push(line);
  }

  return lines;
}

function displayModelName(modelKey: string): string {
  const idx = modelKey.indexOf("/");
  return idx === -1 ? modelKey : modelKey.slice(idx + 1);
}

function renderLegendItems(
  modelColors: Map<ModelKey, RGB>,
  orderedModels: ModelKey[],
  otherColor: RGB,
): string[] {
  const items: string[] = [];
  for (const mk of orderedModels) {
    const c = modelColors.get(mk);
    if (!c) continue;
    items.push(`${ansiFg(c, "█")} ${displayModelName(mk)}`);
  }
  items.push(`${ansiFg(otherColor, "█")} other`);
  return items;
}

function fitRight(text: string, width: number): string {
  if (width <= 0) return "";
  let w = visibleWidth(text);
  let t = text;
  if (w > width) {
    t = sliceByColumn(t, w - width, width, true);
    w = visibleWidth(t);
  }
  return " ".repeat(Math.max(0, width - w)) + t;
}

function renderLegendBlock(
  leftLabel: string,
  items: string[],
  width: number,
): string[] {
  if (width <= 0) return [];
  if (items.length === 0) return [truncateToWidth(leftLabel, width)];

  const lines: string[] = [];
  // First line: label on left, first item right-aligned into remaining space.
  const leftW = visibleWidth(leftLabel);
  if (leftW >= width) {
    lines.push(truncateToWidth(leftLabel, width));
    // Put all items on their own lines right-aligned.
    for (const it of items) lines.push(fitRight(it, width));
    return lines;
  }

  const remaining = Math.max(0, width - leftW);
  lines.push(leftLabel + fitRight(items[0], remaining));

  for (let i = 1; i < items.length; i++) {
    lines.push(fitRight(items[i], width));
  }
  return lines;
}

// Fixed widths for the token-detail / cost / share trailing columns.
const TOK_IN_W = 7;
const TOK_OUT_W = 6;
const TOK_CACHE_W = 9; // cacheRead magnitude
const TOK_HIT_W = 5;
const COST_W = 10;
const SHARE_W = 6;

/** Trailing column header text (in/out/cache/hit/cost/share) per visibility. */
function trailingHeader(
  showDetail: boolean,
  showHit: boolean,
): string {
  const parts: string[] = [];
  if (showDetail) {
    parts.push(padLeft("in", TOK_IN_W));
    parts.push(padLeft("out", TOK_OUT_W));
    parts.push(padLeft("cache", TOK_CACHE_W));
  }
  if (showHit) parts.push(padLeft("hit%", TOK_HIT_W));
  parts.push(padLeft("cost", COST_W));
  parts.push(padLeft("share", SHARE_W));
  return parts.map((p) => "  " + p).join("");
}

/** Trailing dashes matching {@link trailingHeader}. */
function trailingSep(showDetail: boolean, showHit: boolean): string {
  const parts: string[] = [];
  if (showDetail) {
    parts.push("-".repeat(TOK_IN_W));
    parts.push("-".repeat(TOK_OUT_W));
    parts.push("-".repeat(TOK_CACHE_W));
  }
  if (showHit) parts.push("-".repeat(TOK_HIT_W));
  parts.push("-".repeat(COST_W));
  parts.push("-".repeat(SHARE_W));
  return parts.map((p) => "  " + p).join("");
}

/** Trailing cells for one row given its token breakdown, cost, and share string. */
function trailingRow(
  tb: TokenBreakdown,
  cost: number,
  shareStr: string,
  showDetail: boolean,
  showHit: boolean,
): string {
  const parts: string[] = [];
  if (showDetail) {
    parts.push(padLeft(formatCount(tb.input + tb.cacheWrite), TOK_IN_W));
    parts.push(padLeft(formatCount(tb.output), TOK_OUT_W));
    parts.push(padLeft(formatCount(tb.cacheRead), TOK_CACHE_W));
  }
  if (showHit) parts.push(padLeft(hitCell(tb), TOK_HIT_W));
  parts.push(padLeft(formatUsd(cost), COST_W));
  parts.push(padLeft(shareStr, SHARE_W));
  return parts.map((p) => "  " + p).join("");
}

function renderModelTable(
  range: RangeAgg,
  mode: MeasurementMode,
  maxRows = 8,
  width = 120,
): string[] {
  const metric = graphMetricForRange(range, mode);
  const kind = metric.kind;

  let perModel: Map<ModelKey, number>;
  let total = 0;
  let label = kind;

  if (kind === "tokens") {
    perModel = range.modelTokens;
    total = range.totalTokens;
  } else if (kind === "messages") {
    perModel = range.modelMessages;
    total = range.totalMessages;
  } else {
    perModel = range.modelSessions;
    total = range.sessions;
  }

  const sorted = sortMapByValueDesc(perModel);
  const rows = sorted.slice(0, maxRows);

  const valueWidth = kind === "tokens" ? 10 : 8;
  const modelWidth = Math.min(
    52,
    Math.max("model".length, ...rows.map((r) => r.key.length)),
  );

  const hasTokens = tbTotal(range.tb) > 0;
  const baseW = modelWidth + 2 + valueWidth;
  const showHit = hasTokens && width >= baseW + 2 + TOK_HIT_W + 2 + COST_W + 2 + SHARE_W;
  const showDetail =
    kind === "tokens" &&
    hasTokens &&
    width >= baseW + 2 + TOK_IN_W + 2 + TOK_OUT_W + 2 + TOK_CACHE_W + 2 + TOK_HIT_W + 2 + COST_W + 2 + SHARE_W;

  const lines: string[] = [];
  lines.push(
    `${padRight("model", modelWidth)}  ${padLeft(label, valueWidth)}` +
      trailingHeader(showDetail, showHit),
  );
  lines.push(
    `${"-".repeat(modelWidth)}  ${"-".repeat(valueWidth)}` +
      trailingSep(showDetail, showHit),
  );

  for (const r of rows) {
    const value = perModel.get(r.key) ?? 0;
    const cost = range.modelCost.get(r.key) ?? 0;
    const tb = range.modelTb.get(r.key) ?? ZERO_TB;
    const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
    lines.push(
      `${padRight(r.key.slice(0, modelWidth), modelWidth)}  ${padLeft(formatCount(value), valueWidth)}` +
        trailingRow(tb, cost, share, showDetail, showHit),
    );
  }

  if (sorted.length === 0) {
    lines.push(dim("(no model data found)"));
  }

  return lines;
}

function renderCwdTable(
  range: RangeAgg,
  mode: MeasurementMode,
  maxRows = 8,
  width = 120,
): string[] {
  const metric = graphMetricForRange(range, mode);
  const kind = metric.kind;

  let perCwd: Map<CwdKey, number>;
  let total = 0;
  let label = kind;

  if (kind === "tokens") {
    perCwd = range.cwdTokens;
    total = range.totalTokens;
  } else if (kind === "messages") {
    perCwd = range.cwdMessages;
    total = range.totalMessages;
  } else {
    perCwd = range.cwdSessions;
    total = range.sessions;
  }

  const sorted = sortMapByValueDesc(perCwd);
  const rows = sorted.slice(0, maxRows);

  const valueWidth = kind === "tokens" ? 10 : 8;
  const displayPaths = rows.map((r) => abbreviatePath(r.key, 40));
  const cwdWidth = Math.min(
    42,
    Math.max("directory".length, ...displayPaths.map((p) => p.length)),
  );

  const hasTokens = tbTotal(range.tb) > 0;
  const baseW = cwdWidth + 2 + valueWidth;
  const showHit = hasTokens && width >= baseW + 2 + TOK_HIT_W + 2 + COST_W + 2 + SHARE_W;
  const showDetail =
    kind === "tokens" &&
    hasTokens &&
    width >= baseW + 2 + TOK_IN_W + 2 + TOK_OUT_W + 2 + TOK_CACHE_W + 2 + TOK_HIT_W + 2 + COST_W + 2 + SHARE_W;

  const lines: string[] = [];
  lines.push(
    `${padRight("directory", cwdWidth)}  ${padLeft(label, valueWidth)}` +
      trailingHeader(showDetail, showHit),
  );
  lines.push(
    `${"-".repeat(cwdWidth)}  ${"-".repeat(valueWidth)}` +
      trailingSep(showDetail, showHit),
  );

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const value = perCwd.get(r.key) ?? 0;
    const cost = range.cwdCost.get(r.key) ?? 0;
    const tb = range.cwdTb.get(r.key) ?? ZERO_TB;
    const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
    lines.push(
      `${padRight(displayPaths[i].slice(0, cwdWidth), cwdWidth)}  ${padLeft(formatCount(value), valueWidth)}` +
        trailingRow(tb, cost, share, showDetail, showHit),
    );
  }

  if (sorted.length === 0) {
    lines.push(dim("(no directory data found)"));
  }

  return lines;
}

function dowMetricForRange(
  range: RangeAgg,
  mode: MeasurementMode,
): {
  kind: "sessions" | "messages" | "tokens";
  perDow: Map<DowKey, number>;
  total: number;
} {
  const metric = graphMetricForRange(range, mode);
  const kind = metric.kind;

  if (kind === "tokens") {
    return { kind, perDow: range.dowTokens, total: range.totalTokens };
  }
  if (kind === "messages") {
    return { kind, perDow: range.dowMessages, total: range.totalMessages };
  }
  return { kind, perDow: range.dowSessions, total: range.sessions };
}

function renderDowDistributionLines(
  range: RangeAgg,
  mode: MeasurementMode,
  dowColors: Map<DowKey, RGB>,
  width: number,
): string[] {
  const { kind, perDow, total } = dowMetricForRange(range, mode);
  const dayWidth = 3;
  const pctWidth = 4; // "100%"
  const valueWidth = kind === "tokens" ? 10 : 8;
  const showValue = width >= dayWidth + 1 + 10 + 1 + pctWidth + 1 + valueWidth;
  const fixedWidth =
    dayWidth + 1 + 1 + pctWidth + (showValue ? 1 + valueWidth : 0);
  const barWidth = Math.max(1, width - fixedWidth);
  const fallbackColor: RGB = { r: 160, g: 160, b: 160 };

  const lines: string[] = [];
  for (const dow of DOW_NAMES) {
    const value = perDow.get(dow) ?? 0;
    const share = total > 0 ? value / total : 0;
    let filled = share > 0 ? Math.round(share * barWidth) : 0;
    if (share > 0) filled = Math.max(1, filled);
    filled = Math.min(barWidth, filled);
    const empty = Math.max(0, barWidth - filled);

    const color = dowColors.get(dow) ?? fallbackColor;
    const filledBar = filled > 0 ? ansiFg(color, "█".repeat(filled)) : "";
    const emptyBar = empty > 0 ? ansiFg(EMPTY_CELL_BG, "█".repeat(empty)) : "";
    const pct = padLeft(`${Math.round(share * 100)}%`, pctWidth);

    let line = `${padRight(dow, dayWidth)} ${filledBar}${emptyBar} ${pct}`;
    if (showValue) line += ` ${padLeft(formatCount(value), valueWidth)}`;
    lines.push(line);
  }

  return lines;
}

function renderDowTable(
  range: RangeAgg,
  mode: MeasurementMode,
  width = 120,
): string[] {
  const { kind, perDow, total } = dowMetricForRange(range, mode);
  const valueWidth = kind === "tokens" ? 10 : 8;
  const dowWidth = 5; // "day  "

  const hasTokens = tbTotal(range.tb) > 0;
  const baseW = dowWidth + 2 + valueWidth;
  const showHit = hasTokens && width >= baseW + 2 + TOK_HIT_W + 2 + COST_W + 2 + SHARE_W;

  const lines: string[] = [];
  lines.push(
    `${padRight("day", dowWidth)}  ${padLeft(kind, valueWidth)}` +
      trailingHeader(false, showHit),
  );
  lines.push(
    `${"-".repeat(dowWidth)}  ${"-".repeat(valueWidth)}` +
      trailingSep(false, showHit),
  );

  // Always show in Mon–Sun order
  for (const dow of DOW_NAMES) {
    const value = perDow.get(dow) ?? 0;
    const cost = range.dowCost.get(dow) ?? 0;
    const tb = range.dowTb.get(dow) ?? ZERO_TB;
    const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
    lines.push(
      `${padRight(dow, dowWidth)}  ${padLeft(formatCount(value), valueWidth)}` +
        trailingRow(tb, cost, share, false, showHit),
    );
  }

  return lines;
}

function renderTodTable(
  range: RangeAgg,
  mode: MeasurementMode,
  width = 120,
): string[] {
  const metric = graphMetricForRange(range, mode);
  const kind = metric.kind;

  let perTod: Map<TodKey, number>;
  let total = 0;

  if (kind === "tokens") {
    perTod = range.todTokens;
    total = range.totalTokens;
  } else if (kind === "messages") {
    perTod = range.todMessages;
    total = range.totalMessages;
  } else {
    perTod = range.todSessions;
    total = range.sessions;
  }

  const valueWidth = kind === "tokens" ? 10 : 8;
  const todWidth = 22; // widest label

  const hasTokens = tbTotal(range.tb) > 0;
  const baseW = todWidth + 2 + valueWidth;
  const showHit = hasTokens && width >= baseW + 2 + TOK_HIT_W + 2 + COST_W + 2 + SHARE_W;

  const lines: string[] = [];
  lines.push(
    `${padRight("time of day", todWidth)}  ${padLeft(kind, valueWidth)}` +
      trailingHeader(false, showHit),
  );
  lines.push(
    `${"-".repeat(todWidth)}  ${"-".repeat(valueWidth)}` +
      trailingSep(false, showHit),
  );

  // Always show in chronological order
  for (const b of TOD_BUCKETS) {
    const value = perTod.get(b.key) ?? 0;
    const cost = range.todCost.get(b.key) ?? 0;
    const tb = range.todTb.get(b.key) ?? ZERO_TB;
    const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
    lines.push(
      `${padRight(b.label, todWidth)}  ${padLeft(formatCount(value), valueWidth)}` +
        trailingRow(tb, cost, share, false, showHit),
    );
  }

  return lines;
}

function renderLeftRight(left: string, right: string, width: number): string {
  const leftW = visibleWidth(left);
  if (width <= 0) return "";
  if (leftW >= width) return truncateToWidth(left, width);

  const remaining = width - leftW;
  let rightText = right;
  const rightW = visibleWidth(rightText);
  if (rightW > remaining) {
    // Keep the *rightmost* part visible.
    rightText = sliceByColumn(rightText, rightW - remaining, remaining, true);
  }
  const pad = Math.max(0, remaining - visibleWidth(rightText));
  return left + " ".repeat(pad) + rightText;
}

function rangeSummary(
  range: RangeAgg,
  days: number,
  mode: MeasurementMode,
): string {
  const avg = range.sessions > 0 ? range.totalCost / range.sessions : 0;
  const costPart =
    range.totalCost > 0
      ? `${formatUsd(range.totalCost)} · avg ${formatUsd(avg)}/session`
      : `$0.0000`;

  // Cache-health segment, shown whenever there are prompt tokens.
  const cachePart = (() => {
    const prompt = tbPrompt(range.tb);
    if (prompt <= 0) return "";
    const hit = formatPct(cacheHitRate(range.tb));
    const lev = formatLeverage(cacheLeverage(range.tb));
    return ` · cache hit ${hit} · leverage ${lev}`;
  })();

  if (mode === "tokens") {
    return (
      `Last ${days} days: ${formatCount(range.sessions)} sessions · ` +
      `${formatCount(range.totalTokens)} tokens${cachePart} · ${costPart}`
    );
  }
  if (mode === "messages") {
    return `Last ${days} days: ${formatCount(range.sessions)} sessions · ${formatCount(range.totalMessages)} messages · ${costPart}`;
  }
  return `Last ${days} days: ${formatCount(range.sessions)} sessions${cachePart} · ${costPart}`;
}

async function computeBreakdown(
  signal?: AbortSignal,
  onProgress?: (update: Partial<BreakdownProgressState>) => void,
): Promise<BreakdownData> {
  const now = new Date();
  const ranges = new Map<number, RangeAgg>();
  for (const d of RANGE_DAYS) ranges.set(d, buildRangeAgg(d, now));
  const range90 = ranges.get(90)!;
  const start90 = range90.days[0].date;
  // Extend the scan window by one full max-range so we can compute the
  // immediately-preceding period for delta comparisons.
  const scanStart = addDaysLocal(start90, -90);

  onProgress?.({
    phase: "scan",
    foundFiles: 0,
    parsedFiles: 0,
    totalFiles: 0,
    currentFile: undefined,
  });

  const candidates = await walkSessionFiles(
    SESSION_ROOT,
    scanStart,
    signal,
    (found) => {
      onProgress?.({ phase: "scan", foundFiles: found });
    },
  );

  const totalFiles = candidates.length;
  onProgress?.({
    phase: "parse",
    foundFiles: totalFiles,
    totalFiles,
    parsedFiles: 0,
    currentFile: totalFiles > 0 ? path.basename(candidates[0]!) : undefined,
  });

  // Previous-period totals per range: window [start - N, start).
  const prevTotals = new Map<number, PeriodTotals>();
  const prevWindows = new Map<number, { start: Date; end: Date }>();
  for (const d of RANGE_DAYS) {
    const range = ranges.get(d)!;
    const curStart = range.days[0].date;
    prevWindows.set(d, {
      start: addDaysLocal(curStart, -d),
      end: addDaysLocal(curStart, -1),
    });
    prevTotals.set(d, {
      sessions: 0,
      messages: 0,
      tokens: 0,
      tb: { ...ZERO_TB },
      cost: 0,
    });
  }

  const allSessions: SessionSummary[] = [];

  let parsedFiles = 0;
  for (const filePath of candidates) {
    if (signal?.aborted) break;
    parsedFiles += 1;
    onProgress?.({
      phase: "parse",
      parsedFiles,
      totalFiles,
      currentFile: path.basename(filePath),
    });

    const session = await parseSessionFile(filePath, signal);
    if (!session) continue;

    const sessionDay = localMidnight(session.startedAt);
    for (const d of RANGE_DAYS) {
      const range = ranges.get(d)!;
      const start = range.days[0].date;
      const end = range.days[range.days.length - 1].date;
      if (sessionDay >= start && sessionDay <= end) {
        addSessionToRange(range, session);
      }
      // Previous-period accumulation for the same range length.
      const pw = prevWindows.get(d)!;
      if (sessionDay >= pw.start && sessionDay <= pw.end) {
        const pt = prevTotals.get(d)!;
        pt.sessions += 1;
        pt.messages += session.messages;
        pt.tokens += session.tokens;
        pt.cost += session.totalCost;
        addTb(pt.tb, session.tb);
      }
    }

    // Keep a lightweight copy for the top-sessions list (bounded to the scan window).
    allSessions.push({
      startedAt: session.startedAt,
      dayKeyLocal: session.dayKeyLocal,
      cwd: session.cwd,
      primaryModel: session.primaryModel,
      messages: session.messages,
      tokens: session.tokens,
      tb: { ...session.tb },
      cost: session.totalCost,
    });
  }

  onProgress?.({ phase: "finalize", currentFile: undefined });

  const palette = choosePaletteFromLast30Days(ranges.get(30)!, 4);
  const cwdPalette = chooseCwdPaletteFromLast30Days(ranges.get(30)!, 4);
  const dowPalette = buildDowPalette();
  const todPalette = buildTodPalette();
  return {
    generatedAt: now,
    ranges,
    prevTotals,
    allSessions,
    palette,
    cwdPalette,
    dowPalette,
    todPalette,
  };
}

// ── Insights panel helpers ────────────────────────────────────────────────

const INSIGHT_LABEL_W = 20;
const INSIGHT_BAR_W = 16;

/** Two-column key/value line: "  {label:<20}  {value}". */
function insightKV(label: string, value: string): string {
  return `  ${padRight(label, INSIGHT_LABEL_W)}  ${value}`;
}

/** Section divider line: "── Title ─────..." sized to width. */
function insightSection(title: string, width: number): string {
  const prefix = `${bold(title)} `;
  const used = visibleWidth(prefix);
  const fill = Math.max(0, Math.min(width, width - used));
  return prefix + dim("─".repeat(fill));
}

/** Key with the maximum numeric value in a map (ties → first encountered). */
function argmaxMap<K extends string>(m: Map<K, number>): K | null {
  let best: K | null = null;
  let bestN = -Infinity;
  for (const [k, v] of m.entries()) {
    if (v > bestN) {
      bestN = v;
      best = k;
    }
  }
  return best;
}

/** Longest run of consecutive days (in calendar order) with sessions > 0. */
function longestActiveStreak(range: RangeAgg): number {
  let best = 0;
  let cur = 0;
  for (const d of range.days) {
    if (d.sessions > 0) {
      cur += 1;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}

/** Count of distinct sessions whose start is within ±2min of another (parallel launches). */
function countParallelSessions(sessions: SessionSummary[]): number {
  if (sessions.length < 2) return 0;
  const times = sessions
    .map((s) => s.startedAt.getTime())
    .sort((a, b) => a - b);
  const WINDOW_MS = 2 * 60 * 1000;
  let count = 0;
  for (let i = 0; i < times.length; i++) {
    const left = i > 0 && times[i]! - times[i - 1]! <= WINDOW_MS;
    const right =
      i < times.length - 1 && times[i + 1]! - times[i]! <= WINDOW_MS;
    if (left || right) count += 1;
  }
  return count;
}

/** Render the full insights panel for a range. */
function renderInsights(
  data: BreakdownData,
  range: RangeAgg,
  days: number,
  width: number,
): string[] {
  const lines: string[] = [];
  const hasTokens = tbTotal(range.tb) > 0;
  const totalSessions = range.sessions;

  // ── Activity ─────────────────────────────────────────────────────────
  lines.push(insightSection("Activity", width));

  const busiestDow = argmaxMap(range.dowSessions);
  if (busiestDow) {
    const n = range.dowSessions.get(busiestDow) ?? 0;
    const share = totalSessions > 0 ? formatPct(n / totalSessions) : "0%";
    lines.push(insightKV("Busiest weekday", `${busiestDow}  (${formatCount(n)} sessions, ${share})`));
  }

  const peakTod = argmaxMap(range.todSessions);
  if (peakTod) {
    const n = range.todSessions.get(peakTod) ?? 0;
    const share = totalSessions > 0 ? formatPct(n / totalSessions) : "0%";
    lines.push(insightKV("Peak time of day", `${todBucketLabel(peakTod)}  (${share})`));
  }

  const activeDays = range.days.filter((d) => d.sessions > 0).length;
  lines.push(insightKV("Active days", `${activeDays} / ${days}`));
  lines.push(insightKV("Longest streak", `${longestActiveStreak(range)} days`));
  lines.push(
    insightKV("Avg sessions/day", (days > 0 ? totalSessions / days : 0).toFixed(1)),
  );

  const topCwd = argmaxMap(range.cwdSessions);
  if (topCwd) {
    const n = range.cwdSessions.get(topCwd) ?? 0;
    const share = totalSessions > 0 ? formatPct(n / totalSessions) : "0%";
    lines.push(
      insightKV("Top project", `${abbreviatePath(topCwd, 34)}  (${share})`),
    );
  }

  // Parallel launches, scoped to this range's calendar window.
  const rangeStart = range.days[0]!.dayKeyLocal;
  const rangeEnd = range.days[range.days.length - 1]!.dayKeyLocal;
  const rangeSessions = data.allSessions.filter(
    (s) => s.dayKeyLocal >= rangeStart && s.dayKeyLocal <= rangeEnd,
  );
  const parallel = countParallelSessions(rangeSessions);
  lines.push(
    insightKV("Parallel launches", `${parallel} session${parallel === 1 ? "" : "s"} (started within ±2 min)`),
  );

  // ── Tokens & cache ────────────────────────────────────────────────────
  if (hasTokens) {
    lines.push("");
    lines.push(insightSection("Tokens & cache", width));
    const tb = range.tb;
    lines.push(
      insightKV(
        "Fresh tokens",
        `${formatCount(tbFresh(tb))}  ${dim(`(in ${formatCount(tb.input + tb.cacheWrite)} · out ${formatCount(tb.output)})`)}`,
      ),
    );
    lines.push(insightKV("Cache read", formatCount(tb.cacheRead)));
    if (tb.reasoning > 0) {
      lines.push(insightKV("Reasoning", formatCount(tb.reasoning)));
    }
    const hit = cacheHitRate(tb);
    const bar = fracBar(hit, INSIGHT_BAR_W, { r: 64, g: 196, b: 99 });
    lines.push(insightKV("Cache hit rate", `${formatPct(hit)}  ${bar}`));
    const lev = cacheLeverage(tb);
    lines.push(
      insightKV("Cache leverage", `${formatLeverage(lev)}  ${dim("(cache saved re-sending prompt ~N×)")}`),
    );

    // Best / worst model by cache hit rate (need prompt tokens to be meaningful).
    let bestMk: ModelKey | null = null;
    let bestHit = -1;
    let worstMk: ModelKey | null = null;
    let worstHit = 2;
    for (const [mk, mtb] of range.modelTb.entries()) {
      if (tbPrompt(mtb) <= 0) continue;
      const h = cacheHitRate(mtb);
      if (h > bestHit) {
        bestHit = h;
        bestMk = mk;
      }
      if (h < worstHit) {
        worstHit = h;
        worstMk = mk;
      }
    }
    if (bestMk && bestMk !== worstMk) {
      lines.push(
        insightKV("Best cache hit", `${displayModelName(bestMk)}  ${formatPct(bestHit)}`),
      );
      lines.push(
        insightKV("Worst cache hit", `${displayModelName(worstMk!)}  ${formatPct(worstHit)}`),
      );
    }
  }

  // ── Efficiency (by model) ─────────────────────────────────────────────
  if (range.modelTokens.size > 0) {
    lines.push("");
    lines.push(insightSection("Efficiency (by model)", width));
    const tokSessW = 8;
    const perMW = 9;
    const hitMW = 6;
    const modelW = Math.max(
      10,
      Math.min(34, width - (tokSessW + perMW + hitMW + 12)),
    );
    lines.push(
      `  ${padRight("model", modelW)}  ${padLeft("tok/sess", tokSessW)}  ${padLeft("$/Mtok", perMW)}  ${padLeft("hit%", hitMW)}`,
    );
    const effRows = sortMapByValueDesc(range.modelTokens).slice(0, 6);
    for (const r of effRows) {
      const sess = range.modelSessions.get(r.key) ?? 0;
      const toks = range.modelTokens.get(r.key) ?? 0;
      const cost = range.modelCost.get(r.key) ?? 0;
      const perSess = sess > 0 ? toks / sess : 0;
      const perM = toks > 0 ? (cost / toks) * 1_000_000 : 0;
      const mtb = range.modelTb.get(r.key);
      const hit = mtb ? hitCell(mtb) : "—";
      lines.push(
        `  ${padRight(displayModelName(r.key).slice(0, modelW), modelW)}  ${padLeft(formatCount(Math.round(perSess)), tokSessW)}  ${padLeft(perM > 0 ? `$${formatCount(Math.round(perM))}` : "—", perMW)}  ${padLeft(hit, hitMW)}`,
      );
    }
  }

  // ── Top sessions (by tokens) ─────────────────────────────────────────
  if (rangeSessions.length > 0) {
    lines.push("");
    lines.push(insightSection("Top sessions (by tokens)", width));
    const dateW = 11;
    const msgW = 6;
    const tokW = 8;
    const hitW = 5;
    const modelW = 18;
    const cwdW = Math.max(
      8,
      Math.min(
        32,
        width - (dateW + 5 + modelW + msgW + tokW + hitW + 18),
      ),
    );
    const top = [...rangeSessions]
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 5);
    for (const s of top) {
      const d = s.startedAt;
      const p2 = (n: number) => String(n).padStart(2, "0");
      const date = `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
      const cwdLabel = s.cwd ? abbreviatePath(s.cwd, cwdW) : "—";
      const hit = hitCell(s.tb);
      lines.push(
        `  ${date}  ${padRight(cwdLabel, cwdW)}  ${padRight(displayModelName(s.primaryModel).slice(0, modelW), modelW)}  ${padLeft(String(s.messages), msgW)}m  ${padLeft(formatCount(s.tokens), tokW)}  ${padLeft(hit, hitW)}`,
      );
    }
  }

  // ── vs previous period ────────────────────────────────────────────────
  const prev = data.prevTotals.get(days);
  if (prev) {
    lines.push("");
    lines.push(insightSection(`vs previous ${days}d`, width));
    const deltaLine = (label: string, cur: number, pv: number, fmt: (n: number) => string): string => {
      const dPct = pv > 0 ? formatDeltaPct((cur - pv) / pv) : cur > 0 ? "new" : "—";
      return insightKV(label, `${fmt(cur)}  ${dim(`(${dPct} vs ${fmt(pv)})`)}`);
    };
    lines.push(deltaLine("Sessions", totalSessions, prev.sessions, (n) => formatCount(n)));
    lines.push(deltaLine("Tokens", range.totalTokens, prev.tokens, (n) => formatCount(n)));
    if (hasTokens || tbTotal(prev.tb) > 0) {
      const curHit = cacheHitRate(range.tb);
      const prevHit = cacheHitRate(prev.tb);
      lines.push(
        insightKV(
          "Cache hit",
          `${formatPct(curHit)}  ${dim(`(${formatDeltaPts(curHit - prevHit)} vs ${formatPct(prevHit)})`)}`,
        ),
      );
    }
    if (range.totalCost > 0 || prev.cost > 0) {
      lines.push(
        deltaLine("Cost", range.totalCost, prev.cost, (n) => formatUsd(n)),
      );
    }
  }

  return lines.map((l) => truncateToWidth(l, width));
}

class BreakdownComponent implements Component {
  private data: BreakdownData;
  private tui: TUI;
  private onDone: () => void;
  private rangeIndex = 1; // default 30d
  private measurement: MeasurementMode = "sessions";
  private view: BreakdownView = "model";
  private showInsights = false;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(data: BreakdownData, tui: TUI, onDone: () => void) {
    this.data = data;
    this.tui = tui;
    this.onDone = onDone;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      data.toLowerCase() === "q"
    ) {
      this.onDone();
      return;
    }

    if (
      matchesKey(data, Key.tab) ||
      matchesKey(data, Key.shift("tab")) ||
      data.toLowerCase() === "t"
    ) {
      const order: MeasurementMode[] = ["sessions", "messages", "tokens"];
      const idx = Math.max(0, order.indexOf(this.measurement));
      const dir = matchesKey(data, Key.shift("tab")) ? -1 : 1;
      this.measurement =
        order[(idx + order.length + dir) % order.length] ?? "sessions";
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Toggle the insights panel (activity + cache + efficiency + deltas).
    if (data.toLowerCase() === "i") {
      this.showInsights = !this.showInsights;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    const prev = () => {
      this.rangeIndex =
        (this.rangeIndex + RANGE_DAYS.length - 1) % RANGE_DAYS.length;
      this.invalidate();
      this.tui.requestRender();
    };
    const next = () => {
      this.rangeIndex = (this.rangeIndex + 1) % RANGE_DAYS.length;
      this.invalidate();
      this.tui.requestRender();
    };

    if (matchesKey(data, Key.left) || data.toLowerCase() === "h") prev();
    if (matchesKey(data, Key.right) || data.toLowerCase() === "l") next();

    if (
      matchesKey(data, Key.up) ||
      matchesKey(data, Key.down) ||
      data.toLowerCase() === "j" ||
      data.toLowerCase() === "k"
    ) {
      const views: BreakdownView[] = ["model", "cwd", "dow", "tod"];
      const idx = views.indexOf(this.view);
      const dir =
        matchesKey(data, Key.up) || data.toLowerCase() === "k" ? -1 : 1;
      this.view = views[(idx + views.length + dir) % views.length] ?? "model";
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (data === "1") {
      this.rangeIndex = 0;
      this.invalidate();
      this.tui.requestRender();
    }
    if (data === "2") {
      this.rangeIndex = 1;
      this.invalidate();
      this.tui.requestRender();
    }
    if (data === "3") {
      this.rangeIndex = 2;
      this.invalidate();
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

    const selectedDays = RANGE_DAYS[this.rangeIndex];
    const range = this.data.ranges.get(selectedDays)!;
    const metric = graphMetricForRange(range, this.measurement);

    const tab = (days: number, idx: number): string => {
      const selected = idx === this.rangeIndex;
      const label = `${days}d`;
      return selected ? bold(`[${label}]`) : dim(` ${label} `);
    };

    const metricTab = (mode: MeasurementMode, label: string): string => {
      const selected = mode === this.measurement;
      return selected ? bold(`[${label}]`) : dim(` ${label} `);
    };

    const viewTab = (v: BreakdownView, label: string): string => {
      const selected = v === this.view;
      return selected ? bold(`[${label}]`) : dim(` ${label} `);
    };

    const header =
      `${bold("Session breakdown")}  ${tab(7, 0)}${tab(30, 1)}${tab(90, 2)}  ` +
      `${metricTab("sessions", "sess")}${metricTab("messages", "msg")}${metricTab("tokens", "tok")}  ` +
      `${viewTab("model", "model")}${viewTab("cwd", "cwd")}${viewTab("dow", "dow")}${viewTab("tod", "tod")}  ` +
      (this.showInsights ? bold("[insights]") : dim(" insights "));

    // Choose colors and legend based on current view
    let activeColorMap: Map<string, RGB>;
    let activeOtherColor: RGB = { r: 160, g: 160, b: 160 };
    const legendItems: string[] = [];

    if (this.view === "model") {
      activeColorMap = this.data.palette.modelColors;
      activeOtherColor = this.data.palette.otherColor;
      for (const mk of this.data.palette.orderedModels) {
        const c = activeColorMap.get(mk);
        if (c) legendItems.push(`${ansiFg(c, "█")} ${displayModelName(mk)}`);
      }
      legendItems.push(`${ansiFg(activeOtherColor, "█")} other`);
    } else if (this.view === "cwd") {
      activeColorMap = this.data.cwdPalette.cwdColors;
      activeOtherColor = this.data.cwdPalette.otherColor;
      for (const cwd of this.data.cwdPalette.orderedCwds) {
        const c = activeColorMap.get(cwd);
        if (c) legendItems.push(`${ansiFg(c, "█")} ${abbreviatePath(cwd, 30)}`);
      }
      legendItems.push(`${ansiFg(activeOtherColor, "█")} other`);
    } else if (this.view === "dow") {
      activeColorMap = this.data.dowPalette.dowColors;
      for (const dow of this.data.dowPalette.orderedDows) {
        const c = activeColorMap.get(dow);
        if (c) legendItems.push(`${ansiFg(c, "█")} ${dow}`);
      }
    } else {
      activeColorMap = this.data.todPalette.todColors;
      for (const tod of this.data.todPalette.orderedTods) {
        const c = activeColorMap.get(tod);
        if (c) legendItems.push(`${ansiFg(c, "█")} ${todBucketLabel(tod)}`);
      }
    }

    const graphDescriptor =
      this.view === "dow"
        ? `share of ${metric.kind} by weekday`
        : `${metric.kind}/day`;
    const summary =
      rangeSummary(range, selectedDays, metric.kind) +
      dim(`   (graph: ${graphDescriptor})`);

    let graphLines: string[];
    if (this.view === "dow") {
      graphLines = renderDowDistributionLines(
        range,
        this.measurement,
        this.data.dowPalette.dowColors,
        width,
      );
    } else {
      const maxScale = selectedDays === 7 ? 4 : selectedDays === 30 ? 3 : 2;
      const weeks = weeksForRange(range);
      const leftMargin = 4; // "Mon " (or 4 spaces)
      const gap = 1;
      const graphArea = Math.max(1, width - leftMargin);
      // Each week column uses: cellWidth + gap. Last column also gets gap (fine; we truncate anyway).
      const idealCellWidth =
        Math.floor((graphArea + gap) / Math.max(1, weeks)) - gap;
      const cellWidth = Math.min(maxScale, Math.max(1, idealCellWidth));

      graphLines = renderGraphLines(
        range,
        activeColorMap,
        activeOtherColor,
        this.measurement,
        { cellWidth, gap },
        this.view,
      );
    }
    const tableLines =
      this.view === "model"
        ? renderModelTable(range, metric.kind, 8, width)
        : this.view === "cwd"
          ? renderCwdTable(range, metric.kind, 8, width)
          : this.view === "dow"
            ? renderDowTable(range, metric.kind, width)
            : renderTodTable(range, metric.kind, width);

    const lines: string[] = [];
    lines.push(truncateToWidth(header, width));
    lines.push(
      truncateToWidth(
        dim(
          this.showInsights
            ? "←/→ range · i insights · q to close"
            : "←/→ range · ↑/↓ view · tab metric · i insights · q to close",
        ),
        width,
      ),
    );
    lines.push("");
    lines.push(truncateToWidth(summary, width));
    lines.push("");

    // Insights panel replaces the graph + breakdown table when toggled on.
    if (this.showInsights) {
      for (const il of renderInsights(this.data, range, selectedDays, width)) {
        lines.push(il);
      }
      this.cachedWidth = width;
      this.cachedLines = lines.map((l) =>
        visibleWidth(l) > width ? truncateToWidth(l, width) : l,
      );
      return this.cachedLines;
    }

    if (this.view === "dow") {
      for (const gl of graphLines) lines.push(truncateToWidth(gl, width));
    } else {
      // Render legend on the RIGHT of the graph if there is space.
      const graphWidth = Math.max(0, ...graphLines.map((l) => visibleWidth(l)));
      const sep = 2;
      const legendWidth = width - graphWidth - sep;
      const showSideLegend = legendWidth >= 22;

      if (showSideLegend) {
        const legendBlock: string[] = [];
        const legendTitle =
          this.view === "model"
            ? "Top models (30d palette):"
            : this.view === "cwd"
              ? "Top directories (30d palette):"
              : "Time of day:";
        legendBlock.push(dim(legendTitle));
        legendBlock.push(...legendItems);
        // Fit into 7 rows (same as graph). If too many, show a final "+N more" line.
        const maxLegendRows = graphLines.length;
        let legendLines = legendBlock.slice(0, maxLegendRows);
        if (legendBlock.length > maxLegendRows) {
          const remaining = legendBlock.length - (maxLegendRows - 1);
          legendLines = [
            ...legendBlock.slice(0, maxLegendRows - 1),
            dim(`+${remaining} more`),
          ];
        }
        while (legendLines.length < graphLines.length) legendLines.push("");

        const padRightAnsi = (s: string, target: number): string => {
          const w = visibleWidth(s);
          return w >= target ? s : s + " ".repeat(target - w);
        };

        for (let i = 0; i < graphLines.length; i++) {
          const left = padRightAnsi(graphLines[i] ?? "", graphWidth);
          const right = truncateToWidth(
            legendLines[i] ?? "",
            Math.max(0, legendWidth),
          );
          lines.push(truncateToWidth(left + " ".repeat(sep) + right, width));
        }
      } else {
        // Fallback: graph only (legend will be shown below).
        for (const gl of graphLines) lines.push(truncateToWidth(gl, width));
        lines.push("");
        // Compact legend below, left-aligned.
        const legendTitleBelow =
          this.view === "model"
            ? "Top models (30d palette):"
            : this.view === "cwd"
              ? "Top directories (30d palette):"
              : "Time of day:";
        lines.push(truncateToWidth(dim(legendTitleBelow), width));
        for (const it of legendItems) lines.push(truncateToWidth(it, width));
      }
    }

    lines.push("");
    for (const tl of tableLines) lines.push(truncateToWidth(tl, width));

    // Ensure no overly long lines (truncateToWidth already), but keep at least 1 line.
    this.cachedWidth = width;
    this.cachedLines = lines.map((l) =>
      visibleWidth(l) > width ? truncateToWidth(l, width) : l,
    );
    return this.cachedLines;
  }
}

export default function sessionBreakdownExtension(pi: ExtensionAPI) {
  pi.registerCommand("session-breakdown", {
    description:
      "Interactive breakdown of last 7/30/90 days of ~/.pi session usage: activity heatmap, model/cwd/weekday/hour breakdowns, cache hit rate & leverage, and an insights panel (i).",
    handler: async (_args, ctx: ExtensionContext) => {
      if (!ctx.hasUI) {
        // Non-interactive fallback: just notify.
        const data = await computeBreakdown(undefined);
        const range = data.ranges.get(30)!;
        pi.sendMessage(
          {
            customType: "session-breakdown",
            content: `Session breakdown (non-interactive)\n${rangeSummary(range, 30, "sessions")}`,
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }

      let aborted = false;
      const data = await ctx.ui.custom<BreakdownData | null>(
        (tui, theme, _kb, done) => {
          const baseMessage = "Analyzing sessions (last 90 days)…";
          const loader = new BorderedLoader(tui, theme, baseMessage);

          const startedAt = Date.now();
          const progress: BreakdownProgressState = {
            phase: "scan",
            foundFiles: 0,
            parsedFiles: 0,
            totalFiles: 0,
            currentFile: undefined,
          };

          const renderMessage = (): string => {
            const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
            if (progress.phase === "scan") {
              return `${baseMessage}  scanning (${formatCount(progress.foundFiles)} files) · ${elapsed}s`;
            }
            if (progress.phase === "parse") {
              return `${baseMessage}  parsing (${formatCount(progress.parsedFiles)}/${formatCount(progress.totalFiles)}) · ${elapsed}s`;
            }
            return `${baseMessage}  finalizing · ${elapsed}s`;
          };

          let intervalId: NodeJS.Timeout | null = null;
          const stopTicker = () => {
            if (intervalId) {
              clearInterval(intervalId);
              intervalId = null;
            }
          };

          // Update every 0.5s so long-running scans show some visible progress.
          setBorderedLoaderMessage(loader, renderMessage());
          intervalId = setInterval(() => {
            setBorderedLoaderMessage(loader, renderMessage());
          }, 500);

          loader.onAbort = () => {
            aborted = true;
            stopTicker();
            done(null);
          };

          computeBreakdown(loader.signal, (update) =>
            Object.assign(progress, update),
          )
            .then((d) => {
              stopTicker();
              if (!aborted) done(d);
            })
            .catch((err) => {
              stopTicker();
              console.error(
                "session-breakdown: failed to analyze sessions",
                err,
              );
              if (!aborted) done(null);
            });

          return loader;
        },
      );

      if (!data) {
        ctx.ui.notify(
          aborted ? "Cancelled" : "Failed to analyze sessions",
          aborted ? "info" : "error",
        );
        return;
      }

      await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
        return new BreakdownComponent(data, tui, done);
      });
    },
  });
}
