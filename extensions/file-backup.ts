/**
 * File Backup Extension
 *
 * Automatically backs up files before write, edit, or file-modifying bash commands.
 * Backups stored in ~/.pi/backups/ with original path structure.
 * Auto-prunes backups older than 7 days.
 * Use /backups to list and restore.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const BACKUP_DIR = path.join(os.homedir(), ".pi/backups");
const MAX_AGE_DAYS = 7;

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
	// Match redirect targets: > file, >> file, &> file
	const redirectMatch = command.match(/(?:&?>{1,2})\s*([^\s;&|]+)/g);
	if (redirectMatch) {
		for (const m of redirectMatch) {
			const p = m.replace(/^[&>]+\s*/, "");
			if (p && !p.startsWith("&")) paths.push(p);
		}
	}
	// Match sed -i '' 's/.../.../' file  or  sed -i 's/.../.../' file
	const sedMatch = command.match(/\bsed\s+(?:-[a-zA-Z]*i[a-zA-Z]*\s*(?:''\s*)?)['"][^'"]*['"]\s+([^\s;&|]+)/);
	if (sedMatch) paths.push(sedMatch[1]);
	// Match mv/cp src dest
	const mvMatch = command.match(/\b(?:mv|cp|install)\s+(?:-[a-zA-Z]+\s+)*([^\s;&|]+)\s+([^\s;&|]+)/);
	if (mvMatch) paths.push(mvMatch[2]);
	// Match tee file
	const teeMatch = command.match(/\btee\s+(?:-[aA]+\s+)*([^\s;&|]+)/);
	if (teeMatch) paths.push(teeMatch[1]);
	// Match truncate -s ... file
	const truncMatch = command.match(/\btruncate\s+(?:-[a-zA-Z]+\s+)*([^\s;&|]+)/);
	if (truncMatch) paths.push(truncMatch[1]);

	return [...new Set(paths)];
}

function formatBackups(backups: Array<{ name: string; mtime: Date; size: number }>): string[] {
	return backups.map((b) => {
		const age = Date.now() - b.mtime.getTime();
		const hours = Math.floor(age / 3600000);
		const mins = Math.floor(age / 60000);
		const ageStr = hours > 0 ? `${hours}h ago` : `${mins}m ago`;
		const sizeStr = b.size > 1024 ? `${(b.size / 1024).toFixed(1)}KB` : `${b.size}B`;
		return `${b.name}  (${ageStr}, ${sizeStr})`;
	});
}

export default function (pi: ExtensionAPI) {
	// Prune on startup
	pruneOldBackups();

	pi.on("tool_call", async (event, ctx) => {
		// Handle write tool
		if (event.toolName === "write" || event.toolName === "edit") {
			const filePath = event.input.path as string;
			if (!filePath) return undefined;

			const backed = backupFile(filePath, ctx.cwd);
			if (backed) {
				console.log(`[file-backup] backed up ${filePath} -> ${backed}`);
			}
			return undefined;
		}

		// Handle file-modifying bash commands
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

	// Prune periodically on session start
	pi.on("session_start", async () => {
		pruneOldBackups();
	});

	pi.registerCommand("backups", {
		description: "List and restore file backups",
		handler: async (args, ctx) => {
			if (!fs.existsSync(BACKUP_DIR)) {
				ctx.ui.notify("No backups found", "info");
				return;
			}

			// Restore mode: /backups restore <backup_name>
			if (args?.startsWith("restore ")) {
				const backupName = args.slice("restore ".length).trim();
				const backupPath = path.join(BACKUP_DIR, backupName);
				if (!fs.existsSync(backupPath)) {
					ctx.ui.notify(`Backup not found: ${backupName}`, "error");
					return;
				}
				// Extract original path from backup name: timestamp__relative/path
				const sepIdx = backupName.indexOf("__");
				if (sepIdx === -1) {
					ctx.ui.notify("Invalid backup name format", "error");
					return;
				}
				const relPath = backupName.slice(sepIdx + 2);
				const restorePath = "/" + relPath;
				const ok = await ctx.ui.confirm(
					"Restore backup?",
					`Restore ${backupName} to ${restorePath}?`,
				);
				if (ok) {
					ensureDir(restorePath);
					fs.copyFileSync(backupPath, restorePath);
					ctx.ui.notify(`Restored to ${restorePath}`, "success");
				}
				return;
			}

			// Prune: /backups prune
			if (args?.trim() === "prune") {
				pruneOldBackups();
				ctx.ui.notify("Old backups pruned", "info");
				return;
			}

			// List backups
			const allBackups: Array<{ name: string; mtime: Date; size: number }> = [];
			function walk(dir: string, prefix: string = "") {
				for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
					const fullPath = path.join(dir, entry.name);
					if (entry.isDirectory()) {
						walk(fullPath, prefix ? `${prefix}/${entry.name}` : entry.name);
					} else {
						const stat = fs.statSync(fullPath);
						const backupName = prefix ? `${prefix}/${entry.name}` : entry.name;
						allBackups.push({ name: backupName, mtime: stat.mtime, size: stat.size });
					}
				}
			}
			walk(BACKUP_DIR);

			if (allBackups.length === 0) {
				ctx.ui.notify("No backups found", "info");
				return;
			}

			allBackups.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
			const recent = allBackups.slice(0, 50);
			const items = formatBackups(recent);

			if (args?.trim() === "list" || recent.length <= 20) {
				const choice = await ctx.ui.select(
					`File backups (${allBackups.length} total):`,
					[...items, "--- Close ---"],
				);
				if (choice && choice !== "--- Close ---") {
					const idx = items.indexOf(choice);
					if (idx >= 0) {
						const backupName = recent[idx].name;
						const sepIdx = backupName.indexOf("__");
						const relPath = sepIdx >= 0 ? backupName.slice(sepIdx + 2) : backupName;
						const restorePath = "/" + relPath;
						const ok = await ctx.ui.confirm(
							"Restore?",
							`Restore to ${restorePath}?`,
						);
						if (ok) {
							const fullBackup = path.join(BACKUP_DIR, backupName);
							ensureDir(restorePath);
							fs.copyFileSync(fullBackup, restorePath);
							ctx.ui.notify(`Restored to ${restorePath}`, "success");
						}
					}
				}
			} else {
				ctx.ui.notify(`${allBackups.length} backups in ${BACKUP_DIR}\nUse /backups restore <name> to restore\nUse /backups prune to clean old ones`, "info");
			}
		},
	});
}
