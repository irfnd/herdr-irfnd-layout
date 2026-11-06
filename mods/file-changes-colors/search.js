// Name and content search for the Files tab. Bounded on purpose: results are capped,
// ripgrep gets two threads and a depth, and a home folder is never scanned for content.
import { exec } from 'herdr';

const CAP = 200,
	FILES = 500;
const sh = async (script, args, cwd, on) => {
	const r = await exec('sh', ['-c', script, 'search', ...args], { cwd, on });
	return r.stdout.split('\n').filter(Boolean);
};

// Files whose path contains `q` (a repo: tracked and untracked, minus ignored; else a bounded find).
export const searchNames = (root, q, on) =>
	sh(
		`if git rev-parse --git-dir >/dev/null 2>&1; then git ls-files -co --exclude-standard
		else find . -maxdepth 6 -type f -not -path '*/.git/*' -not -path '*/node_modules/*' | sed 's|^\\./||'; fi |
		grep -i -F -- "$1" | head -${CAP}`,
		[q],
		root,
		on,
	);

// Lines containing `q`: [{ path, line, text }]. At the home folder this is off.
export async function searchContent(root, q, home, on) {
	if (!on && root === home) return [];
	const lines = await sh(
		`if git rev-parse --git-dir >/dev/null 2>&1; then git grep -n -I -i -F --untracked --max-count=3 -e "$1"
		elif command -v rg >/dev/null 2>&1; then rg -n -i -F -j 2 --max-depth 12 --max-count 3 --no-heading --color never -g '!node_modules' -e "$1" .
		else grep -rnIiF --exclude-dir=.git --exclude-dir=node_modules -m 3 -e "$1" . ; fi | head -${CAP}`,
		[q],
		root,
		on,
	);
	return lines.flatMap((l) => {
		const m = /^(.*?):(\d+):(.*)$/.exec(l);
		return m ? [{ path: m[1].replace(/^\.\//, ''), line: Number(m[2]), text: m[3].trim().slice(0, 200) }] : [];
	});
}

// Every file with a match (not just the first lines of each, as the results show): [relative path].
export async function searchFiles(root, q, home, on) {
	if (!on && root === home) return [];
	const files = await sh(
		`if git rev-parse --git-dir >/dev/null 2>&1; then git grep -l -I -i -F --untracked -e "$1"
		elif command -v rg >/dev/null 2>&1; then rg -l -i -F -j 2 --max-depth 12 --color never -g '!node_modules' -e "$1" .
		else grep -rlIiF --exclude-dir=.git --exclude-dir=node_modules -e "$1" . ; fi | head -${FILES}`,
		[q],
		root,
		on,
	);
	return files.map((f) => f.replace(/^\.\//, ''));
}
