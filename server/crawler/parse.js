/**
 * Dependency-free parsers for the two kinds of content the crawler ingests:
 * RSS 2.0 / Atom feeds and HTML documentation pages. They are deliberately
 * forgiving (regex-based) because real-world feeds are frequently malformed.
 */

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©' };

/** Decode named and numeric HTML/XML entities. */
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

const BLOCK_TAGS = /<\/?(p|div|br|li|ul|ol|h[1-6]|pre|tr|table|section|article|blockquote|dd|dt)\b[^>]*>/gi;

/** Convert an HTML fragment into readable plain text. */
export function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, '')
      .replace(BLOCK_TAGS, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n[\s]*/g, '\n')
    .trim();
}

function unwrapCdata(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/** Inner content of the first `<name>` element in `xml`, or null. */
function tagText(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? unwrapCdata(m[1]).trim() : null;
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3]) : null;
}

function toIso(date) {
  if (!date) return null;
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Parse an RSS 2.0 or Atom document.
 * @param {string} xml
 * @param {string} [baseUrl] Used to resolve relative item links.
 * @returns {{title: string|null, items: Array<{title: string, url: string, content: string, publishedAt: string|null}>}}
 */
export function parseFeed(xml, baseUrl) {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  const channelXml = xml.replace(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi, '');
  const feedTitle = tagText(channelXml, 'title');

  const items = [];
  for (const block of blocks) {
    let link;
    if (isAtom) {
      const links = block.match(/<link\b[^>]*>/gi) ?? [];
      const alt = links.find((l) => !attr(l, 'rel') || attr(l, 'rel') === 'alternate') ?? links[0];
      link = alt ? attr(alt, 'href') : null;
      link ??= tagText(block, 'id');
    } else {
      link = tagText(block, 'link') || tagText(block, 'guid');
    }
    if (!link) continue;
    try {
      link = new URL(decodeEntities(link), baseUrl).href;
    } catch {
      continue;
    }
    const rawBody =
      tagText(block, 'content:encoded') ?? tagText(block, 'content') ?? tagText(block, 'description') ?? tagText(block, 'summary') ?? '';
    // Feed bodies are usually entity-escaped HTML: decode once, then strip tags.
    const content = htmlToText(/<[a-z]/i.test(rawBody) ? rawBody : decodeEntities(rawBody));
    items.push({
      title: htmlToText(tagText(block, 'title') ?? '') || link,
      url: link,
      content,
      publishedAt: toIso(tagText(block, 'pubDate') ?? tagText(block, 'published') ?? tagText(block, 'updated') ?? tagText(block, 'dc:date')),
    });
  }
  return { title: feedTitle ? htmlToText(feedTitle) : null, items };
}

/**
 * Extract title, main text, outgoing links and robots meta directives from an HTML page.
 * Prefers `<main>` / `<article>` content and drops navigation chrome from the text,
 * but collects links from the whole document (doc-site sidebars are how we discover pages).
 */
export function extractHtml(html, pageUrl) {
  const robotsMeta = (html.match(/<meta\b[^>]*name\s*=\s*["']robots["'][^>]*>/i) ?? [''])[0];
  const robots = (attr(robotsMeta, 'content') ?? '').toLowerCase();

  const links = new Set();
  for (const a of html.match(/<a\b[^>]*>/gi) ?? []) {
    const href = attr(a, 'href');
    if (!href || /^(mailto:|javascript:|tel:|#)/i.test(href)) continue;
    if ((attr(a, 'rel') ?? '').includes('nofollow')) continue;
    try {
      const u = new URL(href, pageUrl);
      u.hash = '';
      if (u.protocol === 'http:' || u.protocol === 'https:') links.add(u.href);
    } catch {
      /* ignore malformed hrefs */
    }
  }

  const scope =
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ??
    html;
  const text = htmlToText(scope.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ''));
  const title = htmlToText(tagText(html, 'title') ?? tagText(html, 'h1') ?? '') || pageUrl;

  return {
    title,
    text,
    links: [...links],
    noindex: robots.includes('noindex'),
    nofollow: robots.includes('nofollow'),
  };
}
