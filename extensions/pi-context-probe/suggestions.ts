import type { ContextBreakdown } from "./accounting.js";

export interface Suggestion {
	icon: string;
	text: string;
}

export function generateSuggestions(bd: ContextBreakdown): Suggestion[] {
	const suggestions: Suggestion[] = [];
	const { percent, total, contextWindow } = bd;

	// High context usage
	if (percent != null && percent > 80) {
		suggestions.push({
			icon: "⚠",
			text: `Context at ${percent.toFixed(0)}% — consider /acm, /compact, or /handoff`,
		});
	} else if (percent != null && percent > 60) {
		suggestions.push({
			icon: "💡",
			text: `Context at ${percent.toFixed(0)}% — getting warm. Plan ahead for compaction.`,
		});
	}

	// Large MCP servers
	for (const server of bd.mcpServers) {
		if (server.toolCount > 10) {
			suggestions.push({
				icon: "📦",
				text: `MCP "${server.name}" has ${server.toolCount} tools (${(server.tokens / 1000).toFixed(1)}k tokens) — consider deferring unused tools`,
			});
		}
	}

	// Large memory files
	for (const mf of bd.memoryFileList) {
		if (mf.tokens > 5000) {
			suggestions.push({
				icon: "📄",
				text: `${mf.path} is ${mf.tokens} tokens — consider trimming or splitting`,
			});
		}
	}

	// Large tool results
	if (bd.toolResults > bd.contextWindow * 0.2) {
		suggestions.push({
			icon: "🔧",
			text: `Tool results using ${((bd.toolResults / bd.contextWindow) * 100).toFixed(0)}% of context — use | head, line ranges, or narrower queries`,
		});
	}

	// Extension tools overhead
	const totalToolDefs = bd.builtinTools + bd.mcpTools + bd.extensionTools;
	if (totalToolDefs > bd.contextWindow * 0.1) {
		suggestions.push({
			icon: "🛠",
			text: `Tool definitions using ${((totalToolDefs / bd.contextWindow) * 100).toFixed(0)}% — review active extensions and MCP servers`,
		});
	}

	if (suggestions.length === 0) {
		suggestions.push({
			icon: "✅",
			text: "Context looks healthy.",
		});
	}

	return suggestions;
}
