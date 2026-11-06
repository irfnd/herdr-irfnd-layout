// The bottom bar: machine, branch with ahead/behind and change counts, agents; on the right,
// the open file's language, size, line endings, encoding and save key (from file-editor),
// else the command palette hint. Cloned from workspace-status.
import { View, div, svg } from 'gpui-kit';
import { h_flex } from 'gpui-base';
import { spaces, panes, agents, theme, run, window, keys, shared, exec } from 'herdr';

// A mod pane (an editor tab) has no folder, and `space.folder` is only where the space was made. So a space
// keeps showing the folder of the last terminal that had focus in it, else of its first terminal.
const lastTerminal = new Map();
const place = (space, pane) => {
	if (space && pane?.cwd) lastTerminal.set(space.id, pane.cwd);
	const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
	return lastTerminal.get(space?.id) ?? panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd;
};

const dirname = (p) => p.replace(/\/[^/]*$/, '') || '/';
const MAC = { cmd: '⌘', ctrl: '⌃', shift: '⇧', alt: '⌥', option: '⌥' };
const CONFLICT = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);

// "## main...origin/main [ahead 1, behind 2]" and one line per changed path.
export function parseStatus(text) {
	const [head = '', ...rest] = text.split('\n').filter(Boolean);
	const ahead = /ahead (\d+)/.exec(head)?.[1],
		behind = /behind (\d+)/.exec(head)?.[1];
	const name = /^## (?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.| \[|$)/.exec(head)?.[1];
	const out = {
		branch: name === 'HEAD (no branch)' ? 'HEAD' : name,
		ahead: Number(ahead ?? 0),
		behind: Number(behind ?? 0),
		modified: 0,
		added: 0,
		deleted: 0,
		staged: 0,
		conflicts: 0,
	};
	for (const l of rest) {
		const xy = l.slice(0, 2);
		if (CONFLICT.has(xy)) out.conflicts++;
		else if (xy === '??') out.added++;
		else {
			if (xy[0] !== ' ') out.staged++;
			if (xy.includes('D')) out.deleted++;
			else if (xy[0] === 'A') out.added++;
			else out.modified++;
		}
	}
	return out;
}

export default class StatusBar extends View {
	init(_p, cx) {
		this.git = null;
		this.at = 0;
		this.nonce = '';
		// Re-read git when the folder changes, when something says it changed, and every few seconds.
		cx.timer.every(1000, (cx) => {
			const { dir, on } = this.where(),
				nonce = `${dir}|${on}|${shared('git.changed')}|${shared('git-graph.changed')}`;
			if (nonce !== this.nonce || Date.now() - this.at > 4000) this.read(cx, nonce, dir, on);
		});
	}

	// The active tab's file project when it is a file-editor tab, else the focused pane's folder.
	where() {
		const space = spaces().find((s) => s.active),
			tab = space?.tabs?.find((t) => t.active);
		const file = (tab && shared('file-editor')?.[tab.id]) || null;
		const pane = panes().find((p) => p.focused && p.tab === tab?.id);
		const home = place(space, pane); // also remembers a focused terminal's folder
		return {
			space,
			file,
			dir: file ? dirname(file.path) : pane?.cwd || home || space?.folder || null,
			on: space?.machine ?? null,
		};
	}

	read(cx, nonce, dir, on) {
		this.nonce = nonce;
		this.at = Date.now();
		if (!dir) {
			this.git = null;
			return cx.notify();
		}
		cx.spawn(async (cx) => {
			const r = await exec(
				'git',
				['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', dir, 'status', '--porcelain=v1', '-b'],
				{ on },
			).catch(() => null);
			if (this.nonce !== nonce) return;
			this.git = r?.code === 0 ? parseStatus(r.stdout) : null;
			cx.notify();
		});
	}

	// A chord as actually bound, in this platform's spelling.
	chord(section, action) {
		const mac = window()?.platform === 'macos',
			all = keys()
				.filter((k) => k.section === section && k.action === action)
				.map((k) => k.keys);
		const k = all.find((x) => (mac ? x.includes('cmd-') : !x.includes('cmd-'))) ?? all[0];
		return k
			? k
					.split('-')
					.map((p) => (mac ? (MAC[p.toLowerCase()] ?? p.toUpperCase()) : p[0].toUpperCase() + p.slice(1)))
					.join(mac ? '' : '+')
			: '';
	}

	hint() {
		const k = this.chord('global', 'app.palette');
		return k ? `${k}  commands` : 'commands';
	}

	render() {
		const t = theme(),
			{ space, file } = this.where(),
			list = agents(),
			needs = list.filter((a) => a.status === 'blocked').length,
			g = this.git;
		const cfg = { statusGit: true, statusCounts: true, statusFormat: true, ...(shared('editor.settings') ?? {}) };
		const label = (icon, text) =>
			h_flex()
				.gap(6)
				.items_center()
				.child(svg(`mods/workspace-chrome/${icon}.svg`).size(13))
				.child(text);
		const count = (n, text, color) => (n ? div().text_color(color).child(`${text}${n}`) : null);
		const sep = () => div().text_color(t.dim).child('·');
		const bar = h_flex()
			.size_full()
			.px(14)
			.gap(16)
			.items_center()
			.bg(t.chrome)
			.border_t(1)
			.border_color(t.border)
			.text_size(11.8)
			.text_color(t.muted)
			.child(label(space?.machine ? 'server' : 'monitor', space?.machine ?? 'This computer'))
			.when(Boolean(g?.branch ?? space?.branch), (el) =>
				el.child(
					h_flex()
						.gap(6)
						.items_center()
						.child(label('branch', g?.branch ?? space.branch))
						.when(g?.ahead > 0, (e) => e.child(div().text_color(t.accent).child(`↑${g.ahead}`)))
						.when(g?.behind > 0, (e) => e.child(div().text_color(t.ansi3).child(`↓${g.behind}`))),
				),
			)
			.when(Boolean(g) && cfg.statusGit && g.modified + g.added + g.deleted + g.conflicts > 0, (el) =>
				el.child(
					h_flex()
						.gap(8)
						.items_center()
						.children(
							[
								count(g.modified, 'M ', t.ansi3),
								count(g.added, 'A ', t.ansi2),
								count(g.deleted, 'D ', t.ansi1),
								count(g.conflicts, '! ', t.blocked),
								count(g.staged, '● ', t.accent),
							].filter(Boolean),
						),
				),
			)
			.child(
				h_flex()
					.gap(6)
					.items_center()
					.child(div().size(6).rounded(3).bg(t.dim))
					.child(`${list.length} agents`)
					.when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))),
			)
			.child(div().flex_1());
		if (file)
			return bar
				.child(
					div()
						.text_color(file.dirty ? t.ansi3 : t.muted)
						.child(file.name + (file.dirty ? ' ●' : file.readonly ? ' · read-only' : '')),
				)
				.child(sep())
				.child(file.language)
				.when(cfg.statusCounts && file.lines !== undefined, (el) =>
					el.child(sep()).child(`${file.lines} lines`).child(`${file.chars} chars`).child(`${file.words} words`),
				)
				.when(cfg.statusFormat && file.eol !== undefined, (el) => el.child(sep()).child(file.eol).child(file.encoding))
				.when(Boolean(this.chord('mod:file-editor', 'file-editor.save')), (el) =>
					el.child(
						div()
							.text_color(t.dim)
							.child(`${this.chord('mod:file-editor', 'file-editor.save')} save`),
					),
				);
		return bar.child(
			div()
				.id('palette')
				.text_color(t.dim)
				.on_click(() => run('app.palette'))
				.child(this.hint()),
		);
	}
}
