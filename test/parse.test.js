import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, extractHtml, decodeEntities, htmlToText } from '../server/crawler/parse.js';
import { parseRobots } from '../server/crawler/robots.js';

test('decodeEntities handles named and numeric entities', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#39;x&#x27; &unknown;'), "a & b <c> 'x' &unknown;");
});

test('htmlToText strips scripts and keeps block structure', () => {
  const text = htmlToText('<p>Hello <b>world</b></p><script>evil()</script><ul><li>one</li><li>two</li></ul>');
  assert.equal(text, 'Hello world\none\ntwo');
});

test('parseFeed reads RSS 2.0 with escaped HTML and CDATA content', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Eng Blog</title>
    <item><title>First &amp; best</title><link>https://ex.com/a</link>
      <description>&lt;p&gt;Escaped &lt;b&gt;html&lt;/b&gt;&lt;/p&gt;</description>
      <pubDate>Mon, 03 Jun 2024 09:00:00 GMT</pubDate></item>
    <item><title><![CDATA[Second]]></title><link>/relative</link>
      <content:encoded><![CDATA[<p>Rich <em>content</em></p>]]></content:encoded></item>
    <item><title>No link, skipped</title></item>
  </channel></rss>`;
  const feed = parseFeed(xml, 'https://ex.com/feed.xml');
  assert.equal(feed.title, 'Eng Blog');
  assert.equal(feed.items.length, 2);
  assert.deepEqual(feed.items[0], {
    title: 'First & best',
    url: 'https://ex.com/a',
    content: 'Escaped html',
    publishedAt: '2024-06-03T09:00:00.000Z',
  });
  assert.equal(feed.items[1].url, 'https://ex.com/relative');
  assert.equal(feed.items[1].content, 'Rich content');
  assert.equal(feed.items[1].publishedAt, null);
});

test('parseFeed reads Atom entries and prefers the alternate link', () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Docs</title>
    <entry><title type="html">Release 2.0</title>
      <link rel="self" href="https://ex.com/self"/><link rel="alternate" href="https://ex.com/release-2"/>
      <updated>2024-01-02T03:04:05Z</updated><summary>Big release</summary></entry></feed>`;
  const feed = parseFeed(xml);
  assert.equal(feed.title, 'Atom Docs');
  assert.equal(feed.items[0].url, 'https://ex.com/release-2');
  assert.equal(feed.items[0].content, 'Big release');
  assert.equal(feed.items[0].publishedAt, '2024-01-02T03:04:05.000Z');
});

test('extractHtml scopes text to <main>, collects absolute links, reads robots meta', () => {
  const html = `<html><head><title>Guide</title><meta name="robots" content="noindex, nofollow"></head><body>
    <nav><a href="other.html">Other</a> <a href="#top">Top</a> <a href="mailto:x@y">Mail</a>
    <a href="/private" rel="nofollow">P</a></nav>
    <main><h1>Install</h1><p>Run the installer.</p></main><footer>Copyright</footer></body></html>`;
  const page = extractHtml(html, 'https://docs.ex.com/v1/guide.html');
  assert.equal(page.title, 'Guide');
  assert.equal(page.text, 'Install\nRun the installer.');
  assert.deepEqual(page.links, ['https://docs.ex.com/v1/other.html']);
  assert.equal(page.noindex, true);
  assert.equal(page.nofollow, true);
});

test('robots.txt: specific group beats *, longest match wins, wildcards work', () => {
  const allowed = parseRobots(
    `User-agent: *\nDisallow: /\n\nUser-agent: CrawlWikiBot\nUser-agent: OtherBot\nDisallow: /private/\nAllow: /private/public-*\nDisallow: /*.pdf$\n`,
    'CrawlWikiBot',
  );
  assert.equal(allowed('/docs/intro'), true);
  assert.equal(allowed('/private/secret'), false);
  assert.equal(allowed('/private/public-notes'), true);
  assert.equal(allowed('/files/a.pdf'), false);
  assert.equal(allowed('/files/a.pdf?x=1'), true);

  const generic = parseRobots('User-agent: *\nDisallow: /admin', 'CrawlWikiBot');
  assert.equal(generic('/admin/users'), false);
  assert.equal(generic('/docs'), true);
  assert.equal(parseRobots('', 'CrawlWikiBot')('/anything'), true);
});
