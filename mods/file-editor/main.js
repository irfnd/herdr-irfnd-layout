// A file in its own tab: edit and save, dirty state, reload on external change,
// Diff (HEAD → buffer) and Blame. Props: { file: absolute path, on?: machine }.
// Layout and patterns follow Agentee's abdh-editor (Apache-2.0, see NOTICE).
import { View, div, svg } from 'gpui-kit';
import { v_flex, h_flex, Editor, EditorState } from 'gpui-base';
import {
	props,
	run,
	panes,
	spaces,
	readTextFile,
	writeTextFile,
	watchFolder,
	nextCommand,
	theme,
	settings,
	shared,
	setShared,
	openOverlay,
	notify,
} from 'herdr';
import { base, dirname, loadDiff, loadBlame, diffView, blameView } from './diff.js';
import { keep, find, drop } from './recovery.js';
import { Ask } from './ask.js';

const LANG = {
	ts: 'js',
	tsx: 'js',
	mts: 'js',
	cts: 'js',
	jsx: 'js',
	mjs: 'js',
	cjs: 'js',
	toml: 'yaml',
	jsonc: 'json',
	svelte: 'html',
	vue: 'html',
};
const LABEL = {
	md: 'Markdown',
	yml: 'YAML',
	yaml: 'YAML',
	sh: 'Shell',
	js: 'JavaScript',
	ts: 'TypeScript',
	tsx: 'TSX',
	jsx: 'JSX',
	json: 'JSON',
	css: 'CSS',
	html: 'HTML',
	py: 'Python',
	rs: 'Rust',
	go: 'Go',
	txt: 'Text',
};
const MAX = 1000000;

function stats(text) {
	return {
		lines: text.split('\n').length,
		chars: text.length,
		words: (text.match(/\S+/g) ?? []).length,
		eol: text.includes('\r\n') ? (text.replace(/\r\n/g, '').includes('\n') ? 'Mixed' : 'CRLF') : 'LF',
		encoding: text.startsWith('﻿') ? 'UTF-8 BOM' : 'UTF-8',
	};
}

export default class FileEditor extends View {
	init(_props, cx) {
		if (props()?.view === 'ask') {
			this.part = new Ask();
			this.part.init(cx);
			return;
		}
		const { file, on } = props() ?? {};
		this.path = file ?? null;
		this.on = on ?? null;
		this.name = file ? base(file) : 'No file';
		this.text = '';
		this.saved = '';
		this.dirty = false;
		this.mode = 'edit'; // 'edit' | 'diff' | 'blame'
		this.data = null; // the diff or blame being shown
		this.error = this.path ? null : 'No file';
		this.external = null; // the disk's text when it changed under unsaved edits
		this.externalAsked = null;
		this.recovered = null; // kept edits from an earlier session, offered back
		this.uid = `fe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		this.asking = false; // a dialog of ours is open
		this.pending = null; // what each of its buttons does
		this.answerSeen = shared('file-editor.answer')?.at ?? null;
		this.requestSeen = shared('file-editor.request')?.at ?? null;
		this.gone = false; // the file was deleted on disk (told once)
		this.kept = ''; // the text last written to recovery
		this.keptAt = 0;
		this.discarded = false;
		this.changed = true; // stats need publishing
		this.handle = cx.focus_handle();
		this.title = props()?.title ?? this.name; // the tab's name, set by whoever opened it
		if (!this.path) return;
		this.language = (this.name.includes('.') ? this.name.split('.').pop() : 'txt').toLowerCase();
		this.label = LABEL[this.language] ?? this.language.toUpperCase();
		this.load(cx);
		this.watch(cx);
		// Stats are shared for the status bar; throttled so typing doesn't redraw every mod.
		cx.timer.every(400, (cx) => {
			// Typing normally reports through the change event; this catches any edit that did not.
			const typed = this.code?.value();
			if (typed !== undefined && typed !== this.text) {
				this.text = typed;
				this.dirty = typed !== this.saved;
				this.changed = true;
				cx.notify();
			}
			this.publish();
			this.listen(cx);
			if (this.dirty && !this.on && this.text !== this.kept && Date.now() - this.keptAt > 3000) {
				this.kept = this.text;
				this.keptAt = Date.now();
				cx.spawn(async () => keep(this.path, this.text).catch(() => {}));
			}
			// Settings changed: the state takes options only when made, and not during render.
			if (this.code && this.sig !== JSON.stringify(this.options())) {
				this.build(this.text);
				cx.notify();
			}
		});
		cx.spawn(async (cx) => {
			for (;;) {
				const c = await nextCommand();
				if (c === 'save') await this.save(cx);
				else if (c === 'diff') this.show('diff', cx);
				else if (c === 'blame') this.show('blame', cx);
				else if (c === 'close') this.requestClose(cx);
				else if (c === 'focus' && this.mode !== 'edit') this.handle.focus();
				cx.notify();
			}
		});
	}

	// Our tab: the one named `title` (or "● title") that holds a file-editor pane.
	// Never guessed from focus, or a rename could land on someone else's tab.
	findTab() {
		const mine = new Set(
			panes()
				.filter((p) => p.mod === 'file-editor')
				.map((p) => p.tab),
		);
		const tabs = spaces().flatMap((s) => s.tabs ?? []);
		return tabs.find((tb) => mine.has(tb.id) && (tb.name === this.title || tb.name === `● ${this.title}`))?.id ?? null;
	}

	// What the status bar reads: shared("file-editor")[tab].
	publish() {
		this.tab = this.findTab();
		if (!this.tab || !this.changed) return;
		this.changed = false;
		const live = new Set(spaces().flatMap((s) => (s.tabs ?? []).map((tb) => tb.id)));
		const kept = Object.fromEntries(Object.entries(shared('file-editor') ?? {}).filter(([id]) => live.has(id)));
		setShared('file-editor', {
			...kept,
			[this.tab]: {
				path: this.path,
				name: this.name,
				language: this.label,
				dirty: this.dirty,
				readonly: Boolean(this.on),
				...(this.code ? stats(this.text) : {}), // a file that could not be opened has no counts
			},
		});
		// The tab says so too: "● name" while there is something unsaved.
		const name = (this.dirty ? '● ' : '') + this.title;
		if (
			spaces()
				.flatMap((s) => s.tabs ?? [])
				.find((tb) => tb.id === this.tab)?.name !== name
		)
			run('tab.rename', { id: this.tab, name });
	}

	async load(cx) {
		try {
			const text = await readTextFile(this.path, { on: this.on });
			if (text === null) throw new Error('This file is no longer available');
			if (text.includes('\0')) throw new Error('Binary file · no text editor');
			if (text.length >= MAX) throw new Error('File is larger than 1 MiB');
			this.fill(text);
			const r = this.on ? null : await find(this.path);
			if (r && r.text !== text) {
				this.recovered = r;
				this.askRecovered();
			} else if (r) drop(this.path);
		} catch (e) {
			const m = String(e.message ?? e);
			this.error = /utf-8/i.test(m)
				? 'This file is binary (not valid UTF-8), so it can’t be opened as text.'
				: /exceeds 1 MiB/i.test(m)
					? 'This file is larger than 1 MiB, too big to edit here.'
					: m;
		}
		cx.notify();
	}

	restore(cx) {
		this.text = this.recovered.text;
		this.dirty = true;
		this.changed = true;
		this.recovered = null;
		this.build(this.text);
		cx.notify();
	}

	discardRecovered(cx) {
		this.recovered = null;
		drop(this.path);
		cx.notify();
	}

	fill(text) {
		this.text = this.saved = text;
		this.dirty = false;
		this.external = null;
		this.error = null;
		this.changed = true;
		this.build(text);
	}

	// Settings → Editor, with their defaults. The state takes them only when it is made.
	options() {
		const o = shared('editor.settings') ?? {};
		return { wrap: o.wrap ?? true, fontSize: o.fontSize ?? 13, lineNumbers: o.lineNumbers ?? true, folding: o.folding ?? true };
	}

	// A new EditorState holding `text` (unsaved edits included on a rebuild).
	build(text) {
		const t = theme(),
			o = this.options();
		this.sig = JSON.stringify(o);
		this.gen = (this.gen ?? 0) + 1; // a new element id, or GPUI keeps painting the old native view
		this.code?.release();
		this.code = EditorState.new({
			readonly: Boolean(this.on),
			language: LANG[this.language] ?? this.language,
			value: text,
			line_numbers: o.lineNumbers,
			folding: o.folding,
			soft_wrap: o.wrap,
			font_family: settings().font_family,
			font_size: o.fontSize,
			syntax: {
				keyword: t.ansi5,
				string: t.ansi2,
				comment: t.dim,
				function: t.ansi4,
				type: t.ansi3,
				number: t.ansi1,
				constant: t.ansi6,
				variable: t.foreground,
				operator: t.muted,
				punctuation: t.muted,
				boolean: t.ansi3,
			},
		});
		// The change event brings its own cx: the one fill() ran under may be gone by the first keystroke.
		this.code.on('change', (_e, cx) => {
			this.text = this.code.value();
			this.dirty = this.text !== this.saved;
			this.changed = true;
			cx.notify();
		});
	}

	watch(cx) {
		if (this.on) return;
		cx.spawn(async (cx) => {
			try {
				for (;;) {
					await watchFolder(dirname(this.path)); // macOS reports /private/var for /var: compare content, not paths
					const disk = await readTextFile(this.path).catch(() => undefined);
					if (disk === undefined || disk === this.saved) continue;
					if (disk === null) {
						if (!this.gone)
							notify({ title: `${this.name} was deleted on disk`, body: 'Save puts it back', level: 'warning', timeout: 6000 });
						this.gone = true;
					} else if (this.dirty) {
						this.external = disk;
						this.askExternal();
					} else {
						this.gone = false;
						this.fill(disk);
						notify({ title: 'Reloaded from disk', body: this.name, level: 'info', timeout: 3000 });
					}
					cx.notify();
				}
			} catch {
				/* the folder is gone; nothing to watch */
			}
		});
	}

	// A problem worth a notification. (A file that could not be opened shows in the editor's place.)
	fail(title, e) {
		const body = String(e?.message ?? e);
		if (!this.code) this.error = body;
		else notify({ title, body, level: 'error', timeout: 6000 });
	}

	async save(cx) {
		if (this.on) {
			this.fail('Read-only', 'This file is on another machine and is read-only here');
			return false;
		}
		if (!this.code) return false;
		// Typing goes on during the await; only what was written counts as saved.
		const text = this.text;
		try {
			try {
				await writeTextFile(this.path, text, this.saved);
			} catch (e) {
				const disk = await readTextFile(this.path).catch(() => undefined);
				if (disk === null)
					await writeTextFile(this.path, text, null); // deleted on disk: Save puts it back
				else if (disk !== undefined && disk !== this.saved) {
					this.external = disk; // changed under us: Overwrite, Reload or keep editing
					this.externalAsked = null;
					this.askExternal();
					cx.notify();
					return false;
				} else throw e;
			}
			this.saved = text;
			this.dirty = this.text !== text;
			if (!this.dirty) drop(this.path);
			this.external = null;
			this.gone = false;
			this.error = null;
			this.changed = true;
			notify({ title: `Saved ${this.name}`, level: 'success', timeout: 2500 });
			setShared('git.changed', Date.now());
			if (this.mode !== 'edit') this.show(this.mode, cx);
			cx.notify();
			return true;
		} catch (e) {
			this.fail('Could not save', e);
		}
		cx.notify();
		return false;
	}

	async overwrite(cx) {
		if (!this.code || this.on) return;
		try {
			this.saved = (await readTextFile(this.path)) ?? '';
			await this.save(cx);
		} catch (e) {
			this.fail('Could not overwrite', e);
		}
		cx.notify();
	}

	async reload(cx) {
		const disk = await readTextFile(this.path, { on: this.on }).catch(() => null);
		if (disk === null) this.fail('Could not reload', 'The file is gone');
		else {
			this.fill(disk);
			if (!this.on) drop(this.path);
		}
		cx.notify();
	}

	show(mode, cx) {
		if (this.mode === mode) mode = 'edit';
		this.mode = mode;
		this.data = null;
		if (mode === 'edit') return cx.notify();
		const text = this.text;
		cx.spawn(async (cx) => {
			const data = await (mode === 'diff' ? loadDiff(this.path, text) : loadBlame(this.path)).catch((e) => ({
				error: String(e.message ?? e),
			}));
			if (this.mode === mode) this.data = data;
			cx.notify();
		});
		cx.notify();
	}

	closeTab() {
		if (this.tab) run('tab.close', { id: this.tab, confirmed: true });
	}

	// A floating dialog (the `ask` view of this mod). `then` maps a button id to what it does;
	// Esc and "cancel" do nothing. One at a time. Returns whether it opened.
	ask(spec, then) {
		if (this.asking) return false;
		this.asking = true;
		this.pending = then;
		openOverlay({ mod: 'file-editor', kind: 'dialog', width: 420, props: { view: 'ask', owner: this.uid, ...spec } });
		return true;
	}

	// Answers to our dialog, and close requests from the tab bar's X (it can't ask for us).
	listen(cx) {
		const a = shared('file-editor.answer');
		if (a?.owner === this.uid && a.at !== this.answerSeen) {
			this.answerSeen = a.at;
			const fn = this.pending?.[a.id];
			this.pending = null;
			this.asking = false;
			if (fn)
				cx.spawn(async (cx) => {
					await fn(cx);
					cx.notify();
				});
		}
		const q = shared('file-editor.request');
		if (q && q.at !== this.requestSeen) {
			this.requestSeen = q.at;
			if (q.tab && q.tab === this.tab) this.requestClose(cx);
		}
	}

	requestClose(cx) {
		if (!this.dirty) this.closeTab();
		else
			this.ask(
				{
					title: `Save changes to ${this.name}?`,
					body: 'Your changes will be lost if you don’t save them.',
					buttons: [
						{ id: 'save', label: 'Save', primary: true },
						{ id: 'discard', label: 'Don’t save', danger: true },
						{ id: 'cancel', label: 'Cancel' },
					],
				},
				{
					save: async (cx) => (await this.save(cx)) && this.closeTab(),
					discard: () => {
						this.discarded = true;
						this.closeTab();
					},
				},
			);
		cx.notify();
	}

	askExternal() {
		if (this.externalAsked === this.external) return;
		const opened = this.ask(
			{
				title: `${this.name} changed on disk`,
				body: 'It was modified outside the editor. Overwrite keeps your version; Reload replaces your edits with the one on disk.',
				buttons: [
					{ id: 'overwrite', label: 'Overwrite', danger: true },
					{ id: 'reload', label: 'Reload from disk' },
					{ id: 'cancel', label: 'Keep editing', primary: true },
				],
			},
			{ overwrite: (cx) => this.overwrite(cx), reload: (cx) => this.reload(cx) },
		);
		if (opened) this.externalAsked = this.external;
	}

	askRecovered() {
		this.ask(
			{
				title: 'Restore unsaved edits?',
				body: `${this.name} has edits from ${new Date(this.recovered.time).toLocaleString()} that were never saved.`,
				buttons: [
					{ id: 'restore', label: 'Restore', primary: true },
					{ id: 'discard', label: 'Discard', danger: true },
					{ id: 'cancel', label: 'Decide later' },
				],
			},
			{ restore: (cx) => this.restore(cx), discard: (cx) => this.discardRecovered(cx) },
		);
	}

	// Herdr closes a tab without asking, so unsaved text is kept for the next time the file opens.
	async close() {
		if (this.part) return this.part.close();
		const dirty = this.dirty && !this.on && !this.discarded && this.path;
		const text = this.text;
		this.code?.release();
		if (dirty) {
			await keep(this.path, text).catch(() => {});
			notify({
				title: 'Unsaved edits kept',
				body: `${this.name} — they come back when you open it again`,
				level: 'warning',
				timeout: 6000,
			});
		} else if (this.path && !this.on && !this.recovered) await drop(this.path); // an unanswered offer stays
	}

	render(cx) {
		if (this.part) return this.part.render(cx);
		const t = theme();
		const tool = (id, label, on, fn) =>
			div()
				.id(id)
				.h(22)
				.px(8)
				.flex()
				.items_center()
				.rounded(4)
				.cursor_pointer()
				.text_size(11)
				.text_color(on ? t.accent : t.dim)
				.hover((s) => s.bg(t.hover).text_color(t.foreground))
				.on_click(fn)
				.child(label);
		const spawn = (fn) => (_e, cx) => cx.spawn(async (cx) => fn(cx));
		return v_flex()
			.id('file-editor')
			.size_full()
			.min_h(0)
			.bg(t.background)
			.text_size(12.5)
			.text_color(t.foreground)
			.track_focus(this.handle)
			.child(
				h_flex()
					.h(34)
					.flex_none()
					.px(12)
					.gap(8)
					.items_center()
					.bg(t.chrome)
					.border_b(1)
					.border_color(t.border)
					.when(this.dirty, (el) => el.child(div().size(6).flex_none().rounded_full().bg(t.ansi3)))
					.child(
						div()
							.flex_1()
							.min_w(0)
							.truncate()
							.text_size(12)
							.text_color(t.muted)
							.child(this.path ?? ''),
					)
					.when(Boolean(this.code), (el) =>
						el
							.child(tool('tool-diff', 'Diff', this.mode === 'diff', (_e, cx) => this.show('diff', cx)))
							.child(tool('tool-blame', 'Blame', this.mode === 'blame', (_e, cx) => this.show('blame', cx)))
							.child(
								tool('tool-settings', svg('mods/workspace-chrome/settings.svg').size(13), false, () =>
									openOverlay({ mod: 'editor-settings', kind: 'dialog', width: 420 }),
								),
							)
							.child(
								tool(
									'tool-save',
									this.on ? 'Read-only' : 'Save',
									false,
									spawn((cx) => this.save(cx)),
								),
							),
					),
			)
			.child(
				v_flex()
					.flex_1()
					.min_h(0)
					.when(this.mode === 'diff', (el) => el.child(diffView(t, this.data)))
					.when(this.mode === 'blame', (el) => el.child(blameView(t, this.data)))
					.when(this.mode === 'edit' && Boolean(this.code), (el) =>
						el.child(Editor.new(this.code).id(`code-${this.gen}`).flex_1().min_h(0)),
					)
					.when(this.mode === 'edit' && !this.code, (el) =>
						el.child(
							div()
								.p(12)
								.text_color(this.error ? t.blocked : t.dim)
								.child(this.error || 'Loading file…'),
						),
					),
			);
	}
}
