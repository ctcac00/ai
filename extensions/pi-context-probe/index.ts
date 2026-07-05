import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	categorizeTool,
	countSessionTokens,
	countToolDefTokens,
	groupMcpTools,
	groupExtensionTools,
	scaleBreakdown,
	type ContextBreakdown,
} from "./accounting.js";
import { scanMemoryFiles, scanSkillFiles } from "./memory.js";
import { generateSuggestions } from "./suggestions.js";
import { ContextProbeModal, type ProbeData } from "./display.js";
import { estimateTokens } from "./utils.js";

export default function contextProbeExtension(pi: ExtensionAPI): void {
	pi.registerCommand("context", {
		description: "Show detailed context window usage breakdown",
		handler: async (
			_args: string,
			ctx: ExtensionCommandContext,
		): Promise<void> => {
			const usage = await ctx.getContextUsage();
			if (
				!usage ||
				usage.tokens == null ||
				usage.contextWindow == null ||
				usage.percent == null
			) {
				ctx.ui.notify("Context usage info not available.", "warning");
				return;
			}

			const sm = ctx.sessionManager as SessionManager;
			const branch = sm.getBranch();
			const systemPrompt = ctx.getSystemPrompt();
			const allTools = pi.getAllTools();
			const activeToolNames = new Set(pi.getActiveTools());
			const activeToolDefs = allTools.filter((t) =>
				activeToolNames.has(t.name),
			);

			// --- Raw token estimates ---
			const systemTokensRaw = estimateTokens(systemPrompt);

			// Group tools by category
			const builtinTools = activeToolDefs.filter(
				(t) => categorizeTool(t) === "builtin",
			);
			const mcpTools = activeToolDefs.filter(
				(t) => categorizeTool(t) === "mcp",
			);
			const extensionTools = activeToolDefs.filter(
				(t) => categorizeTool(t) === "extension",
			);

			const builtinTokensRaw = countToolDefTokens(builtinTools);
			const mcpTokensRaw = countToolDefTokens(mcpTools);
			const extensionTokensRaw = countToolDefTokens(extensionTools);

			const {
				messages: msgTokensRaw,
				toolCalls: toolCallsRaw,
				toolResults: toolResultsRaw,
			} = countSessionTokens(branch);

			// --- Memory & Skills scanning ---
			const memoryFiles = scanMemoryFiles(ctx.cwd);
			const skillFiles = scanSkillFiles();
			const memoryTokensRaw = memoryFiles.reduce((sum, f) => sum + f.tokens, 0);
			const skillsTokensRaw = skillFiles.reduce((sum, f) => sum + f.tokens, 0);

			// --- Scale to actual API usage ---
			const totalActual = usage.tokens;
			const limit = usage.contextWindow;

			const scaled = scaleBreakdown(
				{
					systemPrompt: systemTokensRaw,
					builtinTools: builtinTokensRaw,
					mcpTools: mcpTokensRaw,
					extensionTools: extensionTokensRaw,
					messages: msgTokensRaw,
					toolCalls: toolCallsRaw,
					toolResults: toolResultsRaw,
				},
				totalActual,
			);

			// Calculate "other" — difference between actual and our measured categories
			// Memory + skills are estimates from files, not from API, so they're informational
			const accountedFor =
				scaled.systemPrompt +
				scaled.builtinTools +
				scaled.mcpTools +
				scaled.extensionTools +
				scaled.messages +
				scaled.toolCalls +
				scaled.toolResults;
			const other = Math.max(0, totalActual - accountedFor);

			const breakdown: ContextBreakdown = {
				systemPrompt: scaled.systemPrompt,
				builtinTools: scaled.builtinTools,
				mcpTools: scaled.mcpTools,
				extensionTools: scaled.extensionTools,
				messages: scaled.messages,
				toolCalls: scaled.toolCalls,
				toolResults: scaled.toolResults,
				skills: skillsTokensRaw,
				memoryFiles: memoryTokensRaw,
				other,
				total: totalActual,
				available: Math.max(0, limit - totalActual),
				contextWindow: limit,
				percent: usage.percent,
				mcpServers: [],
				memoryFileList: memoryFiles.map((f) => ({
					path: f.path,
					tokens: f.tokens,
				})),
				skillGroups: [],
				builtinToolNames: builtinTools.map((t) => t.name),
				extensionToolNames: extensionTools.map((t) => ({
					name: t.name,
					source: t.sourceInfo?.source ?? "unknown",
				})),
			};

			// --- Detailed tool groups with per-tool tokens ---
			const mcpGroups = Array.from(groupMcpTools(activeToolDefs).entries()).map(
				([name, tools]) => ({
					name,
					tools: tools.map((t) => ({
						name: t.name,
						tokens: estimateTokens(JSON.stringify(t)),
					})),
					tokens: countToolDefTokens(tools),
				}),
			);

			const extGroups = Array.from(
				groupExtensionTools(activeToolDefs).entries(),
			).map(([source, tools]) => ({
				name: source,
				tools: tools.map((t) => ({
					name: t.name,
					tokens: estimateTokens(JSON.stringify(t)),
				})),
				tokens: countToolDefTokens(tools),
			}));

			const builtinToolsData = builtinTools.map((t) => ({
				name: t.name,
				tokens: estimateTokens(JSON.stringify(t)),
			}));

			// --- Suggestions ---
			const suggestions = generateSuggestions(breakdown);

			// --- Display ---
			await ctx.ui.custom(
				(tui, theme, _keybindings, done) => {
					const data: ProbeData = {
						breakdown,
						mcpGroups,
						extensionGroups: extGroups,
						builtinTools: builtinToolsData,
						memoryFiles,
						skillFiles,
						suggestions,
					};

					return new ContextProbeModal(data, theme, tui, () => done(undefined));
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "90%",
						margin: 1,
					},
				},
			);
		},
	});
}
