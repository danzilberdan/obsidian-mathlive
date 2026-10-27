import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{
		ignores: ["main.js", "node_modules/", "dist/", "*.config.js", "*.mjs", "scripts/", "tests/", "build-banner.js"],
	},
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.mjs"],
				},
			},
		},
		rules: {
			// Off in the recommended set, but the community scorecard reports it.
			"obsidianmd/prefer-active-doc": "error",
			// getSettingDefinitions() needs Obsidian 1.13; the settings tab must keep display() for older versions.
			"obsidianmd/settings-tab/prefer-setting-definitions": "off",
			"obsidianmd/ui/sentence-case": [
				"error",
				{
					brands: ["MathLive", "MathJax", "LaTeX", "Obsidian", "Docker", "Dan Zilberman", "Live Preview", "Markdown", "macOS", "System Settings", "Privacy & Security", "Screen Recording"],
					acronyms: ["API", "OCR", "PDF"],
				},
			],
		},
	},
]);
