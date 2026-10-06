#!/usr/bin/env node
/**
 * Patch the `ensureSession` mkdir branch inside an installed (compiled)
 * `@deepseek-ai/dsh-api-session-controller`, so a Windows drive root (`C:\`)
 * can host a new Session.
 *
 *   node patch-package.mjs --anchor "C:\dsh-runtime\0.2.1-alpha.1" [--apply]
 *
 * `--anchor` is a dsh installation root — the directory that contains
 * `node_modules/@deepseek-ai/dsh-api-session-controller` (typically
 * `<anchor>/node_modules/@deepseek-ai/dsh/...` for the nested npm layout).
 * Use `--pkg "<...>/dsh-api-session-controller"` to point at the package itself.
 *
 * Source-tree users do not need this: apply `fix.patch` instead.
 * No dependencies: plain Node >= 22.
 */
import fs from 'node:fs';
import path from 'node:path';

const GUARD = 'if (error.code !== "EPERM" || !/^[a-z]:[\\/]?$/i.test(cwd)) throw error;';

// Matches both formatting shapes shipped in lib/:
//   } catch (error) {          (bundled lib/index.js)
//   }
//   catch (error) {            (module-table copy lib/types/*.js)
const PATTERN = /^([ \t]*)try \{\r?\n[ \t]*await mkdir\(cwd, \{ recursive: true \}\);\r?\n\1\}(?:[ \t]*catch \(error\) \{\r?\n|\r?\n[ \t]*catch \(error\) \{\r?\n)[ \t]*throw new Error\(`failed to ensure project directory "\$\{cwd\}": \$\{String\(error\)\}`, \{ cause: error \}\);\r?\n[ \t]*\}/m;

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const apply = argv.includes('--apply');

function findPackageDirs(anchor, explicit) {
  if (explicit) return [explicit];
  const roots = [
    path.join(anchor, 'node_modules', '@deepseek-ai', 'dsh-api-session-controller'),
    path.join(anchor, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-api-session-controller'),
  ];
  const found = roots.filter((p) => fs.existsSync(path.join(p, 'package.json')));
  if (found.length === 0) {
    console.error('dsh-api-session-controller not found under ' + anchor);
    console.error('try --pkg "<...>/@deepseek-ai/dsh-api-session-controller">');
    process.exit(2);
  }
  return found;
}

function walkJs(dir) {
  const out = [];
  (function rec(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
    }
  })(dir);
  return out;
}

const explicit = argOf('--pkg');
const anchor = argOf('--anchor');
if (!explicit && !anchor) {
  console.error('usage: node patch-package.mjs --anchor <dsh install root> [--apply]');
  process.exit(2);
}

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
let planned = 0, already = 0, written = 0;

for (const pkg of findPackageDirs(anchor, explicit)) {
  console.log('package   : ' + pkg);
  const version = (() => { try { return JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version; } catch { return '?'; } })();
  console.log('version   : ' + version);
  for (const file of walkJs(pkg)) {
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(GUARD)) { already++; continue; }
    const m = text.match(PATTERN);
    if (!m) continue;
    const baseIndent = m[1];
    const inner = baseIndent + (baseIndent.includes('\t') ? '\t' : '    ');
    const replacement =
      baseIndent + 'try {\n' +
      inner + 'await mkdir(cwd, { recursive: true });\n' +
      baseIndent + '} catch (error) {\n' +
      inner + GUARD + '\n' +
      baseIndent + '}';
    planned++;
    const rel = path.relative(pkg, file);
    if (!apply) { console.log('  PLAN    ' + rel); continue; }
    const bak = file + '.bak-' + stamp;
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
    fs.writeFileSync(file, text.replace(m[0], replacement), 'utf8');
    written++;
    console.log('  PATCHED ' + rel + '   (backup ' + path.basename(bak) + ')');
  }
}

console.log('');
if (!apply) {
  console.log(`dry run: ${planned} file(s) would be patched, ${already} already patched. Re-run with --apply.`);
} else {
  console.log(`patched ${written} file(s); ${already} were already patched.`);
}
if (planned > 0 && already === 0 && !apply) {
  console.log('note: a dsh process using this install must be restarted for the change to take effect.');
}
