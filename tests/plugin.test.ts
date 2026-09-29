import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildSync } from 'esbuild';
import { STARTER_GUIDE } from '../src/template';

// Exercise the bundled plugin against a small Obsidian adapter. No live API calls.
const bundle = buildSync({ entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian'], format: 'cjs', platform: 'browser', write: false }).outputFiles[0]!.text;
async function fixture() {
  const notices: string[] = [];
  const contents = new Map<string, string>();
  const requests: Record<string, any>[] = [];
  const opened: any[] = [];
  const buttons: any[] = [];
  let beforeReply = () => {};
  let responseOverride: ((request: Record<string, any>) => Record<string, any> | null) | undefined;
  class Element {
    children: Element[] = [];
    textContent = '';
    disabled = false;
    handlers = new Map<string, () => void>();
    createEl(_tag: string, options?: { text?: string }) { const child = new Element(); child.textContent = options?.text ?? ''; this.children.push(child); return child; }
    createDiv() { return this.createEl('div'); }
    empty() { this.children = []; }
    setText(value: string) { this.textContent = value; }
    addEventListener(event: string, handler: () => void) { this.handlers.set(event, handler); }
  }
  class Button {
    text = ''; disabled = false; click = async () => {};
    setButtonText(text: string) { this.text = text; return this; }
    setCta() { return this; }
    setDisabled(disabled: boolean) { this.disabled = disabled; return this; }
    onClick(callback: () => Promise<void>) { this.click = callback; return this; }
  }
  class File {
    extension = 'md';
    constructor(public path: string) {}
    get basename() { return this.path.replace(/\.md$/, ''); }
  }
  class MarkdownView {}
  const guide = new File('Guide.md');
  const note = new File('Note.md');
  contents.set(guide.path, STARTER_GUIDE);
  contents.set(note.path, '# My idea\n\nBuild a note classification plugin.\n');
  const files = [guide, note];
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => files.find(file => file.path === path),
      getMarkdownFiles: () => files,
      read: async (file: File) => contents.get(file.path),
      process: async (file: File, update: (source: string) => string) => { contents.set(file.path, update(contents.get(file.path)!)); },
    },
    workspace: { getActiveFile: () => note, getLeavesOfType: () => [], on: () => ({}) },
  };
  class Plugin {
    app = app;
    loadData = async () => ({ apiKey: 'test-key', guidePath: guide.path });
    saveData = async () => {};
    addRibbonIcon() {}
    addStatusBarItem() { return { setText() {} }; }
    addCommand() {}
    registerEvent() {}
    addSettingTab() {}
  }
  const obsidian = {
    Plugin, TFile: File, MarkdownView,
    Notice: class { constructor(message: string) { notices.push(message); } },
    FuzzySuggestModal: class {}, PluginSettingTab: class {},
    Modal: class {
      contentEl = new Element();
      onOpen() {} onClose() {} setTitle() {}
      open() { opened.push(this); this.onOpen(); }
      close() { this.onClose(); }
    },
    Setting: class {
      addButton(configure: (button: Button) => void) { const button = new Button(); buttons.push(button); configure(button); return this; }
    },
    addIcon() {}, normalizePath: (path: string) => path,
    requestUrl: async (request: Record<string, any>) => {
      requests.push(request);
      beforeReply();
      const override = responseOverride?.(request);
      if (override) return override;
      const body = JSON.parse(request.body);
      return { status: 200, headers: {}, json: { answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]: [string, any]) => [id, question.type === 'noul'
        ? { type: 'noul', noul: id === 'p1_o0' ? 0.99 : 0.01 }
        : { type: 'choice', choice: 'o0', confidence: 0.99, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === 'o0' ? 1 : 0])) }])) } };
    },
  };
  const module = { exports: {} as any };
  vm.runInNewContext(bundle, { module, exports: module.exports, require: () => obsidian, AbortController, setTimeout, clearTimeout, console });
  const plugin = new module.exports.default();
  await plugin.onload();
  return {
    plugin, note, guide, files, contents, requests, notices, opened, buttons,
    addNote: (path: string, content: string) => { const file = new File(path); files.push(file); contents.set(path, content); return file; },
    beforeReply: (callback: () => void) => { beforeReply = callback; },
    setResponse: (callback: typeof responseOverride) => { responseOverride = callback; },
  };
}
test('plugin classifies a note through the documented HTTP contract', async () => {
  const f = await fixture();
  const original = f.contents.get(f.note.path)!;
  await f.plugin.classifyCurrent();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(f.requests[0]!.headers.Authorization, 'Bearer test-key');
  assert.ok(f.contents.get(f.note.path)!.endsWith(original));
  assert.match(f.contents.get(f.note.path)!, /note-type: idea/);
  assert.equal(f.plugin.controller, null);
});
test('plugin refuses to overwrite edits made during a request', async () => {
  const f = await fixture();
  f.beforeReply(() => f.contents.set(f.note.path, 'New user edits'));
  await f.plugin.classifyCurrent();
  assert.equal(f.contents.get(f.note.path), 'New user edits');
  assert.match(f.notices.join(' '), /note changed/);
});
test('plugin cancellation prevents writes from in-flight requests', async () => {
  const f = await fixture();
  const original = f.contents.get(f.note.path);
  f.beforeReply(() => f.plugin.controller.abort());
  await f.plugin.classifyCurrent();
  assert.equal(f.contents.get(f.note.path), original);
  assert.match(f.notices.join(' '), /Stopped/);
});
test('guide, excluded paths, and empty notes never call Jev', async () => {
  const f = await fixture();
  await f.plugin.classifyCurrent(f.guide);
  f.plugin.settings.excludedFolders = f.note.path;
  await f.plugin.classifyCurrent();
  f.plugin.settings.excludedFolders = '';
  f.contents.set(f.note.path, '---\ntags: [existing]\n---\n');
  await f.plugin.classifyCurrent();
  assert.equal(f.requests.length, 0);
});
test('vault run uses captured settings and reports completed notes', async () => {
  const f = await fixture();
  const config = await f.plugin.prepare();
  f.plugin.settings.apiKey = 'changed-after-start';
  const result = await f.plugin.classifyVault(config, f.files, () => {});
  assert.equal(result.updated, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.failures.length, 0);
  assert.equal(f.requests[0]!.headers.Authorization, 'Bearer test-key');
});
test('existing settings receive the default parallelism without losing other settings', async () => {
  const f = await fixture();
  assert.equal(f.plugin.settings.concurrency, 4);
  assert.equal(f.plugin.settings.apiKey, 'test-key');
  assert.equal(f.plugin.settings.guidePath, 'Guide.md');
  f.plugin.settings.concurrency = 2;
  assert.equal((await f.plugin.prepare()).concurrency, 2);
});
test('bulk retry button runs only failed notes and leaves completed notes alone', async () => {
  const f = await fixture();
  const broken = f.addNote('Broken.md', 'A second idea.');
  f.setResponse(request => JSON.parse(request.body).state.note.title === 'Broken' ? { status: 422, headers: {}, json: null } : null);
  await f.plugin.openBulk();
  assert.equal(f.opened.length, 1);
  const start = f.buttons[0];
  await start.click();
  assert.equal(f.requests.length, 2);
  assert.match(start.text, /Retry failed \/ unfinished \(1 notes\)/);
  assert.equal(start.disabled, false);
  assert.equal(f.contents.get(broken.path), 'A second idea.');
  const completed = f.contents.get(f.note.path);
  f.setResponse(undefined);
  await start.click();
  assert.equal(f.requests.length, 3);
  assert.equal(JSON.parse(f.requests[2]!.body).state.note.title, 'Broken');
  assert.equal(f.contents.get(f.note.path), completed);
  assert.match(f.contents.get(broken.path)!, /note-type: idea/);
  assert.equal(start.text, 'All notes processed');
  assert.equal(start.disabled, true);
});
test('closing the bulk modal cancels all workers before any note is changed', async () => {
  const f = await fixture();
  f.addNote('Second.md', 'Another idea.');
  const original = new Map(f.contents);
  await f.plugin.openBulk();
  f.beforeReply(() => f.opened[0].close());
  await f.buttons[0].click();
  assert.deepEqual(f.contents, original);
  assert.equal(f.plugin.controller, null);
});
