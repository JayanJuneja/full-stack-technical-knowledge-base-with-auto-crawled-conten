/**
 * Small, safe Markdown renderer shared by the React UI and the tests.
 *
 * Safety model: all input is HTML-escaped *before* any markup is generated, and link
 * targets are restricted to http(s), relative paths and fragments — so user-authored
 * pages cannot inject script. Supports headings, fenced code, lists, blockquotes,
 * paragraphs, inline code, bold, italic, links and wiki links (`[[page-slug]]`).
 */

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function safeHref(url) {
  const u = url.trim();
  return /^(https?:\/\/|\/|#|\.{0,2}\/)/i.test(u) || /^[\w-]+(\.html?)?$/.test(u) ? u : '#';
}

/** Render inline markup on an already-escaped line. */
function inline(escaped) {
  const codes = [];
  let s = escaped.replace(/`([^`]+)`/g, (_m, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\[\[([a-z0-9-]+)(?:\|([^\]]+))?\]\]/g, (_m, slug, label) => `<a href="#/page/${slug}" class="wikilink">${label ?? slug}</a>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) => `<a href="${safeHref(url)}" rel="noopener noreferrer">${text}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
}

/**
 * @param {string} markdown
 * @returns {string} HTML
 */
export function renderMarkdown(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { tag: 'ul'|'ol', items: string[] }

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = escapeHtml(lines[i]);
    const fence = lines[i].match(/^```\s*([\w+-]*)/);
    if (fence) {
      flushPara();
      flushList();
      const code = [];
      while (++i < lines.length && !lines[i].startsWith('```')) code.push(escapeHtml(lines[i]));
      const cls = fence[1] ? ` class="language-${fence[1]}"` : '';
      out.push(`<pre><code${cls}>${code.join('\n')}</code></pre>`);
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara();
      flushList();
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    } else if ((m = line.match(/^\s*([-*]|\d+\.)\s+(.*)$/))) {
      flushPara();
      const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push(m[2]);
    } else if ((m = line.match(/^&gt;\s?(.*)$/))) {
      flushPara();
      flushList();
      out.push(`<blockquote>${inline(m[1])}</blockquote>`);
    } else if (line.trim() === '') {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return out.join('\n');
}
