export interface PluginSettings {
	apiKey: string | null;
	useLocalInference: boolean;
	enableInlineEditorMode: boolean;
	enableInlineMathWidgets: boolean;
	enableBlockMathWidgets: boolean;
	hideRenderedInlineMath: boolean;
	hideRenderedBlockMath: boolean;
	immediateInlineUpdate: boolean;
	arrowKeyNavigation: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	apiKey: null,
	useLocalInference: false,
	enableInlineEditorMode: false,
	enableInlineMathWidgets: true,
	enableBlockMathWidgets: true,
	hideRenderedInlineMath: true,
	hideRenderedBlockMath: true,
	immediateInlineUpdate: true,
	arrowKeyNavigation: true,
};
