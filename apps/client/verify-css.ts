import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, 'src');

const css = readFileSync(join(root, 'style.css'), 'utf8');
const hud = readFileSync(join(root, 'game', 'Hud.ts'), 'utf8');

let failures = 0;

const hasUtility = /\{\s*display:\s*none\s*!important;?\s*\}/.test(css);
if (!hasUtility) {
  console.error('FAIL: no global `.hidden { display: none !important }` utility in style.css');
  failures++;
}

const selectors = new Set<string>();
for (const m of hud.matchAll(/class="([^"]*)"/g)) {
  const tokens = m[1].split(/\s+/);
  const i = tokens.indexOf('hidden');
  if (i > 0) selectors.add(tokens[i - 1]);
}

for (const sel of selectors) {
  const specific = new RegExp(`\\.${sel}\\.hidden\\s*\\{[^}]*display:\\s*none`, 's');
  if (!specific.test(css) && !hasUtility) {
    console.error(`FAIL: no hide rule for .${sel}.hidden (neither element rule nor global utility)`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`${failures} CSS hide-rule gap(s) — the overlay stack would trap the UI again`);
  process.exit(1);
}
console.log(`PASS: ${selectors.size} hidden-toggled element(s) covered (global utility + element rules)`);
