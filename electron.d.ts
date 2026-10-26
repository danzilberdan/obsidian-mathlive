// The parts of Electron that screen scanning uses. Obsidian's desktop app provides the module at
// runtime; its types aren't a dependency of the plugin.
declare module "electron" {
	interface NativeImage {
		isEmpty(): boolean;
		toPNG(): Uint8Array<ArrayBuffer>;
	}

	interface WebContents {
		capturePage(): Promise<NativeImage>;
	}

	interface BrowserWindow {
		webContents: WebContents;
	}

	export const remote: {
		getCurrentWindow(): BrowserWindow;
	};
}
