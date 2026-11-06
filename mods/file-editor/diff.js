// Line diff (HEAD -> buffer) and blame (git blame --porcelain), and their views.
// The LCS diff is adapted from Agentee's abdh-editor (Apache-2.0, see NOTICE).
import { div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { exec } from 'herdr';

export const base = (p) => p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? p;
export const dirname = (p) => p.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
const CAP = 2000; // rows drawn; a longer view says so

function lineDiff(a, b) {
	const n = a.length,
		m = b.length;
	if (n * m > 4000000) return { tooLarge: true };
	const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
	for (let i = n - 1; i >= 0; i--)
		for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
	const ops = [];
	let i = 0,
		j = 0,
		oldNo = 1,
		newNo = 1,
		added = 0,
		removed = 0;
	const push = (sign, text) => {
		ops.push([sign, text, sign === '+' ? null : oldNo++, sign === '-' ? null : newNo++]);
		if (sign === '+') added++;
		else if (sign === '-') removed++;
	};
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			push(' ', a[i++]);
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) push('-', a[i++]);
		else push('+', b[j++]);
	}
	while (i < n) push('-', a[i++]);
	while (j < m) push('+', b[j++]);
	// Three lines of context around each change, "…" for the gaps.
	const keep = new Set();
	ops.forEach((op, k) => {
		if (op[0] !== ' ') for (let x = Math.max(0, k - 3); x <= Math.min(ops.length - 1, k + 3); x++) keep.add(x);
	});
	const lines = [];
	let gap = false;
	ops.forEach((op, k) => {
		if (keep.has(k)) {
			gap = false;
			lines.push(op);
		} else if (!gap) {
			gap = true;
			lines.push(['…', '', null, null]);
		}
	});
	return { lines, added, removed };
}

// HEAD's version of `file` against `text`. Resolves to a diff, or { error }.
export async function loadDiff(file, text) {
	const dir = dirname(file);
	const top = await exec('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
	if (top.code !== 0) return { error: 'Not a git repository' };
	const head = await exec('git', ['-C', dir, 'show', `HEAD:./${base(file)}`]);
	const before = head.code === 0 ? head.stdout.replace(/\r\n/g, '\n') : '';
	const lines = (x) => (x ? x.replace(/\n$/, '').split('\n') : []);
	return lineDiff(lines(before), lines(text.replace(/\r\n/g, '\n')));
}

// Every line's commit, author and date. Resolves to rows, or { error }.
export async function loadBlame(file) {
	const r = await exec('git', ['-C', dirname(file), 'blame', '--porcelain', '--', base(file)]);
	if (r.code !== 0) return { error: r.stderr.trim().split('\n')[0] || 'Not a git repository' };
	const info = {},
		rows = [];
	let cur = null;
	for (const line of r.stdout.split('\n')) {
		if (line.startsWith('\t')) {
			rows.push({ ...info[cur.hash], hash: cur.hash, no: cur.no, text: line.slice(1) });
			continue;
		}
		const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
		if (head) {
			cur = { hash: head[1], no: Number(head[2]) };
			info[cur.hash] ??= {};
		} else if (cur) {
			const [k, ...v] = line.split(' ');
			if (k === 'author' || k === 'summary') info[cur.hash][k] = v.join(' ');
			else if (k === 'author-time') info[cur.hash].time = Number(v[0]);
		}
	}
	return { rows };
}

const ago = (s) => {
	const d = Date.now() / 1000 - s;
	for (const [n, u] of [
		[31536000, 'y'],
		[2592000, 'mo'],
		[86400, 'd'],
		[3600, 'h'],
		[60, 'm'],
	])
		if (d >= n) return `${Math.floor(d / n)}${u} ago`;
	return 'now';
};

const bar = (t, ...children) =>
	h_flex()
		.h(24)
		.flex_none()
		.px(10)
		.gap(10)
		.items_center()
		.bg(t.chrome)
		.border_b(1)
		.border_color(t.border)
		.text_size(11)
		.children(children);
const note = (t, text, color) =>
	div()
		.p(12)
		.text_color(color ?? t.dim)
		.child(text);

export function diffView(t, d) {
	if (!d) return note(t, 'Comparing with HEAD…');
	if (d.error) return note(t, d.error, t.blocked);
	if (d.tooLarge) return note(t, 'This file is too large to diff here.');
	const sign = (s) => (s === '+' ? t.done : s === '-' ? t.blocked : t.dim);
	const gutter = (n) =>
		div()
			.w(34)
			.flex_none()
			.text_size(9.5)
			.text_color(t.dim)
			.child(n == null ? '' : String(n));
	return v_flex()
		.size_full()
		.min_h(0)
		.text_size(11.5)
		.child(
			bar(
				t,
				div().text_color(t.muted).child('HEAD → buffer'),
				div().flex_1(),
				...(d.added ? [div().text_color(t.done).child(`+${d.added}`)] : []),
				...(d.removed ? [div().text_color(t.blocked).child(`−${d.removed}`)] : []),
			),
		)
		.child(
			d.lines.length === 0
				? note(t, 'No changes against HEAD.')
				: div()
						.id('diff-rows')
						.flex_1()
						.min_h(0)
						.overflow_y_scrollbar()
						.children(
							d.lines.slice(0, CAP).map(([s, text, o, n], i) =>
								h_flex()
									.id(`df-${i}`)
									.h(18)
									.px(6)
									.gap(4)
									.items_center()
									.when(s === '+', (el) => el.bg(t.done + '1f'))
									.when(s === '-', (el) => el.bg(t.blocked + '1f'))
									.child(gutter(o))
									.child(gutter(n))
									.child(div().w(10).flex_none().text_size(10).text_color(sign(s)).child(s))
									.child(
										div()
											.flex_1()
											.min_w(0)
											.truncate()
											.text_color(s === ' ' ? t.muted : t.foreground)
											.child(text || ' '),
									),
							),
						)
						.when(d.lines.length > CAP, (el) => el.child(note(t, `Showing the first ${CAP} rows`))),
		);
}

export function blameView(t, d) {
	if (!d) return note(t, 'Reading blame…');
	if (d.error) return note(t, d.error, t.blocked);
	return v_flex()
		.size_full()
		.min_h(0)
		.text_size(11.5)
		.child(bar(t, div().text_color(t.muted).child('Blame'), div().text_color(t.dim).child(`${d.rows.length} lines`)))
		.child(
			div()
				.id('blame-rows')
				.flex_1()
				.min_h(0)
				.overflow_y_scrollbar()
				.children(
					d.rows.slice(0, CAP).map((r, i) => {
						const fresh = /^0+$/.test(r.hash);
						return h_flex()
							.id(`bl-${i}`)
							.h(18)
							.px(6)
							.gap(8)
							.items_center()
							.tooltip(fresh ? 'Not committed yet' : (r.summary ?? ''))
							.child(div().w(34).flex_none().text_size(9.5).text_color(t.dim).child(String(r.no)))
							.child(
								div()
									.w(54)
									.flex_none()
									.text_color(fresh ? t.ansi3 : t.accent)
									.child(fresh ? 'new' : r.hash.slice(0, 7)),
							)
							.child(
								div()
									.w(110)
									.flex_none()
									.truncate()
									.text_color(t.muted)
									.child(fresh ? 'You' : (r.author ?? '')),
							)
							.child(
								div()
									.w(64)
									.flex_none()
									.text_color(t.dim)
									.child(fresh || !r.time ? '' : ago(r.time)),
							)
							.child(
								div()
									.flex_1()
									.min_w(0)
									.truncate()
									.text_color(t.foreground)
									.child(r.text || ' '),
							);
					}),
				)
				.when(d.rows.length > CAP, (el) => el.child(note(t, `Showing the first ${CAP} lines`))),
		);
}
