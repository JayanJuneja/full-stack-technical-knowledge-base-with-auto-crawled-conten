/**
 * Minimal robots.txt support (RFC 9309 subset): user-agent groups, Allow/Disallow,
 * `*` and `$` wildcards, longest-match-wins with Allow winning ties.
 */

/**
 * @param {string} text robots.txt body
 * @param {string} userAgent our crawler's product token, e.g. "CrawlWikiBot"
 * @returns {(path: string) => boolean} predicate: may we fetch this path (+query)?
 */
export function parseRobots(text, userAgent) {
  const groups = []; // { agents: string[], rules: {allow: boolean, pattern: string}[] }
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (current && (key === 'allow' || key === 'disallow') && value) {
        current.rules.push({ allow: key === 'allow', pattern: value });
      }
    }
  }

  const ua = userAgent.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules).map((r) => ({ ...r, re: patternToRegex(r.pattern) }));

  return (path) => {
    let best = null;
    for (const r of rules) {
      if (!r.re.test(path)) continue;
      if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) {
        best = r;
      }
    }
    return best ? best.allow : true;
  };
}

function patternToRegex(pattern) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}
