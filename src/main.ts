import {
  App, FuzzySuggestModal, MarkdownView, Modal, Notice, Plugin, PluginSettingTab,
  Setting, TFile, addIcon, normalizePath, requestUrl,
} from 'obsidian';
import { applyMatches, buildEvaluation, parseGuide, readMatches, splitNote, type Evaluation, type WriteMode } from './core';
import { askJev, checkCancelled, ENDPOINT, type Transport } from './client';
import { runBatch, type BatchProgress, type Outcome } from './batch';
import { STARTER_GUIDE } from './template';

interface Settings { apiKey: string; guidePath: string; writeMode: WriteMode; excludedFolders: string }
interface RunConfig { apiKey: string; guide: TFile; evaluation: Evaluation; writeMode: WriteMode; excluded: string[] }
const DEFAULTS: Settings = { apiKey: '', guidePath: 'Jev classification guide.md', writeMode: 'merge', excludedFolders: '' };
const transport: Transport = async (body, key) => {
  const response = await requestUrl({ url: ENDPOINT, method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body, throw: false });
  // Parse success bodies only; error bodies may be HTML or contain request details.
  return { status: response.status, headers: response.headers, json: response.status >= 200 && response.status < 300 ? response.json : null };
};

export default class JevClassifier extends Plugin {
  settings: Settings = { ...DEFAULTS };
  controller: AbortController | null = null;
  private loaded = false;
  private status!: HTMLElement;

  async onload() {
    const saved = await this.loadData();
    for (const key of ['apiKey', 'guidePath', 'excludedFolders'] as const) {
      if (typeof saved?.[key] === 'string') this.settings[key] = saved[key];
    }
    this.settings.writeMode = saved?.writeMode === 'replace' ? 'replace' : 'merge';
    this.loaded = true;
    addIcon('jev-classifier', '<path d="M32 22h36v38c0 16-8 23-21 23S26 76 26 64" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><path d="m76 12 3 8 8 3-8 3-3 8-3-8-8-3 8-3z" fill="currentColor"/>');
    this.addRibbonIcon('jev-classifier', 'Jev: classify current note', () => void this.classifyCurrent());
    this.status = this.addStatusBarItem();
    this.status.setText('Jev');
    this.addCommand({ id: 'classify-note', name: 'Classify current note', callback: () => void this.classifyCurrent() });
    this.addCommand({ id: 'classify-vault', name: 'Classify entire vault', callback: () => void this.openBulk() });
    this.addCommand({ id: 'stop-classification', name: 'Stop classification', callback: () => this.controller?.abort() });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension === 'md') menu.addItem(item => item.setTitle('Classify with Jev').setIcon('jev-classifier').onClick(() => void this.classifyCurrent(file)));
    }));
    this.addSettingTab(new JevSettingsTab(this.app, this));
  }
  onunload() { this.loaded = false; this.controller?.abort(); }
  async saveSettings() { await this.saveData(this.settings); }

  private async saveOpenEditors(file: TFile) {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file === file) await leaf.view.save();
    }
  }
  async prepare(): Promise<RunConfig> {
    const settings = { ...this.settings };
    if (!settings.apiKey.trim()) throw new Error('Add your Jev API key in Settings → Jev Classifier.');
    const guide = this.app.vault.getAbstractFileByPath(normalizePath(settings.guidePath.trim()));
    if (!(guide instanceof TFile) || guide.extension !== 'md') throw new Error('Select a classification guide note in Settings → Jev Classifier.');
    await this.saveOpenEditors(guide);
    const evaluation = buildEvaluation(parseGuide(await this.app.vault.read(guide)));
    return { apiKey: settings.apiKey.trim(), guide, evaluation, writeMode: settings.writeMode, excluded: settings.excludedFolders.split('\n').map(path => normalizePath(path.trim()).replace(/\/$/, '')).filter(Boolean) };
  }
  eligible(file: TFile, config: RunConfig): boolean {
    return file !== config.guide && file.extension === 'md' && !config.excluded.some(path => file.path === path || file.path.startsWith(`${path}/`));
  }
  private async classify(file: TFile, config: RunConfig, signal: AbortSignal): Promise<Outcome> {
    checkCancelled(signal);
    if (!this.eligible(file, config)) return 'skipped';
    const path = file.path;
    await this.saveOpenEditors(file);
    const source = await this.app.vault.read(file);
    const content = splitNote(source).body;
    if (!content.trim()) return 'skipped';
    applyMatches(source, [], config.writeMode); // Reject malformed properties before calling Jev.
    const response = await askJev(transport, config.apiKey, file.basename, content, config.evaluation, signal);
    checkCancelled(signal);
    const matches = readMatches(config.evaluation, response);
    let changed = 0;
    await this.app.vault.process(file, current => {
      checkCancelled(signal);
      if (!this.loaded) throw new Error('The plugin was unloaded.');
      if (file.path !== path || current !== source) throw new Error('The note changed while Jev was working. Run it again on the updated note.');
      for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
        if (leaf.view instanceof MarkdownView && leaf.view.file === file && leaf.view.editor.getValue() !== source) throw new Error('The note has new edits. Run Jev again after editing.');
      }
      const result = applyMatches(current, matches, config.writeMode);
      changed = result.changed;
      return result.content;
    });
    return changed ? 'updated' : 'unchanged';
  }
  async classifyCurrent(target?: TFile) {
    if (this.controller) { new Notice('Jev is already running.'); return; }
    const file = target ?? this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') { new Notice('Open a Markdown note to classify.'); return; }
    const controller = this.controller = new AbortController();
    this.status.setText('Jev: classifying…');
    try {
      const config = await this.prepare();
      const outcome = await this.classify(file, config, controller.signal);
      new Notice(outcome === 'updated' ? `Jev updated ${file.basename}.` : outcome === 'skipped' ? 'Jev skipped this note (guide, excluded, or empty).' : 'No property changes: no new matches, or existing values were kept.');
    } catch (error) { this.showError(error); }
    finally { this.controller = null; this.status.setText('Jev'); }
  }
  async openBulk() {
    if (this.controller) { new Notice('Jev is already running.'); return; }
    try {
      const config = await this.prepare();
      const files = this.app.vault.getMarkdownFiles().filter(file => this.eligible(file, config)).sort((a, b) => a.path.localeCompare(b.path));
      new BulkModal(this.app, this, config, files).open();
    } catch (error) { this.showError(error); }
  }
  async classifyVault(config: RunConfig, files: TFile[], progress: (state: BatchProgress) => void) {
    if (this.controller) throw new Error('Jev is already running.');
    if (!this.loaded) throw new Error('The plugin was unloaded.');
    const controller = this.controller = new AbortController();
    try {
      return await runBatch(files, controller.signal, file => this.classify(file, config, controller.signal), state => {
        this.status.setText(`Jev: ${state.processed}/${state.total}`);
        progress(state);
      });
    } finally { this.controller = null; this.status.setText('Jev'); }
  }
  showError(error: unknown) { new Notice(error instanceof Error ? error.message : 'Jev could not finish. Try again.', 9000); }
  async createGuide() {
    try {
      const path = 'Jev classification guide.md';
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing) { new Notice('A starter guide already exists. Select it with Choose note.'); return; }
      const file = await this.app.vault.create(path, STARTER_GUIDE);
      this.settings.guidePath = path;
      await this.saveSettings();
      await this.app.workspace.getLeaf(false).openFile(file);
      new Notice('Guide created. Edit its properties and descriptions to fit your vault.');
    } catch (error) { this.showError(error); }
  }
}

class GuidePicker extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly choose: (file: TFile) => void) { super(app); this.setPlaceholder('Choose your classification guide note'); }
  getItems() { return this.app.vault.getMarkdownFiles(); }
  getItemText(file: TFile) { return file.path; }
  onChooseItem(file: TFile) { this.choose(file); }
}

class JevSettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: JevClassifier) { super(app, plugin); }
  display() {
    const { containerEl: el, plugin } = this;
    el.empty();
    el.createEl('h2', { text: 'Jev Classifier' });
    el.createEl('p', { text: 'Describe your categories once, then let Jev fill the properties of a note or your entire vault.' });
    new Setting(el).setName('Jev API key').setDesc('Stored in this vault’s plugin data.json as plain text. Vault sync or backups may copy it.').addText(input => {
      input.inputEl.type = 'password';
      input.inputEl.autocomplete = 'off';
      input.setPlaceholder('TypeSafe API key').setValue(plugin.settings.apiKey).onChange(async value => { plugin.settings.apiKey = value.trim(); await plugin.saveSettings(); });
    });
    new Setting(el).setName('Classification guide').setDesc('One note containing your properties, allowed values, and descriptions.').addText(input => input.setPlaceholder('Jev classification guide.md').setValue(plugin.settings.guidePath).onChange(async value => { plugin.settings.guidePath = value; await plugin.saveSettings(); })).addButton(button => button.setButtonText('Choose note').onClick(() => new GuidePicker(this.app, file => {
      plugin.settings.guidePath = file.path;
      void plugin.saveSettings().then(() => this.display()).catch(error => plugin.showError(error));
    }).open()));
    new Setting(el).setName('Starter guide').setDesc('Creates an editable example note in the vault root.').addButton(button => button.setButtonText('Create starter guide').onClick(async () => { await plugin.createGuide(); this.display(); }));
    new Setting(el).setName('Existing classifications').setDesc('Add keeps filled single values and merges lists. Replace updates matching properties. No match leaves a property unchanged in either mode.').addDropdown(dropdown => dropdown.addOption('merge', 'Add and keep existing values').addOption('replace', 'Replace matching properties').setValue(plugin.settings.writeMode).onChange(async value => { plugin.settings.writeMode = value === 'replace' ? 'replace' : 'merge'; await plugin.saveSettings(); }));
    new Setting(el).setName('Excluded folders or notes').setDesc('Optional vault-relative paths, one per line. Applies to individual and vault-wide runs.').addTextArea(input => input.setPlaceholder('Templates\nArchive\nPrivate note.md').setValue(plugin.settings.excludedFolders).onChange(async value => { plugin.settings.excludedFolders = value; await plugin.saveSettings(); }));
    const section = el.createDiv({ cls: 'jev-vault-section' });
    section.createEl('h3', { text: 'Classify your entire vault' });
    section.createEl('p', { text: 'Use this after setting up your guide. Jev processes Markdown notes one at a time and saves each completed result. The guide, excluded paths, and notes with no body text are skipped.' });
    const button = section.createEl('button', { text: 'Classify entire vault', cls: 'mod-cta jev-vault-button' });
    button.addEventListener('click', () => void plugin.openBulk());
    section.createEl('p', { cls: 'setting-item-description', text: 'The next screen shows the note count before starting. You can stop a run at any time; completed changes remain saved.' });
    el.createEl('p', { cls: 'setting-item-description', text: 'When you start classification, note titles, note bodies, and the definitions from your guide are sent to TypeSafe’s API. Existing frontmatter, attachments, and linked note contents are not included. Each evaluated note uses your Jev account’s API credits.' });
  }
}

class BulkModal extends Modal {
  private running = false;
  constructor(app: App, private readonly plugin: JevClassifier, private readonly config: RunConfig, private readonly files: TFile[]) { super(app); }
  onOpen() {
    this.setTitle('Classify entire vault with Jev');
    const el = this.contentEl;
    el.createEl('p', { text: `${this.files.length} Markdown notes are eligible. Empty notes are skipped during the run. Guide: ${this.config.guide.path}.` });
    el.createEl('p', { text: `Mode: ${this.config.writeMode === 'merge' ? 'add matches and keep existing values' : 'replace properties that have matches'}. Note titles, bodies, and guide definitions will be sent to TypeSafe using your API credits.` });
    const status = el.createEl('p', { text: 'Ready to start.', attr: { 'aria-live': 'polite' } });
    const meter = el.createEl('progress', { cls: 'jev-progress', attr: { max: String(this.files.length || 1), value: '0', 'aria-label': 'Notes processed' } });
    const current = el.createEl('p', { cls: 'jev-current-note' });
    const results = el.createDiv();
    const buttons = new Setting(el);
    buttons.addButton(start => start.setButtonText(`Start classification (${this.files.length} notes)`).setCta().setDisabled(!this.files.length).onClick(async () => {
      if (this.plugin.controller) { new Notice('Jev is already running.'); return; }
      start.setDisabled(true);
      this.running = true;
      stop.textContent = 'Stop classification';
      try {
        await this.plugin.classifyVault(this.config, this.files, state => {
          meter.value = state.processed;
          status.setText(`${state.done ? state.stopped ? 'Stopped. ' : 'Finished. ' : ''}${state.processed}/${state.total} processed · ${state.updated} updated · ${state.unchanged} unchanged · ${state.skipped} skipped · ${state.failures.length} failed`);
          current.setText(state.current);
          if (state.done && state.failures.length) {
            results.createEl('h3', { text: 'Notes that need attention' });
            const list = results.createEl('ul', { cls: 'jev-failures' });
            for (const failure of state.failures) list.createEl('li', { text: `${failure.path}: ${failure.message}` });
          }
        });
      } catch (error) { this.plugin.showError(error); status.setText('Could not start classification.'); }
      finally { this.running = false; stop.textContent = 'Close'; stop.disabled = false; }
    }));
    const stop = el.createEl('button', { text: 'Cancel' });
    stop.addEventListener('click', () => {
      if (this.running) { this.plugin.controller?.abort(); stop.disabled = true; stop.textContent = 'Stopping…'; }
      else this.close();
    });
  }
  onClose() { if (this.running) this.plugin.controller?.abort(); this.contentEl.empty(); }
}
