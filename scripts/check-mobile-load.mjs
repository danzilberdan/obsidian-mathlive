// Loads the built main.js the way Obsidian's mobile app would: without Electron. The plugin must
// only reach for Electron when the user starts a desktop-only feature, like Scan from screen.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const mainJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../main.js");

// Every Obsidian and CodeMirror export is a stand-in class, enough to define the plugin's classes.
const Stub = class {};
const obsidian = new Proxy({}, {
	get: (_, name) => (name === "Platform" ? { isMobile: true, isMobileApp: true, isDesktopApp: false } : Stub),
});
const load = Module._load;
Module._load = function (request, ...rest) {
	if (request === "electron") {
		throw new Error("main.js requires Electron while loading, which crashes Obsidian on phones and tablets.");
	}
	if (request === "obsidian" || request.startsWith("@codemirror/")) {
		return obsidian;
	}
	return load.call(this, request, ...rest);
};
globalThis.window = globalThis;
globalThis.document = {};

require(mainJs);
console.log("main.js loads without Electron.");
