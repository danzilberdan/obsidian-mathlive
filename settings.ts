// Set at build time (webpack.config.js): production, or staging for test builds.
declare const MATHLIVE_ORIGIN: string;

export interface PluginSettings {
	apiKey: string | null;
	// How the key got here: "device" by connecting, "trial" for the free trial, null when pasted.
	// The plugin only deletes its own device and trial keys from the server.
	apiKeySource: "device" | "trial" | null;
	useLocalInference: boolean;
	localInferenceUrl: string;
	enableInlineEditorMode: boolean;
	enableInlineMathWidgets: boolean;
	enableBlockMathWidgets: boolean;
	hideRenderedInlineMath: boolean;
	hideRenderedBlockMath: boolean;
	immediateInlineUpdate: boolean;
	arrowKeyNavigation: boolean;
	// The welcome window shows once, on a fresh install.
	welcomeShown: boolean;
	// Not in the settings tab: where the cloud scanner and website are, so tests can point the
	// plugin at stand-ins.
	cloudScannerUrl: string;
	websiteUrl: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	apiKey: null,
	apiKeySource: null,
	useLocalInference: false,
	localInferenceUrl: "http://localhost:8502",
	enableInlineEditorMode: true,
	enableInlineMathWidgets: true,
	enableBlockMathWidgets: true,
	hideRenderedInlineMath: true,
	hideRenderedBlockMath: true,
	immediateInlineUpdate: true,
	arrowKeyNavigation: true,
	welcomeShown: false,
	cloudScannerUrl: `${MATHLIVE_ORIGIN}/ocr`,
	websiteUrl: MATHLIVE_ORIGIN,
};
