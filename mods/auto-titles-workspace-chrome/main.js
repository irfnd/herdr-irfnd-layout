import { View, div, image, svg } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { theme, run, props, window, shared, setShared, updates, layout } from 'herdr';

function find(node, id) {
	if (node?.id === id) return node;
	for (const child of node?.children ?? []) {
		const found = find(child, id);
		if (found) return found;
	}
	return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), 'sidebar')?.size?.px ?? Infinity) < 160;

// To the rail, or back to the width it had.
function toggleSidebar() {
	const width = find(layout(), 'sidebar')?.size?.px,
		collapsing = !narrow();
	if (collapsing) setShared('sidebar.width', width);
	// Mods edited before the rail went by width still read the flag.
	setShared('sidebar.collapsed', collapsing);
	if (collapsing) run('layout.select', { stack: 'sidebar-body', child: 'spaces-view' }); // the rail only has the Spaces view
	run(collapsing ? 'layout.hide' : 'layout.show', { id: 'sidebar-switch' });
	run('layout.resize', { id: 'sidebar', px: collapsing ? 44 : (shared('sidebar.width') ?? 268) });
}

export default class WorkspaceChrome extends View {
	button(id, icon, action) {
		// the icon is tinted by hand: an svg doesn't follow its parent's hover colour
		const t = theme(),
			hot = this.hot === id;
		return div()
			.id(id)
			.size(26)
			.flex_none()
			.flex()
			.items_center()
			.justify_center()
			.rounded(8)
			.hover((s) => s.bg(t.hover))
			.cursor_pointer()
			.on_hover((h, cx) => {
				this.hot = h ? id : this.hot === id ? null : this.hot;
				cx.notify();
			})
			.on_click(action)
			.child(
				svg(icon)
					.size(15)
					.text_color(hot ? t.foreground : t.muted),
			);
	}
	render() {
		const t = theme();
		const collapsed = narrow();
		if (props()?.switcher) {
			// the Spaces | Files | Changes tabs at the top of the sidebar
			if (collapsed) return div();
			const active = find(layout(), 'sidebar-body')?.active ?? 'spaces-view';
			const tab = (id, label, icon) => {
				const on = active === id;
				return h_flex()
					.id(`switch-${id}`)
					.h(26)
					.px(6)
					.gap(4)
					.flex_1()
					.min_w(0)
					.justify_center()
					.items_center()
					.rounded(6)
					.text_size(12)
					.cursor_pointer()
					.bg(on ? t.selected : t.chrome)
					.text_color(on ? t.foreground : t.muted)
					.hover((s) => s.bg(on ? t.selected : t.hover))
					.on_click(() => run('layout.select', { stack: 'sidebar-body', child: id }))
					.child(svg(icon).size(13))
					.child(label);
			};
			return h_flex()
				.size_full()
				.bg(t.chrome)
				.px(8)
				.gap(2)
				.items_center()
				.child(tab('spaces-view', 'Spaces', 'mods/auto-titles-workspace-chrome/layers.svg'))
				.child(tab('files-view', 'Files', 'mods/auto-titles-workspace-chrome/files.svg'))
				.child(tab('changes-view', 'Changes', 'mods/auto-titles-workspace-chrome/changes.svg'));
		}
		if (props()?.footer) {
			const row = (id, icon, label, dim, action) => {
				// the icon is tinted by hand: an svg doesn't follow its parent's hover colour
				const hot = this.hot === id;
				return h_flex()
					.id(id)
					.h(28)
					.px(8)
					.gap(9)
					.items_center()
					.w_full()
					.when(!collapsed, (el) => el.justify_end())
					.when(collapsed, (el) => el.px(0).justify_center())
					.rounded(8)
					.text_color(dim ? t.dim : t.muted)
					.hover((s) => s.bg(t.hover).text_color(t.foreground))
					.cursor_pointer()
					.on_hover((h, cx) => {
						this.hot = h ? id : this.hot === id ? null : this.hot;
						cx.notify();
					})
					.on_click(action)
					.child(
						svg(`mods/auto-titles-workspace-chrome/${icon}.svg`)
							.size(14)
							.text_color(hot ? t.foreground : dim ? t.dim : t.muted),
					)
					.when(!collapsed, (el) => el.child(label));
			};
			return v_flex()
				.size_full()
				.bg(t.chrome)
				.border_t(1)
				.border_color(t.border)
				.px(8)
				.pt(4)
				.pb(8)
				.text_size(13)
				.child(
					row('settings', 'settings', 'Settings', false, () => run('app.settings')).when(Boolean(updates().app.ready), (el) =>
						el.child(div().size(6).rounded_full().bg(t.accent)),
					),
				);
		}
		const logo = h_flex()
			.gap(8)
			.items_center()
			.child(image('frame/welcome/herdr.png').size(20).rounded(5))
			.child(div().font_semibold().text_color(t.foreground).child('Herdr'));
		const toggle = this.button('sidebar-toggle', 'mods/auto-titles-workspace-chrome/sidebar.svg', toggleSidebar);
		const search = this.button('search', 'mods/auto-titles-workspace-chrome/search.svg', () =>
			run('mod.open', { name: 'auto-titles-picker' }),
		);
		if (collapsed) return h_flex().size_full().bg(t.chrome).items_center().justify_center().child(toggle);
		// buttons on the left, logo on the right
		return h_flex()
			.size_full()
			.bg(t.chrome)
			.pl(10)
			.pr(14)
			.items_center()
			.justify_between()
			.text_size(13.5)
			.child(h_flex().gap(4).items_center().child(toggle).child(search))
			.child(logo);
	}
}
