import { access, chmod, lstat, mkdir, readlink, symlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.ALFRED_INSTALL_HOME || homedir();
const codexHome = process.env.ALFRED_INSTALL_HOME ? join(home, '.codex') : process.env.CODEX_HOME || join(home, '.codex');
const mappings = [
  [join(root, 'dist/cli.js'), join(home, '.local/bin/alfred')],
  [join(root, '.agents/skills/alfred'), join(codexHome, 'skills/alfred')],
];

// Preflight all targets before installing either one. Preserve existing installs.
for (const [source, target] of mappings) {
  await access(source, constants.R_OK);
  try {
    const info = await lstat(target);
    if (!info.isSymbolicLink() || resolve(dirname(target), await readlink(target)) !== source) {
      throw new Error(`An existing item occupies ${target}. Move it deliberately before installing Alfred.`);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await chmod(mappings[0][0], 0o755);
for (const [source, target] of mappings) {
  await mkdir(dirname(target), { recursive: true });
  try { await symlink(source, target); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  console.log(`Installed ${target}`);
}
console.log('Open a new Codex task to discover $alfred. Add ~/.local/bin to PATH if needed.');
