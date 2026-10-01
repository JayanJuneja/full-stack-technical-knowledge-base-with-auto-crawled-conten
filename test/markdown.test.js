import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../shared/markdown.js';

test('renders headings, lists, emphasis and inline code', () => {
  const html = renderMarkdown('# Title\n\nSome **bold** and *em* and `x < y`.\n\n- a\n- b\n\n1. one\n2. two');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong> and <em>em<\/em> and <code>x &lt; y<\/code>/);
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(html, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
});

test('fenced code blocks are escaped and not parsed as markdown', () => {
  const html = renderMarkdown('```js\nconst a = "<b>**not bold**</b>";\n```');
  assert.equal(html, '<pre><code class="language-js">const a = &quot;&lt;b&gt;**not bold**&lt;/b&gt;&quot;;</code></pre>');
});

test('raw HTML and javascript: links are neutralised', () => {
  const html = renderMarkdown('<script>alert(1)</script> [click](javascript:alert(1)) <img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('javascript:'));
  assert.match(html, /<a href="#" rel="noopener noreferrer">click<\/a>/);
});

test('wiki links and normal links render', () => {
  const html = renderMarkdown('See [[deploy-runbook]] or [[onboarding|the intro]] and [docs](https://ex.com/a?b=1&c=2).');
  assert.match(html, /<a href="#\/page\/deploy-runbook" class="wikilink">deploy-runbook<\/a>/);
  assert.match(html, /<a href="#\/page\/onboarding" class="wikilink">the intro<\/a>/);
  assert.match(html, /href="https:\/\/ex.com\/a\?b=1&amp;c=2"/);
});
