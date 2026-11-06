// Unsaved edits, kept in <app home>/recovery/<hash of the path>.json as { path, text, time }.
// Written while a buffer is dirty (every few seconds) and when its tab closes, removed when the
// file is saved or the edits are discarded; offered back the next time the file opens.
import * as fs from 'fs/promises';
import { appHome, readTextFile } from 'herdr';

const dir = () => `${appHome()}/recovery`;
const id = (path) => {
	let h = 5381;
	for (const c of path) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
	return h.toString(36);
};
const file = (path) => `${dir()}/${id(path)}.json`;

export async function keep(path, text) {
	await fs.mkdir(dir(), { recursive: true });
	await fs.writeFile(file(path), JSON.stringify({ path, text, time: Date.now() }));
}

// The kept edits for `path`, or null (a hash clash with another path counts as none).
export async function find(path) {
	const raw = await readTextFile(file(path)).catch(() => null);
	try {
		const r = raw && JSON.parse(raw);
		return r?.path === path ? r : null;
	} catch {
		return null;
	}
}

export const drop = (path) => fs.unlink(file(path)).catch(() => {});
