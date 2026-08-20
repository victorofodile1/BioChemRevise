#!/usr/bin/env node
/**
 * Extracts the TOPICS object and the plain text of each notes section
 * out of every page in notes/ and writes content/<slug>.json.
 *
 *   node ai-upgrade/tools/extract-content.mjs
 *
 * Re-run this whenever you edit a notes page. Commit the output.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOTES = join(ROOT, 'notes');
const OUT = join(ROOT, 'content');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

/** Pull `const TOPICS = { … };` out of the page and evaluate it safely. */
function extractTopics(html) {
  const start = html.indexOf('const TOPICS = {');
  if (start === -1) return null;
  // walk braces to find the matching close, ignoring braces inside strings
  let i = html.indexOf('{', start), depth = 0, quote = null, esc = false;
  for (; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  const literal = html.slice(html.indexOf('{', start), i + 1);
  // no globals, no require, no network — just evaluates an object literal
  return vm.runInNewContext('(' + literal + ')', Object.create(null), { timeout: 1000 });
}

/** Plain text of one <section id="sN"> … </section> (or div), tags stripped. */
function sectionText(html, id) {
  const re = new RegExp(`<(section|div)[^>]*\\bid="${id}"[^>]*>`, 'i');
  const m = re.exec(html);
  if (!m) return '';
  const tag = m[1];
  let i = m.index + m[0].length, depth = 1;
  const open = new RegExp(`<${tag}\\b`, 'gi'), close = new RegExp(`</${tag}>`, 'gi');
  const rest = html.slice(i);
  let pos = 0;
  while (depth > 0) {
    open.lastIndex = close.lastIndex = pos;
    const o = open.exec(rest), c = close.exec(rest);
    if (!c) break;
    if (o && o.index < c.index) { depth++; pos = o.index + 1; }
    else { depth--; pos = c.index + 1; if (depth === 0) { pos = c.index; break; } }
  }
  return rest.slice(0, pos)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&rsaquo;/g, '>').replace(/&mdash;/g, '—')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

const files = readdirSync(NOTES).filter(f => f.endsWith('.html')).sort();
let ok = 0, skipped = [];

for (const f of files) {
  const html = readFileSync(join(NOTES, f), 'utf8');
  const slug = f.replace(/\.html$/, '');
  let topics;
  try { topics = extractTopics(html); }
  catch (e) { skipped.push([slug, 'TOPICS parse: ' + e.message]); continue; }
  if (!topics) { skipped.push([slug, 'no TOPICS object']); continue; }

  const title = (/<h1 class="page-title">([\s\S]*?)<\/h1>/.exec(html) || [, ''])[1]
    .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
  const num = (/<title>([\d.]+)/.exec(html) || [, ''])[1];

  const sections = {};
  for (const key of Object.keys(topics)) {
    const id = topics[key].section;
    if (id && !sections[id]) sections[id] = sectionText(html, id);
  }

  writeFileSync(
    join(OUT, slug + '.json'),
    JSON.stringify({ slug, num, title, topics, sections }, null, 1)
  );
  ok++;
}

console.log(`wrote ${ok} files to content/`);
if (skipped.length) { console.log('skipped:'); skipped.forEach(s => console.log('  ', ...s)); }
