// The parts of Electron that screen scanning uses. Obsidian's desktop app provides the module at
// runtime; its types aren't a dependency of the plugin.
declare module "electron" {
	interface Rectangle {
		x: number;
		y: number;
		width: number;
		height: number;
	}

	interface NativeImage {
		isEmpty(): boolean;
		getSize(): { width: number; height: number };
		crop(rect: Rectangle): NativeImage;
		toPNG(): Uint8Array<ArrayBuffer>;
		toDataURL(): string;
	}

	interface WebContents {
		capturePage(): Promise<NativeImage>;
		executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
	}

	interface BrowserWindow {
		webContents: WebContents;
		getBounds(): Rectangle;
		isVisible(): boolean;
		isDestroyed(): boolean;
		hide(): void;
		show(): void;
		focus(): void;
		destroy(): void;
		loadURL(url: string): Promise<void>;
		setAlwaysOnTop(flag: boolean, level?: string): void;
		once(event: "closed", listener: () => void): void;
	}

	interface Display {
		id: number;
		bounds: Rectangle;
		size: { width: number; height: number };
		scaleFactor: number;
	}

	interface DesktopCapturerSource {
		display_id: string;
		thumbnail: NativeImage;
	}

	export const remote: {
		getCurrentWindow(): BrowserWindow;
		BrowserWindow?: {
			new (options: Record<string, unknown>): BrowserWindow;
			getAllWindows(): BrowserWindow[];
		};
		desktopCapturer?: {
			getSources(options: {
				types: string[];
				thumbnailSize: { width: number; height: number };
			}): Promise<DesktopCapturerSource[]>;
		};
		screen?: {
			getDisplayMatching(rect: Rectangle): Display;
		};
		systemPreferences?: {
			getMediaAccessStatus?(mediaType: "screen"): string;
		};
	};

	export const shell: {
		openExternal(url: string): Promise<void>;
	};
}
