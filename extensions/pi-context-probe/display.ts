import type { ContextBreakdown } from "./accounting.js";
import { formatTokens } from "./utils.js";
// @ts-expect-error — pi-tui available at runtime via pi-coding-agent
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

// --- Data types passed from index.ts ---

export interface ToolGroup {
	name: string;
	tools: { name: string; tokens: number }[];
	tokens: number;
}

export interface ProbeData {
	breakdown: ContextBreakdown;
	mcpGroups: ToolGroup[];
	extensionGroups: ToolGroup[];
	builtinTools: { name: string; tokens: number }[];
	memoryFiles: { path: string; tokens: number }[];
	skillFiles: { path: string; tokens: number }[];
	suggestions: { icon: string; text: string }[];
}

// --- Internal line type ---

interface Line {
	text: string;
	expandKey?: string; // if set, Enter toggles this key
}

// --- Color mapping ---

const CATEGORY_COLORS: Record<string, string> = {
	"System Prompt": "muted",
	"Builtin Tools": "dim",
	"MCP Tools": "warning",
	"Extension Tools": "accent",
	Messages: "accent",
	"Tool Calls": "success",
	"Tool Results": "success",
	"Memory Files ⊂": "mdLink",
	"Skills ⊂": "syntaxNumber",
	Other: "dim",
	Available: "borderMuted",
};

// --- Modal ---

export class ContextProbeModal {
	private data: ProbeData;
	private theme: any;
	private done: () => void;
	private tui: any;

	private expanded = new Set<string>();
	private cursorY = 0;
	private scrollY = 0;
	private scrollX = 0;
	private maxVisibleLines = 20;

	private static readonly H_STEP = 4;

	constructor(data: ProbeData, theme: any, tui: any, done: () => void) {
		this.data = data;
		this.theme = theme;
		this.tui = tui;
		this.done = done;
	}

	// --- Dynamic content generation ---

	private buildLines(): Line[] {
		const lines: Line[] = [];
		this.addOverview(lines);

		// Build all groups for consistent column widths across sections
		const builtinGroup: ToolGroup[] =
			this.data.builtinTools.length > 0
				? [
						{
							name: `Builtin Tools (${this.data.builtinTools.length})`,
							tools: this.data.builtinTools,
							tokens: this.data.builtinTools.reduce((s, t) => s + t.tokens, 0),
						},
					]
				: [];
		const allGroups = [
			...this.data.mcpGroups,
			...this.data.extensionGroups,
			...builtinGroup,
		];

		// Compute name column widths across all sections, capped
		const maxNameW =
			allGroups.length > 0
				? Math.min(
						35,
						Math.max(10, ...allGroups.map((g) => visibleWidth(g.name))),
					)
				: 10;
		const allTools = allGroups.flatMap((g) => g.tools);
		const maxToolW =
			allTools.length > 0
				? Math.min(
						45,
						Math.max(10, ...allTools.map((t) => visibleWidth(t.name))),
					)
				: 10;

		this.addToolSection(
			lines,
			"mcp",
			"warning",
			"MCP Servers",
			this.data.mcpGroups,
			maxNameW,
			maxToolW,
		);
		this.addToolSection(
			lines,
			"ext",
			"accent",
			"Extension Tools",
			this.data.extensionGroups,
			maxNameW,
			maxToolW,
		);
		this.addToolSection(
			lines,
			"builtin",
			"dim",
			"Builtin Tools",
			builtinGroup,
			maxNameW,
			maxToolW,
		);

		this.addMemorySection(lines);
		this.addSkillSection(lines);
		this.addSuggestionSection(lines);
		return lines;
	}

	private addOverview(lines: Line[]): void {
		const th = this.theme;
		const bd = this.data.breakdown;
		const limit = bd.contextWindow;

		const gridWidth = 10;
		const gridHeight = 10;
		const totalBlocks = gridWidth * gridHeight;

		const categories = [
			{ label: "System Prompt", value: bd.systemPrompt },
			{ label: "Builtin Tools", value: bd.builtinTools },
			{ label: "MCP Tools", value: bd.mcpTools },
			{ label: "Extension Tools", value: bd.extensionTools },
			{ label: "Messages", value: bd.messages },
			{ label: "Tool Calls", value: bd.toolCalls },
			{ label: "Tool Results", value: bd.toolResults },
			{ label: "Memory Files \u2282", value: bd.memoryFiles },
			{ label: "Skills \u2282", value: bd.skills },
		];
		if (bd.other > 10) categories.push({ label: "Other", value: bd.other });
		categories.push({ label: "Available", value: bd.available });

		const blocks: { color: string; filled: boolean }[] = [];
		for (const cat of categories) {
			if (cat.label === "Available") continue;
			// Memory Files and Skills are already counted inside System Prompt — skip grid blocks
			if (cat.label === "Memory Files \u2282" || cat.label === "Skills \u2282")
				continue;
			let count = Math.round((cat.value / limit) * totalBlocks);
			if (count === 0 && cat.value > 0) count = 1;
			for (let i = 0; i < count && blocks.length < totalBlocks; i++) {
				blocks.push({
					color: CATEGORY_COLORS[cat.label] || "dim",
					filled: true,
				});
			}
		}
		while (blocks.length < totalBlocks) {
			blocks.push({ color: "borderMuted", filled: false });
		}

		const gridLines: string[] = [];
		for (let r = 0; r < gridHeight; r++) {
			let rowStr = "";
			for (let c = 0; c < gridWidth; c++) {
				const b = blocks[r * gridWidth + c];
				rowStr += th.fg(b.color as any, b.filled ? "■ " : "□ ");
			}
			gridLines.push(rowStr.trimEnd());
		}

		const totalLine = `${th.fg("text", th.bold("Total Usage".padEnd(16)))} ${th.fg("text", th.bold(formatTokens(bd.total).padStart(7)))} ${th.fg("text", th.bold(`(${(bd.percent ?? 0).toFixed(1).padStart(5)}% of ${formatTokens(limit)})`))}`;

		const catLines = categories.map((cat) => {
			const color = CATEGORY_COLORS[cat.label] || "dim";
			const labelStr = cat.label.padEnd(16);
			const valStr = formatTokens(cat.value).padStart(7);
			const pct = ((cat.value / limit) * 100).toFixed(1).padStart(5);
			const icon = cat.label === "Available" ? "□" : "■";
			return `${th.fg(color as any, icon)} ${th.fg("text", labelStr)} ${th.fg("accent", valStr)} (${pct}%)`;
		});

		const allDetail = [totalLine, "", ...catLines];
		const detailW = Math.max(...allDetail.map((l) => visibleWidth(l)));
		const maxH = Math.max(gridLines.length, allDetail.length);
		for (let i = 0; i < maxH; i++) {
			const detailRow = allDetail[i] || "";
			const pad = Math.max(0, detailW - visibleWidth(detailRow));
			const left = detailRow + " ".repeat(pad);
			const gridRow = gridLines[i] || "";
			lines.push({ text: `    ${left}  ${gridRow}` });
		}
		lines.push({ text: "" });
	}

	private addToolSection(
		lines: Line[],
		prefix: string,
		color: string,
		title: string,
		groups: ToolGroup[],
		maxNameW: number,
		maxToolW: number,
	): void {
		if (groups.length === 0) return;
		const th = this.theme;
		lines.push({ text: th.fg(color, th.bold(` ── ${title} ──`)) });

		for (const group of groups) {
			const key = `${prefix}:${group.name}`;
			const isExpanded = this.expanded.has(key);
			const arrow = isExpanded ? "▼" : "▶";
			const truncated = truncateToWidth(group.name, maxNameW, "…");
			const nameStr =
				truncated + " ".repeat(Math.max(0, maxNameW - visibleWidth(truncated)));
			const tokenStr = formatTokens(group.tokens).padStart(7);
			lines.push({
				text: `  ${th.fg(color, arrow)} ${th.fg(color, nameStr)} ${group.tools.length} tools  ${th.fg("dim", tokenStr + " tokens")}`,
				expandKey: key,
			});
			if (isExpanded) {
				for (const tool of group.tools) {
					const toolTrunc = truncateToWidth(tool.name, maxToolW, "…");
					const toolName =
						toolTrunc +
						" ".repeat(Math.max(0, maxToolW - visibleWidth(toolTrunc)));
					const tt = formatTokens(tool.tokens).padStart(7);
					lines.push({
						text: `      ${th.fg("text", "·")} ${th.fg("text", toolName)} ${th.fg("dim", tt + " tokens")}`,
					});
				}
			}
		}
		lines.push({ text: "" });
	}

	private addMemorySection(lines: Line[]): void {
		if (this.data.memoryFiles.length === 0) return;
		const th = this.theme;
		lines.push({
			text: th.fg(
				"mdLink",
				th.bold(" ── Memory Files ── ") +
					th.fg("dim", "(included in System Prompt)"),
			),
		});
		const maxP = Math.max(
			...this.data.memoryFiles.map((f) => f.path.length),
			10,
		);
		for (const mf of this.data.memoryFiles) {
			const p = mf.path.padEnd(maxP);
			const t = formatTokens(mf.tokens).padStart(7);
			lines.push({
				text: `  ${th.fg("mdLink", p)}  ${th.fg("dim", t + " tokens")}`,
			});
		}
		lines.push({ text: "" });
	}

	private addSkillSection(lines: Line[]): void {
		if (this.data.skillFiles.length === 0) return;
		const th = this.theme;
		lines.push({
			text: th.fg(
				"syntaxNumber",
				th.bold(" ── Skills ── ") + th.fg("dim", "(included in System Prompt)"),
			),
		});

		const skillNames = this.data.skillFiles.map((sf) => {
			// Extract skill name: last non-SKILL.md path segment
			const parts = sf.path.replace(/\\/g, "/").split("/");
			const idx = parts.lastIndexOf("SKILL.md");
			const name = idx > 0 ? parts[idx - 1] : parts[parts.length - 1];
			return { name, tokens: sf.tokens };
		});

		const maxNameW =
			skillNames.length > 0
				? Math.min(
						35,
						Math.max(10, ...skillNames.map((s) => visibleWidth(s.name))),
					)
				: 10;

		for (const sk of skillNames) {
			const trunc = truncateToWidth(sk.name, maxNameW, "…");
			const nameStr =
				trunc + " ".repeat(Math.max(0, maxNameW - visibleWidth(trunc)));
			const t = formatTokens(sk.tokens).padStart(7);
			lines.push({
				text: `  ${th.fg("syntaxNumber", nameStr)} ${th.fg("dim", t + " tokens")}`,
			});
		}
		lines.push({ text: "" });
	}

	private addSuggestionSection(lines: Line[]): void {
		if (this.data.suggestions.length === 0) return;
		const th = this.theme;
		lines.push({ text: th.fg("accent", th.bold(" ── Suggestions ──")) });
		for (const s of this.data.suggestions) {
			lines.push({ text: `  ${s.icon} ${th.fg("text", s.text)}` });
		}
		lines.push({ text: "" });
	}

	// --- Component interface ---

	handleInput(data: string): void {
		if (
			matchesKey(data, "escape") ||
			matchesKey(data, "ctrl+c") ||
			data === "q"
		) {
			this.done();
			return;
		}

		const lines = this.buildLines();

		if (matchesKey(data, "up")) {
			this.cursorY = Math.max(0, this.cursorY - 1);
			this.clampScroll(lines.length);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.cursorY = Math.min(lines.length - 1, this.cursorY + 1);
			this.clampScroll(lines.length);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "enter")) {
			const line = lines[this.cursorY];
			if (line?.expandKey) {
				if (this.expanded.has(line.expandKey)) {
					this.expanded.delete(line.expandKey);
				} else {
					this.expanded.add(line.expandKey);
				}
				// Clamp cursor after content change
				const newLines = this.buildLines();
				this.cursorY = Math.min(this.cursorY, newLines.length - 1);
				this.clampScroll(newLines.length);
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "left")) {
			this.scrollX = Math.max(0, this.scrollX - ContextProbeModal.H_STEP);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "right")) {
			this.scrollX += ContextProbeModal.H_STEP;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageup")) {
			this.cursorY = Math.max(0, this.cursorY - this.maxVisibleLines);
			this.clampScroll(lines.length);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pagedown")) {
			this.cursorY = Math.min(
				lines.length - 1,
				this.cursorY + this.maxVisibleLines,
			);
			this.clampScroll(lines.length);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "home")) {
			this.cursorY = 0;
			this.scrollX = 0;
			this.clampScroll(lines.length);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "end")) {
			this.cursorY = lines.length - 1;
			this.clampScroll(lines.length);
			this.tui.requestRender();
			return;
		}
	}

	private clampScroll(totalLines: number): void {
		if (this.cursorY < this.scrollY) {
			this.scrollY = this.cursorY;
		} else if (this.cursorY >= this.scrollY + this.maxVisibleLines) {
			this.scrollY = this.cursorY - this.maxVisibleLines + 1;
		}
		this.scrollY = Math.max(
			0,
			Math.min(totalLines - this.maxVisibleLines, this.scrollY),
		);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);

		this.maxVisibleLines = Math.max(3, process.stdout.rows - 6);

		const lines = this.buildLines();
		this.cursorY = Math.min(this.cursorY, lines.length - 1);
		this.clampScroll(lines.length);

		const border = (c: string) => th.fg("accent", c);
		const padLine = (s: string) => truncateToWidth(s, innerW, "…", true);

		const result: string[] = [];

		// Top border
		const title = truncateToWidth(" Context Probe ", innerW);
		const titlePad = Math.max(0, innerW - visibleWidth(title));
		result.push(
			border("╭") +
				th.fg("accent", th.bold(title)) +
				border(`${"─".repeat(titlePad)}╮`),
		);

		// Scroll info
		const infoParts: string[] = [];
		if (lines.length > this.maxVisibleLines) {
			infoParts.push(`row ${this.cursorY + 1}/${lines.length}`);
		}
		if (this.scrollX > 0) {
			infoParts.push(`col ${this.scrollX}`);
		}
		const scrollInfo =
			infoParts.length > 0 ? th.fg("dim", infoParts.join("  ")) : "";
		result.push(border("│") + padLine(` ${scrollInfo}`) + border("│"));

		// Content lines
		const visStart = this.scrollY;
		const visEnd = Math.min(visStart + this.maxVisibleLines, lines.length);
		const cursorOffset = this.cursorY - visStart;

		for (let i = visStart; i < visEnd; i++) {
			const line = lines[i];
			const shifted = shiftLineLeft(line.text, this.scrollX);
			const content = ` ${shifted}`;
			const isCursor = i - visStart === cursorOffset;
			const rendered = isCursor
				? th.bg("selectedBg", padLine(content))
				: padLine(content);
			result.push(border("│") + rendered + border("│"));
		}

		// Pad
		for (let i = visEnd - visStart; i < this.maxVisibleLines; i++) {
			result.push(border("│") + " ".repeat(innerW) + border("│"));
		}

		// Help bar
		const help = th.fg(
			"dim",
			" ↑↓ scroll · Enter expand · ←→ h-scroll · PgUp/PgDn · Esc close",
		);
		result.push(border("│") + padLine(` ${help}`) + border("│"));

		// Bottom border
		result.push(border(`╰${"─".repeat(innerW)}╯`));

		return result;
	}
}

// --- ANSI-aware horizontal shift ---

function shiftLineLeft(line: string, offset: number): string {
	if (offset <= 0) return line;

	let visibleCount = 0;
	let i = 0;
	const ansiRe = /\x1b\[[0-9;]*m/g;
	const prefixParts: string[] = [];

	while (i < line.length && visibleCount < offset) {
		if (line.charCodeAt(i) === 0x1b) {
			ansiRe.lastIndex = i;
			const m = ansiRe.exec(line);
			if (m && m.index === i) {
				prefixParts.push(m[0]);
				i += m[0].length;
				continue;
			}
		}
		const code = line.codePointAt(i)!;
		const charLen = code > 0xffff ? 2 : 1;
		visibleCount += isWideChar(code) ? 2 : 1;
		i += charLen;
	}

	while (i < line.length && line.charCodeAt(i) === 0x1b) {
		ansiRe.lastIndex = i;
		const m = ansiRe.exec(line);
		if (m && m.index === i) {
			prefixParts.push(m[0]);
			i += m[0].length;
			continue;
		}
		break;
	}

	return prefixParts.join("") + line.slice(i);
}

function isWideChar(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x231a && code <= 0x231b) ||
		(code >= 0x2329 && code <= 0x232a) ||
		(code >= 0x2e80 && code <= 0x303e) ||
		(code >= 0x3040 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe10 && code <= 0xfe19) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff01 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1f9ff) ||
		(code >= 0x20000 && code <= 0x2fffd) ||
		(code >= 0x30000 && code <= 0x3fffd)
	);
}
