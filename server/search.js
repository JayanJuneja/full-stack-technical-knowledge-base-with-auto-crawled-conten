/**
 * In-memory BM25 search index shared by authored pages and crawled items.
 *
 * The database is the source of truth; the index is rebuilt from it at startup and
 * updated incrementally on every write, so search never touches SQL. Title terms are
 * weighted more heavily than body terms (a simple BM25F variant), the last query term
 * is prefix-expanded for type-ahead, and results carry a plain-text snippet.
 */

const STOPWORDS = new Set(
  'a an and are as at be but by for from has have how i if in into is it its of on or that the this to was were what when where which who why will with you your'.split(' '),
);
const TITLE_WEIGHT = 3;
const K1 = 1.2;
const B = 0.75;
const MAX_PREFIX_EXPANSIONS = 20;

/** Very light English stemmer: enough to match "crawlers"/"crawler", "indexing"/"index". */
export function stem(word) {
  if (word.length <= 4 || /[^a-z]/.test(word)) return word;
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.endsWith('ing') && word.length > 6) return word.slice(0, -3);
  if (word.endsWith('ed') && word.length > 5) return word.slice(0, -2);
  if (word.endsWith('es') && /(ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * Split text into normalized, stemmed tokens (stopwords removed).
 * Technical compounds like `node.js` or `max_pages` are kept whole *and* split
 * into their parts, so both "node.js" and "node" match.
 */
export function tokenize(text) {
  const out = [];
  const push = (w) => {
    if (!STOPWORDS.has(w)) out.push(stem(w));
  };
  for (const raw of String(text).toLowerCase().match(/[a-z0-9][a-z0-9+#._-]*[a-z0-9+#]|[a-z0-9]/g) ?? []) {
    push(raw);
    if (/[._-]/.test(raw)) for (const part of raw.split(/[._-]+/)) if (part) push(part);
  }
  return out;
}

/**
 * @typedef {object} IndexedDoc
 * @property {string} title
 * @property {string} body
 * @property {string} type   'page' | 'item'
 * @property {object} [meta] Arbitrary data returned with results (slug, url, ...).
 */

export class SearchIndex {
  constructor() {
    /** @type {Map<string, Map<string, number>>} term -> (docId -> weighted tf) */
    this.postings = new Map();
    /** @type {Map<string, {doc: IndexedDoc, len: number, terms: string[]}>} */
    this.docs = new Map();
    this.totalLen = 0;
  }

  get size() {
    return this.docs.size;
  }

  /** Add or replace a document. */
  add(id, doc) {
    if (this.docs.has(id)) this.remove(id);
    const tf = new Map();
    const titleTokens = tokenize(doc.title);
    const bodyTokens = tokenize(doc.body);
    for (const t of titleTokens) tf.set(t, (tf.get(t) ?? 0) + TITLE_WEIGHT);
    for (const t of bodyTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [term, w] of tf) {
      let list = this.postings.get(term);
      if (!list) this.postings.set(term, (list = new Map()));
      list.set(id, w);
    }
    const len = titleTokens.length * TITLE_WEIGHT + bodyTokens.length;
    this.docs.set(id, { doc, len, terms: [...tf.keys()] });
    this.totalLen += len;
  }

  remove(id) {
    const entry = this.docs.get(id);
    if (!entry) return;
    for (const term of entry.terms) {
      const list = this.postings.get(term);
      list.delete(id);
      if (list.size === 0) this.postings.delete(term);
    }
    this.totalLen -= entry.len;
    this.docs.delete(id);
  }

  /** Expand the final query term to vocabulary terms sharing its prefix. */
  #expand(term, isLast) {
    if (!isLast || term.length < 3) return [[term, 1]];
    const out = this.postings.has(term) ? [[term, 1]] : [];
    for (const vocab of this.postings.keys()) {
      if (out.length >= MAX_PREFIX_EXPANSIONS) break;
      if (vocab !== term && vocab.startsWith(term)) out.push([vocab, 0.5]);
    }
    return out;
  }

  /**
   * Rank documents for a free-text query.
   * @param {string} query
   * @param {{type?: string, limit?: number, offset?: number}} [opts]
   * @returns {{total: number, results: Array<{id: string, score: number, title: string, type: string, snippet: string, meta?: object}>}}
   */
  search(query, { type, limit = 20, offset = 0 } = {}) {
    const raw = String(query).trim();
    const terms = [...new Set(tokenize(raw))];
    if (terms.length === 0 || this.docs.size === 0) return { total: 0, results: [] };
    const N = this.docs.size;
    const avgdl = this.totalLen / N || 1;
    const scores = new Map();
    const prefixLast = !/\s$/.test(String(query));

    terms.forEach((qt, i) => {
      for (const [term, boost] of this.#expand(qt, prefixLast && i === terms.length - 1)) {
        const list = this.postings.get(term);
        if (!list) continue;
        const idf = Math.log(1 + (N - list.size + 0.5) / (list.size + 0.5));
        for (const [id, tf] of list) {
          const { len, doc } = this.docs.get(id);
          if (type && doc.type !== type) continue;
          const s = boost * idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * len) / avgdl)));
          scores.set(id, (scores.get(id) ?? 0) + s);
        }
      }
    });

    const phrase = raw.toLowerCase();
    const ranked = [];
    for (const [id, score] of scores) {
      const { doc } = this.docs.get(id);
      const bonus = phrase.length > 2 && doc.title.toLowerCase().includes(phrase) ? 2 : 0;
      ranked.push({ id, score: score + bonus });
    }
    ranked.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));

    const results = ranked.slice(offset, offset + limit).map(({ id, score }) => {
      const { doc } = this.docs.get(id);
      return {
        id,
        score: Math.round(score * 1000) / 1000,
        title: doc.title,
        type: doc.type,
        snippet: makeSnippet(doc.body, raw),
        meta: doc.meta,
      };
    });
    return { total: ranked.length, results };
  }
}

/** Return a ~200 char window of `body` around the earliest query word found in it. */
export function makeSnippet(body, query, width = 200) {
  const text = String(body).replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  let pos = -1;
  for (const word of query.toLowerCase().split(/\W+/).filter((w) => w.length > 1)) {
    for (const candidate of [word, stem(word)]) {
      const p = lower.indexOf(candidate);
      if (p !== -1 && (pos === -1 || p < pos)) pos = p;
    }
  }
  if (pos === -1) return text.slice(0, width) + (text.length > width ? '…' : '');
  const start = Math.max(0, pos - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}
