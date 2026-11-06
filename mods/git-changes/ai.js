// Commit message from the changes, by Claude Haiku through the `claude` CLI on this Mac.
// `--model haiku` is the CLI's alias for the newest Haiku installed. The call is isolated:
// no tools, no session file, no user settings or hooks, so it can't touch the repository or
// leave a trace. The diff is read where the repository is (any machine); claude runs here.
import { exec, home } from 'herdr';
import * as G from './git.js';

const MAX_DIFF = 20000;
const SYSTEM = `You write git commit messages in the Commitizen / Conventional Commits standard.
Format: <type>(<optional scope>): <subject>
Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.
Rules: imperative mood, lowercase subject, no trailing period, subject at most 72 characters.
Add a blank line and a short body (lines wrapped at 72) only when the change needs the why explained.
Add "BREAKING CHANGE: ..." in the footer only for a real breaking change.
Follow the scope names used in the recent commits when they fit.
Answer with the commit message alone: no code fence, no quotes, no preamble, no explanation.`;

// What to read, by commit mode: the staged changes, else every tracked change (git commit -a).
function sources(mode, hasHead) {
	const base = ['--no-ext-diff', '--no-textconv', '--no-color'];
	return mode === 'staged' ? [...base, '--cached'] : hasHead ? [...base, 'HEAD'] : base;
}

async function claude(args, prompt) {
	// A GUI-started Herdr may lack ~/.local/bin on PATH: try it by full path as a fallback.
	for (const bin of ['claude', `${home()}/.local/bin/claude`]) {
		try {
			return await exec(bin, [...args, prompt], { cwd: home() });
		} catch {}
	}
	throw new Error('The claude CLI was not found on this Mac');
}

export async function generateMessage({ root, on, mode, hasHead }) {
	const git = (args) => exec('git', [...G.READ, ...args], { cwd: root, on });
	const src = sources(mode, hasHead);
	const [stat, patch, log] = await Promise.all([
		git(['diff', ...src, '--stat=120']),
		git(['diff', ...src]),
		git(['log', '-n', '10', '--format=%s']),
	]);
	if (!patch.stdout.trim() && !stat.stdout.trim()) throw new Error('No changes to describe');
	const cut = patch.stdout.length > MAX_DIFF;
	const prompt = [
		'Recent commit subjects (for style and scope names):',
		log.code === 0 ? log.stdout.trim() || '(none yet)' : '(none yet)',
		'',
		'Changed files:',
		stat.stdout.trim(),
		'',
		`Diff${cut ? ` (first ${MAX_DIFF} characters)` : ''}:`,
		patch.stdout.slice(0, MAX_DIFF),
		'',
		'Write the commit message for these changes.',
	].join('\n');
	const r = await claude(
		[
			'-p',
			'--model',
			'haiku',
			'--system-prompt',
			SYSTEM,
			'--tools',
			'',
			'--no-session-persistence',
			'--disable-slash-commands',
			'--setting-sources',
			'',
			'--strict-mcp-config',
		],
		prompt,
	);
	if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ') || `claude exited ${r.code}`);
	const message = r.stdout
		.trim()
		.replace(/^```\w*\n?|\n?```$/g, '')
		.trim();
	if (!message) throw new Error('Claude returned an empty message');
	return message;
}
