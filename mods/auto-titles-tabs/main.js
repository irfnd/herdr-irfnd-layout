import { tabTitle, titleSnapshot } from './titles.js';
import { fileAppearance } from './appearance.js';
// A Changes diff tab: what it shows (a file, all changes, a stash or a commit). The panel records the tab's id
// in shared "git-changes.view", one entry per space.
const diffOf = (tab) => Object.values(shared('git-changes.view') ?? {}).find((e) => e.tab === tab)?.item ?? null;
const DIFF_ICON = { all: 'diff', stash: 'stash', commit: 'commit' };
import { View, div, svg, image } from 'gpui-kit';
import { h_flex } from 'gpui-base';
import {
	spaces,
	panes,
	run,
	openOverlay,
	theme,
	window,
	shared,
	setShared,
	terminals,
	layout,
	settings,
	exec,
	hc,
	focused,
	notify,
	nextCommand,
} from 'herdr';

// Key command "zed" (keys.json: "cmd-o": "auto-titles-tabs.zed"): open the focused terminal's folder in Zed.
// The `zed` CLI is optional on macOS and is `zeditor` on some Linux distros.
async function openInZed(folder) {
	const tries = [
		['zed', [folder]],
		['zeditor', [folder]],
	];
	if (window()?.platform === 'macos') tries.push(['open', ['-a', 'Zed', folder]]);
	for (const [command, args] of tries) {
		try {
			if ((await exec(command, args)).code === 0) return true;
		} catch {}
	}
	return false;
}

// The folder of the terminal that has the keyboard (the app's own notion of focus, which also covers peeks and
// terminal blocks), else the focused pane's; null in a space on another machine, where a local Zed can't open it.
function focusedFolder() {
	const f = focused(),
		pane = panes().find((p) => p.focused);
	const space = spaces().find((s) => s.id === (f?.space ?? pane?.space)) ?? spaces().find((s) => s.active);
	return space?.machine ? null : (f?.cwd ?? pane?.cwd ?? null);
}

function find(node, id) {
	if (node?.id === id) return node;
	for (const child of node?.children ?? []) {
		const found = find(child, id);
		if (found) return found;
	}
	return null;
}

// The last command typed in each shell/runtime pane (a terminal with no agent): every 3 s its recent terminal text is
// read (`hc read`) and the text after the last prompt character (❯ ➜ › » $ % # >) is kept, cut to 3 words plus "..." when
// longer. Shown as "<program> \u2022 <command>" by titles.js. Kept in shared state "auto-titles.cmd": { [terminal]: command }.
// ponytail: prompt-character heuristic, no shell integration; a prompt without one of those characters shows no command.
const CMD_EVERY = 3000,
	CMD_LINES = 200; // history above the screen, so a TUI/server's launch command is still found
function lastCommand(text) {
	const lines = text.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const m = /^\s*[\u276f\u279c\u203a\u00bb$%#>]\s+(\S.*?)\s*$/.exec(lines[i]);
		if (!m) continue;
		const words = m[1].split(/\s+/);
		return words.length > 3 ? `${words.slice(0, 3).join(' ')}...` : m[1];
	}
	return null;
}

export default class Tabs extends View {
	init(_props, cx) {
		// Key commands (keys.json: "cmd-o": "auto-titles-tabs.zed", "...files" / "...changes").
		cx.spawn(async (cx) => {
			for (;;) {
				const c = await nextCommand();
				try {
					// one failing command must not end the loop: every later key would go nowhere
					if (c === 'zed') {
						const dir = focusedFolder();
						if (!dir) notify({ title: 'Open with Zed', body: 'No local folder in focus.', level: 'warning', timeout: 3000 });
						else if (!(await openInZed(dir)))
							notify({ title: "Couldn't open Zed", body: `Is the zed CLI or Zed.app installed? Folder: ${dir}`, level: 'error' });
					} else {
						this.togglePanel(c);
						cx.notify();
					}
				} catch (e) {
					notify({ title: 'Key command failed', body: `${c}: ${e?.message ?? e}`, level: 'error' });
				}
			}
		});
		this.cmdBusy = false;
		cx.timer.every(CMD_EVERY, (cx) => this.cmdTick(cx));
		this.pressed = null;
		this.panels = JSON.parse(localStorage.getItem('panels') ?? '{}');
	}

	cmdTick(cx) {
		if (this.cmdBusy) return;
		const targets = [],
			live = new Set();
		const remote = new Set(
			spaces()
				.filter((s) => s.machine)
				.flatMap((s) => (s.tabs ?? []).map((t) => t.id)),
		); // no local `hc read` for other machines
		for (const p of panes()) {
			if (!p.terminal) continue;
			live.add(p.terminal);
			if (!p.program?.agent && !remote.has(p.tab)) targets.push(p.terminal);
		}
		this.cmdBusy = true;
		cx.spawn(async (cx) => {
			try {
				const cmds = { ...(shared('auto-titles.cmd') ?? {}) };
				let changed = false;
				for (const id of Object.keys(cmds))
					if (!live.has(id)) {
						delete cmds[id];
						changed = true;
					}
				for (const id of targets) {
					const r = await hc(['read', id, '--lines', String(CMD_LINES)]).catch(() => null);
					const cmd = r?.code === 0 ? lastCommand(r.stdout) : null;
					if (cmd && cmds[id] !== cmd) {
						cmds[id] = cmd;
						changed = true;
					}
				}
				if (changed) setShared('auto-titles.cmd', cmds);
			} finally {
				this.cmdBusy = false;
				cx.notify();
			}
		});
	}

	// Opens a side panel as its button does: switch to it, or close the panel when it's already showing.
	togglePanel(id) {
		// keys: auto-titles-tabs.spaces / .files / .changes select that sidebar tab
		const view = { spaces: 'spaces-view', files: 'files-view', changes: 'changes-view' }[id];
		if (!view) return;
		if ((find(layout(), 'sidebar')?.size?.px ?? Infinity) < 160) {
			// a collapsed sidebar unfolds to show it
			run('layout.show', { id: 'sidebar-switch' });
			run('layout.resize', { id: 'sidebar', px: shared('sidebar.width') ?? 268 });
			setShared('sidebar.collapsed', false);
		}
		run('layout.select', { stack: 'sidebar-body', child: view });
	}

	// The side panel is remembered per space: switching shows that space's choice
	// (closed if it never had one), and opening or closing it records it.
	syncPanel(space, panel, body, enabled) {
		if (!space || !panel) return;
		const now = panel.hidden ? null : (body?.active ?? null);
		if (space.id !== this.space) {
			const first = this.space === undefined;
			this.space = space.id;
			this.pending = null;
			if (!(first && !(space.id in this.panels))) {
				const stored = this.panels[space.id] ?? null,
					want = enabled.includes(stored) ? stored : null;
				if (want !== now) {
					this.pending = { want, until: Date.now() + 1000 };
					if (want) {
						run('layout.select', { stack: 'panel-body', child: want });
						run('layout.show', { id: 'panel' });
					} else run('layout.hide', { id: 'panel' });
					return;
				}
			}
		}
		// Until the restore lands (or something else won), the old state isn't a choice.
		if (this.pending) {
			if (this.pending.want !== now && Date.now() < this.pending.until) return;
			this.pending = null;
		}
		if (this.panels[space.id] === now) return;
		this.panels[space.id] = now;
		localStorage.setItem('panels', JSON.stringify(this.panels));
	}

	render() {
		const t = theme();
		const snapshot = titleSnapshot(spaces(), panes(), terminals(), shared('auto-titles.cmd'));
		if (
			shared('auto-titles.snapshot')?.layout !== shared('layout') ||
			JSON.stringify(shared('auto-titles.snapshot')?.data) !== JSON.stringify(snapshot)
		)
			setShared('auto-titles.snapshot', { updated_at: new Date().toISOString(), layout: shared('layout'), data: snapshot });

		const space = spaces().find((p) => p.active);
		const shown = space?.tabs ?? [];
		const stop = (_e, cx) => cx.stop_propagation();
		const button = (id, label, action) =>
			div()
				.id(id)
				.size(26)
				.flex_none()
				.flex()
				.items_center()
				.justify_center()
				.rounded(6)
				.text_color(t.dim)
				.hover((s) => s.bg(t.hover).text_color(t.foreground))
				.on_mouse_down('left', stop)
				.on_click(action)
				.child(label);
		const item = (c, i) => {
			const program =
				panes().find((p) => p.tab === c.id && p.program?.agent)?.program ?? panes().find((p) => p.tab === c.id)?.program;
			const name = tabTitle(c, panes(), shared('auto-titles.cmd'));
			// An editor tab shows its file's icon, the one the Files tab uses. (A stale entry of a tab that
			// is no longer an editor must not count, so the tab has to hold a file-editor pane.)
			let file = panes().some((p) => p.tab === c.id && p.mod === 'file-editor') ? shared('file-editor')?.[c.id]?.path : null;
			// A Changes diff tab looks the same: its file's icon, or a git icon for all changes, a stash, a commit.
			const diff = panes().some((p) => p.tab === c.id && p.mod === 'git-changes') ? diffOf(c.id) : null;
			if (diff?.area === 'file') file = diff.path;
			const git = diff && diff.area !== 'file' ? DIFF_ICON[diff.area] : null;
			return h_flex()
				.id(`tab-${c.id}`)
				.h(29)
				.px(10)
				.gap(7)
				.rounded(7)
				.items_center()
				.flex_none()
				.text_size(12.8)
				.border(1)
				.border_color(c.active ? t.border : t.chrome)
				.bg(c.active ? t.raised : t.chrome)
				.text_color(c.active ? t.foreground : t.muted)
				.hover((s) => s.bg(t.hover))
				.on_mouse_down('left', (e, cx) => {
					cx.stop_propagation();
					this.pressed = i;
					if (e.click_count === 2) run('tab.rename', { id: c.id });
				})
				.on_mouse_up('left', () => {
					const from = this.pressed;
					this.pressed = null;
					if (from !== null && from !== i)
						run('tab.move', { id: shown[from].id, index: space.tabs.findIndex((x) => x.id === c.id) + 1 });
					else run('tab.select', { id: c.id });
				})
				.on_mouse_down('right', () =>
					openOverlay({
						mod: 'auto-titles-menu',
						kind: 'popup',
						width: 200,
						props: { tab: 'tab', target: { id: c.id, space: space.id } },
					}),
				)
				.when(Boolean(file), (el) =>
					el.child(
						image(`mods/file-changes-colors/icons/${fileAppearance(file).icon}.svg`)
							.size(14)
							.flex_none(),
					),
				)
				.when(Boolean(git), (el) => el.child(svg(`mods/git-changes/icons/${git}.svg`).size(14).flex_none().text_color(t.muted)))
				.when(!file && !git && Boolean(program?.icon), (el) =>
					el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)),
				)
				.child(
					div()
						.max_w(170)
						.truncate()
						.child(c.zoomed ? `${name} Z` : name),
				)
				.when(c.status === 'working', (el) =>
					el.child(svg('mods/auto-titles-workspace-chrome/spinner.svg').size(12).flex_none().text_color(t.working).spin(900)),
				)
				.when(c.status === 'blocked' || c.status === 'done', (el) => el.child(div().size(6).rounded(3).bg(t[c.status])))
				.when(c.active, (el) =>
					el.child(
						div()
							.id(`close-${c.id}`)
							.text_color(t.dim)
							.on_mouse_down('left', stop)
							.on_click((_e, cx) => {
								cx.stop_propagation();
								// An editor tab with unsaved text asks first (the editor shows the dialog).
								if (shared('file-editor')?.[c.id]?.dirty) return setShared('file-editor.request', { tab: c.id, at: Date.now() });
								run('tab.close', { id: c.id });
							})
							.child(svg('mods/auto-titles-pane/close.svg').size(12)),
					),
				);
		};
		const root = layout(),
			sidebar = find(root, 'sidebar'),
			w = window();
		// The sidebar is on the right, so the tab bar always starts under the window buttons.
		const lightsPadding =
			w?.platform === 'macos' && w.titlebar === 'none' && !w.fullscreen && root?.traffic_lights
				? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom)
				: 10;
		const panel = find(root, 'panel'),
			body = find(root, 'panel-body');
		const enabled = [...(shared('workspace.panels') ?? ['files', 'changes']).filter((x) => x !== 'files')]; // Files moved into the sidebar
		this.syncPanel(space, panel, body, enabled);
		return h_flex()
			.size_full()
			.min_w(0)
			.px(10)
			.pl(lightsPadding)
			.gap(3)
			.items_center()
			.bg(t.chrome)
			.border_b(1)
			.border_color(t.border)
			.on_mouse_up('left', () => {
				this.pressed = null;
			})
			.on_scroll_wheel((e) => {
				if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? 'tab.prev' : 'tab.next');
			})
			.child(div().w(8).flex_none()) // a little air between the panel buttons and the tabs
			.child(
				h_flex()
					.id('tab-scroll')
					.flex_1()
					.min_w(0)
					.h_full()
					.items_center()
					.gap(3)
					.overflow_x_scrollbar()
					.children(shown.map(item)),
			)
			.child(button('tab-new', '+', () => openOverlay({ mod: 'auto-titles-new-menu', kind: 'popup', width: 250, height: 543 })))
			.when(window()?.buttons, (el) =>
				el
					.child(button('minimize', '−', () => run('window.minimize')))
					.child(button('maximize', '□', () => run('window.maximize')))
					.child(button('close-window', svg('mods/auto-titles-pane/close.svg').size(13), () => run('window.close'))),
			);
	}
}
