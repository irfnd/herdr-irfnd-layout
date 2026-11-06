// Merge conflicts in a file: find the <<<<<<< / ||||||| / ======= / >>>>>>> blocks, pick a side for each,
// and the view that lists them. Text in, text out: the editor decides what to do with the result.
import { div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { settings } from 'herdr';

const MARK = {
	open: /^<{7}(?: (.*))?$/,
	base: /^\|{7}(?: (.*))?$/,
	split: /^={7}$/,
	close: /^>{7}(?: (.*))?$/,
};

// [{ start, end (indexes of the first and last marker line), current, incoming, base, from, to (labels) }].
// A block that never closes is just text.
export function parseConflicts(text) {
	const lines = text.split('\n'),
		out = [];
	let at = null;
	lines.forEach((raw, i) => {
		const line = raw.replace(/\r$/, '');
		let m;
		if ((m = MARK.open.exec(line)))
			at = { start: i, part: 'current', current: [], base: null, incoming: [], from: m[1] ?? '', to: '' };
		else if (!at) return;
		else if (MARK.base.test(line) && at.part === 'current') ((at.part = 'base'), (at.base = []));
		else if (MARK.split.test(line) && at.part !== 'incoming') at.part = 'incoming';
		else if ((m = MARK.close.exec(line)) && at.part === 'incoming') {
			out.push({ ...at, end: i, to: m[1] ?? '' });
			at = null;
		} else at[at.part].push(raw);
	});
	return out;
}

const pick = { current: (b) => b.current, incoming: (b) => b.incoming, both: (b) => [...b.current, ...b.incoming] };

// The text with block `index` (or every block, when `index` is null) replaced by the chosen side.
export function resolve(text, choice, index = null) {
	const blocks = parseConflicts(text),
		lines = text.split('\n');
	for (const [n, b] of [...blocks.entries()].reverse())
		if (index === null || index === n) lines.splice(b.start, b.end - b.start + 1, ...pick[choice](b));
	return lines.join('\n');
}

const SHOWN = 30; // lines drawn per side; a longer side says so

export function conflictsView(t, text, actions) {
	const blocks = parseConflicts(text);
	const mono = settings().font_family ?? 'JetBrains Mono';
	const button = (id, label, color, fn) =>
		div()
			.id(id)
			.h(22)
			.px(8)
			.flex()
			.items_center()
			.rounded(4)
			.cursor_pointer()
			.text_size(11)
			.text_color(color)
			.hover((s) => s.bg(t.hover))
			.on_click((_e, cx) => fn(cx))
			.child(label);
	const side = (title, lines, tint) =>
		v_flex()
			.flex_1()
			.min_w(0)
			.child(div().h(22).px(8).flex().items_center().text_size(10.5).text_color(t.dim).truncate().child(title))
			.child(
				v_flex()
					.px(8)
					.py(4)
					.bg(tint + '1a')
					.font_family(mono)
					.text_size(11.5)
					.children(
						(lines.length ? lines.slice(0, SHOWN) : ['(empty)']).map((l, i) =>
							div()
								.id(`${title}-${i}`)
								.truncate()
								.text_color(lines.length ? t.foreground : t.dim)
								.child(l.replace(/\r$/, '') || ' '),
						),
					)
					.when(lines.length > SHOWN, (el) =>
						el.child(
							div()
								.text_color(t.dim)
								.child(`… ${lines.length - SHOWN} more lines`),
						),
					),
			);
	const card = (b, n) =>
		v_flex()
			.id(`conflict-${n}`)
			.mx(10)
			.mb(8)
			.rounded(6)
			.border(1)
			.border_color(t.border)
			.child(
				h_flex()
					.h(28)
					.px(8)
					.gap(2)
					.items_center()
					.bg(t.chrome)
					.child(
						div()
							.flex_1()
							.text_size(11.5)
							.text_color(t.muted)
							.child(`Conflict ${n + 1} of ${blocks.length} · line ${b.start + 1}`),
					)
					.child(button(`cf-cur-${n}`, 'Accept Current', t.done, (cx) => actions.resolve('current', n, cx)))
					.child(button(`cf-inc-${n}`, 'Accept Incoming', t.accent, (cx) => actions.resolve('incoming', n, cx)))
					.child(button(`cf-both-${n}`, 'Accept Both', t.foreground, (cx) => actions.resolve('both', n, cx))),
			)
			.child(
				h_flex()
					.child(side(`Current${b.from ? ` · ${b.from}` : ''}`, b.current, t.done))
					.child(div().w(1).bg(t.border))
					.child(side(`Incoming${b.to ? ` · ${b.to}` : ''}`, b.incoming, t.accent)),
			);
	return v_flex()
		.size_full()
		.min_h(0)
		.text_size(12)
		.child(
			h_flex()
				.h(32)
				.flex_none()
				.px(10)
				.gap(2)
				.items_center()
				.border_b(1)
				.border_color(t.border)
				.child(
					div()
						.flex_1()
						.text_color(blocks.length ? t.blocked : t.done)
						.child(blocks.length ? `${blocks.length} conflict${blocks.length === 1 ? '' : 's'}` : 'No conflicts left'),
				)
				.when(blocks.length > 0, (el) =>
					el
						.child(button('cf-all-cur', 'All Current', t.done, (cx) => actions.resolve('current', null, cx)))
						.child(button('cf-all-inc', 'All Incoming', t.accent, (cx) => actions.resolve('incoming', null, cx))),
				)
				.when(blocks.length === 0 && Boolean(actions.stage), (el) =>
					el.child(button('cf-stage', 'Save and mark resolved', t.accent, (cx) => actions.stage(cx))),
				),
		)
		.child(div().id('conflict-rows').flex_1().min_h(0).overflow_y_scrollbar().pt(8).children(blocks.slice(0, 100).map(card)));
}
