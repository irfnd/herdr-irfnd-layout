// Syntax colours for diff rows. gpui has no inline coloured text, so the diff view draws one small div per
// token; this file only finds the tokens. It reads one line at a time, so a block comment or a template
// string that runs over several lines is only coloured where a line shows its start (or a leading `*`).
// Unknown file types return null and are drawn plain.

const W = (s) => new Set(s.split(' '));
const BOOL = W('true false null nil undefined NaN None True False NULL Infinity');
const STAR = /^\s*\*(?:\s|\/|$)/; // a line inside /* ... */

const JS = W(
	'as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function if implements import in instanceof interface keyof let namespace new of package private protected public readonly return satisfies static super switch this throw try type typeof var void while with yield abstract',
);
const C_COM = '(\\/\\/.*|\\/\\*.*?(?:\\*\\/|$))';
const HASH = '(#.*)';
const NONE = '((?!))';

// com: regex source of a comment (one capture group). tick: backtick strings. sq: 'single' strings.
// types: Capitalised words are types. star: STAR lines are comments. keys: a string before ":" is a key.
// key: a line like `name:` or `name =` colours the name. head: a whole-line section header.
const SPEC = {};
const def = (exts, spec) => exts.split(' ').forEach((e) => (SPEC[e] = { com: C_COM, sq: true, types: true, ...spec }));

def('js jsx mjs cjs ts tsx mts cts', { kw: JS, tick: true, star: true });
def('json jsonc json5', { kw: new Set(), com: NONE, keys: true, types: false });
def('py pyi', {
	com: HASH,
	kw: W(
		'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case',
	),
});
def('go', {
	tick: true,
	star: true,
	kw: W('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var iota'),
});
def('rs', {
	sq: false,
	star: true,
	kw: W('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while'),
});
def('java kt kts cs swift dart scala php', {
	star: true,
	kw: W(
		'abstract as async await break case catch class const continue default do echo else elseif enum extends final finally for foreach fun func function if implements import in interface is let namespace new object override package private protected public return static struct super switch this throw throws trait try typeof use using val var virtual void when while yield',
	),
});
def('c h cc cpp hpp cxx', {
	star: true,
	kw: W(
		'auto bool break case char class const constexpr continue default define delete do double else endif enum explicit extern float for friend goto if ifdef ifndef include inline int long namespace new nullptr operator pragma private protected public register return short signed sizeof static struct switch template this throw try typedef typename union unsigned using virtual void volatile while',
	),
});
def('rb', {
	com: HASH,
	kw: W('alias and begin break case class def defined do else elsif end ensure for if in include module next not or rescue require retry return self super then unless until when while yield'),
});
def('sh bash zsh', {
	com: HASH,
	types: false,
	extra: '(\\$\\{?[A-Za-z_]\\w*\\}?|\\$[0-9@#?*!$])',
	extraKind: 'const',
	kw: W('alias break case continue do done elif else esac eval exec exit export fi for function if in local readonly return select set shift source then unset until while'),
});
def('sql', {
	com: '(--.*|\\/\\*.*?(?:\\*\\/|$))',
	types: false,
	ci: true,
	kw: W(
		'add all alter and as asc begin between by case commit constraint create default delete desc distinct drop else end exists foreign from group having if in index inner insert into is join key left like limit not null offset on or order outer primary references right rollback select set table then union unique update values when where with',
	),
});
def('yaml yml', { com: HASH, kw: new Set(), types: false, key: /^(\s*(?:- )?)([\w.\-/ ]+?)(\s*:(?:\s|$))/ });
def('toml ini conf env', {
	com: HASH,
	kw: new Set(),
	types: false,
	key: /^(\s*)([\w.\-"]+)(\s*=)/,
	head: /^\s*\[\[?[^\]]+\]\]?\s*$/,
});
def('css scss less', {
	com: '(\\/\\*.*?(?:\\*\\/|$)|\\/\\/.*)',
	types: false,
	star: true,
	id: '@?[A-Za-z_-][\\w-]*',
	num: '#[0-9a-fA-F]{3,8}\\b|\\d[\\d_]*(?:\\.\\d+)?',
	kw: new Set(),
	prop: true,
});
def('html htm xml svg vue', {
	com: '(<!--.*?(?:-->|$))',
	types: false,
	sq: true,
	extra: '(<\\/?[A-Za-z][\\w:.-]*|\\/?>)',
	extraKind: 'kw',
	id: '[A-Za-z_:@][\\w:.-]*',
	kw: new Set(),
	attr: true,
});
def('md markdown', { md: true });
def('dockerfile', {
	com: HASH,
	types: false,
	kw: W('ADD ARG CMD COPY ENTRYPOINT ENV EXPOSE FROM HEALTHCHECK LABEL RUN USER VOLUME WORKDIR AS'),
});
def('make', { com: HASH, types: false, kw: W('ifeq ifneq ifdef ifndef else endif include define endef') });

// File name -> key of SPEC, or null.
export function langOf(path) {
	const name = (path ?? '').split('/').pop().toLowerCase();
	if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile';
	if (name === 'makefile' || name === 'gnumakefile') return 'make';
	if (name.startsWith('.env')) return 'env';
	const ext = name.includes('.') ? name.split('.').pop() : '';
	return SPEC[ext] ? ext : null;
}

// One regex per spec: comment | string | number | extra | word. Built on first use.
function scanner(s) {
	if (s.re) return s.re;
	const q = [`"(?:\\\\.|[^"\\\\])*"?`, s.sq ? `'(?:\\\\.|[^'\\\\])*'?` : null, s.tick ? '`(?:\\\\.|[^`\\\\])*`?' : null].filter(Boolean);
	s.re = new RegExp(
		[
			s.com,
			`(${q.join('|')})`,
			`(0[xX][0-9a-fA-F_]+|${s.num ?? '\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?'})`,
			s.extra ?? NONE,
			`(${s.id ?? '[A-Za-z_$][\\w$]*'})`,
		].join('|'),
		'g',
	);
	return s.re;
}

const word = (s, w, text, end) => {
	const lw = s.ci ? w.toLowerCase() : w;
	if (s.kw.has(lw) || w.startsWith('@')) return 'kw';
	if (BOOL.has(w)) return 'bool';
	if (/^[A-Z][A-Z0-9_]{2,}$/.test(w)) return 'const';
	if (s.attr) return text[end] === '=' ? 'type' : null;
	if (s.prop) return /^\s*:/.test(text.slice(end)) && !/^\s*::?\w/.test(text.slice(end)) ? 'fn' : null;
	if (s.types && /^[A-Z]/.test(w)) return 'type';
	return text[end] === '(' ? 'fn' : null;
};

function markdown(text) {
	if (/^\s{0,3}#{1,6}\s/.test(text)) return [[text, 'kw']];
	const out = [],
		m = /^(\s*(?:[-*+]|\d+\.)\s)/.exec(text);
	let from = 0;
	if (m) {
		out.push([m[1], 'kw']);
		from = m[1].length;
	}
	for (const part of text.slice(from).split(/(`[^`]*`)/)) if (part) out.push([part, part[0] === '`' && part.length > 1 ? 'str' : null]);
	return out;
}

const cache = new Map();

// [[text, kind]] where kind is kw|str|com|fn|type|num|const|bool or null (plain); null when `lang` is unknown.
export function highlight(text, lang) {
	const s = SPEC[lang];
	if (!s || text.length > 800) return null;
	const hit = cache.get(`${lang}\0${text}`);
	if (hit) return hit;
	const out = [];
	const push = (t, k) => {
		if (!t) return;
		const last = out.at(-1);
		if (last && last[1] === k) last[0] += t;
		else out.push([t, k]);
	};
	if (s.md) markdown(text).forEach(([t, k]) => push(t, k));
	else if (s.star && STAR.test(text)) push(text, 'com');
	else if (s.head?.test(text)) push(text, 'kw');
	else {
		let from = 0;
		const k = s.key?.exec(text);
		if (k) {
			push(k[1], null);
			push(k[2], 'fn');
			push(k[3], null);
			from = k[0].length;
		}
		const re = scanner(s);
		re.lastIndex = from;
		let m,
			at = from;
		while ((m = re.exec(text))) {
			push(text.slice(at, m.index), null);
			const [all, com, str, num, extra, w] = m;
			if (com) push(all, 'com');
			else if (str) push(all, s.keys && /^\s*:/.test(text.slice(re.lastIndex)) ? 'fn' : 'str');
			else if (num) push(all, 'num');
			else if (extra) push(all, s.extraKind);
			else push(all, word(s, w, text, re.lastIndex));
			at = re.lastIndex;
			if (!all) re.lastIndex++; // never loop on an empty match
		}
		push(text.slice(at), null);
	}
	if (cache.size > 4000) cache.clear();
	cache.set(`${lang}\0${text}`, out);
	return out;
}
