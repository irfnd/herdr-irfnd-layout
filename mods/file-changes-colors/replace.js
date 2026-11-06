// Replace in files, for the Files search. Local files only (the host writes nowhere else).
// Matches the way the search does, ignoring case; the replacement is taken literally.
import { readTextFile, writeTextFile } from 'herdr';

const escape = (q) => q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// -> { files, occurrences, failed: [{ path, why }] }. A file that fails does not stop the rest.
export async function replaceAll(root, files, query, replacement) {
	const re = new RegExp(escape(query), 'gi');
	const out = { files: 0, occurrences: 0, failed: [] };
	for (const path of files) {
		try {
			const text = await readTextFile(`${root}/${path}`);
			if (text === null || text.includes('\0')) throw new Error('Not a text file');
			let n = 0;
			const next = text.replace(re, () => (n++, replacement));
			if (!n) continue;
			await writeTextFile(`${root}/${path}`, next, text);
			out.files++;
			out.occurrences += n;
		} catch (e) {
			out.failed.push({ path, why: String(e.message ?? e) });
		}
	}
	return out;
}
