declare module "node:fs";
declare module "node:path";
declare module "node:readline";

declare const process: {
	argv: string[];
	env: Record<string, string | undefined>;
	exit(code?: number): never;
};
