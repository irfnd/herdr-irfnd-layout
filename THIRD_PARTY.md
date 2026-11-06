# Third-party code and assets

This layout is built on other people's work. Each file that uses it says so in its own header;
this is the list.

| What | From | License | Where |
|---|---|---|---|
| Commit graph: lane layout (copied unchanged), graph cell drawing, label look, menu look | [herdr-git-graph](https://github.com/rabeeh-ta/herdr-git-graph) by Rabeeh T A | MIT, `LICENSES/MIT-herdr-git-graph.txt` | `mods/git-changes/lanes.js`, `history.js`, `git.js`, `menu.js` |
| Line diff, bar layout, external-change handling | `abdh-editor` in [herdr-agentee-theme](https://github.com/abdh01h/herdr-agentee-theme) | Apache-2.0 | `mods/file-editor/` (see its `NOTICE`) |
| Diff rows and virtual-list layout, and the panel, folder watch and refresh | Herdr's shipped `changes` mod | Apache-2.0 | `mods/git-changes/diff.js`, `panel.js` |
| Before/after pairing rule (idea only, no code used) | better-changes by Tawsif Aqib, [munza/herdr-mods](https://github.com/munza/herdr-mods) | Apache-2.0 | `mods/git-changes/diff.js` |
| File icons (Charmed) | Littensy | MIT, `CHARMED-LICENSE.md` next to the icons | `mods/file-changes-colors/`, `mods/git-changes/file-icons/` |
| File status colours | `files-changes-colorized` in shafiqimtiaz/ai-tools `herdr-mods` | not stated in the source header | `mods/git-changes/appearance.js`, `mods/file-changes-colors/appearance.js` |
| `auto-titles-*`, `status-bar`, `space-avatars`, `herdr-open-with-zed` | clones of Herdr's shipped `tabs`, `pane`, `workspace-chrome`, `agents`, `menu`, `new-menu`, `peek`, `workspace-status` and `spaces` mods | Herdr's | each `mod.json` has `cloned_from` |
| Zed logo | Zed Industries | trademark of its owner | `mods/herdr-open-with-zed/zed.svg` |
