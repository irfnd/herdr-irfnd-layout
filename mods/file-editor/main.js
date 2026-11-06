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
	exec,
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
import { lint, format, hasLinter } from './lint.js';
import { parseConflicts, resolve, conflictsView } from './conflicts.js';

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
const BIG = 4000000; // bytes of a file over 1 MiB that open read-only

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

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
	get ro() {
		return Boolean(this.on || this.big);
	}

	init(_props, cx) {
		if (props()?.view === 'ask') {
			this.part = new Ask();
			this.part.init(cx);
			return;
		}
		const { file, on } = props() ?? {};
		this.path = file ?? null;
		this.on = on ?? null;
		this.split = Boolean(props()?.split); // a second editor beside the tab's own: it leaves the tab and the status bar to the first
		this.big = null; // { size, shown } for a file too large to edit
		this.name = file ? base(file) : 'No file';
		this.text = '';
		this.saved = '';
		this.dirty = false;
		this.mode = props()?.mode === 'conflicts' ? 'conflicts' : 'edit'; // 'edit' | 'diff' | 'blame' | 'conflicts'
		this.hadConflicts = false; // markers were seen: resolving them can end in "mark resolved"
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
		this.diags = null; // [{ line, col, severity, message, source }] from the last check; null = none ran
		this.lintNote = '';
		this.linted = []; // the lines the checker saw (the saved text)
		this.lintSeq = 0;
		this.needLint = false;
		this.problems = false; // the Problems list is open
		this.busy = false; // saving and formatting: the watcher stays out of it
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
			if (this.needLint && this.code) {
				this.needLint = false;
				this.check(cx);
			}
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
				else if (c === 'problems') this.problems = !this.problems;
				else if (c === 'close' && !this.split) this.requestClose(cx);
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
		if (this.split) return;
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
				readonly: this.ro,
				...(this.diags ? { errors: this.count('error'), warnings: this.count('warning') } : {}),
				...(this.code && !this.big ? stats(this.text) : {}), // a file that could not be opened (or only partly) has no counts
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
			this.fill(text);
			this.remember();
			const r = this.on ? null : await find(this.path);
			if (r && r.text !== text) {
				this.recovered = r;
				this.askRecovered();
			} else if (r) drop(this.path);
		} catch (e) {
			const m = String(e.message ?? e);
			if (/exceeds 1 MiB/i.test(m)) return this.loadBig(cx);
			this.error = /utf-8/i.test(m) ? 'This file is binary (not valid UTF-8), so it can’t be opened as text.' : m;
		}
		cx.notify();
	}

	// The Files search lists what was opened lately (newest first, twenty).
	remember() {
		if (this.split) return;
		const rest = (shared('files.recent') ?? []).filter((r) => r.path !== this.path || r.on !== this.on);
		setShared('files.recent', [{ path: this.path, on: this.on, at: Date.now() }, ...rest].slice(0, 20));
	}

	// Over 1 MiB the host won't hand the file over, so the first BIG bytes are read through the shell, read-only.
	async loadBig(cx) {
		try {
			const sh = (script) => exec('sh', ['-c', script, 'big', this.path, String(BIG)], { on: this.on });
			const [head, size] = await Promise.all([sh('head -c "$2" "$1"'), sh('wc -c < "$1"')]);
			if (head.code !== 0) throw new Error(head.stderr.trim() || 'Cannot read this file');
			if (head.stdout.includes('\0')) throw new Error('Binary file · no text editor');
			const total = Number(size.stdout.trim()) || head.stdout.length;
			this.big = { size: total, shown: Math.min(total, BIG) };
			this.fill(head.stdout);
			this.remember();
		} catch (e) {
			this.error = String(e.message ?? e);
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
		this.needLint = true;
		this.build(text);
	}

	// Settings → Editor, with their defaults. The state takes them only when it is made.
	options() {
		const o = shared('editor.settings') ?? {};
		return {
			wrap: o.wrap ?? true,
			fontSize: o.fontSize ?? 13,
			lineNumbers: o.lineNumbers ?? true,
			folding: o.folding ?? true,
			formatOnSave: o.formatOnSave ?? true,
			lintOnSave: o.lintOnSave ?? true,
		};
	}

	// A new EditorState holding `text` (unsaved edits included on a rebuild).
	build(text) {
		const t = theme(),
			o = this.options();
		this.sig = JSON.stringify(o);
		this.gen = (this.gen ?? 0) + 1; // a new element id, or GPUI keeps painting the old native view
		this.code?.release();
		this.code = EditorState.new({
			readonly: this.ro,
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
					if (this.busy) continue; // our own write and format
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
		if (this.ro) {
			this.fail('Read-only', 'This file is on another machine and is read-only here');
			return false;
		}
		if (!this.code) return false;
		// Typing goes on during the await; only what was written counts as saved.
		const text = this.text;
		this.busy = true;
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
			await this.formatOnDisk(text);
			if (!this.dirty) drop(this.path);
			this.external = null;
			this.gone = false;
			this.error = null;
			this.changed = true;
			notify({ title: `Saved ${this.name}`, level: 'success', timeout: 2500 });
			setShared('git.changed', Date.now());
			if (this.options().lintOnSave) this.needLint = true;
			if (this.mode === 'diff' || this.mode === 'blame') this.reloadView(cx);
			cx.notify();
			return true;
		} catch (e) {
			this.fail('Could not save', e);
		} finally {
			this.busy = false;
		}
		cx.notify();
		return false;
	}

	// The project's formatter, run on the file just written. What it changed comes back into the buffer
	// unless something was typed meanwhile (those edits stay, on top of the formatted file).
	async formatOnDisk(wrote) {
		if (!this.options().formatOnSave) return;
		const r = await format(this.path, this.language).catch(() => null);
		if (r?.error) notify({ title: 'Could not format', body: r.error, level: 'warning', timeout: 5000 });
		if (!r?.ran) return;
		const disk = await readTextFile(this.path).catch(() => null);
		if (disk === null || disk === wrote) return;
		const typed = this.text !== wrote;
		this.saved = disk;
		if (!typed) {
			this.text = disk;
			this.dirty = false;
			this.code.set_value(disk);
		} else this.dirty = this.text !== disk;
		this.changed = true;
	}

	// How many conflicts the buffer holds (kept for as long as the text is the same).
	conflictCount() {
		if (this.cfText !== this.text) {
			this.cfText = this.text;
			this.cfCount = this.text.includes('<<<<<<<') ? parseConflicts(this.text).length : 0;
			if (this.cfCount) this.hadConflicts = true;
		}
		return this.cfCount;
	}

	// Picks a side for one conflict, or for all of them (`index` null). The buffer changes; saving is yours.
	pick(choice, index, cx) {
		if (this.ro || !this.code) return;
		const next = resolve(this.text, choice, index);
		this.text = next;
		this.code.set_value(next);
		this.dirty = next !== this.saved;
		this.changed = true;
		if (!parseConflicts(next).length)
			notify({ title: 'All conflicts resolved', body: 'Save, then mark the file resolved', level: 'success', timeout: 4000 });
		cx.notify();
	}

	// Saves, then `git add`s the file: what the Changes panel's "Mark resolved" does.
	async stage(cx) {
		if (this.ro || (this.dirty && !(await this.save(cx)))) return;
		try {
			const r = await exec('git', ['add', '--', base(this.path)], { cwd: dirname(this.path) });
			if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || 'git add failed');
			setShared('git.changed', Date.now());
			notify({ title: `Marked ${this.name} resolved`, level: 'success', timeout: 3000 });
		} catch (e) {
			this.fail('Could not mark resolved', e);
		}
		cx.notify();
	}

	count(severity) {
		return (this.diags ?? []).filter((d) => d.severity === severity).length;
	}

	// Runs the project's checker on the saved file; stale answers are dropped.
	async check(cx) {
		if (this.ro || !this.code || !this.options().lintOnSave) return;
		const seq = ++this.lintSeq,
			text = this.saved;
		const r = await lint(this.path, this.language, text).catch((e) => ({ items: null, note: String(e.message ?? e) }));
		if (seq !== this.lintSeq) return;
		this.diags = r.items?.sort((a, b) => a.line - b.line || a.col - b.col) ?? null;
		this.lintNote = r.note;
		this.linted = text.split('\n');
		this.changed = true;
		cx.notify();
	}

	// "✕ 2  ⚠ 1", "✓" when clean, "– lint" when no checker could run; clicking opens the Problems list.
	badge(t) {
		const e = this.count('error'),
			w = this.count('warning');
		let label, color, tip;
		if (this.diags === null) [label, color, tip] = [this.lintNote ? '– lint' : '…', t.dim, this.lintNote || 'Checking…'];
		else if (!e && !w) [label, color, tip] = ['✓', t.done, 'No problems'];
		else
			[label, color, tip] = [[e && `✕ ${e}`, w && `⚠ ${w}`].filter(Boolean).join('  '), e ? t.blocked : t.ansi3, 'Show problems'];
		return div()
			.id('tool-problems')
			.h(22)
			.px(8)
			.flex()
			.items_center()
			.rounded(4)
			.cursor_pointer()
			.text_size(11)
			.text_color(color)
			.tooltip(tip)
			.when(this.problems, (el) => el.bg(t.hover))
			.hover((el) => el.bg(t.hover))
			.on_click((_e, cx) => {
				this.problems = !this.problems;
				cx.notify();
			})
			.child(label);
	}

	// The list under the editor. The editor cannot move its cursor from here, so each row quotes its line.
	problemsView(t) {
		const items = this.diags ?? [];
		return v_flex()
			.flex_none()
			.h(180)
			.border_t(1)
			.border_color(t.border)
			.bg(t.chrome)
			.text_size(11.5)
			.child(
				h_flex()
					.h(26)
					.flex_none()
					.px(10)
					.gap(8)
					.items_center()
					.border_b(1)
					.border_color(t.border)
					.child(div().text_color(t.muted).child('Problems'))
					.child(
						div()
							.text_color(t.dim)
							.child(this.dirty ? 'as of the last save' : ''),
					)
					.child(div().flex_1())
					.child(
						div()
							.id('problems-close')
							.cursor_pointer()
							.text_color(t.dim)
							.hover((el) => el.text_color(t.foreground))
							.on_click((_e, cx) => {
								this.problems = false;
								cx.notify();
							})
							.child('×'),
					),
			)
			.child(
				items.length === 0
					? div()
							.p(10)
							.text_color(t.dim)
							.child(this.lintNote || 'No problems')
					: div()
							.id('problem-rows')
							.flex_1()
							.min_h(0)
							.overflow_y_scrollbar()
							.children(
								items.slice(0, 200).map((d, i) =>
									v_flex()
										.id(`problem-${i}`)
										.px(10)
										.py(4)
										.child(
											h_flex()
												.gap(8)
												.child(
													div()
														.text_color(d.severity === 'error' ? t.blocked : t.ansi3)
														.child(d.severity === 'error' ? '✕' : '⚠'),
												)
												.child(div().w(54).flex_none().text_color(t.dim).child(`${d.line}:${d.col}`))
												.child(div().flex_1().min_w(0).text_color(t.foreground).child(d.message))
												.child(div().flex_none().text_color(t.dim).child(d.source)),
										)
										.child(
											div()
												.pl(78)
												.truncate()
												.text_size(10.5)
												.text_color(t.muted)
												.child((this.linted[d.line - 1] ?? '').trim().slice(0, 160) || ' '),
										),
								),
							)
							.when(items.length > 200, (el) =>
								el.child(div().p(8).text_color(t.dim).child(`Showing the first 200 of ${items.length}`)),
							),
			);
	}

	async overwrite(cx) {
		if (!this.code || this.ro) return;
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
		this.mode = this.mode === mode ? 'edit' : mode;
		this.reloadView(cx);
	}

	// (Re)loads what the Diff or Blame view shows; the other modes have nothing to load.
	reloadView(cx) {
		const mode = this.mode;
		this.data = null;
		if (mode === 'edit' || mode === 'conflicts') return cx.notify();
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
							.when(Boolean(hasLinter(this.language)) && !this.ro && this.options().lintOnSave, (el) => el.child(this.badge(t)))
							.when(this.conflictCount() > 0 || this.mode === 'conflicts', (el) =>
								el.child(
									tool(
										'tool-conflicts',
										div()
											.text_color(this.conflictCount() ? t.blocked : t.done)
											.child(this.conflictCount() ? `Conflicts ${this.conflictCount()}` : 'Conflicts ✓'),
										this.mode === 'conflicts',
										(_e, cx) => this.show('conflicts', cx),
									),
								),
							)
							.when(!this.split, (el) =>
								el.child(
									tool('tool-split', 'Split', false, () =>
										run('pane.split', {
											direction: 'right',
											mod: 'file-editor',
											props: { file: this.path, on: this.on, title: this.title, split: true },
										}),
									),
								),
							)
							.when(!this.big, (el) =>
								el.child(tool('tool-diff', 'Diff', this.mode === 'diff', (_e, cx) => this.show('diff', cx))),
							)
							.child(tool('tool-blame', 'Blame', this.mode === 'blame', (_e, cx) => this.show('blame', cx)))
							.child(
								tool('tool-settings', svg('mods/workspace-chrome/settings.svg').size(13), false, () =>
									openOverlay({ mod: 'editor-settings', kind: 'dialog', width: 420 }),
								),
							)
							.child(
								tool(
									'tool-save',
									this.ro ? 'Read-only' : 'Save',
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
					.when(Boolean(this.big) && this.mode === 'edit', (el) =>
						el.child(
							div()
								.flex_none()
								.px(12)
								.py(6)
								.bg(t.chrome)
								.border_b(1)
								.border_color(t.border)
								.text_size(11.5)
								.text_color(t.ansi3)
								.child(`Large file (${mb(this.big.size)}): read-only, showing the first ${mb(this.big.shown)}`),
						),
					)
					.when(this.mode === 'diff', (el) => el.child(diffView(t, this.data)))
					.when(this.mode === 'blame', (el) => el.child(blameView(t, this.data)))
					.when(this.mode === 'conflicts' && Boolean(this.code), (el) =>
						el.child(
							conflictsView(t, this.text, {
								resolve: (choice, index, cx) => this.pick(choice, index, cx),
								stage: this.hadConflicts && !this.ro ? (cx) => cx.spawn(async (cx) => this.stage(cx)) : null,
							}),
						),
					)
					.when(this.mode === 'edit' && Boolean(this.code), (el) =>
						el.child(Editor.new(this.code).id(`code-${this.gen}`).flex_1().min_h(0)),
					)
					.when(this.mode === 'edit' && Boolean(this.code) && this.problems, (el) => el.child(this.problemsView(t)))
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
