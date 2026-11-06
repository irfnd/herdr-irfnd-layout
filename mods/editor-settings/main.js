// Editor, Explorer and Status bar settings in one dialog. They live in shared("editor.settings")
// (kept by Herdr between runs); file-editor, the Files tab and the status bar read them with
// their own defaults, so a key that was never set means the default shown here.
import { View, div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { props, closeOverlay, shared, setShared, theme } from 'herdr';

const DEFAULTS = {
	wrap: true,
	fontSize: 13,
	lineNumbers: true,
	folding: true,
	formatOnSave: true,
	lintOnSave: true,
	hidden: true,
	contentSearch: true,
	statusGit: true,
	statusCounts: true,
	statusFormat: true,
};
const SECTIONS = [
	[
		'Editor',
		[
			['wrap', 'Wrap long lines'],
			['fontSize', 'Font size', [10, 20]],
			['lineNumbers', 'Line numbers'],
			['folding', 'Code folding'],
			['formatOnSave', 'Format on save (project formatter)'],
			['lintOnSave', 'Check for problems'],
		],
	],
	[
		'Explorer',
		[
			['hidden', 'Show hidden files'],
			['contentSearch', 'Search file contents'],
		],
	],
	[
		'Status bar',
		[
			['statusGit', 'Git changes'],
			['statusCounts', 'Lines, characters, words'],
			['statusFormat', 'Line endings and encoding'],
		],
	],
];

const get = (k) => (shared('editor.settings') ?? {})[k] ?? DEFAULTS[k];
const set = (k, v) => setShared('editor.settings', { ...(shared('editor.settings') ?? {}), [k]: v });

export default class EditorSettings extends View {
	init(_p, cx) {
		this.handle = cx.focus_handle();
		this.handle.focus();
	}

	render() {
		const t = theme();
		const toggle = (k) =>
			div()
				.id(`set-${k}`)
				.w(34)
				.h(18)
				.flex_none()
				.rounded_full()
				.cursor_pointer()
				.bg(get(k) ? t.accent : t.input)
				.on_click(() => set(k, !get(k)))
				.child(
					div()
						.absolute()
						.top(2)
						.left(get(k) ? 18 : 2)
						.size(14)
						.rounded_full()
						.bg(get(k) ? t.solid_foreground : t.muted),
				);
		const step = (k, [lo, hi]) => {
			const b = (id, text, by) =>
				div()
					.id(`set-${k}-${id}`)
					.size(22)
					.flex()
					.items_center()
					.justify_center()
					.rounded(6)
					.cursor_pointer()
					.bg(t.raised)
					.hover((s) => s.bg(t.hover))
					.on_click(() => set(k, Math.min(hi, Math.max(lo, get(k) + by))))
					.child(text);
			return h_flex()
				.gap(8)
				.items_center()
				.child(b('dec', '−', -1))
				.child(
					div()
						.w(22)
						.text_center()
						.child(String(get(k))),
				)
				.child(b('inc', '+', 1));
		};
		return v_flex()
			.id('editor-settings')
			.track_focus(this.handle)
			.on_key_down((e, cx) => {
				if (e.key !== 'escape') return;
				closeOverlay(props().overlay);
				cx.stop_propagation();
			})
			.w_full()
			.min_h(0)
			.p(18)
			.gap(14)
			.bg(t.popover)
			.text_color(t.foreground)
			.text_size(12.8)
			.child(
				h_flex()
					.items_center()
					.child(div().flex_1().text_size(15).font_semibold().child('Editor settings'))
					.child(div().text_size(11).text_color(t.dim).child('Esc')),
			)
			.children(
				SECTIONS.map(([title, rows]) =>
					v_flex()
						.gap(2)
						.child(div().pb(4).text_size(11).text_color(t.dim).child(title))
						.children(
							rows.map(([k, label, range]) =>
								h_flex()
									.h(32)
									.items_center()
									.justify_between()
									.child(div().child(label))
									.child(range ? step(k, range) : toggle(k)),
							),
						),
				),
			)
			.child(
				h_flex()
					.justify_end()
					.child(
						div()
							.id('set-reset')
							.h(28)
							.px(12)
							.flex()
							.items_center()
							.rounded(7)
							.cursor_pointer()
							.text_size(12)
							.text_color(t.muted)
							.bg(t.raised)
							.hover((s) => s.bg(t.hover).text_color(t.foreground))
							.on_click(() => setShared('editor.settings', null))
							.child('Reset to defaults'),
					),
			);
	}
}
