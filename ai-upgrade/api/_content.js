// Loads the extracted notes corpus. Run `node tools/extract-content.mjs` first.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CACHE = new Map();
const DIR = join(process.cwd(), 'content');
const SLUG_RE = /^[a-z0-9-]{3,80}$/;   // never trust the client with a path

function loadPage(slug) {
  if (!SLUG_RE.test(slug)) return null;
  if (CACHE.has(slug)) return CACHE.get(slug);
  const f = join(DIR, slug + '.json');
  if (!existsSync(f)) return null;
  const data = JSON.parse(readFileSync(f, 'utf8'));
  CACHE.set(slug, data);
  return data;
}

/**
 * Returns everything a prompt needs for one topic on one page, or null.
 * The client only ever sends slug + topicKey — never the notes text itself.
 */
export function loadTopic(slug, topicKey) {
  const page = loadPage(slug);
  if (!page) return null;
  const t = page.topics?.[topicKey];
  if (!t) return null;
  return {
    num: page.num,
    title: page.title,
    label: t.label,
    tiers: t.tiers || [],
    qa: t.qa || [],
    keywords: t.keywords || [],
    sectionText: page.sections?.[t.section] || ''
  };
}
