// The Files tab's popup menu and dialogs. Opened as overlays of this mod:
//   { view: 'menu',   path, dir, on }                 right-click on a row (path: absolute; null = the root)
//   { view: 'name',   action: 'file'|'folder'|'rename', path, on }   path: the folder to create in, or the item to rename
//   { view: 'delete', path, dir, on }
import { div, svg } from 'gpui-kit';
import { v_flex, h_flex, InputState, Input } from 'gpui-base';
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

// Paste into `dir`: a copy keeps the original, a cut moves it (and is spent).
export async function paste(dir, on) {
	const c = clipboard();
	if (!c || c.on !== on) throw new Error('Nothing to paste on this machine');
	try {
		await (c.mode === 'cut' ? move : copy)(c.path, dir, on);
		if (c.mode === 'cut') setShared('files.clipboard', null);
	} catch (e) {
		// The clipboard stays, so it can be pasted somewhere else.
		notify({
			title: `Could not ${c.mode === 'cut' ? 'move' : 'copy'} ${base(c.path)}`,
			body: String(e.message ?? e),
			level: 'error',
		});
	}
	refresh();
}

function items(p) {
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
					['Copy', 'copy', () => setShared('files.clipboard', { mode: 'copy', path: p.path, on: p.on })],
					['Cut', 'scissors', () => setShared('files.clipboard', { mode: 'cut', path: p.path, on: p.on })],
				]),
		['Paste', 'clipboard', () => paste(there, p.on).catch(() => {}), !c || c.on !== p.on],
		...(root ? [] : [['Copy path', 'link', () => copyPath(p.path)]]),
		...(p.on ? [] : [['Reveal in Finder', 'external', () => reveal(p.path ?? p.root)]]),
		...(root ? [] : [['Delete…', 'trash', () => dialog('delete', { path: p.path, dir: p.dir }), false, true]]),
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
			try {
				await remove(p.path, p.on);
				refresh();
				closeOverlay(p.overlay);
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
		return frame(
			t,
			`Delete ${base(p.path)}?`,
			this.handle,
			escape,
			div()
				.text_color(t.muted)
				.child(
					trashes(p.on)
						? `${p.dir ? 'The folder and everything in it' : 'The file'} moves to the Trash.`
						: `${p.dir ? 'The folder and everything in it' : 'The file'} is deleted for good. This cannot be undone.`,
				),
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
