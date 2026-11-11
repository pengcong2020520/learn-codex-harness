import fs from 'node:fs';
import path from 'node:path';

export const repositoryUrl = 'https://github.com/pengcong2020520/learn-codex-harness/blob/main';
export const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
// Anchors depend only on the canonical term, never on ordering, stage or definition.
export const termId = term => 'term-' + term.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

export function validateGlossary(rows, {repository, stages}) {
  if (!Array.isArray(rows)) throw Error('Glossary must be an array');
  const known = new Set(['intro', ...stages.map(stage => stage.id)]), terms = new Set(), anchors = new Set();
  for (const row of rows) {
    if (!row || ['term','source'].some(key => typeof row[key] !== 'string' || !row[key].trim()) ||
        ['short','detail'].some(key => typeof row[key] !== 'string' || (row[key] !== '' && !row[key].trim())) ||
        ['aka','related'].some(key => !Array.isArray(row[key]) || row[key].some(item => typeof item !== 'string' || !item.trim()))) throw Error('Invalid glossary fields');
    if (!known.has(row.stage)) throw Error(`Invalid glossary stage: ${row.stage}`);
    if (terms.has(row.term)) throw Error(`Duplicate glossary term: ${row.term}`);
    terms.add(row.term);
    const id = termId(row.term);
    if (id === 'term-' || anchors.has(id)) throw Error(`Duplicate or empty glossary anchor: ${row.term}`);
    anchors.add(id);
    const file = row.source.split('#')[0];
    if (!file || path.isAbsolute(file) || file.includes('\\') || file.split('/').includes('..') || /^[a-z]+:/i.test(file)) throw Error(`Invalid glossary source: ${row.source}`);
    const target = path.join(repository, file);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw Error(`Missing glossary source: ${file}`);
    const relative = path.relative(fs.realpathSync(repository), fs.realpathSync(target));
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw Error(`Invalid glossary source: ${row.source}`);
  }
  for (const row of rows) for (const term of row.related) if (!terms.has(term)) throw Error(`Unknown related term: ${row.term} → ${term}`);
  return rows;
}

export function sourceUrl(source) {
  const [file, ...fragment] = source.split('#');
  // Data uses heading text after #; GitHub lowercases and removes punctuation.
  const anchor = fragment.join('#').toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
  return `${repositoryUrl}/${file.split('/').map(encodeURIComponent).join('/')}${fragment.length ? '#' + encodeURIComponent(anchor) : ''}`;
}

const decodeHtml = text => text.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, entity => {
  if (entity.startsWith('&#')) return String.fromCodePoint(entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3),16) : parseInt(entity.slice(2),10));
  return {'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':'\u00a0'}[entity.toLowerCase()];
});

export function linkGlossaryTerms(html, glossary) {
  // Canonical names take precedence over aliases; matching stays case-sensitive and exact.
  const names = new Map(glossary.map(row => [row.term, row]));
  for (const row of glossary) for (const aka of row.aka) if (!names.has(aka)) names.set(aka, row);
  return html.replace(/<span\b([^>]*\bclass="[^"]*\bterm\b[^"]*"[^>]*)>([^<]*)<\/span>/g, (original, attributes, text) => {
    if (!/\bdata-definition="[^"]*"/.test(attributes)) return original;
    const row = names.get(decodeHtml(text));
    if (!row || !row.short) return original;
    const updated = attributes.replace(/\bdata-definition="[^"]*"/, () => `data-definition="${escapeHtml(row.short)}"`);
    return `<a${updated} href="/course/glossary.html#${escapeHtml(termId(row.term))}">${text}</a>`;
  });
}
