/// <reference path="./node-shims.d.ts" />

/**
 * Pi Session Insights Analyzer
 *
 * Scans pi session files, extracts errors/corrections/patterns,
 * and outputs a markdown report with actionable suggestions.
 *
 * Usage: npx tsx scripts/analyze.ts [--days N] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dir PATH]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

// ── Types ───────────────────────────────────────────────────────────────────

interface SessionEntry {
	type: string;
	id?: string;
	timestamp?: string;
	message?: {
		role: string;
		content?: unknown;
		toolCallId?: string;
		toolName?: string;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			totalTokens?: number;
			cost?: { total?: number };
		};
		provider?: string;
		model?: string;
	};
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	cwd?: string;
	customType?: string;
}

interface SessionMeta {
	file: string;
	id: string;
	cwd: string;
	timestamp: string;
	provider: string;
	model: string;
	thinkingLevel: string;
	messageCount: number;
	assistantCount: number;
	userCount: number;
	toolCallCount: number;
	bashErrorCount: number;
	editWriteCount: number;
	compactionCount: number;
	totalCost: number;
	totalTokens: number;
}

interface Finding {
	category: string;
	severity: "high" | "medium" | "low";
	session: string;
	sessionCwd: string;
	timestamp: string;
	description: string;
	excerpt: string;
	toolName?: string;
	suggestion?: string;
}

interface AnalysisResult {
	meta: SessionMeta[];
	findings: Finding[];
	stats: {
		totalSessions: number;
		totalMessages: number;
		totalToolCalls: number;
		totalBashErrors: number;
		totalCompactions: number;
		totalCost: number;
		totalTokens: number;
		avgMessagesPerSession: number;
		errorRate: number;
		compactionRate: number;
	};
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseDate(input: string): Date {
	// ISO format: 2026-04-29
	const match = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (match) return new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
	return new Date(input);
}

function parseCliArgs(): { from: Date; to: Date; sessionsDir: string } {
	const args = process.argv.slice(2);
	const now = new Date();
	let from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // default: 7 days
	let to = now;
	let sessionsDir = path.join(
		process.env.HOME || "/root",
		".pi/agent/sessions",
	);

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--days" && args[i + 1]) {
			from = new Date(
				now.getTime() - parseInt(args[i + 1]) * 24 * 60 * 60 * 1000,
			);
			i++;
		} else if (args[i] === "--from" && args[i + 1]) {
			from = parseDate(args[i + 1]);
			i++;
		} else if (args[i] === "--to" && args[i + 1]) {
			to = parseDate(args[i + 1]);
			to.setHours(23, 59, 59, 999);
			i++;
		} else if (args[i] === "--dir" && args[i + 1]) {
			sessionsDir = args[i + 1];
			i++;
		}
	}

	return { from, to, sessionsDir };
}

function formatCost(cost: number): string {
	return `$${cost.toFixed(4)}`;
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
	return `${tokens}`;
}

function truncate(s: string, maxLen: number): string {
	s = s.replace(/\n/g, " ").trim();
	if (s.length <= maxLen) return s;
	return s.slice(0, maxLen - 3) + "...";
}

function getTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(b): b is { type: "text"; text: string } =>
				typeof b === "object" &&
				b !== null &&
				(b as any).type === "text" &&
				typeof (b as any).text === "string",
		)
		.map((b) => b.text)
		.join("\n");
}

function getToolCalls(
	content: unknown,
): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
	if (!Array.isArray(content)) return [];
	return content
		.filter(
			(
				b,
			): b is {
				type: "toolCall";
				id: string;
				name: string;
				arguments: Record<string, unknown>;
			} =>
				typeof b === "object" && b !== null && (b as any).type === "toolCall",
		)
		.map((b) => ({ id: b.id, name: b.name, arguments: b.arguments }));
}

// ── Correction detection ────────────────────────────────────────────────────

function extractBashErrorSummary(text: string): string {
	// Try to extract a concise error summary
	const exitMatch = text.match(/Command exited with code (\d+)/);
	const permMatch = text.match(/Permission denied[^\n]*/);
	const notFoundMatch = text.match(/(\S+): (command not found|not found)/);
	const failedMatch = text.match(/Job for [^ ]+ failed/);
	const errorMatch = text.match(/\nError: ([^\n]+)/);

	if (permMatch) return `Permission denied`;
	if (notFoundMatch) return `Not found: ${notFoundMatch[1]}`;
	if (failedMatch) return failedMatch[0].trim();
	if (errorMatch) return `Error: ${errorMatch[1].trim()}`;
	if (exitMatch) return `Exit code ${exitMatch[1]}`;
	return "Command failed";
}

const CORRECTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
	{
		pattern:
			/\b(no|nope|wrong|incorrect|that('?s| is) (not|wrong)|that doesn'?t work)\b/i,
		label: "correction",
	},
	{
		pattern: /\b(revert|undo|roll back|go back|don'?t do that|stop)\b/i,
		label: "revert",
	},
	{
		pattern:
			/\b(try (a different|another|using)|instead of that|use .* instead)\b/i,
		label: "redirect",
	},
	{
		pattern:
			/\b(I meant|what I (actually )?want|let me clarify|to be clear)\b/i,
		label: "clarification",
	},
	{
		pattern:
			/\b(that'?s? (not|isn'?t) (right|correct|what I|needed)|not quite|close but)\b/i,
		label: "correction",
	},
	{
		pattern:
			/\b(don'?t (do|use|write|create|remove|delete)|never (do|use|write))\b/i,
		label: "constraint",
	},
	{
		pattern:
			/\b(fix (the|that|it)|fixing|broken|doesn'?t (work|compile|run))\b/i,
		label: "error_report",
	},
	{ pattern: /\b(wait|hold on|actually,?\s)/i, label: "interrupt" },
];

function detectCorrections(
	text: string,
): Array<{ label: string; match: string }> {
	const results: Array<{ label: string; match: string }> = [];
	for (const { pattern, label } of CORRECTION_PATTERNS) {
		const m = text.match(pattern);
		if (m) results.push({ label, match: m[0] });
	}
	return results;
}

// ── Session scanning ────────────────────────────────────────────────────────

async function* findSessionFiles(
	dir: string,
	from: Date,
	to: Date,
): AsyncGenerator<string> {
	if (!fs.existsSync(dir)) return;

	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* findSessionFiles(fullPath, from, to);
		} else if (entry.name.endsWith(".jsonl")) {
			// Check file mtime as quick filter
			try {
				const stat = fs.statSync(fullPath);
				if (stat.mtime >= from && stat.mtime <= to) {
					yield fullPath;
				}
			} catch {
				// Skip unreadable files
			}
		}
	}
}

async function analyzeSession(
	filePath: string,
	from: Date,
	to: Date,
): Promise<{ meta: SessionMeta; findings: Finding[] } | null> {
	const entries: SessionEntry[] = [];

	const stream = fs.createReadStream(filePath, "utf-8");
	const rl = readline.createInterface({ input: stream });

	let lineCount = 0;
	for await (const line of rl) {
		lineCount++;
		if (!line.trim()) continue;
		try {
			const entry: SessionEntry = JSON.parse(line);
			entries.push(entry);
		} catch {
			// Skip malformed lines
		}
	}

	if (entries.length === 0) return null;

	// Extract session header
	const sessionEntry = entries.find((e) => e.type === "session");
	if (!sessionEntry) return null;

	// Check timestamp is in range
	const sessionDate = new Date(sessionEntry.timestamp || "");
	if (sessionDate < from || sessionDate > to) return null;

	// Skip subagent sessions
	const isSubagent = filePath.includes("/subagents/");
	if (isSubagent) return null;

	const modelEntry = entries.find((e) => e.type === "model_change");
	const thinkingEntry = entries.find((e) => e.type === "thinking_level_change");

	const meta: SessionMeta = {
		file: filePath,
		id: sessionEntry.id || "",
		cwd: sessionEntry.cwd || "",
		timestamp: sessionEntry.timestamp || "",
		provider: modelEntry?.provider || "unknown",
		model: modelEntry?.modelId || "unknown",
		thinkingLevel: thinkingEntry?.thinkingLevel || "unknown",
		messageCount: 0,
		assistantCount: 0,
		userCount: 0,
		toolCallCount: 0,
		bashErrorCount: 0,
		editWriteCount: 0,
		compactionCount: 0,
		totalCost: 0,
		totalTokens: 0,
	};

	const findings: Finding[] = [];
	const sessionId = path.basename(filePath, ".jsonl");

	// Track tool calls for repetition detection
	const toolCallHistory: Array<{
		name: string;
		args: Record<string, unknown>;
		timestamp: string;
	}> = [];

	// Track files written for revert detection
	const fileEdits: Map<
		string,
		Array<{ timestamp: string; tool: string }>
	> = new Map();

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;
		const ts = entry.timestamp || "";

		if (msg.role === "user") {
			meta.userCount++;
			meta.messageCount++;
			const text = getTextFromContent(msg.content);
			if (!text) continue;

			// Detect corrections
			const corrections = detectCorrections(text);
			for (const correction of corrections) {
				findings.push({
					category: "user_correction",
					severity: correction.label === "constraint" ? "high" : "medium",
					session: sessionId,
					sessionCwd: meta.cwd,
					timestamp: ts,
					description: `User ${correction.label}: "${correction.match}"`,
					excerpt: truncate(text, 200),
					suggestion:
						correction.label === "constraint"
							? "Consider adding this constraint to AGENTS.md so the model remembers it."
							: "Review if this correction reveals a recurring misunderstanding the model has.",
				});
			}
		} else if (msg.role === "assistant") {
			meta.assistantCount++;
			meta.messageCount++;

			// Count tool calls
			const toolCalls = getToolCalls(msg.content);
			for (const tc of toolCalls) {
				meta.toolCallCount++;
				toolCallHistory.push({
					name: tc.name,
					args: tc.arguments,
					timestamp: ts,
				});

				// Track edits/writes
				if (tc.name === "edit" || tc.name === "write") {
					const filePath = String(tc.arguments.path || "");
					if (filePath) {
						if (!fileEdits.has(filePath)) fileEdits.set(filePath, []);
						fileEdits.get(filePath)!.push({ timestamp: ts, tool: tc.name });
					}
					meta.editWriteCount++;
				}

				// Detect repeated identical tool calls (model struggling)
				const recentCalls = toolCallHistory.filter(
					(c) =>
						c.name === tc.name &&
						c.args.path === tc.arguments.path &&
						c.args.command === tc.arguments.command &&
						new Date(c.timestamp).getTime() > new Date(ts).getTime() - 120000,
				);
				if (recentCalls.length >= 5) {
					findings.push({
						category: "repeated_tool_call",
						severity: "medium",
						session: sessionId,
						sessionCwd: meta.cwd,
						timestamp: ts,
						description: `Model called ${tc.name} on ${String(tc.arguments.path || "?")} ${recentCalls.length} times within 60s`,
						excerpt: truncate(JSON.stringify(tc.arguments), 150),
						toolName: tc.name,
						suggestion:
							"Model may be struggling with this file/task. Consider providing clearer instructions or splitting the task.",
					});
				}
			}

			// Track cost/tokens
			if (msg.usage) {
				meta.totalCost += msg.usage.cost?.total || 0;
				meta.totalTokens += msg.usage.totalTokens || 0;
			}
		} else if (msg.role === "toolResult") {
			meta.messageCount++;
			const text = getTextFromContent(msg.content);
			const toolName = msg.toolName || "";

			// Detect bash errors
			if (toolName === "bash" && text) {
				// Skip if it looks like output from reading a file (documentation, source code)
				const isFileContent =
					text.includes("pi can create") ||
					text.includes("import type") ||
					text.startsWith("> ");
				const hasError =
					text.includes("exited with code") &&
					!text.includes("exited with code 0");
				const hasDenied = text.includes("Permission denied");
				const hasNotFound =
					text.includes("command not found") || text.includes(": not found");
				const hasFailed =
					!hasError &&
					(text.includes("\nError:") ||
						text.includes("\nFAILED") ||
						(text.includes("Job for ") && text.includes("failed")));

				if (
					!isFileContent &&
					(hasError || hasDenied || hasNotFound || hasFailed)
				) {
					meta.bashErrorCount++;
					const errorSummary = extractBashErrorSummary(text);
					findings.push({
						category: "bash_error",
						severity: hasDenied ? "high" : "medium",
						session: sessionId,
						sessionCwd: meta.cwd,
						timestamp: ts,
						description: `Bash error: ${errorSummary}`,
						excerpt: truncate(text, 200),
						toolName: "bash",
						suggestion: hasDenied
							? "Permission issue — the model may need guidance on file permissions or sudo usage."
							: hasNotFound
								? "Missing command/tool — consider noting required tools in AGENTS.md or a setup script."
								: "Bash failure — check if the command was correct or if the model needs better instructions for this task.",
					});
				}
			}

			// Detect fetch/read errors
			if (toolName === "fetch_content" && text) {
				// Only flag actual HTTP errors, not search result summaries
				if (
					text.startsWith("Error: HTTP") ||
					(text.includes("404") && text.length < 200)
				) {
					findings.push({
						category: "fetch_error",
						severity: "low",
						session: sessionId,
						sessionCwd: meta.cwd,
						timestamp: ts,
						description: `${toolName} returned an error`,
						excerpt: truncate(text, 200),
						toolName,
						suggestion:
							"Network/fetch error — may indicate outdated URLs or API issues.",
					});
				}
			}
		}
	}

	// Detect compaction events
	const compactionEntries = entries.filter(
		(e) =>
			e.type === "custom" &&
			(e.customType === "compaction" || e.customType === "compact"),
	);
	meta.compactionCount = compactionEntries.length;

	for (const comp of compactionEntries) {
		findings.push({
			category: "compaction",
			severity: "low",
			session: sessionId,
			sessionCwd: meta.cwd,
			timestamp: comp.timestamp || "",
			description: "Session was compacted (context got too large)",
			excerpt: "",
			suggestion:
				"Frequent compaction means the session context is getting large. Consider using /handoff to start fresh sessions for new tasks, or shorter focused sessions.",
		});
	}

	// Detect file reverts (file edited then reverted within short time)
	for (const [filePath, edits] of fileEdits) {
		if (edits.length >= 3) {
			const timeSpan =
				new Date(edits[edits.length - 1].timestamp).getTime() -
				new Date(edits[0].timestamp).getTime();
			if (timeSpan < 5 * 60 * 1000) {
				// Within 5 minutes
				findings.push({
					category: "file_churn",
					severity: "medium",
					session: sessionId,
					sessionCwd: meta.cwd,
					timestamp: edits[0].timestamp,
					description: `File ${path.basename(filePath)} was edited ${edits.length} times in ${Math.round(timeSpan / 1000)}s`,
					excerpt: filePath,
					suggestion:
						"High file churn suggests the model is uncertain or iterating blindly. Provide clearer requirements or ask for a plan first.",
				});
			}
		}
	}

	// Flag very long sessions (high message count)
	if (meta.userCount > 30) {
		findings.push({
			category: "long_session",
			severity: "low",
			session: sessionId,
			sessionCwd: meta.cwd,
			timestamp: meta.timestamp,
			description: `Very long session: ${meta.userCount} user messages, ${meta.assistantCount} assistant responses`,
			excerpt: "",
			suggestion:
				"Long sessions accumulate context and cost. Consider breaking large tasks into focused sessions using /handoff.",
		});
	}

	// Flag sessions with high error ratio
	if (
		meta.bashErrorCount > 3 &&
		meta.bashErrorCount / Math.max(meta.toolCallCount, 1) > 0.2
	) {
		findings.push({
			category: "high_error_rate",
			severity: "high",
			session: sessionId,
			sessionCwd: meta.cwd,
			timestamp: meta.timestamp,
			description: `High bash error rate: ${meta.bashErrorCount} errors in ${meta.toolCallCount} tool calls (${Math.round((meta.bashErrorCount / meta.toolCallCount) * 100)}%)`,
			excerpt: "",
			suggestion:
				"High error rate suggests the model lacks context about the project setup. Consider adding setup instructions to AGENTS.md.",
		});
	}

	return { meta, findings };
}

// ── Report generation ───────────────────────────────────────────────────────

function generateReport(result: AnalysisResult, from: Date, to: Date): string {
	const lines: string[] = [];
	const { meta: sessions, findings, stats } = result;

	const fromStr = from.toISOString().slice(0, 10);
	const toStr = to.toISOString().slice(0, 10);

	lines.push(`# Pi Session Insights Report`);
	lines.push(``);
	lines.push(`**Period:** ${fromStr} → ${toStr}`);
	lines.push(`**Sessions analyzed:** ${stats.totalSessions}`);
	lines.push(`**Generated:** ${new Date().toISOString().slice(0, 10)}`);
	lines.push(``);

	// ── Summary stats ──
	lines.push(`## Summary`);
	lines.push(``);
	lines.push(`| Metric | Value |`);
	lines.push(`|---|---|`);
	lines.push(`| Sessions | ${stats.totalSessions} |`);
	lines.push(`| User messages | ${stats.totalMessages} |`);
	lines.push(`| Tool calls | ${stats.totalToolCalls} |`);
	lines.push(`| Bash errors | ${stats.totalBashErrors} |`);
	lines.push(`| Compactions | ${stats.totalCompactions} |`);
	lines.push(`| Total cost | ${formatCost(stats.totalCost)} |`);
	lines.push(`| Total tokens | ${formatTokens(stats.totalTokens)} |`);
	lines.push(
		`| Avg messages/session | ${stats.avgMessagesPerSession.toFixed(1)} |`,
	);
	lines.push(`| Bash error rate | ${(stats.errorRate * 100).toFixed(1)}% |`);
	lines.push(
		`| Compaction rate | ${(stats.compactionRate * 100).toFixed(1)}% of sessions |`,
	);
	lines.push(``);

	// ── Findings by category ──
	const categories = [
		{
			key: "user_correction",
			title: "🔄 User Corrections",
			desc: "Times you corrected, redirected, or clarified the model's output",
		},
		{
			key: "bash_error",
			title: "❌ Bash Errors",
			desc: "Failed shell commands",
		},
		{
			key: "fetch_error",
			title: "🌐 Fetch/Search Errors",
			desc: "Failed web requests",
		},
		{
			key: "repeated_tool_call",
			title: "🔁 Repeated Tool Calls",
			desc: "Model called the same tool multiple times rapidly",
		},
		{
			key: "file_churn",
			title: "📝 File Churn",
			desc: "Files edited many times in quick succession",
		},
		{
			key: "compaction",
			title: "🗜️ Context Compactions",
			desc: "Sessions that hit context limits",
		},
		{
			key: "high_error_rate",
			title: "⚠️ High Error Rate Sessions",
			desc: "Sessions with unusually high failure rates",
		},
		{
			key: "long_session",
			title: "📏 Long Sessions",
			desc: "Sessions with many messages",
		},
	];

	for (const cat of categories) {
		const catFindings = findings.filter((f) => f.category === cat.key);
		if (catFindings.length === 0) continue;

		lines.push(`## ${cat.title}`);
		lines.push(``);
		lines.push(
			`*${cat.desc}* — **${catFindings.length} finding${catFindings.length > 1 ? "s" : ""}**`,
		);
		lines.push(``);

		// Group by unique descriptions for cleaner output
		const grouped = new Map<string, Finding[]>();
		for (const f of catFindings) {
			const key = f.description;
			if (!grouped.has(key)) grouped.set(key, []);
			grouped.get(key)!.push(f);
		}

		for (const [desc, group] of grouped) {
			lines.push(`### ${desc}`);
			lines.push(``);
			lines.push(`- **Occurrences:** ${group.length}`);
			if (group[0].toolName) lines.push(`- **Tool:** ${group[0].toolName}`);

			// Show excerpts (max 3)
			const excerpts = group.filter((f) => f.excerpt).slice(0, 3);
			if (excerpts.length > 0) {
				lines.push(`- **Examples:**`);
				for (const ex of excerpts) {
					lines.push(`  > ${ex.excerpt}`);
				}
			}

			// Sessions where this happened
			const sessionList = [
				...new Set(group.map((f) => f.session.slice(0, 8))),
			].slice(0, 5);
			if (sessionList.length > 0) {
				lines.push(
					`- **Sessions:** ${sessionList.join(", ")}${group.length > 5 ? ` (+${group.length - 5} more)` : ""}`,
				);
			}

			if (group[0].suggestion) {
				lines.push(`- **💡 Suggestion:** ${group[0].suggestion}`);
			}
			lines.push(``);
		}
	}

	// ── Actionable suggestions ──
	lines.push(`## 💡 Top Suggestions for AGENTS.md or Memory`);
	lines.push(``);

	// Collect unique suggestions from high/medium findings
	const suggestions = new Map<
		string,
		{ count: number; severity: string; categories: Set<string> }
	>();
	for (const f of findings) {
		if (!f.suggestion || f.severity === "low") continue;
		const key = f.suggestion;
		if (!suggestions.has(key)) {
			suggestions.set(key, {
				count: 0,
				severity: f.severity,
				categories: new Set(),
			});
		}
		const s = suggestions.get(key)!;
		s.count++;
		s.categories.add(f.category);
	}

	if (suggestions.size === 0) {
		lines.push(
			`No high-priority suggestions found. Your sessions look clean! 🎉`,
		);
	} else {
		const sorted = [...suggestions.entries()].sort(
			(a, b) => b[1].count - a[1].count,
		);
		for (const [suggestion, data] of sorted) {
			lines.push(
				`1. **[${data.severity.toUpperCase()}]** (×${data.count}) ${suggestion}`,
			);
		}
	}
	lines.push(``);

	// ── Constraint extraction ──
	const constraintFindings = findings.filter(
		(f) =>
			f.category === "user_correction" && f.description.includes("constraint"),
	);
	if (constraintFindings.length > 0) {
		lines.push(`## 📋 Detected Constraints`);
		lines.push(``);
		lines.push(
			`These are rules you've explicitly told the model. Consider adding them to AGENTS.md:`,
		);
		lines.push(``);
		for (const f of constraintFindings) {
			lines.push(`- ${f.excerpt}`);
		}
		lines.push(``);
	}

	// ── Per-session breakdown ──
	lines.push(`## 📊 Sessions Analyzed`);
	lines.push(``);
	lines.push(`| Session | Project | Messages | Tools | Bash Errors | Cost |`);
	lines.push(`|---|---|---|---|---|---|`);
	for (const s of sessions.slice(0, 30)) {
		const shortId = s.id.slice(0, 8);
		const project = path.basename(s.cwd);
		lines.push(
			`| ${shortId} | ${project} | ${s.messageCount} | ${s.toolCallCount} | ${s.bashErrorCount} | ${formatCost(s.totalCost)} |`,
		);
	}
	if (sessions.length > 30) {
		lines.push(`| *...${sessions.length - 30} more sessions* | | | | | |`);
	}
	lines.push(``);

	return lines.join("\n");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
	const { from, to, sessionsDir } = parseCliArgs();

	console.error(
		`Scanning sessions from ${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}...`,
	);
	console.error(`Directory: ${sessionsDir}`);

	const allMeta: SessionMeta[] = [];
	const allFindings: Finding[] = [];

	let sessionCount = 0;

	for await (const filePath of findSessionFiles(sessionsDir, from, to)) {
		try {
			const result = await analyzeSession(filePath, from, to);
			if (result) {
				allMeta.push(result.meta);
				allFindings.push(...result.findings);
				sessionCount++;
			}
		} catch (err) {
			console.error(`Error processing ${filePath}: ${err}`);
		}
	}

	console.error(
		`Analyzed ${sessionCount} sessions, found ${allFindings.length} findings.`,
	);

	if (sessionCount === 0) {
		console.log("# Pi Session Insights Report\n");
		console.log("No sessions found in the specified time range.");
		return;
	}

	// Sort sessions by timestamp
	allMeta.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

	// Sort findings by severity then timestamp
	const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
	allFindings.sort(
		(a, b) =>
			severityOrder[a.severity] - severityOrder[b.severity] ||
			a.timestamp.localeCompare(b.timestamp),
	);

	const totalMessages = allMeta.reduce((s, m) => s + m.messageCount, 0);
	const totalToolCalls = allMeta.reduce((s, m) => s + m.toolCallCount, 0);
	const totalBashErrors = allMeta.reduce((s, m) => s + m.bashErrorCount, 0);
	const totalCompactions = allMeta.reduce((s, m) => s + m.compactionCount, 0);
	const totalCost = allMeta.reduce((s, m) => s + m.totalCost, 0);
	const totalTokens = allMeta.reduce((s, m) => s + m.totalTokens, 0);

	const result: AnalysisResult = {
		meta: allMeta,
		findings: allFindings,
		stats: {
			totalSessions: sessionCount,
			totalMessages,
			totalToolCalls,
			totalBashErrors,
			totalCompactions,
			totalCost,
			totalTokens,
			avgMessagesPerSession:
				sessionCount > 0 ? totalMessages / sessionCount : 0,
			errorRate: totalToolCalls > 0 ? totalBashErrors / totalToolCalls : 0,
			compactionRate: sessionCount > 0 ? totalCompactions / sessionCount : 0,
		},
	};

	const report = generateReport(result, from, to);
	console.log(report);
}

main().catch((err) => {
	console.error(`Fatal error: ${err}`);
	process.exit(1);
});
