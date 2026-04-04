#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const manifestPath = path.join(repoRoot, "manifest.json");

function printUsage() {
	console.log("Usage: npm run link-vault -- \"/path/to/YourVault\"");
}

const vaultArg = process.argv[2];
if (!vaultArg || vaultArg === "--help" || vaultArg === "-h") {
	printUsage();
	process.exit(vaultArg ? 0 : 1);
}

const vaultPath = path.resolve(process.cwd(), vaultArg);
const obsidianDir = path.join(vaultPath, ".obsidian");
const pluginsDir = path.join(obsidianDir, "plugins");

try {
	await fs.access(obsidianDir);
} catch {
	console.error(`Could not find an Obsidian vault at: ${vaultPath}`);
	console.error("Expected to find a .obsidian folder there.");
	process.exit(1);
}

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const pluginDir = path.join(pluginsDir, manifest.id);

await fs.mkdir(pluginsDir, { recursive: true });

try {
	const existing = await fs.lstat(pluginDir);

	if (!existing.isSymbolicLink()) {
		console.error(`Target already exists and is not a symlink: ${pluginDir}`);
		console.error("Move or delete that folder first, then run this command again.");
		process.exit(1);
	}

	const currentTarget = await fs.readlink(pluginDir);
	const resolvedTarget = path.resolve(path.dirname(pluginDir), currentTarget);

	if (resolvedTarget === repoRoot) {
		console.log(`Vault already linked: ${pluginDir} -> ${repoRoot}`);
		process.exit(0);
	}

	console.error(`Target already points somewhere else: ${pluginDir} -> ${resolvedTarget}`);
	console.error("Update or remove that symlink first, then run this command again.");
	process.exit(1);
} catch (error) {
	if (error.code !== "ENOENT") {
		throw error;
	}
}

await fs.symlink(repoRoot, pluginDir, "dir");

console.log(`Linked ${pluginDir} -> ${repoRoot}`);
console.log("Run `npm run dev` to rebuild main.js as you work.");
