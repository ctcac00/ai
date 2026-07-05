/**
 * Tool Manager Extension
 *
 * Interactive UI to view, enable, and disable tools. Shows estimated token
 * cost per tool, grouped by category (builtin read, builtin write, extension read,
 * extension write, other).
 *
 * Persists blocked tools to blocked-tools.json (global + project-local).
 * Replaces the simpler blocked-tools.ts extension.
 *
 * Usage:
 *   /tools          — open tool manager UI
 *   /tools save     — save current state to blocked-tools.json
 *   /tools reset    — clear blocked list, restore all tools
 *
 * Config files (merged, project takes precedence):
 *   ~/.pi/agent/blocked-tools.json          (global)
 *   <cwd>/.pi/blocked-tools.json            (project-local)
 *
 * Format:
 *   { "blockedTools": ["web_search", "analyze_image"] }
 *   — or —
 *   ["web_search", "analyze_image"]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
	DynamicBorder,
	getAgentDir,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SettingItem,
	SettingsList,
	Text,
} from "@earendil-works/pi-tui";

// ============================================================================
// Config
// ============================================================================

function parseConfig(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.filter((t) => typeof t === "string");
	if (raw && typeof raw === "object" && "blockedTools" in raw) {
		const arr = (raw as { blockedTools: unknown }).blockedTools;
		if (Array.isArray(arr)) return arr.filter((t) => typeof t === "string");
	}
	return [];
}

function loadBlocked(cwd: string): string[] {
	const paths = [
		join(getAgentDir(), "blocked-tools.json"),
		join(cwd, ".pi", "blocked-tools.json"),
	];

	let blocked: string[] = [];
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const content = readFileSync(path, "utf-8");
			const parsed = parseConfig(JSON.parse(content));
			blocked = [...new Set([...blocked, ...parsed])];
		} catch (err) {
			console.error(`[tool-manager] Failed to read ${path}: ${err}`);
		}
	}
	return blocked;
}

function saveBlockedGlobal(blocked: Set<string> | string[]): void {
	const list = Array.isArray(blocked) ? blocked : [...blocked];
	const path = join(getAgentDir(), "blocked-tools.json");
	writeFileSync(
		path,
		JSON.stringify({ blockedTools: list.sort() }, null, 2) + "\n",
		"utf-8",
	);
}

// ============================================================================
// Token estimation (chars/4 heuristic from pi compaction)
// ============================================================================

function estimateToolTokens(tool: ToolInfo): number {
	const name = tool.name.length;
	const desc = (tool.description ?? "").length;
	const params = JSON.stringify(tool.parameters ?? {}).length;
	// Include function-definition overhead (~40 chars for name, schema wrapper)
	return Math.ceil((name + desc + params + 40) / 4);
}

function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

// ============================================================================
// Tool classification
// ============================================================================

const READ_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"web_search",
	"code_search",
	"fetch_content",
	"get_search_content",
	"session_search",
	"session_ask",
	"session_query",
	"ast_grep_search",
	"lsp_navigation",
	"memory_search",
	"memory_list",
	"memory_check",
	"memory_sync",
	"analyze_image",
	"search_external_files",
	"tape_info",
	"tape_list",
	"tape_search",
	"tape_read",
	"subagent",
	"mcp",
	"manage_todo_list",
	"todo",
]);

const WRITE_TOOLS = new Set([
	"edit",
	"write",
	"bash",
	"telegram_attach",
	"ast_grep_replace",
	"memory_sync",
	"tape_handoff",
	"tape_delete",
	"tape_reset",
	"handoff",
	"add_directory",
]);

type ToolCategory =
	| "builtin-read"
	| "builtin-write"
	| "ext-read"
	| "ext-write"
	| "other";

function classifyTool(tool: ToolInfo): ToolCategory {
	const name = tool.name;
	const isBuiltin =
		tool.sourceInfo?.source === "builtin" || tool.sourceInfo?.source === "sdk";
	const isRead =
		READ_TOOLS.has(name) ||
		name.includes("search") ||
		name.includes("list") ||
		name.includes("check") ||
		name.includes("info") ||
		name.includes("get_");
	const isWrite =
		WRITE_TOOLS.has(name) ||
		name.includes("edit") ||
		name.includes("write") ||
		name.includes("create") ||
		name.includes("delete") ||
		name.includes("attach");

	if (isBuiltin && isRead) return "builtin-read";
	if (isBuiltin && isWrite) return "builtin-write";
	if (!isBuiltin && isRead) return "ext-read";
	if (!isBuiltin && isWrite) return "ext-write";
	if (isBuiltin) return "builtin-write"; // default builtin to write (safer)
	return "other";
}

const CATEGORY_LABELS: Record<ToolCategory, string> = {
	"builtin-read": "BUILT-IN  READ-ONLY",
	"builtin-write": "BUILT-IN  READ-WRITE",
	"ext-read": "EXTENSIONS  READ-ONLY",
	"ext-write": "EXTENSIONS  READ-WRITE",
	other: "OTHER",
};

const CATEGORY_ORDER: ToolCategory[] = [
	"builtin-read",
	"builtin-write",
	"ext-read",
	"ext-write",
	"other",
];

// ============================================================================
// UI
// ============================================================================

function showToolManager(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	blocked: Set<string>,
) {
	const allTools = pi.getAllTools();
	const activeNames = new Set(pi.getActiveTools());

	// Group tools by category
	const grouped = new Map<ToolCategory, ToolInfo[]>();
	for (const cat of CATEGORY_ORDER) grouped.set(cat, []);
	for (const tool of allTools) {
		const cat = classifyTool(tool);
		grouped.get(cat)!.push(tool);
	}

	ctx.ui.custom((tui, theme, _kb, done) => {
		const container = new Container();

		// ── Header ──
		container.addChild(
			new DynamicBorder((s: string) => theme.fg("borderAccent", s)),
		);
		container.addChild(
			new Text(theme.fg("accent", theme.bold("  Tool Manager")), 1, 0),
		);
		container.addChild(
			new Text(
				theme.fg("dim", "  toggle enabled/blocked, changes apply immediately"),
				1,
				0,
			),
		);
		container.addChild(
			new DynamicBorder((s: string) => theme.fg("borderAccent", s)),
		);

		// ── Color-coded summary ──
		let totalTokens = 0;
		let activeTokens = 0;
		for (const tool of allTools) {
			const t = estimateToolTokens(tool);
			totalTokens += t;
			if (activeNames.has(tool.name) && !blocked.has(tool.name))
				activeTokens += t;
		}

		container.addChild(
			new Text(
				"  " +
					theme.fg("text", `${allTools.length} tools`) +
					" " +
					theme.fg("muted", `~${formatTokens(totalTokens)} tok`) +
					"  " +
					theme.fg("dim", "|") +
					"  " +
					theme.fg("success", `active ~${formatTokens(activeTokens)}`) +
					"  " +
					theme.fg(
						blocked.size > 0 ? "warning" : "dim",
						`blocked ${blocked.size}`,
					),
				1,
				0,
			),
		);
		container.addChild(new Text("", 0, 0));

		// ── Build SettingItems with section headers ──
		const allItems: SettingItem[] = [];

		for (const cat of CATEGORY_ORDER) {
			const tools = grouped.get(cat)!;
			if (tools.length === 0) continue;

			const catTokens = tools.reduce(
				(sum, t) => sum + estimateToolTokens(t),
				0,
			);

			allItems.push({
				id: `__header_${cat}`,
				label: `── ${CATEGORY_LABELS[cat]}  ${tools.length} tools, ~${formatTokens(catTokens)} tok ──`,
				currentValue: "",
				values: [],
			});

			for (const tool of tools) {
				const tokens = estimateToolTokens(tool);
				const isActive = activeNames.has(tool.name) && !blocked.has(tool.name);

				allItems.push({
					id: tool.name,
					label: `    ${tool.name}  (~${formatTokens(tokens)} tok)`,
					currentValue: blocked.has(tool.name)
						? "blocked"
						: isActive
							? "enabled"
							: "disabled",
					values: ["enabled", "blocked"],
				});
			}
		}

		const settingsList = new SettingsList(
			allItems,
			Math.min(allItems.length + 2, 25),
			getSettingsListTheme(),
			(id: string, newValue: string) => {
				if (id.startsWith("__")) return;

				if (newValue === "blocked") {
					blocked.add(id);
				} else {
					blocked.delete(id);
				}

				const activeTools = pi.getActiveTools().filter((n) => !blocked.has(n));
				pi.setActiveTools(activeTools);
				saveBlockedGlobal(blocked);
			},
			() => done(undefined),
			{ enableSearch: true },
		);

		container.addChild(settingsList);

		// ── Footer ──
		container.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));
		container.addChild(
			new Text(
				theme.fg(
					"dim",
					"  ↑↓ navigate · tab toggle · / search · esc close · auto-saves to blocked-tools.json",
				),
				1,
				0,
			),
		);

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				settingsList.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}

// ============================================================================
// Extension
// ============================================================================

export default function toolManagerExtension(pi: ExtensionAPI) {
	let blocked: Set<string> = new Set();

	function applyBlocked(): number {
		const active = pi.getActiveTools();
		const filtered = active.filter((name) => !blocked.has(name));
		const removed = active.length - filtered.length;
		if (removed > 0) {
			pi.setActiveTools(filtered);
		}
		return removed;
	}

	// Register /tools command
	pi.registerCommand("tools", {
		description: "Manage tools: view tokens, enable/disable, save config",
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();

			if (arg === "reset") {
				blocked.clear();
				// Re-enable all tools
				const allNames = pi.getAllTools().map((t) => t.name);
				pi.setActiveTools(allNames);
				saveBlockedGlobal([]);
				ctx.ui.notify("All tools re-enabled, config cleared", "info");
				return;
			}

			if (arg === "save") {
				saveBlockedGlobal(blocked);
				ctx.ui.notify(`Saved ${blocked.size} blocked tools to config`, "info");
				return;
			}

			// Default: show UI
			showToolManager(ctx, pi, blocked);
		},
	});

	// Apply blocked tools on session start
	pi.on("session_start", async (_event, ctx) => {
		blocked = new Set(loadBlocked(ctx.cwd));
		if (blocked.size === 0) return;

		const removed = applyBlocked();
		if (removed > 0) {
			ctx.ui.notify(
				`Blocked ${removed} tool(s): ${[...blocked].join(", ")}`,
				"info",
			);
		}
	});

	// Safety net: re-apply before each turn
	pi.on("before_agent_start", async () => {
		if (blocked.size > 0) {
			applyBlocked();
		}
	});
}
