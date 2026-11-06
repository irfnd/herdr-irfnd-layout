// The space menu (right-click a space): the shipped `menu` mod's space items, plus
// "Set icon…" (spaces on this computer) and "Remove icon" (when one is set).
// Also the space's group items (Move to group…, Remove from group) and a group's own
// menu, from herdr-space-groups. Opened as a popup of this mod with props
// { view: "menu", space, nested } or { view: "menu", group }.
// ↑/↓ move, Enter runs, Esc closes.

import { div, svg } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { run, props, closeOverlay, openOverlay, theme, keys, spaces, panes, exec, shared } from 'herdr';
import { SHARED_KEY } from './avatars.js';
import { MOD, removeIcon } from './files.js';
import { load, groupOf, childrenOf, assign, remove, shift } from './groups.js';

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
	const tabs = new Set((s.tabs ?? []).map((c) => c.id));
	return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder, on) {
	const top = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: folder, on });
	const common = await exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: folder, on });
	if (top.code !== 0 || common.code !== 0) return null;
	return common.stdout.trim() === `${top.stdout.trim()}/.git` ? 'main' : 'linked';
}

// [label, command, args, disabled]; "worktree", "icon.*" and "group.*" are handled here.
function items(p, git) {
	if (p?.group) {
		const state = load();
		const g = state.groups.find((g) => g.id === p.group);
		const mine = g ? childrenOf(state, g.machine, g.parent) : [];
		return [
			['Rename group', 'group.rename', { group: p.group }],
			['Add Sub Group…', 'group.new', { parent: p.group }],
			['Move to group…', 'group.move', { group: p.group }],
			['Move up', 'group.shift', { group: p.group, by: -1 }, mine[0] === g],
			['Move down', 'group.shift', { group: p.group, by: 1 }, mine.at(-1) === g],
			['Delete group', 'group.delete', { group: p.group }],
		];
	}
	const id = p?.space;
	const space = spaces().find((s) => s.id === id);
	const grouped = space && groupOf(load(), space);
	const has = Boolean((shared(SHARED_KEY) ?? {})[id]);
	return [
		['Rename', 'space.rename', { id }],
		...(git
			? [
					['New worktree', 'worktree', { space: id, action: 'new' }],
					['Open worktree', 'worktree', { space: id, action: 'open' }],
				]
			: []),
		...(git === 'linked' ? [['Remove worktree', 'worktree', { space: id, action: 'remove' }]] : []),
		...(space && !space.machine ? [['Set icon…', 'icon.set', { space: id }]] : []),
		...(has ? [['Remove icon', 'icon.remove', { space: id }]] : []),
		// A worktree nested under its checkout goes with its checkout's group.
		...(p?.nested
			? []
			: [
					['Move to group…', 'group.move', { space: id }],
					...(grouped ? [['Remove from group', 'group.leave', { space: id }]] : []),
				]),
		['Close', 'space.close', { id }],
	];
}

function menuIcon([, command, args]) {
	if (command.startsWith('icon.')) return `mods/${MOD}/image.svg`;
	if (command === 'group.shift') return `mods/${MOD}/arrow-${args.by < 0 ? 'up' : 'down'}.svg`;
	const names = {
		'group.delete': 'x',
		'group.move': 'folder',
		'group.leave': 'minus',
		'group.new': 'folder-plus',
		worktree: 'git-branch',
	};
	const name = names[command] ?? (command.endsWith('.close') ? 'x' : command.endsWith('.rename') ? 'square-pen' : 'terminal');
	return `mods/workspace-chrome/${name}.svg`;
}

const separated = (command) => command.endsWith('.close') || command === 'group.delete' || command === 'group.move';

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
	const value = args && Object.values(args)[0];
	const k = keys().find((b) => b.section === 'global' && (b.action === name || b.action === `${name}:${value}`));
	return k ? k.keys : '';
}

export class SpaceMenu {
	init(p, cx) {
		this.p = p;
		this.id = p?.space;
		this.at = 0;
		this.git = null;
		this.handle = cx.focus_handle();
		this.handle.focus();
		const space = spaces().find((s) => s.id === this.id);
		const folder = space && place(space);
		if (folder)
			cx.spawn(async (cx) => {
				this.git = await checkout(folder, space.machine).catch(() => null);
				cx.notify();
			});
	}

	choose(i, cx) {
		const it = items(this.p, this.git)[i];
		if (!it || it[3]) return;
		const overlay = props()?.overlay;
		if (it[1] === 'icon.remove') {
			// Remove before closing: closing cancels this copy's unfinished tasks.
			cx.spawn(async () => {
				await removeIcon(it[2].space).catch(() => {});
				closeOverlay(overlay);
			});
			return;
		}
		closeOverlay(overlay);
		if (it[1] === 'worktree')
			openOverlay({
				mod: 'worktree',
				kind: 'dialog',
				...(it[2].action === 'open' ? { width: 560, height: 480 } : { width: 440, height: 260 }),
				props: it[2],
			});
		else if (it[1] === 'icon.set')
			openOverlay({ mod: MOD, kind: 'dialog', width: 460, height: 250, props: { view: 'pick', space: it[2].space } });
		else if (it[1] === 'group.move') openOverlay({ mod: MOD, kind: 'dialog', width: 380, props: { view: 'move', ...it[2] } });
		else if (it[1] === 'group.leave') assign(it[2].space, null);
		else if (it[1] === 'group.rename')
			openOverlay({ mod: MOD, kind: 'dialog', width: 380, props: { view: 'name', group: it[2].group } });
		else if (it[1] === 'group.new')
			openOverlay({ mod: MOD, kind: 'dialog', width: 380, props: { view: 'name', parent: it[2].parent } });
		else if (it[1] === 'group.shift') shift(it[2].group, it[2].by);
		else if (it[1] === 'group.delete') remove(it[2].group);
		else run(it[1], it[2]);
	}

	render() {
		const t = theme();
		const list = items(this.p, this.git);
		return v_flex()
			.id('menu')
			.track_focus(this.handle)
			.w_full()
			.min_h(0)
			.p(5)
			.bg(t.popover)
			.text_size(12.8)
			.on_key_down((e, cx) => {
				if (e.key === 'down') this.at = (this.at + 1) % list.length;
				else if (e.key === 'up') this.at = (this.at + list.length - 1) % list.length;
				else if (e.key === 'enter') this.choose(this.at, cx);
				else if (e.key === 'escape') closeOverlay(props().overlay);
				else return;
				cx.notify();
			})
			.children(
				list.map((it, i) =>
					v_flex()
						.when(i > 0 && separated(it[1]), (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
						.child(
							h_flex()
								.id(`mi-${i}`)
								.h(31)
								.px(8)
								.gap(9)
								.rounded(7)
								.items_center()
								.justify_between()
								.text_color(it[3] ? t.dim : t.foreground)
								.when(i === this.at, (el) => el.bg(t.selected))
								.when(!it[3], (el) => el.hover((s) => s.bg(t.hover)))
								.on_click((_e, cx) => this.choose(i, cx))
								.child(
									svg(menuIcon(it))
										.size(14)
										.flex_none()
										.text_color(it[3] ? t.dim : t.muted),
								)
								.child(div().flex_1().child(it[0]))
								.child(div().text_size(11).text_color(t.dim).child(shortcut(it[1], it[2]))),
						),
				),
			);
	}
}
