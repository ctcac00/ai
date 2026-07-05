import type {
	SessionManager,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "./utils.js";

// --- Category types ---

export interface TokenCategory {
	label: string;
	tokens: number;
	color: string;
	icon: string; // ■ for used, □ for available
}

export interface McpServerBreakdown {
	name: string;
	toolCount: number;
	tokens: number;
}

export interface MemoryFileBreakdown {
	path: string;
	tokens: number;
}

export interface SkillGroupBreakdown {
	source: string;
	skillCount: number;
	tokens: number;
}

export interface ContextBreakdown {
	systemPrompt: number;
	builtinTools: number;
	mcpTools: number;
	extensionTools: number;
	messages: number;
	toolCalls: number;
	toolResults: number;
	skills: number;
	memoryFiles: number;
	other: number;
	total: number;
	available: number;
	contextWindow: number;
	percent: number | null;

	// Detailed breakdowns
	mcpServers: McpServerBreakdown[];
	memoryFileList: MemoryFileBreakdown[];
	skillGroups: SkillGroupBreakdown[];
	builtinToolNames: string[];
	extensionToolNames: { name: string; source: string }[];
}

// --- Tool categorization ---

const BUILTIN_TOOL_SOURCES = new Set([
	"@earendil-works/pi-coding-agent",
	"builtin",
]);

const MCP_TOOL_SOURCES = new Set(["pi-mcp-adapter", "mcp"]);

export function categorizeTool(
	tool: ToolInfo,
): "builtin" | "mcp" | "extension" {
	const source = tool.sourceInfo?.source ?? "";
	if (BUILTIN_TOOL_SOURCES.has(source)) return "builtin";
	if (MCP_TOOL_SOURCES.has(source) || source.includes("mcp")) return "mcp";
	return "extension";
}

export function getToolSourceLabel(tool: ToolInfo): string {
	const raw = tool.sourceInfo?.source ?? "unknown";
	// Strip npm: and git:github.com/ prefixes for cleaner display
	if (raw.startsWith("npm:")) return raw.slice(4);
	if (raw.startsWith("git:github.com/")) {
		// git:github.com/User/repo → User/repo
		return raw.slice("git:github.com/".length);
	}
	return raw;
}

// --- Session branch token counting ---

export function countSessionTokens(branch: SessionEntry[]): {
	messages: number;
	toolCalls: number;
	toolResults: number;
} {
	let messages = 0;
	let toolCalls = 0;
	let toolResults = 0;

	for (const entry of branch) {
		if (entry.type === "message") {
			const m = entry.message;
			if (m.role === "user") {
				if (typeof m.content === "string")
					messages += estimateTokens(m.content);
				else if (Array.isArray(m.content)) {
					for (const p of m.content)
						if (p.type === "text") messages += estimateTokens(p.text);
				}
			} else if (m.role === "assistant") {
				if (typeof m.content === "string")
					messages += estimateTokens(m.content);
				else if (Array.isArray(m.content)) {
					for (const p of m.content) {
						if (p.type === "text") messages += estimateTokens(p.text);
						if (p.type === "toolCall")
							toolCalls += estimateTokens(JSON.stringify(p));
					}
				}
			} else if (m.role === "toolResult") {
				if (Array.isArray(m.content)) {
					for (const p of m.content)
						if (p.type === "text") toolResults += estimateTokens(p.text);
				}
			} else if (m.role === "bashExecution") {
				toolCalls += estimateTokens(m.command || "");
			}
		} else if (entry.type === "branch_summary" || entry.type === "compaction") {
			messages += estimateTokens(entry.summary || "");
		}
	}

	return { messages, toolCalls, toolResults };
}

// --- Tool definition token counting ---

export function countToolDefTokens(tools: ToolInfo[]): number {
	return estimateTokens(JSON.stringify(tools));
}

export function groupMcpTools(allTools: ToolInfo[]): Map<string, ToolInfo[]> {
	const groups = new Map<string, ToolInfo[]>();
	for (const tool of allTools) {
		if (categorizeTool(tool) !== "mcp") continue;
		const source = getToolSourceLabel(tool);
		if (!groups.has(source)) groups.set(source, []);
		groups.get(source)!.push(tool);
	}
	return groups;
}

export function groupExtensionTools(
	allTools: ToolInfo[],
): Map<string, ToolInfo[]> {
	const groups = new Map<string, ToolInfo[]>();
	for (const tool of allTools) {
		if (categorizeTool(tool) !== "extension") continue;
		const source = getToolSourceLabel(tool);
		if (!groups.has(source)) groups.set(source, []);
		groups.get(source)!.push(tool);
	}
	return groups;
}

// --- Scale raw estimates to actual API usage ---

export function scaleBreakdown(
	raw: {
		systemPrompt: number;
		builtinTools: number;
		mcpTools: number;
		extensionTools: number;
		messages: number;
		toolCalls: number;
		toolResults: number;
	},
	totalActual: number,
): Record<string, number> {
	const totalRaw = Object.values(raw).reduce((a, b) => a + b, 0);
	const ratio = totalRaw > 0 ? totalActual / totalRaw : 1;
	const result: Record<string, number> = {};
	for (const [k, v] of Object.entries(raw)) {
		result[k] = Math.round(v * ratio);
	}
	return result;
}
