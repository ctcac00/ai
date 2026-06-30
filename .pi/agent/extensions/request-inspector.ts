/**
 * Request Inspector Extension
 *
 * Captures LLM request payloads to disk and provides /inspect command
 * to view the system prompt in a scrollable overlay.
 *
 * Usage:
 *   /inspect          — view the latest captured system prompt
 *   /inspect raw      — view the full raw JSON payload
 *
 * Data stored at .pi/inspector/request.json (overwritten each LLM call).
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	Key,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

// ============================================================================
// Constants
// ============================================================================

const INSPECTOR_DIR = ".pi";
const INSPECTOR_FILE = "inspector-request.json";

// ~4 chars per token is a reasonable heuristic for mixed English/code
const CHARS_PER_TOKEN = 4;

// ============================================================================
// Payload Extraction
// ============================================================================

interface ExtractedSystem {
	text: string;
	source: "anthropic" | "openai" | "unknown";
}

function extractSystemPrompt(payload: unknown): ExtractedSystem {
	if (!payload || typeof payload !== "object") {
		return { text: "(empty payload)", source: "unknown" };
	}
	const p = payload as Record<string, unknown>;

	// Anthropic: payload.system is array of content blocks
	if (Array.isArray(p.system) && p.system.length > 0) {
		const text = p.system
			.filter(
				(b: unknown) =>
					typeof b === "object" &&
					b !== null &&
					(b as Record<string, unknown>).type === "text",
			)
			.map((b: unknown) => (b as Record<string, unknown>).text as string)
			.join("\n");
		if (text) return { text, source: "anthropic" };
	}

	// Anthropic: payload.system might be a string
	if (typeof p.system === "string" && p.system.length > 0) {
		return { text: p.system, source: "anthropic" };
	}

	// OpenAI: system/developer role in messages
	if (Array.isArray(p.messages)) {
		const sysMsg = (p.messages as Array<Record<string, unknown>>).find(
			(m) => m.role === "system" || m.role === "developer",
		);
		if (sysMsg) {
			const content =
				typeof sysMsg.content === "string"
					? sysMsg.content
					: JSON.stringify(sysMsg.content, null, 2);
			return { text: content, source: "openai" };
		}
	}

	return { text: "(no system prompt found in payload)", source: "unknown" };
}

function extractModelName(payload: unknown): string {
	if (!payload || typeof payload !== "object") return "unknown";
	const p = payload as Record<string, unknown>;
	return (p.model as string) ?? "unknown";
}

// ============================================================================
// Token Estimation
// ============================================================================

function estimateTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

// ============================================================================
// Scrollable Viewer Component
// ============================================================================

interface ViewerState {
	lines: string[];
	scrollOffset: number;
	model: string;
	timestamp: string;
	title: string;
	tokenEstimate: number;
	_lastWidth?: number;
}

function createScrollViewer(
	state: ViewerState,
	theme: Theme,
	done: () => void,
) {
	// Header = 2 lines (title + scroll info), footer = 2 lines (keys + bottom border)
	const RESERVED_LINES = 4;

	// We don't know terminal height inside render(), so we track it dynamically.
	// The overlay maxHeight: "90%" constrains the outer frame; render() receives
	// lines that fit within that frame. We compute maxVisibleLines from the
	// number of lines we're asked to produce minus reserved lines.
	let cachedMaxVisible = 40; // sensible default until first render

	function getMaxVisible(): number {
		return cachedMaxVisible;
	}

	function getTotalLines(): number {
		return state.lines.length;
	}

	function getMaxOffset(): number {
		return Math.max(0, getTotalLines() - getMaxVisible());
	}

	return {
		handleInput(data: string) {
			if (matchesKey(data, Key.escape) || data === "q") {
				done();
				return;
			}

			const halfPage = Math.max(1, Math.floor(getMaxVisible() / 2));

			if (matchesKey(data, Key.up) || data === "k") {
				state.scrollOffset = Math.max(0, state.scrollOffset - 1);
			} else if (matchesKey(data, Key.down) || data === "j") {
				state.scrollOffset = Math.min(getMaxOffset(), state.scrollOffset + 1);
			} else if (matchesKey(data, Key.ctrl("u"))) {
				state.scrollOffset = Math.max(0, state.scrollOffset - halfPage);
			} else if (matchesKey(data, Key.ctrl("d"))) {
				state.scrollOffset = Math.min(
					getMaxOffset(),
					state.scrollOffset + halfPage,
				);
			} else if (data === "g") {
				state.scrollOffset = 0;
			} else if (data === "G") {
				state.scrollOffset = getMaxOffset();
			}
		},

		render(width: number): string[] {
			const th = theme;
			// Overlay width: use full terminal width
			const innerW = Math.max(1, width - 2);
			const padLine = (s: string) => {
				const vis = visibleWidth(s);
				return s + " ".repeat(Math.max(0, innerW - vis));
			};
			const border = (c: string) => th.fg("border", c);

			const result: string[] = [];

			// Header
			const totalLines = getTotalLines();
			const tokenStr = `~${formatTokenCount(state.tokenEstimate)} tokens`;
			const titleText = ` ${state.title} (${state.model}, ${totalLines} lines, ${tokenStr}) `;
			const titlePad = Math.max(
				0,
				innerW - visibleWidth(th.fg("accent", titleText)),
			);
			result.push(
				border("╭") +
					th.fg("accent", titleText) +
					border(`${"─".repeat(titlePad)}╮`),
			);

			// Scroll info line
			const maxVis = getMaxVisible();
			const remaining = Math.max(
				0,
				totalLines - maxVis - state.scrollOffset,
			);
			const scrollInfo =
				state.scrollOffset > 0 || remaining > 0
					? th.fg("dim", ` ↑${state.scrollOffset} | ↓${remaining}`)
					: "";
			result.push(border("│") + padLine(scrollInfo) + border("│"));

			// Content lines
			const contentWidth = innerW - 1; // 1 space left padding
			const visible = state.lines.slice(
				state.scrollOffset,
				state.scrollOffset + maxVis,
			);

			for (let i = 0; i < visible.length; i++) {
				const lineNum = state.scrollOffset + i + 1;
				const numStr = String(lineNum).padStart(4, " ");
				const gutter = th.fg("dim", numStr + " " + th.fg("border", "│"));
				const lineContent = visible[i] ?? "";
				const line =
					gutter + " " + truncateToWidth(lineContent, contentWidth - 7, "");
				result.push(border("│") + padLine(" " + line) + border("│"));
			}

			// Pad to maxVisibleLines
			for (let i = visible.length; i < maxVis; i++) {
				result.push(border("│") + padLine("") + border("│"));
			}

			// Footer with keybindings
			const keys = th.fg(
				"dim",
				" ↑↓/j/k scroll │ Ctrl+u/d half-page │ g/G top/bottom │ Esc/q close ",
			);
			result.push(border("│") + padLine(keys) + border("│"));
			result.push(border(`╰${"─".repeat(innerW)}╯`));

			// Update cachedMaxVisible based on what we actually rendered
			cachedMaxVisible = Math.max(1, result.length - RESERVED_LINES);

			return result;
		},

		invalidate() {},
	};
}

// ============================================================================
// Wrap text into lines for viewer
// ============================================================================

function wrapContent(text: string, width: number): string[] {
	if (!text) return ["(empty)"];
	// Use wrapTextWithAnsi for ANSI-safe wrapping at target width
	// We wrap at width minus gutter space (4 digits + space + │ + space = ~8)
	const contentWidth = Math.max(20, width - 10);
	return wrapTextWithAnsi(text, contentWidth);
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
	const getInspectorPath = (cwd: string) =>
		join(cwd, INSPECTOR_DIR, INSPECTOR_FILE);

	// Hook: write payload to disk on every LLM request
	pi.on("before_provider_request", (event, ctx) => {
		const dir = join(ctx.cwd, INSPECTOR_DIR);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const filePath = getInspectorPath(ctx.cwd);
		writeFileSync(filePath, JSON.stringify(event.payload, null, 2), "utf8");
	});

	// Command: /inspect [raw]
	pi.registerCommand("inspect", {
		description:
			"Inspect the latest LLM request payload (system prompt or raw JSON)",
		handler: async (args, ctx) => {
			const isRaw = args?.trim() === "raw";
			const filePath = getInspectorPath(ctx.cwd);

			if (!existsSync(filePath)) {
				ctx.ui.notify(
					"No request captured yet. Send a prompt first.",
					"warning",
				);
				return;
			}

			let payload: unknown;
			try {
				payload = JSON.parse(readFileSync(filePath, "utf8"));
			} catch {
				ctx.ui.notify("Failed to parse captured payload.", "error");
				return;
			}

			// Get timestamp from file
			let timestamp = "unknown";
			try {
				const stat = statSync(filePath);
				timestamp = new Date(stat.mtime).toLocaleTimeString();
			} catch {
				// ignore
			}

			const model = extractModelName(payload);

			if (isRaw) {
				// Raw JSON view
				const rawText = JSON.stringify(payload, null, 2);
				const lines = rawText.split("\n");

				await ctx.ui.custom<void>(
					(tui, theme, _kb, done) => {
						const state: ViewerState = {
							lines,
							scrollOffset: 0,
							model,
							timestamp,
							title: "Raw Payload",
							tokenEstimate: estimateTokens(rawText),
						};
						const viewer = createScrollViewer(state, theme, done);

						return {
							render(w: number) {
								return viewer.render(w);
							},
							invalidate() {
								viewer.invalidate();
							},
							handleInput(data: string) {
								viewer.handleInput(data);
								tui.requestRender();
							},
						};
					},
					{ overlay: true, overlayOptions: { maxHeight: "90%", width: "100%", margin: 1 } },
				);
			} else {
				// System prompt view
				const { text, source } = extractSystemPrompt(payload);
				const lines = text.split("\n");

				await ctx.ui.custom<void>(
					(tui, theme, _kb, done) => {
						const state: ViewerState = {
							lines,
							scrollOffset: 0,
							model,
							timestamp,
							title: `System Prompt (${source})`,
							tokenEstimate: estimateTokens(text),
						};
						const viewer = createScrollViewer(state, theme, done);

						return {
							render(w: number) {
								// Re-wrap lines for current width
								if (w !== state._lastWidth) {
									state.lines = wrapContent(text, w);
									state._lastWidth = w;
									state.scrollOffset = Math.min(
										state.scrollOffset,
										Math.max(0, state.lines.length - 40),
									);
								}
								return viewer.render(w);
							},
							invalidate() {
								state._lastWidth = undefined;
								viewer.invalidate();
							},
							handleInput(data: string) {
								viewer.handleInput(data);
								tui.requestRender();
							},
						};
					},
					{ overlay: true, overlayOptions: { maxHeight: "90%", width: "100%", margin: 1 } },
				);
			}
		},
	});
}
