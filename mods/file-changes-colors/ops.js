// File operations for the Files tab. Every path goes in as a positional parameter
// of one small sh script, never spliced into a command line.
import { exec, run, shared, spaces, window } from 'herdr';

export const base = (p) => p.split('/').filter(Boolean).pop() ?? p;
export const parent = (p) => p.replace(/\/[^/]*$/, '') || '/';

async function sh(script, args, on) {
	const r = await exec('sh', ['-c', script, 'ops', ...args], { on });
	if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || 'The operation failed');
}
const EXISTS = '[ -e "$1" ] || [ -L "$1" ]';

// A name that is one path segment.
export function checkName(name) {
	if (!name.trim()) return 'Name is empty';
	if (name.includes('/') || name === '.' || name === '..') return 'Use a single name, without "/"';
	return null;
}

export const createFile = (path, on) => sh(`${EXISTS} && { echo "Already exists" >&2; exit 1; }; : > "$1"`, [path], on);
export const createDir = (path, on) => sh(`${EXISTS} && { echo "Already exists" >&2; exit 1; }; mkdir -p "$1"`, [path], on);
export const rename = (from, to, on) =>
	sh('[ -e "$2" ] || [ -L "$2" ] && { echo "Already exists" >&2; exit 1; }; mv "$1" "$2"', [from, to], on);

// A folder can't go into itself.
const INTO_SELF = 'case "$2/" in "$1"/*) echo "Cannot put a folder inside itself" >&2; exit 1;; esac;';
export const move = (from, dir, on) =>
	sh(`${INTO_SELF} d="$2/\${1##*/}"; [ -e "$d" ] && { echo "Already exists there" >&2; exit 1; }; mv "$1" "$d"`, [from, dir], on);
// A copy beside its original gets "name copy.ext", "name copy 2.ext", ... (a folder or dotfile: "name copy")
export const copy = (from, dir, on) =>
	sh(
		`${INTO_SELF} n="\${1##*/}"; s="$n"; x=""; if [ -f "$1" ]; then case "$n" in ?*.*) s="\${n%.*}"; x=".\${n##*.}";; esac; fi; d="$2/$n"; i=0; while [ -e "$d" ]; do i=$((i+1)); if [ $i = 1 ]; then d="$2/$s copy$x"; else d="$2/$s copy $i$x"; fi; done; cp -R "$1" "$d"`,
		[from, dir],
		on,
	);

// macOS local: into ~/.Trash (a plain mv: Finder's AppleScript would ask for permission),
// so a mistake can be undone. Elsewhere: gone for good (the dialog says so).
export const trashes = (on) => !on && window()?.platform === 'macos';
export const remove = (path, on) =>
	trashes(on)
		? sh(
				'n="${1##*/}"; d="$HOME/.Trash/$n"; i=0; while [ -e "$d" ]; do i=$((i+1)); d="$HOME/.Trash/$n $i"; done; mv "$1" "$d"',
				[path],
				on,
			)
		: sh('rm -rf -- "$1"', [path], on);

export async function reveal(path) {
	const mac = window()?.platform === 'macos';
	await (mac ? exec('open', ['-R', path]) : exec('xdg-open', [parent(path)]));
}
export async function copyPath(path) {
	await exec('sh', [
		'-c',
		window()?.platform === 'macos' ? 'printf %s "$1" | pbcopy' : 'printf %s "$1" | (wl-copy || xclip -selection clipboard)',
		'x',
		path,
	]);
}

// Shared: what Cut/Copy took, for Paste in any copy of the Files mod.
export const clipboard = () => shared('files.clipboard') ?? null;

// A file opens full in its own tab; one already open is shown instead of opened twice.
export function openFile(file, on) {
	const name = base(file),
		open = shared('file-editor') ?? {},
		tabs = spaces().flatMap((s) => s.tabs ?? []);
	const there = Object.entries(open).find(([id, e]) => e.path === file && tabs.some((tb) => tb.id === id));
	if (there) return run('tab.select', { id: there[0] });
	// Two files named alike get their folder in the tab name, so each tab stays findable.
	const taken = tabs.some((tb) => tb.name === name || tb.name === `● ${name}`);
	const title = taken ? file.split('/').slice(-2).join('/') : name;
	run('tab.new', { name: title, mod: 'file-editor', props: { file, title, on } });
}
