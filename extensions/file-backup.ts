/**
 * File Backup Extension
 *
 * Automatically backs up files before write, edit, or file-modifying bash commands.
 * Backups stored in ~/.pi/backups/ with original path structure.
 * Auto-prunes backups older than 7 days.
 *
 * Commands:
 *   /backups                — interactive browser: fuzzy search, keyboard navigation, actions
 *   /backups restore <name> — restore a specific backup
 *   /backups delete <name>  — delete a specific backup
 *   /backups view <name>    — preview a backup's contents
 *   /backups prune          — remove backups older than 7 days
 *   /backups search <term>  — open the browser pre-filtered by <term>
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	matchesKey,
	SelectList,
	type SelectItem,
	Text,
} from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const BACKUP_DIR = path.join(os.homedir(), ".pi/backups");
const MAX_AGE_DAYS = 7;
const PREVIEW_LINES = 20;
const MAX_VISIBLE = 14;

// Bash patterns that modify files
const BASH_MODIFY_PATTERNS = [
	/\bsed\s+.*-i\b/,
	/\bmv\b/,
	/\bcp\s+.*\b/,
	/\btruncate\b/,
	/\bdd\s+/,
	/\btee\b/,
	/\bchmod\b/,
	/\bchown\b/,
	/\binstall\s+/,
	/>[>\s]/, // > or >> redirect
	/\bperl\s+.*-i\b/,
	/\bawk\s+.*-i\b/,
];

function ensureDir(filePath: string) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function pruneOldBackups() {
	try {
		if (!fs.existsSync(BACKUP_DIR)) return;
		const now = Date.now();
		const maxAge = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
		const entries = fs.readdirSync(BACKUP_DIR);
		let pruned = 0;
		for (const entry of entries) {
			const fullPath = path.join(BACKUP_DIR, entry);
			const stat = fs.statSync(fullPath);
			if (now - stat.mtimeMs > maxAge) {
				fs.rmSync(fullPath, { recursive: true, force: true });
				pruned++;
			}
		}
		if (pruned > 0) {
			console.log(`[file-backup] pruned ${pruned} old backup(s)`);
		}
	} catch {
		// silent
	}
}

function backupFile(filePath: string, cwd: string): string | null {
	const absPath = path.resolve(cwd, filePath);
	if (!fs.existsSync(absPath)) return null;

	const relPath = path.relative("/", absPath).replace(/^\//, "");
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupPath = path.join(BACKUP_DIR, `${timestamp}__${relPath}`);

	ensureDir(backupPath);
	fs.copyFileSync(absPath, backupPath);
	return backupPath;
}

function extractPathsFromBash(command: string): string[] {
	const paths: string[] = [];
	const redirectMatch = command.match(/(?:&?>{1,2})\s*([^\s;&|]+)/g);
	if (redirectMatch) {
		for (const m of redirectMatch) {
			const p = m.replace(/^[&>]+\s*/, "");
			if (p && !p.startsWith("&")) paths.push(p);
		}
	}
	const sedMatch = command.match(/\bsed\s+(?:-[a-zA-Z]*i[a-zA-Z]*\s*(?:''\s*)?)['"][^'"]*['"]\s+([^\s;&|]+)/);
	if (sedMatch) paths.push(sedMatch[1]);
	const mvMatch = command.match(/\b(?:mv|cp|install)\s+(?:-[a-zA-Z]+\s+)*([^\s;&|]+)\s+([^\s;&|]+)/);
	if (mvMatch) paths.push(mvMatch[2]);
	const teeMatch = command.match(/\btee\s+(?:-[aA]+\s+)*([^\s;&|]+)/);
	if (teeMatch) paths.push(teeMatch[1]);
	const truncMatch = command.match(/\btruncate\s+(?:-[a-zA-Z]+\s+)*([^\s;&|]+)/);
	if (truncMatch) paths.push(truncMatch[1]);

	return [...new Set(paths)];
}

function formatAge(ms: number): string {
	if (ms < 60000) return "just now";
	const mins = Math.floor(ms / 60000);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(ms / 3600000);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(ms / 86400000);
	return `${days}d ago`;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function extractOriginalPath(backupName: string): string {
	const sepIdx = backupName.indexOf("__");
	return sepIdx >= 0 ? backupName.slice(sepIdx + 2) : backupName;
}

interface BackupEntry {
	name: string;
	mtime: Date;
	size: number;
	originalPath: string;
}

function collectBackups(): BackupEntry[] {
	if (!fs.existsSync(BACKUP_DIR)) return [];
	const backups: BackupEntry[] = [];
	function walk(dir: string, prefix: string = "") {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath, prefix ? `${prefix}/${entry.name}` : entry.name);
			} else {
				const stat = fs.statSync(fullPath);
				const backupName = prefix ? `${prefix}/${entry.name}` : entry.name;
				backups.push({
					name: backupName,
					mtime: stat.mtime,
					size: stat.size,
					originalPath: extractOriginalPath(backupName),
				});
			}
		}
	}
	walk(BACKUP_DIR);
	backups.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
	return backups;
}

type PickerResult =
	| { kind: "backup"; backup: BackupEntry }
	| { kind: "new" }
	| { kind: "prune" }
	| { kind: "cancel" };

type ActionResult =
	| { kind: "restore" }
	| { kind: "view" }
	| { kind: "delete" }
	| { kind: "back" };

function buildSelectList(
	items: SelectItem[],
	onSelect: (item: SelectItem) => void,
	onCancel: () => void,
): SelectList {
	const list = new SelectList(
		items,
		Math.min(items.length, MAX_VISIBLE),
		getSelectListTheme(),
	);
	list.onSelect = onSelect;
	list.onCancel = onCancel;
	return list;
}

/**
 * Main backups picker: fuzzy search input + keyboard-navigable list.
 * Typing filters; up/down/pgup/pgdn navigate; enter selects; esc closes.
 */
async function showBackupsPicker(
	ctx: ExtensionContext,
	initialFilter = "",
): Promise<PickerResult> {
	const backups = collectBackups();
	if (backups.length === 0) return { kind: "cancel" };

	return ctx.ui.custom<PickerResult>((tui, theme, _kb, done) => {
		let currentItems = backups;
		let list: SelectList;

		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		const title = new Text(
			theme.fg("accent", theme.bold(`Backups (${backups.length})`)),
			1,
			0,
		);
		container.addChild(title);

		const searchInput = new Input();
		searchInput.focused = true;
		if (initialFilter) searchInput.setValue(initialFilter);
		container.addChild(searchInput);

		const help = new Text(
			theme.fg(
				"dim",
				"type to filter • ↑↓ navigate • PgUp/PgDn jump • enter actions • ^N new • ^P prune • esc close",
			),
			1,
			0,
		);

		// Layout: [border, title, search, list, help, border] — list swapped on filter change
		const LIST_CHILD_INDEX = 3;

		const refresh = () => {
			const query = searchInput.getValue().trim();
			currentItems = query
				? fuzzyFilter(backups, query, (b) => b.originalPath)
				: backups;
			title.setText(
				theme.fg(
					"accent",
					theme.bold(
						query
							? `Backups — ${currentItems.length}/${backups.length} matching "${query}"`
							: `Backups (${backups.length})`,
					),
				),
			);
			// Rebuild list in place (swap child between search input and help)
			const selectItems: SelectItem[] = currentItems.map((b) => ({
				value: b.name,
				label: b.originalPath,
				description: `${formatAge(b.mtime.getTime())} · ${formatSize(b.size)}`,
			}));
			list = buildSelectList(
				selectItems,
				(item) => {
					const backup = backups.find((b) => b.name === item.value);
					if (backup) done({ kind: "backup", backup });
				},
				() => done({ kind: "cancel" }),
			);
			if (container.children.length > LIST_CHILD_INDEX) {
				container.children[LIST_CHILD_INDEX] = list;
			} else {
				container.addChild(list);
			}
			tui.requestRender();
		};

		refresh();
		container.addChild(help);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				// Navigation keys -> list
				if (
					matchesKey(data, "up") ||
					matchesKey(data, "down") ||
					matchesKey(data, "enter")
				) {
					list.handleInput(data);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
					const selected = list.getSelectedItem();
					const idx = currentItems.findIndex((b) => b.name === selected?.value);
					const delta = matchesKey(data, "pageUp") ? -MAX_VISIBLE : MAX_VISIBLE;
					list.setSelectedIndex(Math.max(0, idx) + delta);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "escape")) {
					if (searchInput.getValue()) {
						searchInput.setValue("");
						refresh();
					} else {
						done({ kind: "cancel" });
					}
					return;
				}
				if (matchesKey(data, "ctrl+n")) {
					done({ kind: "new" });
					return;
				}
				if (matchesKey(data, "ctrl+p")) {
					done({ kind: "prune" });
					return;
				}
				// Everything else -> search input (live filter)
				searchInput.handleInput(data);
				refresh();
			},
		};
	});
}

async function showActionMenu(
	ctx: ExtensionContext,
	backup: BackupEntry,
): Promise<ActionResult> {
	return ctx.ui.custom<ActionResult>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(
			new Text(theme.fg("accent", theme.bold(backup.originalPath)), 1, 0),
		);
		container.addChild(
			new Text(
				theme.fg(
					"dim",
					`${formatAge(backup.mtime.getTime())} · ${formatSize(backup.size)} · ${backup.name}`,
				),
				1,
				0,
			),
		);

		const items: SelectItem[] = [
			{ value: "restore", label: "Restore", description: `Restore to /${backup.originalPath}` },
			{ value: "view", label: "View preview", description: `First ${PREVIEW_LINES} lines` },
			{ value: "delete", label: "Delete", description: "Remove this backup permanently" },
			{ value: "back", label: "Back", description: "Return to backup list" },
		];
		const list = buildSelectList(
			items,
			(item) => done({ kind: item.value as ActionResult["kind"] }),
			() => done({ kind: "back" }),
		);
		container.addChild(list);
		container.addChild(
			new Text(theme.fg("dim", "↑↓ navigate • enter select • esc back"), 1, 0),
		);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

/** Interactive browser: picker -> action menu -> action, looping until closed. */
async function browseBackups(ctx: ExtensionContext, initialFilter = "") {
	let filter = initialFilter;
	while (true) {
		const pick = await showBackupsPicker(ctx, filter);
		if (pick.kind === "cancel") return;

		if (pick.kind === "new") {
			await doManualBackup(ctx);
			return;
		}

		if (pick.kind === "prune") {
			await doPrune(ctx);
			return;
		}

		// Action submenu
		const action = await showActionMenu(ctx, pick.backup);
		if (action.kind === "restore") {
			await doRestore(ctx, pick.backup);
			return;
		}
		if (action.kind === "view") {
			await doView(ctx, pick.backup);
			// loop back to picker after preview
			continue;
		}
		if (action.kind === "delete") {
			await doDelete(ctx, pick.backup);
			return;
		}
		// back -> reopen picker
	}
}

async function doManualBackup(ctx: ExtensionContext) {
	const filePath = await ctx.ui.input("Manual backup", "Enter file path to back up");
	if (!filePath) return;
	try {
		const absPath = path.resolve(ctx.cwd, filePath);
		if (!fs.existsSync(absPath)) {
			ctx.ui.notify(`File not found: ${filePath}`, "error");
			return;
		}
		const backed = backupFile(filePath, ctx.cwd);
		if (backed) {
			ctx.ui.notify(`Backed up to ${backed}`, "info");
		} else {
			ctx.ui.notify("Backup failed", "error");
		}
	} catch (err: unknown) {
		ctx.ui.notify(`Backup failed: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}

async function doPrune(ctx: ExtensionContext) {
	const beforeCount = collectBackups().length;
	pruneOldBackups();
	const afterCount = collectBackups().length;
	ctx.ui.notify(`Pruned ${beforeCount - afterCount} old backup(s)`, "info");
}

async function doRestore(ctx: ExtensionContext, backup: BackupEntry) {
	const restorePath = "/" + backup.originalPath;
	const ok = await ctx.ui.confirm("Restore backup?", `Restore "${backup.name}" to ${restorePath}?`);
	if (!ok) return;
	try {
		const fullBackup = path.join(BACKUP_DIR, backup.name);
		ensureDir(restorePath);
		fs.copyFileSync(fullBackup, restorePath);
		ctx.ui.notify(`Restored to ${restorePath}`, "info");
	} catch (err: unknown) {
		ctx.ui.notify(`Restore failed: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}

async function doDelete(ctx: ExtensionContext, backup: BackupEntry) {
	const ok = await ctx.ui.confirm("Delete backup?", `Delete "${backup.name}"? This cannot be undone.`);
	if (!ok) return;
	try {
		const fullBackup = path.join(BACKUP_DIR, backup.name);
		fs.rmSync(fullBackup, { force: true });
		cleanEmptyParents(path.dirname(fullBackup));
		ctx.ui.notify(`Deleted backup: ${backup.name}`, "info");
	} catch (err: unknown) {
		ctx.ui.notify(`Delete failed: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}

function cleanEmptyParents(dir: string) {
	try {
		let current = dir;
		while (current.startsWith(BACKUP_DIR) && current !== BACKUP_DIR) {
			const entries = fs.readdirSync(current);
			if (entries.length === 0) {
				fs.rmdirSync(current);
				current = path.dirname(current);
			} else {
				break;
			}
		}
	} catch {
		// silent
	}
}

async function doView(ctx: ExtensionContext, backup: BackupEntry) {
	try {
		const fullBackup = path.join(BACKUP_DIR, backup.name);
		const content = fs.readFileSync(fullBackup, "utf-8");
		const lines = content.split("\n");
		const totalLines = lines.length;
		const preview = lines.slice(0, PREVIEW_LINES).join("\n");
		const truncated = totalLines > PREVIEW_LINES ? `\n... (${totalLines - PREVIEW_LINES} more lines)` : "";

		const restore = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(
				new Text(
					theme.fg(
						"accent",
						theme.bold(
							`Preview: ${backup.originalPath} (${totalLines} lines, ${formatSize(backup.size)})`,
						),
					),
					1,
					0,
				),
			);
			container.addChild(new Text(preview + truncated, 1, 0));
			container.addChild(
				new Text(theme.fg("dim", "r restore • esc close"), 1, 0),
			);
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					if (data === "r") done(true);
					else if (matchesKey(data, "escape")) done(false);
					tui.requestRender();
				},
			};
		});

		if (restore) {
			await doRestore(ctx, backup);
		}
	} catch (err: unknown) {
		ctx.ui.notify(`Preview failed: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}

export default function (pi: ExtensionAPI) {
	pruneOldBackups();

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			const filePath = event.input.path as string;
			if (!filePath) return undefined;
			const backed = backupFile(filePath, ctx.cwd);
			if (backed) {
				console.log(`[file-backup] backed up ${filePath} -> ${backed}`);
			}
			return undefined;
		}

		if (event.toolName === "bash") {
			const command = event.input.command as string;
			if (!command) return undefined;
			const isModifying = BASH_MODIFY_PATTERNS.some((p) => p.test(command));
			if (!isModifying) return undefined;
			const filePaths = extractPathsFromBash(command);
			for (const fp of filePaths) {
				const backed = backupFile(fp, ctx.cwd);
				if (backed) {
					console.log(`[file-backup] backed up ${fp} -> ${backed}`);
				}
			}
			return undefined;
		}
	});

	pi.on("session_start", async () => {
		pruneOldBackups();
	});

	pi.registerCommand("backups", {
		description: "List, restore, delete, and preview file backups",
		handler: async (args, ctx) => {
			if (!fs.existsSync(BACKUP_DIR)) {
				ctx.ui.notify("No backups found", "info");
				return;
			}

			// Restore mode: /backups restore <backup_name>
			if (args?.startsWith("restore ")) {
				const backupName = args.slice("restore ".length).trim();
				const backups = collectBackups();
				const backup = backups.find((b) => b.name === backupName);
				if (!backup) {
					ctx.ui.notify(`Backup not found: ${backupName}`, "error");
					return;
				}
				await doRestore(ctx, backup);
				return;
			}

			// Delete mode: /backups delete <backup_name>
			if (args?.startsWith("delete ")) {
				const backupName = args.slice("delete ".length).trim();
				const backups = collectBackups();
				const backup = backups.find((b) => b.name === backupName);
				if (!backup) {
					ctx.ui.notify(`Backup not found: ${backupName}`, "error");
					return;
				}
				await doDelete(ctx, backup);
				return;
			}

			// View mode: /backups view <backup_name>
			if (args?.startsWith("view ")) {
				const backupName = args.slice("view ".length).trim();
				const backups = collectBackups();
				const backup = backups.find((b) => b.name === backupName);
				if (!backup) {
					ctx.ui.notify(`Backup not found: ${backupName}`, "error");
					return;
				}
				await doView(ctx, backup);
				return;
			}

			// Prune: /backups prune
			if (args?.trim() === "prune") {
				await doPrune(ctx);
				return;
			}

			// Search mode: /backups search <term> — open picker pre-filtered
			if (args?.startsWith("search ")) {
				const searchTerm = args.slice("search ".length).trim();
				if (collectBackups().length === 0) {
					ctx.ui.notify("No backups found", "info");
					return;
				}
				await browseBackups(ctx, searchTerm);
				return;
			}

			// /backups list or default — interactive browser
			if (collectBackups().length === 0) {
				ctx.ui.notify("No backups found", "info");
				return;
			}
			await browseBackups(ctx);
		},
	});
}
