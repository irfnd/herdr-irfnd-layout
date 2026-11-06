// A one-line name dialog (new branch, rename). Opened as a dialog of this mod with props
// { role: 'prompt', owner, title, value?, placeholder?, submit }. Enter posts the text to
// the panel that opened it (shared "git-changes.pick", id "prompt"); the git work runs there.
import { div } from 'gpui-kit';
import { v_flex, h_flex, InputState, Input } from 'gpui-base';
import { props, closeOverlay, setShared, theme } from 'herdr';

export class Prompt {
	init(cx) {
		const p = props();
		this.text = p.value ?? '';
		this.input = InputState.new({ value: this.text, placeholder: p.placeholder ?? 'name' });
		if (this.text) this.input.set_selected_range({ start: 0, end: this.text.length });
		this.input.on('change', (_e, cx) => {
			this.text = this.input.value();
			cx.notify();
		});
		this.input.on('submit', () => this.send());
		this.input.focus();
		cx.timer.after(600, () => this.input.focus());
		this.handle = cx.focus_handle();
	}

	send() {
		const name = this.text.trim(),
			{ overlay, owner } = props();
		if (!name) return;
		setShared('git-changes.pick', { owner, id: 'prompt', value: name, at: Date.now() });
		closeOverlay(overlay);
	}

	render() {
		const t = theme(),
			p = props(),
			ok = Boolean(this.text.trim());
		const button = (id, text, primary, action) =>
			h_flex()
				.id(id)
				.h(32)
				.px(14)
				.items_center()
				.rounded(8)
				.border_1()
				.border_color(primary ? t.solid : t.input)
				.bg(primary ? t.solid : t.raised)
				.text_color(primary ? t.solid_foreground : t.foreground)
				.text_size(12.5)
				.font_medium()
				.when(primary && !ok, (el) => el.opacity(0.5))
				.when(!primary || ok, (el) =>
					el
						.cursor_pointer()
						.hover((s) => s.opacity(0.88))
						.on_click(action),
				)
				.child(text);
		return v_flex()
			.id('git-changes-prompt')
			.track_focus(this.handle)
			.on_key_down((e, cx) => {
				if (e.key !== 'escape') return;
				closeOverlay(p.overlay);
				cx.stop_propagation();
			})
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
					.child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(p.title))
					.child(div().text_size(11).text_color(t.dim).child('Esc')),
			)
			.child(
				Input.new(this.input)
					.h(36)
					.px(10)
					.rounded(9)
					.border_1()
					.border_color(t.accent)
					.bg(t.background)
					.text_size(12.8)
					.text_color(t.foreground),
			)
			.child(
				h_flex()
					.pt(6)
					.gap(8)
					.justify_end()
					.child(button('pr-cancel', 'Cancel', false, () => closeOverlay(p.overlay)))
					.child(button('pr-ok', p.submit ?? 'OK', true, () => this.send())),
			);
	}
}
