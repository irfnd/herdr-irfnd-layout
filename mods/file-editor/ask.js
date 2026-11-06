// A floating confirmation dialog of this mod, opened by an editor tab with props
// { view: "ask", owner, title, body?, buttons: [{ id, label, primary?, danger? }] }.
// The choice goes back as shared "file-editor.answer" { owner, id, at }; Esc, or any other way
// out, answers "cancel". Enter picks the primary button.
import { div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { props, closeOverlay, setShared, theme } from 'herdr';

export class Ask {
	init(cx) {
		this.p = props();
		this.sent = false;
		this.handle = cx.focus_handle();
		this.handle.focus();
		cx.timer.after(300, () => this.handle.focus());
	}

	answer(id) {
		if (this.sent) return;
		this.sent = true;
		setShared('file-editor.answer', { owner: this.p.owner, id, at: Date.now() });
		closeOverlay(this.p.overlay);
	}

	// Called once when the dialog goes, however it went.
	async close() {
		if (!this.sent) {
			this.sent = true;
			setShared('file-editor.answer', { owner: this.p?.owner, id: 'cancel', at: Date.now() });
		}
	}

	render() {
		const t = theme(),
			p = props() ?? this.p,
			buttons = p.buttons ?? [];
		const button = (b) =>
			div()
				.id(`ask-${b.id}`)
				.h(32)
				.px(14)
				.flex()
				.items_center()
				.rounded(8)
				.border_1()
				.border_color(b.primary ? t.solid : b.danger ? t.blocked : t.input)
				.bg(b.primary ? t.solid : t.raised)
				.text_color(b.primary ? t.solid_foreground : b.danger ? t.blocked : t.foreground)
				.text_size(12.5)
				.font_medium()
				.cursor_pointer()
				.hover((s) => s.opacity(0.88))
				.on_click(() => this.answer(b.id))
				.child(b.label);
		return v_flex()
			.id('ask')
			.track_focus(this.handle)
			.on_key_down((e, cx) => {
				if (e.key === 'enter') {
					const primary = buttons.find((b) => b.primary);
					if (primary) this.answer(primary.id);
				} else if (e.key === 'escape') closeOverlay(p.overlay);
				else return;
				cx.stop_propagation();
			})
			.w_full()
			.min_h(0)
			.p(18)
			.gap(10)
			.bg(t.popover)
			.text_color(t.foreground)
			.text_size(12.8)
			.child(
				h_flex()
					.items_center()
					.child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(p.title))
					.child(div().text_size(11).text_color(t.dim).child('Esc')),
			)
			.when(Boolean(p.body), (el) => el.child(div().text_color(t.muted).child(p.body)))
			.child(h_flex().pt(10).gap(8).justify_end().children(buttons.map(button)));
	}
}
