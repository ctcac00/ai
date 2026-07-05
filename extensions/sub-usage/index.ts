/**
 * sub-usage — On-demand usage display via /sub command.
 * Consumes sub-core's event bus to fetch and display current provider usage.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Minimal types inlined from @marckrenn/pi-sub-shared
interface RateWindow {
	label: string;
	usedPercent: number;
	resetDescription?: string;
	resetAt?: string;
}

type StatusIndicator = "none" | "minor" | "major" | "critical" | "maintenance" | "unknown";

interface ProviderStatus {
	indicator: StatusIndicator;
	description?: string;
}

interface UsageSnapshot {
	provider: string;
	displayName: string;
	windows: RateWindow[];
	extraUsageEnabled?: boolean;
	fiveHourUsage?: number;
	lastSuccessAt?: number;
	error?: { code: string; message: string; httpStatus?: number };
	status?: ProviderStatus;
	requestsSummary?: string;
	requestsRemaining?: number;
	requestsEntitlement?: number;
}

interface SubCoreState {
	provider?: string;
	usage?: UsageSnapshot;
}

// ── Formatting ──────────────────────────────────────────────────────────────

function formatBar(percent: number, width = 10): string {
	const filled = Math.round((percent / 100) * width);
	const empty = width - filled;
	return "█".repeat(filled) + "░".repeat(empty);
}

function formatStatusIndicator(status?: ProviderStatus): string {
	if (!status) return "";
	const icons: Record<StatusIndicator, string> = {
		none: "✅",
		minor: "⚠️",
		major: "🔴",
		critical: "🔴",
		maintenance: "🔧",
		unknown: "❓",
	};
	const icon = icons[status.indicator] ?? "❓";
	return status.indicator === "none" ? "" : `${icon} ${status.description ?? status.indicator}`;
}

function formatUsage(state: SubCoreState): string {
	if (!state.usage) {
		return state.provider
			? `No usage data available for ${state.provider}`
			: "No provider detected";
	}

	const u = state.usage;
	const lines: string[] = [];

	// Header
	lines.push(`📊 ${u.displayName ?? state.provider ?? "Unknown"}`);

	if (u.error) {
		lines.push(`   Error: ${u.error.message}`);
		return lines.join("\n");
	}

	// Windows
	for (const w of u.windows) {
		const pct = Math.round(w.usedPercent);
		const bar = formatBar(pct);
		const reset = w.resetDescription ? ` (${w.resetDescription} left)` : "";
		lines.push(`   ${w.label.padEnd(12)} ${bar} ${pct}%${reset}`);
	}

	// Extra usage (Anthropic)
	if (u.extraUsageEnabled !== undefined) {
		const label = u.extraUsageEnabled ? "Enabled" : "Disabled";
		lines.push(`   Extra Usage  ${label}`);
	}

	// Requests (Copilot)
	if (u.requestsSummary) {
		lines.push(`   Requests     ${u.requestsSummary}`);
	}

	// Status
	const statusLine = formatStatusIndicator(u.status);
	if (statusLine) {
		lines.push(`   Status       ${statusLine}`);
	} else if (u.status?.indicator === "none") {
		lines.push(`   Status       ✅ All systems operational`);
	}

	return lines.join("\n");
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function registerSubUsage(pi: ExtensionAPI): void {
	let cachedState: SubCoreState = {};

	// Keep local cache of sub-core updates
	pi.events.on("sub-core:update-current", (payload) => {
		const data = payload as { state: SubCoreState };
		cachedState = data.state ?? {};
	});

	pi.events.on("sub-core:ready", (payload) => {
		const data = payload as { state: SubCoreState };
		cachedState = data.state ?? {};
	});

	pi.registerCommand("sub", {
		description: "Show current provider usage (on-demand)",
		handler: async (_args, ctx) => {
			// Request fresh state from sub-core
			const freshState = await new Promise<SubCoreState>((resolve) => {
				let replied = false;
				const timeout = setTimeout(() => {
					if (!replied) {
						replied = true;
						resolve(cachedState);
					}
				}, 5000);
				timeout.unref?.();

				pi.events.emit("sub-core:request", {
					reply: (response: { state: SubCoreState }) => {
						if (!replied) {
							replied = true;
							clearTimeout(timeout);
							resolve(response.state);
						}
					},
				});
			});

			// Trigger a background refresh for next time
			pi.events.emit("sub-core:action", { type: "refresh", force: true });

			const text = formatUsage(freshState);
			pi.sendMessage({
				customType: "sub-usage",
				content: text,
				display: true,
			});
		},
	});
}
