import { estimateTokens } from "./utils.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface MemoryFile {
	path: string;
	tokens: number;
	exists: boolean;
}

const MEMORY_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"];

/**
 * Scan for memory/instruction files that get loaded into context.
 * Checks: home dir, .pi/agent/, cwd, project .pi/
 */
export function scanMemoryFiles(cwd: string): MemoryFile[] {
	const candidates: string[] = [];
	const home = os.homedir();

	// Home dir
	for (const name of MEMORY_FILE_NAMES) {
		candidates.push(path.join(home, name));
	}

	// ~/.pi/agent/
	for (const name of MEMORY_FILE_NAMES) {
		candidates.push(path.join(home, ".pi", "agent", name));
	}

	// Current working directory
	for (const name of MEMORY_FILE_NAMES) {
		candidates.push(path.join(cwd, name));
	}

	// Project .pi/
	for (const name of MEMORY_FILE_NAMES) {
		candidates.push(path.join(cwd, ".pi", name));
	}

	// Deduplicate and scan
	const seen = new Set<string>();
	const results: MemoryFile[] = [];

	for (const filePath of candidates) {
		const resolved = path.resolve(filePath);
		if (seen.has(resolved)) continue;
		seen.add(resolved);

		try {
			const stat = fs.statSync(resolved);
			if (stat.isFile()) {
				const content = fs.readFileSync(resolved, "utf-8");
				results.push({
					path: resolved.replace(home, "~"),
					tokens: estimateTokens(content),
					exists: true,
				});
			}
		} catch {
			// File doesn't exist — skip silently
		}
	}

	return results.sort((a, b) => b.tokens - a.tokens);
}

/**
 * Scan for skill files. Looks at skill directories referenced by the extension system.
 */
export function scanSkillFiles(): MemoryFile[] {
	const home = os.homedir();
	const skillDirs = [
		path.join(home, ".pi", "agent", "skills"),
		path.join(home, ".agents", "skills"),
	];

	const results: MemoryFile[] = [];

	for (const dir of skillDirs) {
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const skillFile = path.join(dir, entry.name, "SKILL.md");
				try {
					const content = fs.readFileSync(skillFile, "utf-8");
					results.push({
						path: `~/.pi/agent/skills/${entry.name}/SKILL.md`,
						tokens: estimateTokens(content),
						exists: true,
					});
				} catch {
					// No SKILL.md — skip
				}
			}
		} catch {
			// Dir doesn't exist — skip
		}
	}

	return results.sort((a, b) => b.tokens - a.tokens);
}
