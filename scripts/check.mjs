#!/usr/bin/env node
/**
 * Static integrity check.
 *
 * The game has no bundler, which means a typo in an import path is only
 * discovered at runtime in the browser. This walks every source file, parses
 * it, and resolves every relative import against the filesystem.
 *
 *   node scripts/check.mjs
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const ROOTS = ['src', 'scripts', 'test'];
/**
 * Files allowed to use bare specifiers. The game itself must not — it runs
 * unbundled in a browser — but dev tooling resolves through node_modules.
 */
const TOOLING = new Set(['scripts/smoke.mjs']);
const IMPORT_RE = /(?:^|[^.\w])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

let errors = 0;
let files = 0;

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      yield* walk(full);
    } else if (['.js', '.mjs'].includes(extname(e.name))) {
      yield full;
    }
  }
}

function fail(file, message) {
  errors++;
  console.error(`  ✗ ${relative(ROOT, file)}: ${message}`);
}

for (const root of ROOTS) {
  for await (const file of walk(join(ROOT, root))) {
    files++;
    const src = await readFile(file, 'utf8');

    // 1. Parse as an ES module. `package.json` sets type=module, so
    //    `node --check` uses the module goal for bare .js files too.
    try {
      await execFileAsync(process.execPath, ['--check', file]);
    } catch (err) {
      const detail = String(err.stderr || err.message).split('\n').slice(0, 4).join(' ').trim();
      fail(file, `syntax error: ${detail}`);
      continue;
    }

    // 2. Resolve every relative specifier.
    const specifiers = new Set();
    for (const re of [IMPORT_RE, BARE_IMPORT_RE, DYNAMIC_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) specifiers.add(m[1]);
    }

    for (const spec of specifiers) {
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.') && !spec.startsWith('/')) {
        if (TOOLING.has(relative(ROOT, file))) continue;
        fail(file, `bare import "${spec}" — the game must run without a bundler`);
        continue;
      }
      const target = resolve(dirname(file), spec);
      const info = await stat(target).catch(() => null);
      if (!info || !info.isFile()) fail(file, `unresolved import "${spec}"`);
    }
  }
}

console.log(`checked ${files} files`);
if (errors) {
  console.error(`\n${errors} problem${errors === 1 ? '' : 's'} found`);
  process.exit(1);
}
console.log('all imports resolve, all files parse');
