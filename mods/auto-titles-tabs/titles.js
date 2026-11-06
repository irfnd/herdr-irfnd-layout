// Kept local to each mod so a cloned mod remains self-contained. The copies
// are checked by the title tests; title policy belongs to mods, not the model.
export function cleanTitle(value) {
	return String(value ?? '')
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
		.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
		.replace(/^[\s\u2800-\u28ff✳✻✽✶✢✦●○◐◓◑◒]+/u, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function folder(cwd) {
	const path = (cwd ?? '').replace(/[\\/]+$/, '');
	return path.split(/[\\/]/).pop() || (cwd ? '/' : '');
}

export function taskTitle(p) {
	const title = cleanTitle(p?.title);
	const lower = title.toLowerCase();
	if (!title || [p?.program?.name, p?.program?.key, p?.app].some((s) => s && s.toLowerCase() === lower)) return '';
	// A prompt's path/host, the terminal's own address (what Herdr reports for a shell that sets no title) and transient status are not a task description.
	if (/^(?:[~\/\\]|[a-z]:[\\/]|\S+@\S+:)/i.test(title) || title === p?.cwd || title === p?.terminal) return '';
	if (/^(?:working|thinking|loading|connecting|idle|done|ready|busy|waiting)(?:[.\u2026! ]*)$/i.test(title)) return '';
	return title;
}

export function paneTitle(p, cmds) {
	if (!p) return 'Terminal';
	if (p.mod) return p.title || p.mod;
	// A shell or runtime pane (no agent): "<program> • <last command>", the command read from the terminal by
	// auto-titles-tabs (shared "auto-titles.cmd"), at most 3 words and "..." after them. A tool with a useful title keeps it.
	const cmd = !p.program?.agent && cmds?.[p.terminal];
	if (cmd && (p.program?.shell || !taskTitle(p))) return `${p.program?.name || 'Terminal'} \u2022 ${cmd}`;
	const task = taskTitle(p);
	if (task) return task;
	const program = p.program?.name || 'Terminal';
	const dir = folder(p.cwd);
	return dir ? `${program} · ${dir}` : program;
}

export function terminalTitle(t) {
	// A core terminal's explicit name is separate from its live OSC title.
	return t?.name || paneTitle(t);
}

export function tabTitle(tab, all, cmds) {
	if (tab.named !== false) return tab.name; // Includes older snapshots without `named`.
	const mine = all.filter((p) => p.tab === tab.id);
	// Stable pane order: moving focus to a split must not rename its tab.
	const ordered = [...mine.filter((p) => p.program?.agent), ...mine.filter((p) => !p.program?.agent)];
	const lead = ordered[0]; // a shell/runtime tab is named by its first pane: "<program> \u2022 <last command>"
	if (lead && !lead.program?.agent && cmds?.[lead.terminal] && (lead.program?.shell || !taskTitle(lead)))
		return paneTitle(lead, cmds);
	const task = ordered.map(taskTitle).find(Boolean);
	return task || (ordered.length ? paneTitle(ordered[0], cmds) : tab.name || 'Terminal');
}

export function titleSnapshot(spaces, panes, terminals, cmds) {
	return {
		spaces: spaces.map((s) => ({
			id: s.id,
			title: s.name,
			mode: s.named === false ? 'automatic' : 'manual',
			machine: s.machine,
			tabs: s.tabs.map((t) => ({ id: t.id, title: tabTitle(t, panes, cmds), mode: t.named === false ? 'automatic' : 'manual' })),
		})),
		panes: panes.map((p) => ({ id: p.pane, tab: p.tab, terminal: p.terminal, title: paneTitle(p, cmds) })),
		terminals: terminals.map((t) => ({ address: t.address, title: terminalTitle(t) })),
	};
}
