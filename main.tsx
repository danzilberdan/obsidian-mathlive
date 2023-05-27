import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { createRoot } from "react-dom/client";
import * as React from "react";
import * as ReactDOM from "react-dom";
import { MathLiveComponent } from "./MathLiveComponent";

export default class MathLivePlugin extends Plugin {

	async onload() {
		this.addCommand({
			id: 'open-modal',
			name: 'Edit in MathLive',
			editorCallback: (editor: Editor, ctx: MarkdownView) => {
				new MathLiveModal(this.app).open();
			}
		});
	}
}

class MathLiveModal extends Modal {
	renderedResult?: string
	
	constructor(app: App) {
		super(app);
	}

	parseSelection(selectionText: string) : { resultRenderTemplate: (result: string) => string, initialLatex: string } | null {
		if (selectionText.length === 0) {
			return {
				resultRenderTemplate: result => result.length > 0 ? "$$" + result + "$$" : "",
				initialLatex: ""
			}
		}

		const mathPreviewStartIndex = selectionText.indexOf("$$");
		if (mathPreviewStartIndex >= 0) {
			const mathPreviewEndIndex = selectionText.indexOf("$$", mathPreviewStartIndex + 2);
			return {
				resultRenderTemplate: result => 
					selectionText.substring(0, mathPreviewStartIndex) 
					+ "$$" 
					+ result 
					+ "$$"
					+ selectionText.substring(mathPreviewEndIndex + 2, selectionText.length),
				initialLatex: selectionText.substring(mathPreviewStartIndex + 2, mathPreviewEndIndex),
			}
		}

		const mathInlineStartIndex = selectionText.indexOf("$");
		if (mathInlineStartIndex >= 0) {
			const mathInlineEndIndex = selectionText.indexOf("$", mathInlineStartIndex + 1);
			return {
				resultRenderTemplate: result => 
					selectionText.substring(0, mathInlineStartIndex) 
					+ "$" 
					+ result 
					+ "$"
					+ selectionText.substring(mathInlineEndIndex + 1, selectionText.length),
				initialLatex: selectionText.substring(mathInlineStartIndex + 1, mathInlineEndIndex),
			}
		}

		return null
	}

	onOpen() {
		const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const selectionText = markdownView?.editor.getSelection();

		const parseResult = this.parseSelection(selectionText ?? "");
		if (!parseResult) {
			new Notice("Please select a $$ text (MathJax).");
			this.close();
			return;
		}

		const {initialLatex, resultRenderTemplate} = parseResult;

		this.renderedResult = resultRenderTemplate(initialLatex);
		
		const root = createRoot(this.containerEl.children[1]);
		root.render(
			<React.StrictMode>
				<MathLiveComponent initialLatex={initialLatex} onLatexChange={latexValue => {
					this.renderedResult = resultRenderTemplate(latexValue)
				}} />
			</React.StrictMode>
		);
	}

	onClose() {
		if (!!this.renderedResult)
			this.app.workspace.getActiveViewOfType(MarkdownView)?.editor.replaceSelection(this.renderedResult);
	}
}
