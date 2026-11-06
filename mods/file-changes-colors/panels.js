// The Files tab's popup menu and dialogs. Opened as overlays of this mod:
//   { view: 'menu',   path, dir, on }                 right-click on a row (path: absolute; null = the root)
//   { view: 'name',   action: 'file'|'folder'|'rename', path, on }   path: the folder to create in, or the item to rename
//   { view: 'delete', path, dir, on }
import { div, svg } from 'gpui-kit';
import { v_flex, h_flex, InputState, Input } from 'gpui-base';
import { home } from 'herdr';
import { searchFiles } from './search.js';
import { replaceAll } from './replace.js';
import { props, closeOverlay, openOverlay, theme, setShared, notify } from 'herdr';
import {
	base,
	parent,
	checkName,
	createFile,
	createDir,
	rename,
	move,
	copy,
	remove,
	trashes,
	reveal,
	copyPath,
	clipboard,
	openFile,
} from './ops.js';

const MOD = 'file-changes-colors';
const refresh = () => setShared('files.refresh', Date.now());
const ico = (name) => `mods/${MOD}/ui/${name}.svg`;
const folderOf = (p) => (p.dir ? p.path : parent(p.path));

// Runs `fn` on every path; one that fails does not stop the rest. -> [{ path, why }] of the failures.
async function each(paths, fn) {
	const failed = [];
	for (const path of paths) {
		try {
			await fn(path);
		} catch (e) {
			failed.push({ path, why: String(e.message ?? e) });
		}
	}
	return failed;
}
const names = (failed) => failed.map((f) => `${base(f.path)}: ${f.why}`).join('\n');

// Paste into `dir`: a copy keeps the originals, a cut moves them. What a cut could not move stays on
// the clipboard, so it can be pasted somewhere else.
export async function paste(dir, on) {
	const c = clipboard(),
		paths = c?.paths ?? (c?.path ? [c.path] : []);
	if (!paths.length || c.on !== on) throw new Error('Nothing to paste on this machine');
	const verb = c.mode === 'cut' ? 'move' : 'copy';
	const failed = await each(paths, (p) => (c.mode === 'cut' ? move : copy)(p, dir, on));
	if (c.mode === 'cut') setShared('files.clipboard', failed.length ? { ...c, paths: failed.map((f) => f.path) } : null);
	if (failed.length)
		notify({
			title: `Could not ${verb} ${failed.length === 1 ? base(failed[0].path) : `${failed.length} of ${paths.length} items`}`,
			body: failed.length === 1 ? failed[0].why : names(failed),
			level: 'error',
		});
	refresh();
}

function items(p) {
	if (p.items?.length > 1) {
		const n = `${p.items.length} items`,
			take = (mode) => () => setShared('files.clipboard', { mode, paths: p.items.map((i) => i.path), on: p.on });
		return [
			[`Copy ${n}`, 'copy', take('copy')],
			[`Cut ${n}`, 'scissors', take('cut')],
			[
				`Delete ${n}…`,
				'trash',
				() => openOverlay({ mod: MOD, kind: 'dialog', width: 400, props: { view: 'delete', on: p.on, items: p.items } }),
				false,
				true,
			],
		];
	}
	const root = !p.path,
		c = clipboard(),
		there = root ? p.root : p.dir ? p.path : parent(p.path);
	return [
		...(!root && !p.dir ? [['Open', 'file-text', () => openFile(p.path, p.on)]] : []),
		['New file…', 'file-plus', () => dialog('name', { action: 'file', path: there })],
		['New folder…', 'folder-plus', () => dialog('name', { action: 'folder', path: there })],
		...(root ? [] : [['Rename…', 'pencil', () => dialog('name', { action: 'rename', path: p.path })]]),
		...(root
			? []
			: [
					['Copy', 'copy', () => setShared('files.clipboard', { mode: 'copy', paths: [p.path], on: p.on })],
					['Cut', 'scissors', () => setShared('files.clipboard', { mode: 'cut', paths: [p.path], on: p.on })],
				]),
		['Paste', 'clipboard', () => paste(there, p.on).catch(() => {}), !c || c.on !== p.on],
		...(root ? [] : [['Copy path', 'link', () => copyPath(p.path)]]),
		...(p.on ? [] : [['Reveal in Finder', 'external', () => reveal(p.path ?? p.root)]]),
		...(root ? [] : [['Delete…', 'trash', () => dialog('delete', { items: [{ path: p.path, dir: p.dir }] }), false, true]]),
	];

	function dialog(view, extra) {
		openOverlay({ mod: MOD, kind: 'dialog', width: 400, props: { view, on: p.on, ...extra } });
	}
}

export class FileMenu {
	init(p, cx) {
		this.at = 0;
		this.handle = cx.focus_handle();
		this.handle.focus();
	}

	choose(i) {
		const it = items(props())[i];
		if (!it || it[3]) return;
		closeOverlay(props().overlay);
		it[2]();
	}

	render() {
		const t = theme();
		const list = items(props());
		return v_flex()
			.id('file-menu')
			.track_focus(this.handle)
			.w_full()
			.min_h(0)
			.p(5)
			.bg(t.popover)
			.text_size(12.8)
			.on_key_down((e, cx) => {
				if (e.key === 'down') this.at = (this.at + 1) % list.length;
				else if (e.key === 'up') this.at = (this.at + list.length - 1) % list.length;
				else if (e.key === 'enter') this.choose(this.at);
				else if (e.key === 'escape') closeOverlay(props().overlay);
				else return;
				cx.notify();
			})
			.children(
				list.map(([label, icon, , off, danger], i) =>
					v_flex()
						.when(danger, (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
						.child(
							h_flex()
								.id(`fm-${i}`)
								.h(30)
								.px(8)
								.gap(9)
								.rounded(7)
								.items_center()
								.text_color(off ? t.dim : danger ? t.blocked : t.foreground)
								.when(i === this.at, (el) => el.bg(t.selected))
								.when(!off, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
								.on_click(() => this.choose(i))
								.child(
									svg(ico(icon))
										.size(14)
										.flex_none()
										.text_color(off ? t.dim : danger ? t.blocked : t.muted),
								)
								.child(div().flex_1().child(label)),
						),
				),
			);
	}
}

const buttons = (t, ok, cancel, okLabel, danger, enabled = true) =>
	h_flex()
		.pt(6)
		.gap(8)
		.justify_end()
		.child(button(t, 'cancel', 'Cancel', false, false, true, cancel))
		.child(button(t, 'ok', okLabel, true, danger, enabled, ok));

function button(t, id, text, primary, danger, enabled, action) {
	const fill = primary ? (danger ? t.blocked : t.solid) : t.raised;
	return h_flex()
		.id(`fd-${id}`)
		.h(32)
		.px(14)
		.items_center()
		.rounded(8)
		.border_1()
		.border_color(primary ? fill : t.input)
		.bg(fill)
		.text_color(primary ? t.solid_foreground : t.foreground)
		.text_size(12.5)
		.font_medium()
		.when(!enabled, (el) => el.opacity(0.5))
		.when(enabled, (el) =>
			el
				.cursor_pointer()
				.hover((s) => s.opacity(0.88))
				.on_click(action),
		)
		.child(text);
}

function frame(t, title, handle, onKey, ...children) {
	return v_flex()
		.id('file-dialog')
		.track_focus(handle)
		.on_key_down(onKey)
		.w_full()
		.min_h(0)
		.p(18)
		.gap(12)
		.bg(t.popover)
		.text_color(t.foreground)
		.text_size(12.8)
		.child(
			h_flex()
				.items_center()
				.child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(title))
				.child(div().text_size(11).text_color(t.dim).child('Esc')),
		)
		.children(children);
}

const escape = (e, cx) => {
	if (e.key !== 'escape') return;
	closeOverlay(props().overlay);
	cx.stop_propagation();
};

export class NameDialog {
	init(p, cx) {
		this.renaming = p.action === 'rename';
		this.text = this.renaming ? base(p.path) : '';
		this.error = null;
		this.busy = false;
		this.input = InputState.new({ value: this.text, placeholder: p.action === 'folder' ? 'folder name' : 'file name' });
		if (this.text) {
			// A rename selects the name without its extension.
			const dot = this.text.lastIndexOf('.');
			this.input.set_selected_range({ start: 0, end: dot > 0 ? dot : this.text.length });
		}
		this.input.on('change', (_e, cx) => {
			this.text = this.input.value();
			this.error = null;
			cx.notify();
		});
		this.input.on('submit', (_e, cx) => this.save(cx));
		this.input.focus();
		cx.timer.after(600, () => this.input.focus());
		this.handle = cx.focus_handle();
	}

	save(cx) {
		const p = props(),
			name = this.text.trim();
		this.error = checkName(name);
		if (this.error || this.busy) return cx.notify();
		this.busy = true;
		const target = `${this.renaming ? parent(p.path) : p.path}/${name}`;
		cx.spawn(async (cx) => {
			try {
				if (this.renaming) await rename(p.path, target, p.on);
				else await (p.action === 'folder' ? createDir : createFile)(target, p.on);
				refresh();
				closeOverlay(p.overlay);
				if (p.action === 'file') openFile(target, p.on); // a new file opens, ready to type in
			} catch (e) {
				this.error = String(e.message ?? e);
				this.busy = false;
				cx.notify();
			}
		});
	}

	render() {
		const t = theme(),
			p = props();
		const where = this.renaming ? '' : ` in ${base(p.path)}`;
		return frame(
			t,
			this.renaming ? `Rename ${base(p.path)}` : `New ${p.action}${where}`,
			this.handle,
			escape,
			Input.new(this.input)
				.h(36)
				.px(10)
				.rounded(9)
				.border_1()
				.border_color(this.error ? t.blocked : t.accent)
				.bg(t.background)
				.text_size(12.8)
				.text_color(t.foreground),
			...(this.error ? [div().text_size(11.5).text_color(t.blocked).child(this.error)] : []),
			buttons(
				t,
				(_e, cx) => this.save(cx),
				() => closeOverlay(p.overlay),
				this.renaming ? 'Rename' : 'Create',
				false,
				!this.busy,
			),
		);
	}
}

export class DeleteDialog {
	init(_p, cx) {
		this.items = [...props().items]; // shrinks to what could not be deleted
		this.error = null;
		this.busy = false;
		this.handle = cx.focus_handle();
		this.handle.focus();
	}

	run(cx) {
		const p = props();
		if (this.busy) return;
		this.busy = true;
		cx.spawn(async (cx) => {
			const failed = await each(
				this.items.map((i) => i.path),
				(path) => remove(path, p.on),
			);
			refresh();
			if (!failed.length) return closeOverlay(p.overlay);
			// What was deleted is gone; the dialog stays for what was not.
			const left = new Set(failed.map((f) => f.path));
			this.items = this.items.filter((i) => left.has(i.path));
			this.error = names(failed);
			this.busy = false;
			cx.notify();
		});
	}

	render() {
		const t = theme(),
			p = props(),
			items = this.items,
			one = items.length === 1,
			folders = items.filter((i) => i.dir).length;
		const what = one
			? items[0].dir
				? 'The folder and everything in it'
				: 'The file'
			: `${items.length} items${folders ? `, ${folders === 1 ? 'a folder' : `${folders} folders`} and everything in ${folders === 1 ? 'it' : 'them'},` : ''}`;
		return frame(
			t,
			one ? `Delete ${base(items[0].path)}?` : `Delete ${items.length} items?`,
			this.handle,
			escape,
			div()
				.text_color(t.muted)
				.child(
					trashes(p.on)
						? `${what} ${one ? 'moves' : 'move'} to the Trash.`
						: `${what} ${one ? 'is' : 'are'} deleted for good. This cannot be undone.`,
				),
			...(one
				? []
				: [
						div()
							.text_size(11.5)
							.text_color(t.dim)
							.child(
								items
									.slice(0, 5)
									.map((i) => base(i.path))
									.join(', ') + (items.length > 5 ? `, and ${items.length - 5} more` : ''),
							),
					]),
			...(this.error ? [div().text_size(11.5).text_color(t.blocked).child(this.error)] : []),
			buttons(
				t,
				(_e, cx) => this.run(cx),
				() => closeOverlay(p.overlay),
				'Delete',
				true,
				!this.busy,
			),
		);
	}
}

// Replace `query` with `replacement` in every file that has it. The list is read when the dialog opens.
export class ReplaceDialog {
	init(_p, cx) {
		this.files = null; // [relative path] with a match, once found
		this.error = null;
		this.busy = false;
		this.handle = cx.focus_handle();
		this.handle.focus();
		const p = props();
		cx.spawn(async (cx) => {
			this.files = await searchFiles(p.root, p.query, home(), p.on).catch((e) => {
				this.error = String(e.message ?? e);
				return [];
			});
			cx.notify();
		});
	}

	run(cx) {
		const p = props();
		if (this.busy || !this.files?.length) return;
		this.busy = true;
		cx.spawn(async (cx) => {
			const r = await replaceAll(p.root, this.files, p.query, p.replacement);
			refresh();
			setShared('git.changed', Date.now());
			notify({
				title: `Replaced ${r.occurrences} in ${r.files} file${r.files === 1 ? '' : 's'}`,
				body: r.failed.length ? `${r.failed.length} could not be changed: ${names(r.failed)}` : undefined,
				level: r.failed.length ? 'warning' : 'success',
				timeout: r.failed.length ? 8000 : 4000,
			});
			closeOverlay(p.overlay);
		});
	}

	render() {
		const t = theme(),
			p = props(),
			n = this.files?.length ?? 0;
		return frame(
			t,
			`Replace “${p.query}”${p.replacement ? ` with “${p.replacement}”` : ' with nothing'}?`,
			this.handle,
			escape,
			div()
				.text_color(t.muted)
				.child(
					this.files === null
						? 'Looking for matches…'
						: n === 0
							? 'No files contain it.'
							: `Every match in ${n} file${n === 1 ? '' : 's'} will change, ignoring case. This writes to the files and cannot be undone here; git can.`,
				),
			...(n
				? [
						div()
							.text_size(11.5)
							.text_color(t.dim)
							.child(this.files.slice(0, 6).join(', ') + (n > 6 ? `, and ${n - 6} more` : '')),
					]
				: []),
			...(this.error ? [div().text_size(11.5).text_color(t.blocked).child(this.error)] : []),
			buttons(
				t,
				(_e, cx) => this.run(cx),
				() => closeOverlay(p.overlay),
				'Replace',
				true,
				!this.busy && n > 0,
			),
		);
	}
}
