import { MathfieldElement } from 'mathlive';
import { App, Editor, MarkdownView, Modal, Notice, Plugin } from 'obsidian';
import { MarkdownFileInfo } from 'obsidian';
import { PluginSettingTab, Setting } from "obsidian";

interface PluginSettings {
	apiKey: string;
	useLocalInference: boolean;
}

const DEFAULT_SETTINGS = {
	apiKey: null,
	selfHosted: false
}

export default class MathLivePlugin extends Plugin {
	settings: PluginSettings;

	async onload() {
		this.addCommand({
			id: 'open-modal',
			name: 'Edit in MathLive',
			editorCallback: (editor: Editor, ctx: MarkdownFileInfo) => {
				new MathLiveModal(this.app, editor, this).open();
			}
		});
		await this.loadSettings();
		this.addSettingTab(new MathliveSettingTab(this.app, this))
	}

	async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

export class MathliveSettingTab extends PluginSettingTab {
  plugin: MathLivePlugin;

  constructor(app: App, plugin: MathLivePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    let { containerEl } = this;

    containerEl.empty();

	const title = document.createElement('h2')
	title.textContent = 'Obsidian Mathlive'
	title.setCssStyles({
		fontSize: '28px'
	})
	containerEl.appendChild(title);
    
	const intro = `This plugins currently has 2 main features, visual formula editor, and image to MathJax scanner.
The MathJax image scanner is available for free when self hosting.
In addition, there is a cloud option that requires no setup.

* Self hosting the image scanner may require technical knowledge of docker and requires background processing resources. For most people, the cloud options is better.`
	const introEl = document.createElement('p');
	introEl.textContent = intro;
	introEl.style.whiteSpace = 'pre-wrap'
	containerEl.appendChild(introEl);

	new Setting(containerEl);
	const cloudTitle = document.createElement('h2')
	cloudTitle.textContent = 'Cloud Settings'
	cloudTitle.setCssStyles({
		fontSize: '24px'
	})
	containerEl.appendChild(cloudTitle);

	new Setting(containerEl)
		.setName('API key')
		.addText(tc => tc.setValue(this.plugin.settings.apiKey).onChange(async val => {
			this.plugin.settings.apiKey = val;
			await this.plugin.saveSettings()
		}))
    
	const homepageLink = document.createElement('a')
	homepageLink.href = 'https://mathlive.danz.blog'
	homepageLink.text = 'Create an API key here'
	containerEl.appendChild(homepageLink)

	new Setting(containerEl);

	const selfHostTitle = document.createElement('h2')
	selfHostTitle.textContent = 'Self Hosting Settings'
	selfHostTitle.setCssStyles({
		fontSize: '24px'
	})
	containerEl.appendChild(selfHostTitle);

	new Setting(containerEl)
		.setName('Self hosted')
		.addToggle(toggle => toggle.setValue(this.plugin.settings.useLocalInference).onChange(async val => {
			this.plugin.settings.useLocalInference = val;
			await this.plugin.saveSettings()
		}))
  }
}

class MathLiveModal extends Modal {
	renderedResult?: string
	editor: Editor
	plugin: MathLivePlugin
	mfe?: MathfieldElement
	resultRenderTemplate: (res: string) => string
	
	constructor(app: App, editor: Editor, plugin: MathLivePlugin) {
		super(app);
		this.editor = editor
		this.plugin = plugin
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

		this.initImageScanner(modalContent)
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
		this.resultRenderTemplate = resultRenderTemplate

		this.renderedResult = resultRenderTemplate(initialLatex);

		this.mfe = new MathfieldElement();
		this.mfe.id = "mathfield"
        this.mfe.value = initialLatex;
        this.mfe.addEventListener('input', () => {
            this.renderedResult = resultRenderTemplate(this.mfe?.value ?? '');
        });

		modalContent.addClass("mathlive-modal-content");
		modalContent.appendChild(this.mfe);
		this.mfe.focus();
		setTimeout(() => document.getElementById("mathfield")!.focus(), 10)
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

	initImageScanner(modalContent: Element) {
		const scan = document.createElement('button')
		scan.innerText = 'Scan MathJax from Clipboard'
		scan.addClass('scan-button')
		scan.onclick = this.onImageScanRequest.bind(this)

		modalContent.appendChild(scan)
	}

	async onImageScanRequest() {
		if (!this.plugin.settings.apiKey) {
			new Notice('Please open plugin settings to create API key.')
			return
		}
		try {
			const clipboardItems = await navigator.clipboard.read();
			for (const item of clipboardItems) {
				for (const type of item.types) {
					if (item.types.includes('image/png')) {
						const blob = await item.getType(type)
						new Notice('Scanning MathJax image')
						const mathjax = await this.scanImage(blob);
						this.mfe!.value = mathjax;
						this.renderedResult = this.resultRenderTemplate(this.mfe?.value ?? '');

						new Notice(`Got scan result for MathJax`)
						return
					}
					
				}
			}
			new Notice('No image found in clipboard.');
		} catch (error) {
			console.error('Error reading clipboard or uploading image:', error);
			new Notice(`Failed to scan image. See console for details.`)
		}	
	}

	async scanImage(imageData: Blob) {
		let address = 'https://mathlive-ocr.danz.blog'
		if (this.plugin.settings.useLocalInference) {
			address = 'http://localhost:8502'
		}

		const formData = new FormData();
		formData.append('file', imageData);
		
		const res = await fetch(address + '/predict/', {
			headers: {
				'Api-key': this.plugin.settings.apiKey			
			},
			method: 'POST',
			body: formData
		});
		return await res.json()
	}

	async convertToJPEG(imageData: string) {
		const img = new Image();
		img.src = imageData;
		await new Promise((resolve) => { img.onload = resolve; });
		
		const canvas = document.createElement('canvas');
		canvas.width = img.width;
		canvas.height = img.height;
		const ctx = canvas.getContext('2d');
		ctx!.drawImage(img, 0, 0);
		
		return canvas.toDataURL('image/jpeg', 0.8);
	}

	onClose() {
		if (!!this.renderedResult)
			this.editor.replaceSelection(this.renderedResult);
	}
}
