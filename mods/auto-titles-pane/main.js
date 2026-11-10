// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "auto-titles-pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

import { paneTitle } from './titles.js';
import { fileAppearance } from './appearance.js';
// A Changes diff tab: what it shows (a file, all changes, a stash or a commit). The panel records the tab's id
// in shared "git-changes.view", one entry per space.
const diffOf = (tab) => Object.values(shared('git-changes.view') ?? {}).find((e) => e.tab === tab)?.item ?? null;
const DIFF_ICON = { all: 'diff', stash: 'stash', commit: 'commit' };
import { View, div, svg, image } from 'gpui-kit';
import { h_flex } from 'gpui-base';
import { panes, props, run, theme, home, shared, setShared } from 'herdr';

function icon(p, size, color) {
	if (!p?.icon) return null;
	return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
	if (!cwd) return '';
	const h = home();
	return cwd === h ? '~' : cwd.startsWith(h + '/') ? '~' + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
	init() {
		this.hovered = false;
	}

	me() {
		return panes().find((p) => p.pane === props()?.pane);
	}

	button(t, id, icon, command, args) {
		return div()
			.id(id)
			.p(3)
			.rounded(4)
			.text_color(t.dim)
			.hover((s) => s.bg(t.hover).text_color(t.foreground))
			.on_click((_e, cx) => {
				cx.stop_propagation();
				// An editor tab with unsaved text asks first (the editor shows the dialog).
				const tab = command === 'pane.close' ? panes().find((p) => p.pane === args?.pane)?.tab : null;
				if (tab && shared('file-editor')?.[tab]?.dirty) return setShared('file-editor.request', { tab, at: Date.now() });
				run(command, args);
			})
			.child(svg(`mods/auto-titles-pane/${icon}.svg`).size(14));
	}

	render(cx) {
		const t = theme();
		const p = this.me();
		if (!p) return div();
		// An editor pane shows its file's name and icon (the Files tab's). The file is the one its tab reports:
		// a split editor has no way to say which file it holds, so it shows the tab's.
		// A Changes diff pane shows what it shows: the file's name and icon, or All changes / the stash / the commit.
		const diff = p.mod === 'git-changes' ? diffOf(p.tab) : null;
		let file = p.mod === 'file-editor' ? shared('file-editor')?.[p.tab]?.path : null;
		if (diff?.area === 'file') file = diff.path;
		const name = file
			? file.split('/').pop()
			: diff
				? diff.area === 'stash'
					? diff.ref
					: diff.area === 'commit'
						? diff.short
						: 'All changes'
				: paneTitle(p, shared('auto-titles.cmd'));
		const pic = file
			? image(`mods/file-changes-colors/icons/${fileAppearance(file).icon}.svg`)
					.w(14)
					.h(14)
					.flex_none()
			: diff
				? svg(`mods/git-changes/icons/${DIFF_ICON[diff.area] ?? 'diff'}.svg`).size(14).flex_none().text_color(t.dim)
				: icon(p.program, 14, t.dim);
		const st = p.status;
		const pane = p.pane;
		return h_flex()
			.id(`pane-head-${pane}`)
			.size_full()
			.px(10)
			.gap(8)
			.items_center()
			.bg(t.background)
			.border_b(1)
			.border_color(t.border)
			.text_size(12)
			.on_hover((hovered, cx) => {
				this.hovered = hovered;
				cx.notify();
			})
			.on_click(() => run('pane.focus', { pane }))
			.when(Boolean(pic), (el) => el.child(pic))
			.child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
			.child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
			.when(st === 'working', (el) =>
				el.child(svg('mods/auto-titles-workspace-chrome/spinner.svg').size(12).flex_none().text_color(t.working).spin(900)),
			)
			.when(st === 'blocked', (el) =>
				el.child(
					div()
						.flex_none()
						.px(6)
						.h(18)
						.flex()
						.items_center()
						.rounded(5)
						.bg(t.blocked + '26')
						.text_size(10.5)
						.font_semibold()
						.text_color(t.blocked)
						.child('Needs you'),
				),
			)
			.when(st === 'done', (el) => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
			.when(this.hovered, (el) =>
				el
					.child(this.button(t, `ph-r-${pane}`, 'split-right', 'pane.split', { direction: 'right', pane }))
					.child(this.button(t, `ph-d-${pane}`, 'split-down', 'pane.split', { direction: 'down', pane }))
					.child(this.button(t, `ph-z-${pane}`, p.zoomed ? 'unzoom' : 'zoom', 'pane.zoom', { pane }))
					.child(this.button(t, `ph-x-${pane}`, 'close', 'pane.close', { pane })),
			);
	}
}
