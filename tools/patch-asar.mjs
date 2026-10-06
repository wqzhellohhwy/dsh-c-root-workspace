#!/usr/bin/env node
/**
 * Patch the `ensureSession` mkdir branch inside a packaged Electron app.asar,
 * so a Windows drive root (`C:\`) can host a new Session.
 *
 *   node patch-asar.mjs --asar "<...>\resources\app.asar" [--apply] [--no-syntax-check]
 *
 * Why the archive surgery is safe: the replacement text is written back with
 * EXACTLY the byte length of the original, so every file offset recorded in the
 * asar header stays valid. Only the two touched entries get their
 * `integrity.hash` / `integrity.blocks` recomputed, and the header JSON keeps a
 * constant length. Everything is verified afterwards by re-parsing the archive
 * and comparing every entry byte for byte against the backup.
 *
 * No dependencies: plain Node >= 22.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const guardFor = (quote) => `if (error.code !== ${quote}EPERM${quote} || !/^[a-z]:[\\\\/]?$/i.test(cwd)) throw error;`;

const TARGETS = [
  {
    file: 'dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js',
    // bundled entry: double-quoted style
    quote: '"',
    pattern: /(^([ \t]*)try \{\r?\n[ \t]*await mkdir\(cwd, \{ recursive: true \}\);\r?\n\2\} catch \(error\) \{\r?\n[ \t]*throw new Error\(`failed to ensure project directory "\$\{cwd\}": \$\{String\(error\)\}`, \{ cause: error \}\);\r?\n\2\})/m,
  },
  {
    file: 'dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/agent.js',
    // module-table copy: single-quoted style, `catch` on its own line
    quote: "'",
    pattern: /(^([ \t]*)try \{\r?\n[ \t]*await mkdir\(cwd, \{ recursive: true \}\);\r?\n\2\}\r?\n[ \t]*catch \(error\) \{\r?\n[ \t]*throw new Error\(`failed to ensure project directory "\$\{cwd\}": \$\{String\(error\)\}`, \{ cause: error \}\);\r?\n\2\})/m,
  },
];

const HEADER_JSON_OFFSET = 16;

// ---------- args -------------------------------------------------------------
const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const asarPath = argOf('--asar');
const apply = argv.includes('--apply');
const syntaxCheck = !argv.includes('--no-syntax-check');
if (!asarPath) {
  console.error('usage: node patch-asar.mjs --asar <app.asar> [--apply] [--no-syntax-check]');
  process.exit(2);
}
if (!fs.existsSync(asarPath)) {
  console.error('asar not found: ' + asarPath);
  process.exit(2);
}

// ---------- asar reader ------------------------------------------------------
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, HEADER_JSON_OFFSET);
  fs.closeSync(fd);
  return { jsonLen, jsonBuf, header: JSON.parse(jsonBuf.toString('utf8')) };
}

function collectEntries(header) {
  const out = [];
  (function walk(node, prefix) {
    for (const [name, e] of Object.entries(node.files || {})) {
      const p = prefix ? prefix + '/' + name : name;
      if (e.files) walk(e, p);
      else out.push({ path: p, offset: Number(e.offset || 0), size: Number(e.size || 0), unpacked: e.unpacked === true, node: e });
    }
  })(header, '');
  return out;
}

const { jsonLen, jsonBuf, header } = readHeader(asarPath);
const baseOffset = HEADER_JSON_OFFSET + jsonLen;
const entries = collectEntries(header);
const byPath = new Map(entries.map((e) => [e.path, e]));
console.log(`asar      : ${asarPath}`);
console.log(`entries   : ${entries.length}   payload@${baseOffset}   jsonLen=${jsonLen}`);

const whole = fs.readFileSync(asarPath);
const readEntryFast = (e) => whole.subarray(baseOffset + e.offset, baseOffset + e.offset + e.size);

// ---------- build the edits --------------------------------------------------
const edits = [];
for (const t of TARGETS) {
  const e = byPath.get(t.file);
  if (!e) { console.log(`SKIP  ${t.file} (not in this archive)`); continue; }
  const buf = readEntryFast(e);
  const text = buf.toString('utf8');
  const m = text.match(t.pattern);
  if (!m) {
    console.log(text.includes('error.code !==') && text.includes('EPERM') ? `ALREADY PATCHED  ${t.file}` : `SKIP  ${t.file} (pattern not found)`);
    continue;
  }
  const original = m[1];
  const baseIndent = m[2];
  const inner = baseIndent + (baseIndent.includes('\t') ? '\t' : '    ');
  const core =
    baseIndent + 'try {\n' +
    inner + 'await mkdir(cwd, { recursive: true });\n' +
    (t.file.includes('/types/') ? baseIndent + '}\n' + baseIndent + 'catch (error) {\n' : baseIndent + '} catch (error) {\n') +
    inner + guardFor(t.quote) + '\n' +
    baseIndent + '}';
  if (core.length > original.length) {
    console.error(`replacement longer than original in ${t.file} (${core.length} > ${original.length}); aborting`);
    process.exit(3);
  }
  const padded = core + ' '.repeat(original.length - core.length);
  edits.push({ entry: e, original, padded, file: t.file, patched: null });
  console.log(`PLAN  ${t.file}   ${original.length}B -> ${padded.length}B (unchanged)`);
}

if (edits.length === 0) {
  console.log('nothing to do.');
  process.exit(0);
}
if (!apply) {
  console.log('\nDRY RUN — re-run with --apply to write.');
  process.exit(0);
}

// ---------- apply ------------------------------------------------------------
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const backup = `${asarPath}.orig-${stamp}`;
if (!fs.existsSync(backup)) {
  fs.copyFileSync(asarPath, backup);
  console.log(`backup    : ${backup}  (sha256 ${sha256(fs.readFileSync(backup))})`);
} else {
  console.log(`backup    : ${backup} (already present)`);
}

const out = Buffer.from(whole);
for (const edit of edits) {
  const { entry, original, padded, file } = edit;
  const buf = readEntryFast(entry);
  const text = buf.toString('utf8');
  const next = text.replace(original, padded);
  const nb = Buffer.from(next, 'utf8');
  if (nb.length !== entry.size) {
    console.error(`size drift in ${file} (${nb.length} != ${entry.size}); aborting`);
    process.exit(4);
  }
  edit.patched = nb;
  nb.copy(out, baseOffset + entry.offset);
  if (entry.node.integrity) {
    entry.node.integrity.hash = sha256(nb);
    if (Array.isArray(entry.node.integrity.blocks)) {
      const bs = entry.node.integrity.blockSize || 4194304;
      const blocks = [];
      for (let o = 0; o < nb.length; o += bs) blocks.push(sha256(nb.subarray(o, Math.min(o + bs, nb.length))));
      entry.node.integrity.blocks = blocks;
    }
  }
  console.log(`patched   : ${file}`);
}

// rewrite the header JSON in place (length must not change)
const newJson = Buffer.from(JSON.stringify(header), 'utf8');
if (newJson.length !== jsonLen) {
  console.error(`header JSON length changed (${jsonLen} -> ${newJson.length}); aborting`);
  process.exit(5);
}
newJson.copy(out, HEADER_JSON_OFFSET);

fs.writeFileSync(asarPath, out);
console.log(`wrote     : ${asarPath}  (${out.length} bytes, sha256 ${sha256(out)})`);

// ---------- verify -----------------------------------------------------------
const { header: h2 } = readHeader(asarPath);
const e2 = collectEntries(h2);
const m2 = new Map(e2.map((e) => [e.path, e]));
const after = fs.readFileSync(asarPath);
let same = 0, diff = 0, moved = 0, skipped = 0;
const touched = new Set(edits.map((x) => x.file));
for (const a of entries) {
  const b = m2.get(a.path);
  if (!b || a.offset !== b.offset || a.size !== b.size) { moved++; continue; }
  if (a.size === 0 || a.unpacked) { skipped++; continue; }   // unpacked entries keep no payload in the archive
  const ba = whole.subarray(baseOffset + a.offset, baseOffset + a.offset + a.size);
  const bb = after.subarray(baseOffset + b.offset, baseOffset + b.offset + b.size);
  if (ba.equals(bb)) same++;
  else if (touched.has(a.path)) diff++;
  else {
    console.error(`UNEXPECTED CHANGE OUTSIDE TARGETS: ${a.path}`);
    process.exit(6);
  }
}
console.log(`verify    : entries=${e2.length} identical=${same} patched=${diff} unpacked/skipped=${skipped} moved=${moved}`);
if (moved !== 0 || diff !== edits.length) {
  console.error('verification failed; restore from ' + backup);
  process.exit(7);
}

if (syntaxCheck) {
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'asar-check-'));
  let bad = 0;
  for (const edit of edits) {
    const dest = path.join(tmp, path.basename(edit.file).replace(/\.js$/, '') + '.mjs');
    fs.writeFileSync(dest, edit.patched.toString('utf8'));
    const r = spawnSync(process.execPath, ['--check', dest], { stdio: 'inherit' });
    if (r.status !== 0) { bad++; console.error('syntax check failed: ' + edit.file); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(bad === 0 ? 'syntax    : ok' : `syntax    : ${bad} FAILED`);
  if (bad !== 0) process.exit(8);
}
console.log('\nDone. Restart DeepSeek Harness for the change to take effect.');
