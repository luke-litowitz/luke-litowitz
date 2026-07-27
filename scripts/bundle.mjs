#!/usr/bin/env node
/**
 * Build a single self-contained HTML file of the whole game.
 *
 * The game normally runs as unbundled ES modules straight off a static server,
 * which is the right shape for a repo but useless if you just want to open one
 * file and play. This produces that one file.
 *
 * It does not rewrite or concatenate the modules. Instead it embeds each one's
 * source verbatim, then at load time walks them in dependency order, rewrites
 * each import specifier to the Blob URL of the module it resolves to, and
 * dynamically imports the entry. Real ES module semantics are preserved
 * exactly — no identifier renaming, no scope merging, no evaluation-order
 * guesswork — which is why this is a hundred lines instead of a bundler.
 *
 *   node scripts/bundle.mjs [out.html]
 */

import { readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const ENTRY = 'src/main.js';
const OUT = process.argv[2] || join(ROOT, 'dist/crossy-cascade.html');

/**
 * Three.js ships both readable and minified builds of the same modules. The
 * repo vendors the readable ones; a single file people download over a phone
 * connection wants the minified ones. Same code, same API.
 */
const MINIFIED = new Map([
  ['vendor/three/three.module.js', 'node_modules/three/build/three.module.min.js'],
  ['vendor/three/three.core.js', 'node_modules/three/build/three.core.min.js'],
]);

/** Matches static and dynamic import/export specifiers. */
const SPECIFIER_RE =
  /(\bfrom\s*|\bimport\s*|\bexport\s*\*\s*from\s*|\bimport\()(["'])(\.\.?\/[^"']+)\2/g;

const sources = new Map(); // repo-relative path -> source text
const deps = new Map(); // repo-relative path -> [repo-relative paths]

async function readModule(rel) {
  const override = MINIFIED.get(rel);
  if (override && (await stat(join(ROOT, override)).catch(() => null))) {
    return readFile(join(ROOT, override), 'utf8');
  }
  return readFile(join(ROOT, rel), 'utf8');
}

/** Collect a module and everything it reaches, depth first. */
async function collect(rel) {
  if (sources.has(rel)) return;
  const src = await readModule(rel);
  sources.set(rel, src);

  const found = new Set();
  for (const m of src.matchAll(SPECIFIER_RE)) {
    const spec = m[3];
    // A minified three build imports its own minified sibling; map that back
    // onto the vendored path so both variants resolve to one module.
    const asVendored = spec.replace('.min.js', '.js');
    const target = relative(ROOT, resolve(join(ROOT, dirname(rel)), asVendored));
    found.add(target);
  }
  deps.set(rel, [...found]);
  for (const d of found) await collect(d);
}

/** Depth-first topological order; throws on a cycle, which this loader cannot serve. */
function topoSort(entry) {
  const order = [];
  const state = new Map(); // 0 = visiting, 1 = done

  const visit = (rel, stack) => {
    const s = state.get(rel);
    if (s === 1) return;
    if (s === 0) {
      throw new Error(`import cycle: ${[...stack, rel].join(' -> ')}`);
    }
    state.set(rel, 0);
    for (const d of deps.get(rel) || []) visit(d, [...stack, rel]);
    state.set(rel, 1);
    order.push(rel);
  };

  visit(entry, []);
  return order;
}

const html = (modulesJson, order, css, title) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${title}</title>
    <meta name="color-scheme" content="light dark" />
    <style>
${css}
    </style>
  </head>
  <body>
    <div id="app">
      <canvas id="game-canvas" aria-label="Game viewport" role="img"></canvas>
      <div id="ui"></div>
    </div>
    <noscript><div class="noscript"><h1>Crossy Cascade</h1><p>This game needs JavaScript and WebGL.</p></div></noscript>

    <script id="modules" type="application/json">${modulesJson}</script>
    <script>
      /*
       * Serve every module from a Blob URL, in dependency order, rewriting each
       * import specifier to the URL of the module it resolves to. This keeps
       * real ES module semantics — the alternative, concatenating sources, has
       * to solve identifier collisions and evaluation order by hand.
       */
      (function () {
        var order = ${JSON.stringify(order)};
        var sources = JSON.parse(document.getElementById('modules').textContent);
        var urls = Object.create(null);

        function dirOf(p) {
          var i = p.lastIndexOf('/');
          return i < 0 ? '' : p.slice(0, i);
        }
        function resolvePath(base, spec) {
          var parts = (dirOf(base) + '/' + spec).split('/');
          var out = [];
          for (var i = 0; i < parts.length; i++) {
            var seg = parts[i];
            if (!seg || seg === '.') continue;
            if (seg === '..') out.pop();
            else out.push(seg);
          }
          return out.join('/');
        }

        var RE = ${SPECIFIER_RE.toString()};

        for (var i = 0; i < order.length; i++) {
          var path = order[i];
          var src = sources[path].replace(RE, function (whole, head, quote, spec) {
            var target = resolvePath(path, spec.replace('.min.js', '.js'));
            var url = urls[target];
            return url ? head + quote + url + quote : whole;
          });
          urls[path] = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        }

        import(urls[${JSON.stringify(ENTRY)}]).catch(function (err) {
          document.getElementById('ui').innerHTML =
            '<div style="padding:2rem;font:16px system-ui">' +
            '<h1>Could not start</h1><pre>' + (err && err.stack || err) + '</pre></div>';
        });
      })();
    </script>
  </body>
</html>
`;

await collect(ENTRY);
const order = topoSort(ENTRY);

const css = await readFile(join(ROOT, 'styles/main.css'), 'utf8');
const indexHtml = await readFile(join(ROOT, 'index.html'), 'utf8');
const title = /<title>([^<]*)<\/title>/.exec(indexHtml)?.[1] || 'Crossy Cascade';

const payload = {};
for (const rel of order) payload[rel] = sources.get(rel);

const out = html(
  JSON.stringify(payload).replace(/<\/script>/gi, '<\\/script>'),
  order,
  css,
  title,
);

await writeFile(OUT, out, 'utf8');
console.log(`${order.length} modules -> ${OUT}`);
console.log(`${(out.length / 1024 / 1024).toFixed(2)} MB`);
console.log('entry:', ENTRY, '| load order ends:', order.slice(-3).join(', '));
