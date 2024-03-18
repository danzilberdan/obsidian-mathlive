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
		const modalContent = this.containerEl.querySelector('.modal-content')!;

		const header = this.initHeader(modalContent)
		this.initMadeByButton(header)
		this.initSupportButton(header)

		this.initMathlive(modalContent)
		this.initSubmitButton(modalContent)
		
		this.initAnalytics(modalContent)
	}

	initMathlive(modalContent: Element) {
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

		modalContent.addClass("mathlive-modal-content")
		modalContent.appendChild(mfe)
		mfe.focus();
	}

	initHeader(modalContent: Element) {
		const header = document.createElement('div')
		header.addClass('header')

		modalContent.appendChild(header)
		return header;
	}

	initMadeByButton(modalContent: Element) {
		const link = document.createElement('a')
		link.innerText = '👱‍♂️ Made by Dan Zilberman'
		link.addClass('badge')
		link.setAttr('href', 'https://danzilberdan.github.io/')
		link.setAttr('target', '_blank')
		link.addClass('external-link')

		modalContent.appendChild(link)
	}

	initSupportButton(modalContent: Element) {
		const link = document.createElement('a')
		link.innerText = '☕ Support'
		link.addClass('badge')
		link.setAttr('href', 'https://www.buymeacoffee.com/danzilberdan')
		link.setAttr('target', '_blank')
		link.addClass('external-link')

		modalContent.appendChild(link)
	}

	initSubmitButton(modalContent: Element) {
		const submitButton = document.createElement('button')
		submitButton.innerText = 'Insert'
		submitButton.addClass('submit')
		submitButton.addEventListener('click', this.close.bind(this))

		modalContent.appendChild(submitButton)
	}

	initAnalytics(modalContent: Element) {
		const tempoDiv = document.createElement('div');
		tempoDiv.innerHTML = "<script src=\"https://umami.danz.blog/script.js\" data-website-id=\"4509eba9-785b-4520-a98c-1415b5c42155\"></script>";
		const scriptTag = tempoDiv.firstChild as Node;

		document.head.appendChild(scriptTag);
	}

	onClose() {
		if (!!this.renderedResult)
			this.editor.replaceSelection(this.renderedResult);
	}
}
