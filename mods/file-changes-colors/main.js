// A lazy file browser for the focused pane's folder. A file opens full in a new tab.
import { View, div, svg, image } from 'gpui-kit';
import { fileAppearance, folderAppearance, gitStatus, statusColor } from './appearance.js';
import { v_flex, h_flex, InputState, Input } from 'gpui-base';
import {
	spaces,
	panes,
	focused,
	exec,
	shared,
	setShared,
	openOverlay,
	props,
	watchFolder,
	theme,
	window,
	home as homeDir,
} from 'herdr';
import { searchNames, searchContent } from './search.js';
import { openFile, parent, clipboard } from './ops.js';
import { FileMenu, NameDialog, DeleteDialog, ReplaceDialog, paste } from './panels.js';

// A mod pane (an editor tab) has no folder, and `space.folder` is only where the space was made. So a space
// keeps showing the folder of the last terminal that had focus in it, else of its first terminal.
const lastTerminal = new Map();
const place = (space, pane) => {
	if (space && pane?.cwd) lastTerminal.set(space.id, pane.cwd);
	const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
	return lastTerminal.get(space?.id) ?? panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd;
};

function location() {
	const space = spaces().find((s) => s.active),
		f = focused();
	const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
	const on = f?.pane === null ? (f.terminal?.includes('/') ? f.terminal.split('/')[0] : null) : (space?.machine ?? null);
	const home = place(space, pane); // also remembers a focused terminal's folder
	return { cwd: pane?.cwd || f?.cwd || home || space?.folder, on };
}
const key = () => JSON.stringify(location());
const PER_FOLDER = 500,
	TOTAL = 5000;
// A folder takes the colour of its strongest change inside: conflict, deleted, modified, added.
const STRONG = ['U', 'D', 'M', 'A'];
const stronger = (a, b) => (!a || STRONG.indexOf(b) < STRONG.indexOf(a) ? b : a);

async function directory(path, on) {
	if (!on && window()?.platform === 'windows') {
		const r = await exec('powershell', [
			'-NoProfile',
			'-Command',
			"& { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) } }) | ConvertTo-Json -Compress }",
			path,
		]);
		if (r.code !== 0) throw new Error(r.stderr || 'Cannot list this folder');
		const result = JSON.parse(r.stdout || '[]');
		return Array.isArray(result) ? result : [result];
	}
	const script =
		'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ] && [ ! -L "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
	const r = await exec('sh', ['-c', script, 'files', path], { on });
	if (r.code !== 0) throw new Error(r.stderr || 'Cannot list this folder');
	const fields = r.stdout.split('\0'),
		out = [];
	for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === 'd' });
	return out;
}

class Files extends View {
	init(_props, cx) {
		this.handle = cx.focus_handle();
		this.selected = null; // { path (relative), dir }: the item last clicked
		this.sel = new Map(); // every selected path (relative) -> dir; cmd/ctrl-click adds, shift-click takes a range
		this.anchor = null; // where a shift-click range starts
		this.order = []; // [path, dir] of the rows on screen, top to bottom
		this.searching = false; // the search field is open
		this.found = null; // { names: [path], hits: [{ path, line, text }] } for the current query
		this.query = '';
		this.input = InputState.new({ placeholder: 'Search files and text' });
		this.input.on('change', (_e, cx) => this.find(this.input.value(), cx));
		this.replacing = false; // the "replace with" field is open
		this.repl = InputState.new({ placeholder: 'Replace with' });
		this.repl.on('submit', () => this.askReplace());
		this.seen = shared('files.refresh') ?? null;
		this.entries = new Map();
		this.folders = new Set();
		this.pending = new Set();
		this.marks = {};
		this.dirs = {}; // folder -> its strongest change inside
		this.untracked = new Set(); // folders git lists whole, as one untracked entry
		this.refresh(cx);
		cx.timer.every(10000, (cx) => this.refresh(cx));
		// File operations in a dialog ask for a refresh (a remote folder has no watcher).
		cx.timer.every(500, (cx) => {
			const n = shared('files.refresh') ?? null;
			if (n !== this.seen) {
				this.seen = n;
				this.refresh(cx);
				if (this.searching && this.query) this.find(this.query, cx); // what a replace changed
			}
		});
	}

	watch(root, cx) {
		if (this.on || this.watched === root) return;
		this.watched = root;
		cx.spawn(async (cx) => {
			try {
				while (this.watched === root) {
					await watchFolder(root);
					if (this.watched === root) this.refresh(cx);
				}
			} catch {
				if (this.watched === root) this.watched = null;
			}
		});
	}

	async loadFolder(path, context) {
		const on = this.on,
			root = this.root;
		const entries = await directory(path ? `${root}/${path}` : root, on);
		if (key() !== context || (path && !this.folders.has(path))) return;
		const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
		this.entries.set(
			path,
			entries
				.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used)))
				.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)),
		);
		if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
	}

	refresh(cx) {
		if (this.loading) return;
		const { cwd, on } = location(),
			context = key();
		if (context !== this.context) {
			this.context = context;
			this.root = cwd;
			this.on = on;
			this.entries = new Map();
			this.folders = new Set();
			this.pending = new Set();
			this.marks = {};
			this.dirs = {};
			this.untracked = new Set();
			this.sel = new Map();
			this.anchor = null;
			this.watched = null;
			this.error = null;
			this.limited = false;
		}
		if (!cwd) return;
		this.loading = true;
		this.limited = false;
		cx.spawn(async (cx) => {
			try {
				for (const path of ['', ...this.folders]) await this.loadFolder(path, context);
				const top = await exec('git', ['rev-parse', '--show-toplevel'], { cwd, on }).catch(() => null);
				const marks = {},
					dirs = {},
					untracked = new Set();
				if (top?.code === 0) {
					// Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
					const status = await exec(
						'git',
						[
							'--no-optional-locks',
							'-c',
							'core.fsmonitor=false',
							'status',
							'--porcelain=v1',
							'-z',
							'--no-renames',
							'--untracked-files=normal',
						],
						{ cwd, on },
					).catch(() => null);
					if (status?.code === 0)
						for (const entry of status.stdout.split('\0').filter(Boolean).slice(0, TOTAL)) {
							const base = top.stdout.trim(),
								status = gitStatus(entry.slice(0, 2)),
								whole = entry.endsWith('/'), // an untracked folder is listed as one entry: "?? dir/"
								abs = `${base}/${entry.slice(3).replace(/\/$/, '')}`;
							marks[abs] = status;
							if (whole) untracked.add(abs);
							for (let at = abs.slice(0, abs.lastIndexOf('/')); at.length > base.length; at = at.slice(0, at.lastIndexOf('/')))
								dirs[at] = stronger(dirs[at], status);
						}
				}
				if (key() !== context) return;
				this.marks = marks;
				this.dirs = dirs;
				this.untracked = untracked;
				this.error = null;
				this.watch(cwd, cx);
			} catch (e) {
				if (key() === context) this.error = String(e);
			} finally {
				this.loading = false;
				cx.notify();
			}
		});
	}

	toggle(path, cx) {
		if (this.folders.has(path)) {
			for (const folder of [...this.folders])
				if (folder === path || folder.startsWith(path + '/')) {
					this.folders.delete(folder);
					this.entries.delete(folder);
				}
		} else {
			this.folders.add(path);
			if (!this.entries.has(path) && !this.pending.has(path)) {
				const context = this.context;
				this.pending.add(path);
				cx.spawn(async (cx) => {
					try {
						await this.loadFolder(path, context);
					} catch (e) {
						if (key() === context) this.error = String(e);
					} finally {
						this.pending.delete(path);
						cx.notify();
					}
				});
			}
		}
		cx.notify();
	}

	// What an operation acts on: the selection (a single click selects one), as absolute paths.
	picked() {
		const list = this.sel.size ? [...this.sel] : this.selected ? [[this.selected.path, this.selected.dir]] : [];
		return list.map(([path, dir]) => ({ path: `${this.root}/${path}`, dir }));
	}

	// A click on a row. Plain: select it and open it (a folder folds). Cmd/Ctrl: add or remove it.
	// Shift: everything from the last plain or cmd click down to it. The last two only select.
	click(path, dir, mod, cx) {
		this.handle.focus();
		const at = this.order.findIndex(([p]) => p === path),
			from = this.order.findIndex(([p]) => p === this.anchor);
		if (mod.shift && at >= 0 && from >= 0) {
			this.sel = new Map(this.order.slice(Math.min(at, from), Math.max(at, from) + 1));
			this.selected = { path, dir };
		} else if (mod.platform || mod.control) {
			if (!this.sel.size && this.selected) this.sel.set(this.selected.path, this.selected.dir);
			if (this.sel.has(path)) this.sel.delete(path);
			else this.sel.set(path, dir);
			const [last] = [...this.sel].slice(-1);
			this.selected = last ? { path: last[0], dir: last[1] } : null;
			this.anchor = path;
		} else {
			this.sel = new Map([[path, dir]]);
			this.selected = { path, dir };
			this.anchor = path;
			if (dir) this.toggle(path, cx);
			else openFile(`${this.root}/${path}`, this.on);
		}
		cx.notify();
	}

	clearSelection(cx) {
		this.sel = this.selected ? new Map([[this.selected.path, this.selected.dir]]) : new Map();
		cx.notify();
	}

	// The folder a new item goes into: the selected folder, else the selected item's folder, else the root.
	target() {
		const at = this.selected;
		return !at ? this.root : `${this.root}/${at.dir ? at.path : at.path.includes('/') ? parent(at.path) : ''}`.replace(/\/$/, '');
	}

	// Typing waits a moment, then both searches run; a newer query drops the older one's results.
	find(q, cx) {
		this.query = q.trim();
		this.stamp = (this.stamp ?? 0) + 1;
		const stamp = this.stamp,
			root = this.root,
			on = this.on;
		if (!this.query || !root) {
			this.found = null;
			return cx.notify();
		}
		cx.spawn(async (cx) => {
			await new Promise((done) => cx.timer.after(250, done));
			if (stamp !== this.stamp) return;
			const q = this.query;
			const [names, hits] = await Promise.all([
				searchNames(root, q, on).catch(() => []),
				((shared('editor.settings') ?? {}).contentSearch ?? true) ? searchContent(root, q, homeDir(), on).catch(() => []) : [],
			]);
			if (stamp === this.stamp) this.found = { names, hits, q };
			cx.notify();
		});
	}

	// Replace-all asks first: a dialog counts the files and does it on Replace.
	askReplace() {
		if (!this.query || this.on) return;
		this.dialog('replace', { root: this.root, query: this.query, replacement: this.repl.value() });
	}

	toggleSearch(cx) {
		this.searching = !this.searching;
		this.found = null;
		this.query = '';
		this.stamp = (this.stamp ?? 0) + 1;
		this.input.set_value('');
		this.replacing = false;
		this.repl.set_value('');
		if (this.searching) {
			this.input.focus();
			cx.timer.after(300, () => this.input.focus());
		}
		cx.notify();
	}

	// A folder as the list shows it: relative to this one when inside it, else with ~ for home.
	near(dir, home) {
		if (dir === this.root) return '.';
		return dir.startsWith(`${this.root}/`) ? dir.slice(this.root.length + 1) : dir.replace(home ?? '\0', '~');
	}

	// With nothing typed yet: the files opened lately, here or on this machine.
	recent(t) {
		const home = homeDir(),
			list = (shared('files.recent') ?? []).filter((r) => (r.on ?? null) === (this.on ?? null));
		const hint = div().p(8).text_size(12).text_color(t.dim).child('Type to search file names and text');
		if (!list.length) return [hint];
		return [
			div().px(8).pt(8).pb(4).text_size(11).text_color(t.dim).child('Recent'),
			...list.map((r, i) =>
				h_flex()
					.id(`recent-${i}`)
					.h(28)
					.flex_none()
					.px(8)
					.gap(7)
					.items_center()
					.rounded(7)
					.cursor_pointer()
					.hover((s) => s.bg(t.hover))
					.on_click(() => openFile(r.path, r.on ?? null))
					.child(
						image(`mods/file-changes-colors/icons/${fileAppearance(r.path.split('/').pop()).icon}.svg`)
							.size(16)
							.flex_none(),
					)
					.child(div().truncate().child(r.path.split('/').pop()))
					.child(
						div()
							.flex_1()
							.min_w(0)
							.truncate()
							.text_size(11)
							.text_color(t.dim)
							.child(this.near(parent(r.path), home)),
					),
			),
			hint,
		];
	}

	results(t) {
		const f = this.found;
		const head = (text) => div().px(8).pt(8).pb(4).text_size(11).text_color(t.dim).child(text);
		const row = (id, path, extra) =>
			h_flex()
				.id(id)
				.h(extra ? 40 : 28)
				.flex_none()
				.px(8)
				.gap(7)
				.items_center()
				.rounded(7)
				.cursor_pointer()
				.hover((s) => s.bg(t.hover))
				.on_click(() => openFile(`${this.root}/${path}`, this.on))
				.child(
					image(`mods/file-changes-colors/icons/${fileAppearance(path.split('/').pop()).icon}.svg`)
						.size(16)
						.flex_none(),
				)
				.child(
					v_flex()
						.flex_1()
						.min_w(0)
						.child(
							h_flex()
								.gap(6)
								.child(div().truncate().child(path.split('/').pop()))
								.child(
									div()
										.flex_1()
										.min_w(0)
										.truncate()
										.text_size(11)
										.text_color(t.dim)
										.child(path.includes('/') ? parent(path) : ''),
								),
						)
						.when(Boolean(extra), (el) => el.child(div().truncate().text_size(11.5).text_color(t.muted).child(extra))),
				);
		if (!this.query) return this.recent(t);
		if (!f) return [div().p(8).text_size(12).text_color(t.dim).child('Searching…')];
		if (!f.names.length && !f.hits.length) return [div().p(8).text_size(12).text_color(t.dim).child(`No results for “${f.q}”`)];
		return [
			...(f.names.length ? [head(`Files · ${f.names.length}`), ...f.names.map((p, i) => row(`sn-${i}`, p))] : []),
			...(f.hits.length
				? [head(`Text · ${f.hits.length}`), ...f.hits.map((h, i) => row(`sh-${i}`, h.path, `${h.line}: ${h.text}`))]
				: []),
		];
	}

	menu(path, dir) {
		const many = this.sel.size > 1;
		const n = many ? 4 : path ? (dir ? 9 : 10) : 4;
		openOverlay({
			mod: 'file-changes-colors',
			kind: 'popup',
			width: 210,
			height: 10 + (n - (this.on || many ? 1 : 0)) * 30 + (path ? 5 : 0),
			props: {
				view: 'menu',
				path: path ? `${this.root}/${path}` : null,
				dir: path ? dir : true,
				root: this.root,
				on: this.on,
				...(many ? { items: this.picked() } : {}),
			},
		});
	}

	tool(id, icon, t, action, on) {
		return div()
			.id(id)
			.size(22)
			.flex_none()
			.flex()
			.items_center()
			.justify_center()
			.rounded(6)
			.cursor_pointer()
			.text_color(on ? t.accent : t.dim)
			.hover((s) => s.bg(t.hover).text_color(t.foreground))
			.on_click(action)
			.child(svg(`mods/file-changes-colors/ui/${icon}.svg`).size(14));
	}

	dialog(view, extra) {
		openOverlay({ mod: 'file-changes-colors', kind: 'dialog', width: 400, props: { view, on: this.on, ...extra } });
	}

	key(e, cx) {
		const at = this.selected,
			abs = at && `${this.root}/${at.path}`,
			list = this.picked(),
			take = (mode) => setShared('files.clipboard', { mode, paths: list.map((i) => i.path), on: this.on });
		if (e.keystroke === 'cmd-f') this.toggleSearch(cx);
		else if (e.keystroke === 'f2' && at && this.sel.size <= 1) this.dialog('name', { action: 'rename', path: abs });
		else if ((e.keystroke === 'delete' || e.keystroke === 'cmd-backspace') && list.length) this.dialog('delete', { items: list });
		else if (e.keystroke === 'cmd-c' && list.length) take('copy');
		else if (e.keystroke === 'cmd-x' && list.length) take('cut');
		else if (e.keystroke === 'cmd-v' && clipboard()) paste(this.target(), this.on).catch(() => {});
		else if (e.keystroke === 'cmd-a' && !this.searching) this.sel = new Map(this.order);
		else if (e.key === 'escape' && this.sel.size > 1) this.clearSelection(cx);
		else return;
		cx.stop_propagation();
		cx.notify();
	}

	// The rows, and what they leave of the selection: a folded-away or deleted item is not selected any more.
	tree(t) {
		this.order = [];
		const out = this.rows('', 0, [], t);
		const shown = new Set(this.order.map(([p]) => p));
		for (const p of [...this.sel.keys()]) if (!shown.has(p)) this.sel.delete(p);
		return out;
	}

	rows(prefix, depth, out, t) {
		if (out.length >= TOTAL || depth > 40) return out;
		const hidden = (shared('editor.settings') ?? {}).hidden ?? true;
		for (const entry of this.entries.get(prefix) ?? []) {
			if (!hidden && entry.name.startsWith('.')) continue;
			if (out.length >= TOTAL) break;
			const path = prefix ? `${prefix}/${entry.name}` : entry.name,
				open = this.folders.has(path),
				abs = `${this.root}/${path}`;
			// Inside a folder git lists whole (untracked), every file is added too.
			let mark = this.marks[abs];
			for (let at = abs; !mark && at.includes('/');) {
				at = at.slice(0, at.lastIndexOf('/'));
				if (this.untracked.has(at)) mark = 'A';
			}
			const shade = mark ?? (entry.dir ? this.dirs[abs] : undefined);
			this.order.push([path, entry.dir]);
			out.push(
				h_flex()
					.id(`file-${path}`)
					.h(28)
					.flex_none()
					.pl(8 + depth * 18)
					.pr(8)
					.gap(7)
					.items_center()
					.rounded(7)
					.cursor_pointer()
					.hover((s) => s.bg(t.hover))
					.when(this.sel.has(path) || (!this.sel.size && this.selected?.path === path), (el) => el.bg(t.selected))
					.on_click((e, cx) => this.click(path, entry.dir, e.modifiers, cx))
					.on_mouse_down('right', (_e, cx) => {
						cx.stop_propagation();
						if (!this.sel.has(path)) {
							this.sel = new Map([[path, entry.dir]]);
							this.anchor = path;
						}
						this.selected = { path, dir: entry.dir };
						this.menu(path, entry.dir);
						cx.notify();
					})
					.child(
						entry.dir
							? svg(`mods/file-changes-colors/chevron-${open ? 'down' : 'right'}.svg`)
									.size(12)
									.flex_none()
									.text_color(t.dim)
							: div().w(12).flex_none(),
					)
					.child(
						image(
							`mods/file-changes-colors/icons/${entry.dir ? folderAppearance(entry.name, open) : fileAppearance(entry.name).icon}.svg`,
						)
							.size(16)
							.flex_none(),
					)
					.child(div().flex_1().min_w(0).truncate().text_color(statusColor(shade, t)).child(entry.name))
					.when(Boolean(mark), (el) => el.child(div().text_size(11).text_color(statusColor(mark, t)).child(mark)))
					.when(!mark && Boolean(shade), (el) => el.child(div().size(6).rounded_full().flex_none().bg(statusColor(shade, t)))),
			);
			if (entry.dir && open) this.rows(path, depth + 1, out, t);
		}
		return out;
	}

	render(cx) {
		if (key() !== this.context) this.refresh(cx);
		const t = theme();
		return v_flex()
			.id('files')
			.size_full()
			.min_h(0)
			.rounded(10)
			.overflow_hidden()
			.bg(t.background)
			.border_1()
			.border_color(t.border)
			.text_color(t.foreground)
			.text_size(13)
			.child(
				h_flex()
					.h(42)
					.flex_none()
					.px(14)
					.gap(8)
					.items_center()
					.border_b(1)
					.border_color(t.border)
					.child(div().font_semibold().child('Files'))
					.child(this.tool('search', 'search', t, (_e, cx) => this.toggleSearch(cx), this.searching))
					.child(this.tool('new-file', 'file-plus', t, () => this.dialog('name', { action: 'file', path: this.target() })))
					.child(this.tool('new-folder', 'folder-plus', t, () => this.dialog('name', { action: 'folder', path: this.target() })))
					.child(this.tool('settings', 'settings', t, () => openOverlay({ mod: 'editor-settings', kind: 'dialog', width: 420 })))
					.child(
						div()
							.flex_1()
							.min_w(0)
							.truncate()
							.text_right()
							.text_size(12)
							.text_color(t.dim)
							.child(this.root?.split(/[\\/]/).pop() ?? ''),
					),
			)
			.when(this.searching, (el) =>
				el.child(
					h_flex()
						.id('files-search')
						.flex_none()
						.px(10)
						.py(8)
						.border_b(1)
						.border_color(t.border)
						.on_key_down((e, cx) => {
							if (e.key !== 'escape') return;
							this.toggleSearch(cx);
							cx.stop_propagation();
						})
						.child(
							Input.new(this.input)
								.flex_1()
								.h(30)
								.px(9)
								.rounded(8)
								.border_1()
								.border_color(t.accent)
								.bg(t.background)
								.text_size(12.5)
								.text_color(t.foreground),
						)
						.when(!this.on, (el) =>
							el.child(
								div()
									.id('replace-toggle')
									.h(30)
									.px(8)
									.ml(6)
									.flex()
									.items_center()
									.rounded(8)
									.cursor_pointer()
									.text_size(11.5)
									.text_color(this.replacing ? t.accent : t.dim)
									.hover((s) => s.bg(t.hover).text_color(t.foreground))
									.on_click((_e, cx) => {
										this.replacing = !this.replacing;
										if (this.replacing) this.repl.focus();
										cx.notify();
									})
									.child('Replace'),
							),
						),
				),
			)
			.when(this.searching && this.replacing && !this.on, (el) =>
				el.child(
					h_flex()
						.id('files-replace')
						.flex_none()
						.px(10)
						.pb(8)
						.gap(6)
						.border_b(1)
						.border_color(t.border)
						.on_key_down((e, cx) => {
							if (e.key !== 'escape') return;
							this.toggleSearch(cx);
							cx.stop_propagation();
						})
						.child(
							Input.new(this.repl)
								.flex_1()
								.h(30)
								.px(9)
								.rounded(8)
								.border_1()
								.border_color(t.input)
								.bg(t.background)
								.text_size(12.5)
								.text_color(t.foreground),
						)
						.child(
							div()
								.id('replace-all')
								.h(30)
								.px(10)
								.flex()
								.items_center()
								.rounded(8)
								.text_size(11.5)
								.bg(t.raised)
								.when(Boolean(this.query), (el) =>
									el
										.cursor_pointer()
										.text_color(t.foreground)
										.hover((s) => s.bg(t.hover))
										.on_click(() => this.askReplace()),
								)
								.when(!this.query, (el) => el.text_color(t.dim))
								.child('Replace all'),
						),
				),
			)
			.child(
				v_flex()
					.id('files-tree')
					.track_focus(this.handle)
					.on_key_down((e, cx) => this.key(e, cx))
					.on_mouse_down('right', () => this.menu(null, true))
					.flex_1()
					.min_h(0)
					.overflow_y_scrollbar()
					.p(6)
					.children(this.searching ? this.results(t) : this.tree(t))
					.when(!this.searching && (Boolean(this.error) || !this.entries.get('')?.length), (el) =>
						el.child(
							div()
								.p(8)
								.text_size(12)
								.text_color(t.dim)
								.child(this.error || (this.loading ? 'Loading files…' : this.root ? 'No files' : 'No folder')),
						),
					)
					.when(this.limited && !this.searching, (el) =>
						el.child(
							div().p(8).text_size(11).text_color(t.dim).child('File list limited to 500 entries per folder and 5,000 total'),
						),
					),
			)
			.when(this.sel.size > 1 && !this.searching, (el) => el.child(this.selectionBar(t)));
	}

	// "3 selected" with what can be done to them, so a selection works without a right-click too.
	selectionBar(t) {
		const take = (mode) => () => setShared('files.clipboard', { mode, paths: this.picked().map((i) => i.path), on: this.on });
		const chip = (id, label, color, action) =>
			div()
				.id(`sel-${id}`)
				.h(24)
				.px(8)
				.flex()
				.items_center()
				.rounded(6)
				.cursor_pointer()
				.text_size(11.5)
				.text_color(color)
				.hover((s) => s.bg(t.hover))
				.on_click(action)
				.child(label);
		return h_flex()
			.flex_none()
			.h(38)
			.px(10)
			.gap(2)
			.items_center()
			.border_t(1)
			.border_color(t.border)
			.child(div().flex_1().text_size(12).text_color(t.muted).child(`${this.sel.size} selected`))
			.child(chip('copy', 'Copy', t.foreground, take('copy')))
			.child(chip('cut', 'Cut', t.foreground, take('cut')))
			.child(chip('delete', 'Delete', t.blocked, () => this.dialog('delete', { items: this.picked() })))
			.child(chip('clear', '×', t.dim, (_e, cx) => this.clearSelection(cx)));
	}
}

// One mod, three views: the file tree (in a layout), its menu, and its dialogs.
export default class FileTree extends Files {
	init(given, cx) {
		// An overlay gets its props through props(), not as init's argument.
		const p = given?.view ? given : props();
		const Part = { menu: FileMenu, name: NameDialog, delete: DeleteDialog, replace: ReplaceDialog }[p?.view] ?? null;
		if (!Part) return super.init(p, cx);
		this.part = new Part();
		this.part.init(p, cx);
	}

	render(cx) {
		return this.part ? this.part.render(cx) : super.render(cx);
	}
}
