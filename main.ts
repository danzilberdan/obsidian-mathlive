import { MathfieldElement } from 'mathlive';
import { App, Editor, MarkdownView, Modal, Notice, Plugin } from 'obsidian';
import { MarkdownFileInfo } from 'obsidian';

export default class MathLivePlugin extends Plugin {

	async onload() {
		this.addCommand({
			id: 'open-modal',
			name: 'Edit in MathLive',
			editorCallback: (editor: Editor, ctx: MarkdownFileInfo) => {
				new MathLiveModal(this.app, editor).open();
			}
		});
	}
}

class MathLiveModal extends Modal {
	renderedResult?: string
	editor: Editor
	
	constructor(app: App, editor: Editor) {
		super(app);
		this.editor = editor
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
			if (mathPreviewEndIndex >= 0) {
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
		this.initMathlive()
		this.initSubmitButton()
	}

	initMathlive() {
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

		const mfe = new MathfieldElement();
        mfe.value = initialLatex;
        mfe.addEventListener('input', () => {
            this.renderedResult = resultRenderTemplate(mfe.value);
        });

		const modalContent = this.containerEl.querySelector('.modal-content')
		modalContent?.addClass("mathlive-modal-content")
		modalContent?.appendChild(mfe)
		mfe.focus();
	}

	initSubmitButton() {
		const submitButton = document.createElement('button')
		submitButton.innerText = 'Insert'
		submitButton.addClass('submit')
		submitButton.addEventListener('click', this.close.bind(this))

		const modalContent = this.containerEl.querySelector('.modal-content')
		modalContent?.appendChild(submitButton)
	}

	onClose() {
		if (!!this.renderedResult)
			this.editor.replaceSelection(this.renderedResult);
	}
}
