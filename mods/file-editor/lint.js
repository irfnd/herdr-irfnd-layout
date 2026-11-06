// Problems and format-on-save for file-editor. Tools are the project's own, found by walking up from
// the file (node_modules/.bin/eslint, prettier) or on PATH (ruff, gofmt, bash). A missing tool is a
// note, never an error. JSON is checked in JavaScript. Local files only.
import { exec } from 'herdr';

const UP = `up() { d=$(dirname "$1"); while :; do [ -e "$d/$2" ] && { printf %s "$d"; return 0; }; [ "$d" = / ] && return 1; d=$(dirname "$d"); done; };`;
const MISSING = 127; // the script's code for "no such tool here"

const JS = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'];
const PRETTIER = [...JS, 'json', 'jsonc', 'css', 'scss', 'html', 'md', 'yml', 'yaml'];
const sh = (script, path) => exec('sh', ['-c', UP + script, 'lint', path]);

const err = (line, col, message, source) => ({
	line: Number(line) || 1,
	col: Number(col) || 1,
	severity: 'error',
	message,
	source,
});

// One entry per language: how to run the tool, and how to read what it printed.
const LINTERS = {
	js: {
		name: 'eslint',
		run: (p) => sh('r=$(up "$1" node_modules/.bin/eslint) || exit 127; cd "$r" && node_modules/.bin/eslint -f json -- "$1"', p),
		parse: (r) => {
			if (r.code > 1) throw new Error(r.stderr.trim().split('\n')[0] || 'eslint failed');
			return (JSON.parse(r.stdout)[0]?.messages ?? []).map((m) => ({
				line: m.line ?? 1,
				col: m.column ?? 1,
				severity: m.severity === 2 || m.fatal ? 'error' : 'warning',
				message: m.message,
				source: m.ruleId ?? 'eslint',
			}));
		},
	},
	py: {
		name: 'ruff',
		run: (p) =>
			sh(
				`if command -v ruff >/dev/null 2>&1; then ruff check -q --output-format json -- "$1"; else python3 -c 'import ast,sys
try: ast.parse(open(sys.argv[1]).read())
except SyntaxError as e: print("%d:%d:%s" % (e.lineno or 1, e.offset or 1, e.msg)); sys.exit(1)' "$1"; fi`,
				p,
			),
		parse: (r) => {
			if (r.stdout.trimStart().startsWith('[')) {
				return JSON.parse(r.stdout).map((m) => ({
					line: m.location?.row ?? 1,
					col: m.location?.column ?? 1,
					severity: !m.code || /^(E9|F6|F7|F82)/.test(m.code) ? 'error' : 'warning',
					message: m.message,
					source: m.code ?? 'ruff',
				}));
			}
			const m = /^(\d+):(\d+):(.*)$/m.exec(r.stdout);
			return m ? [err(m[1], m[2], m[3].trim(), 'python')] : [];
		},
	},
	go: {
		name: 'gofmt',
		run: (p) => sh('command -v gofmt >/dev/null 2>&1 || exit 127; gofmt -e "$1" >/dev/null', p),
		parse: (r) => {
			const seen = new Set(); // one error cascades into several on the same line
			return [...r.stderr.matchAll(/:(\d+):(\d+): (.*)$/gm)]
				.filter((m) => !seen.has(m[1]) && seen.add(m[1]))
				.map((m) => err(m[1], m[2], m[3], 'gofmt'));
		},
	},
	sh: {
		name: 'bash -n',
		run: (p) => sh('bash -n "$1"', p),
		parse: (r) => [...r.stderr.matchAll(/line (\d+): (.*)$/gm)].map((m) => err(m[1], 1, m[2], 'bash')),
	},
};
for (const e of JS) LINTERS[e] = LINTERS.js;
LINTERS.bash = LINTERS.sh;

// Where JSON first goes wrong. The engine's own message has no position, so a small strict scanner finds it.
const SCALAR = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?|true|false|null/y;
function jsonError(s) {
	let i = 0;
	const bad = (msg) => {
		throw { i, msg };
	};
	const ws = () => {
		while (i < s.length && ' \t\n\r'.includes(s[i])) i++;
	};
	const str = () => {
		for (i++; s[i] !== '"'; i += s[i] === '\\' ? 2 : 1) {
			if (i >= s.length) bad('Unterminated string');
			if (s[i] < ' ') bad('Control character in string');
		}
		i++;
	};
	const list = (close, item) => {
		i++;
		ws();
		if (s[i] === close) return i++;
		for (;;) {
			ws();
			item();
			ws();
			if (s[i] === ',') i++;
			else if (s[i] === close) return i++;
			else bad(`Expected ',' or '${close}'`);
		}
	};
	const val = () => {
		ws();
		if (s[i] === '{')
			list('}', () => {
				if (s[i] !== '"') bad('Expected a property name');
				str();
				ws();
				if (s[i] !== ':') bad("Expected ':'");
				i++;
				val();
			});
		else if (s[i] === '[') list(']', val);
		else if (s[i] === '"') str();
		else {
			SCALAR.lastIndex = i;
			const m = SCALAR.exec(s);
			if (!m) bad(i >= s.length ? 'Unexpected end of file' : `Unexpected '${s[i]}'`);
			i += m[0].length;
		}
	};
	try {
		val();
		ws();
		if (i < s.length) bad('Unexpected data after the value');
	} catch (e) {
		if (e.msg === undefined) throw e;
		return e;
	}
	return null;
}

export function lintJson(text) {
	try {
		JSON.parse(text);
		return [];
	} catch (e) {
		const at = jsonError(text) ?? { i: 0, msg: String(e.message ?? e).slice(0, 120) };
		const before = text.slice(0, at.i).split('\n');
		return [err(before.length, before.at(-1).length + 1, at.msg, 'json')];
	}
}

const tooling = (ext) => (ext === 'json' ? 'json' : LINTERS[ext] ? LINTERS[ext].name : null);
export const hasLinter = tooling;

// -> { items: [{ line, col, severity, message, source }] | null, note }. `items` is null when nothing could run.
export async function lint(path, ext, text) {
	const name = path.split('/').pop();
	if (ext === 'json' && !/^(tsconfig|jsconfig)/.test(name)) return { items: lintJson(text), note: '' };
	const l = LINTERS[ext];
	if (!l) return { items: null, note: 'No linter for this file type' };
	try {
		const r = await l.run(path);
		if (r.code === MISSING) return { items: null, note: `${l.name} is not installed for this project` };
		return { items: l.parse(r), note: '' };
	} catch (e) {
		return { items: null, note: `${l.name}: ${String(e.message ?? e)}` };
	}
}

const FORMAT = `case "$2" in
${PRETTIER.map((e) => `"${e}"`).join('|')}) r=$(up "$1" node_modules/.bin/prettier) || exit 127; cd "$r" && node_modules/.bin/prettier --find-config-path "$1" >/dev/null 2>&1 || exit 127; node_modules/.bin/prettier --write -- "$1" >/dev/null;;
py) command -v ruff >/dev/null 2>&1 || exit 127; up "$1" ruff.toml >/dev/null || up "$1" pyproject.toml >/dev/null || exit 127; ruff format -q -- "$1";;
go) command -v gofmt >/dev/null 2>&1 || exit 127; gofmt -w "$1";;
*) exit 127;;
esac`;

// Formats the file on disk in place with the project's own formatter. Prettier only runs where the
// project has a prettier config, so a project that never used it is not rewritten. -> { ran, error }
export async function format(path, ext) {
	const r = await exec('sh', ['-c', UP + FORMAT, 'fmt', path, ext]);
	if (r.code === MISSING) return { ran: false };
	return r.code === 0 ? { ran: true } : { ran: false, error: r.stderr.trim().split('\n')[0] || 'The formatter failed' };
}
