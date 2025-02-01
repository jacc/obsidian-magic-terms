import {
	App,
	Editor,
	Notice,
	Plugin,
	PluginSettingTab,
	requestUrl,
	Setting,
	TFile,
} from "obsidian";

interface TermDefinition {
	term: string;
	definition: string;
	category?: string;
}

interface FolderMapping {
	sourcePath: string;
	targetPath: string;
}

interface TermDefinitionPluginSettings {
	apiEndpoint: string;
	apiKey: string;
	folderMappings: FolderMapping[];
	defaultGlossaryPath: string;
	llmModel: string;
}

const DEFAULT_SETTINGS: TermDefinitionPluginSettings = {
	apiEndpoint: "",
	apiKey: "",
	folderMappings: [],
	llmModel: "",
	defaultGlossaryPath: "Glossary",
};

export default class TermDefinitionPlugin extends Plugin {
	settings: TermDefinitionPluginSettings;

	async onload() {
		await this.loadSettings();

		// Add command to handle term definition
		this.addCommand({
			id: "create-term-definition",
			name: "Create Term Definition",
			editorCallback: (editor: Editor) =>
				this.handleTermDefinition(editor),
		});

		// Add settings tab
		this.addSettingTab(new TermDefinitionSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async handleTermDefinition(editor: Editor) {
		const selectedText = editor.getSelection();
		if (!selectedText) {
			new Notice("No text selected");
			return;
		}

		try {
			// Get definition from LLM API
			const definition = await this.getDefinitionFromLLM(selectedText);
			if (!definition) {
				new Notice("Failed to get definition from API");
				return;
			}

			await this.createDefinitionNote(definition);
			let linkedText = this.createSmartLink(
				selectedText,
				definition.term
			);

			linkedText = linkedText.replace(`${definition}`);
			editor.replaceSelection(linkedText);

			new Notice("Term definition created successfully");
		} catch (error) {
			console.error("Error handling term definition:", error);
			new Notice("Error creating term definition");
		}
	}

	async getDefinitionFromLLM(
		selectedText: string
	): Promise<TermDefinition | null> {
		try {
			const response = await requestUrl({
				url: this.settings.apiEndpoint,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.settings.apiKey}`,
				},
				body: JSON.stringify({
					model: this.settings.llmModel,
					messages: [
						{
							role: "system",
							content: `You are a helpful assistant that extracts terms and their definitions from text. Based on this input, split this into a term and definition definition. Keep the term definition lower case, unless it's an acronym.
							
							If a user has text in the string that appears like [[this]], make sure to include that in the original definition that you refactor - that's a link to another term. 
							If the term has a slash in it, substitute it for something else. 
							
							Return your response as a JSON object with 'term' and 'definition' fields. Return as JSON output.`,
						},
						{
							role: "user",
							content: selectedText,
						},
					],
					stream: false,
					response_format: {
						type: "json_object",
					},
				}),
			});

			if (!response) {
				throw new Error("API request failed");
			}

			return JSON.parse(
				response.json.choices[0].message.content
			) as TermDefinition;
		} catch (error) {
			console.error("Error calling LLM API:", error);
			return null;
		}
	}

	async createDefinitionNote(definition: TermDefinition): Promise<string> {
		// Determine the target folder based on current file location
		const activeFile = this.app.workspace.getActiveFile();
		const targetFolder = this.getTargetFolder(activeFile);

		// Create folder if it doesn't exist
		await this.ensureFolderExists(targetFolder);

		// Create the note content
		const noteContent = [
			definition.definition,
			"",
			activeFile ? `- Source: [[${activeFile.basename}]]` : "",
		].join("\n");

		// Generate safe filename
		const notePath = `${targetFolder}/${definition.term}.md`;

		// Create the note
		await this.app.vault.create(notePath, noteContent);

		return notePath.replace(".md", "");
	}

	getTargetFolder(sourceFile: TFile | null): string {
		if (!sourceFile) {
			return this.settings.defaultGlossaryPath;
		}

		const sourcePath = sourceFile.path;
		for (const mapping of this.settings.folderMappings) {
			if (sourcePath.startsWith(mapping.sourcePath)) {
				return mapping.targetPath;
			}
		}

		return this.settings.defaultGlossaryPath;
	}

	async ensureFolderExists(path: string) {
		const folders = path.split("/");
		let currentPath = "";

		for (const folder of folders) {
			currentPath += folder;
			if (!(await this.app.vault.adapter.exists(currentPath))) {
				await this.app.vault.createFolder(currentPath);
			}
			currentPath += "/";
		}
	}

	createSmartLink(originalText, term) {
		const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`\\b${escapedTerm}\\b`, "i");
		return originalText.replace(regex, (match) => `[[${term}|${match}]]`);
	}
}

class TermDefinitionSettingTab extends PluginSettingTab {
	plugin: TermDefinitionPlugin;

	constructor(app: App, plugin: TermDefinitionPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("API Endpoint")
			.setDesc("Enter the LLM API endpoint")
			.addText((text) =>
				text
					.setPlaceholder("https://api.example.com/v1/completions")
					.setValue(this.plugin.settings.apiEndpoint)
					.onChange(async (value) => {
						this.plugin.settings.apiEndpoint = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("API Key")
			.setDesc("Enter your API key")
			.addText((text) =>
				text
					.setPlaceholder("Enter your API key")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("LLM Model")
			.setDesc("Enter the name of your model")
			.addText((text) =>
				text
					.setPlaceholder("deepseek-chat")
					.setValue(this.plugin.settings.llmModel)
					.onChange(async (value) => {
						this.plugin.settings.llmModel = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default Glossary Path")
			.setDesc("Default path for storing definitions")
			.addText((text) =>
				text
					.setPlaceholder("Glossary")
					.setValue(this.plugin.settings.defaultGlossaryPath)
					.onChange(async (value) => {
						this.plugin.settings.defaultGlossaryPath = value;
						await this.plugin.saveSettings();
					})
			);

		// Folder Mappings
		containerEl.createEl("h3", { text: "Folder Mappings" });

		this.plugin.settings.folderMappings.forEach((mapping, index) => {
			const mappingContainer = containerEl.createDiv();

			new Setting(mappingContainer)
				.setName(`Mapping ${index + 1}`)
				.addText((text) =>
					text
						.setPlaceholder("Source folder path")
						.setValue(mapping.sourcePath)
						.onChange(async (value) => {
							this.plugin.settings.folderMappings[
								index
							].sourcePath = value;
							await this.plugin.saveSettings();
						})
				)
				.addText((text) =>
					text
						.setPlaceholder("Target glossary path")
						.setValue(mapping.targetPath)
						.onChange(async (value) => {
							this.plugin.settings.folderMappings[
								index
							].targetPath = value;
							await this.plugin.saveSettings();
						})
				)
				.addButton((button) =>
					button.setButtonText("Remove").onClick(async () => {
						this.plugin.settings.folderMappings.splice(index, 1);
						await this.plugin.saveSettings();
						this.display();
					})
				);
		});

		new Setting(containerEl).setName("Add Mapping").addButton((button) =>
			button.setButtonText("Add").onClick(async () => {
				this.plugin.settings.folderMappings.push({
					sourcePath: "",
					targetPath: "",
				});
				await this.plugin.saveSettings();
				this.display();
			})
		);
	}
}
