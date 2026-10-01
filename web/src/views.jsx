import { useEffect, useState } from 'react';
import { api, ApiError, navigate } from './api.js';
import { renderMarkdown } from '../../shared/markdown.js';

/** Load data from the API whenever `deps` change; returns [data, error, reload]. */
function useApi(path, deps = []) {
  const [state, setState] = useState({ data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ data: null, error: null });
    api(path)
      .then((data) => live && setState({ data, error: null }))
      .catch((error) => live && setState({ data: null, error }));
    return () => {
      live = false;
    };
  }, [...deps, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return [state.data, state.error, () => setTick((t) => t + 1)];
}

const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const Err = ({ error }) => (error ? <p className="error">{error.message}</p> : null);
const Tags = ({ tags }) => (
  <span className="tags">
    {(tags || '').split(',').filter(Boolean).map((t) => (
      <span key={t} className="tag">{t}</span>
    ))}
  </span>
);

/** Highlight query words inside plain text without using innerHTML. */
function Highlight({ text, query }) {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
  if (!words.length) return text;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

export function Login({ onLogin }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      onLogin(await api(`/auth/${mode}`, { method: 'POST', body: form }));
    } catch (err) {
      setError(err);
    }
  };
  return (
    <form className="card login" onSubmit={submit}>
      <h1>CrawlWiki</h1>
      <p className="muted">Team docs + crawled sources, one search box.</p>
      <input placeholder="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
      <input placeholder="Password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
      <Err error={error} />
      <button type="submit">{mode === 'login' ? 'Log in' : 'Create account'}</button>
      <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
        {mode === 'login' ? 'Need an account? Register' : 'Have an account? Log in'}
      </button>
    </form>
  );
}

export function Home() {
  const [data, error] = useApi('/pages');
  return (
    <section>
      <h2>Recently updated pages</h2>
      <Err error={error} />
      {data && data.pages.length === 0 && <p className="muted">No pages yet. <a href="#/new">Write the first one.</a></p>}
      <ul className="list">
        {data?.pages.map((p) => (
          <li key={p.id}>
            <a href={`#/page/${p.slug}`}>{p.title}</a> <Tags tags={p.tags} />
            <div className="muted small">v{p.version} · {p.updated_by ?? 'unknown'} · {fmt(p.updated_at)}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SearchResults({ query, type }) {
  const [data, error] = useApi(`/search?q=${encodeURIComponent(query)}&type=${type}&limit=50`, [query, type]);
  const tab = (t, label) => (
    <a className={type === t ? 'tab active' : 'tab'} href={`#/search?q=${encodeURIComponent(query)}&type=${t}`}>{label}</a>
  );
  return (
    <section>
      <div className="tabs">{tab('', 'All')}{tab('page', 'Pages')}{tab('item', 'Crawled')}</div>
      <Err error={error} />
      {data && <p className="muted small">{data.total} result{data.total === 1 ? '' : 's'} for “{query}”</p>}
      <ul className="list">
        {data?.results.map((r) => (
          <li key={r.id}>
            <span className={`badge ${r.type}`}>{r.type === 'page' ? 'page' : r.meta.sourceName}</span>{' '}
            <a href={r.type === 'page' ? `#/page/${r.meta.slug}` : `#/item/${r.meta.itemId}`}>
              <Highlight text={r.title} query={query} />
            </a>
            <div className="snippet"><Highlight text={r.snippet} query={query} /></div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PageView({ slug, user }) {
  const [data, error] = useApi(`/pages/${slug}`, [slug]);
  if (error) return <Err error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  const { page } = data;
  const remove = async () => {
    if (!confirm(`Delete "${page.title}"?`)) return;
    await api(`/pages/${slug}`, { method: 'DELETE' });
    navigate('/');
  };
  return (
    <article>
      <div className="toolbar">
        <a href={`#/page/${slug}/edit`}>Edit</a>
        <a href={`#/page/${slug}/history`}>History</a>
        {user.role === 'admin' && <button className="link danger" onClick={remove}>Delete</button>}
      </div>
      <h1>{page.title}</h1>
      <div className="muted small">
        v{page.version} · created by {page.author ?? 'unknown'} · last edit by {page.updated_by ?? 'unknown'} {fmt(page.updated_at)} <Tags tags={page.tags} />
      </div>
      <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(page.body) }} />
    </article>
  );
}

export function PageEditor({ slug }) {
  const [form, setForm] = useState({ title: '', body: '', tags: '', version: null });
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    if (!slug) return;
    api(`/pages/${slug}`)
      .then(({ page }) => setForm({ title: page.title, body: page.body, tags: page.tags, version: page.version }))
      .catch(setError);
  }, [slug]);

  const save = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const { page } = slug
        ? await api(`/pages/${slug}`, { method: 'PUT', body: form })
        : await api('/pages', { method: 'POST', body: form });
      navigate(`/page/${page.slug}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(new Error(`Conflict: ${err.body.current.updated_by} saved v${err.body.current.version} while you were editing. Copy your changes, then reload.`));
      } else setError(err);
    }
  };

  return (
    <form className="editor" onSubmit={save}>
      <h2>{slug ? `Editing v${form.version ?? '…'}` : 'New page'}</h2>
      <input placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      <input placeholder="Tags (comma separated)" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
      <div className="tabs">
        <button type="button" className={preview ? 'tab' : 'tab active'} onClick={() => setPreview(false)}>Write</button>
        <button type="button" className={preview ? 'tab active' : 'tab'} onClick={() => setPreview(true)}>Preview</button>
      </div>
      {preview ? (
        <div className="markdown card" dangerouslySetInnerHTML={{ __html: renderMarkdown(form.body) }} />
      ) : (
        <textarea rows={20} placeholder="Markdown. Link pages with [[page-slug]]." value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
      )}
      <Err error={error} />
      <div className="toolbar">
        <button type="submit">Save</button>
        <a href={slug ? `#/page/${slug}` : '#/'}>Cancel</a>
      </div>
    </form>
  );
}

export function History({ slug }) {
  const [data, error] = useApi(`/pages/${slug}/revisions`, [slug]);
  const [open, setOpen] = useState(null);
  return (
    <section>
      <h2>History of <a href={`#/page/${slug}`}>{slug}</a></h2>
      <Err error={error} />
      <ul className="list">
        {data?.revisions.map((r) => (
          <li key={r.version}>
            <button className="link" onClick={() => setOpen(open === r.version ? null : r.version)}>
              v{r.version} — {r.title}
            </button>
            <span className="muted small"> by {r.edited_by ?? 'unknown'} · {fmt(r.created_at)}</span>
            {open === r.version && <pre className="raw">{r.body}</pre>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ItemView({ id }) {
  const [data, error] = useApi(`/items/${id}`, [id]);
  if (error) return <Err error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  const { item } = data;
  return (
    <article>
      <span className="badge item">{item.source_name}</span>
      <h1>{item.title}</h1>
      <div className="muted small">
        <a href={item.url} target="_blank" rel="noopener noreferrer">{item.url}</a> · published {fmt(item.published_at)} · fetched {fmt(item.fetched_at)}
      </div>
      <div className="crawled">{item.content}</div>
    </article>
  );
}

export function Sources({ user }) {
  const [data, error, reload] = useApi('/sources');
  const [form, setForm] = useState({ name: '', url: '', kind: 'rss', max_pages: 25, interval_minutes: 60 });
  const [msg, setMsg] = useState(null);
  const isAdmin = user.role === 'admin';

  const run = async (fn) => {
    setMsg(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setMsg(err.message);
    }
  };
  const add = (e) => {
    e.preventDefault();
    run(async () => {
      await api('/sources', { method: 'POST', body: form });
      setForm({ ...form, name: '', url: '' });
    });
  };
  const crawl = (s) =>
    run(async () => {
      const { stats } = await api(`/sources/${s.id}/crawl`, { method: 'POST' });
      setMsg(`${s.name}: fetched ${stats.fetched}, +${stats.added} new, ${stats.updated} updated${stats.errors.length ? `, errors: ${stats.errors.join('; ')}` : ''}`);
    });
  const remove = (s) => confirm(`Delete source "${s.name}" and its items?`) && run(() => api(`/sources/${s.id}`, { method: 'DELETE' }));

  return (
    <section>
      <h2>Crawl sources</h2>
      <Err error={error} />
      {msg && <p className="notice">{msg}</p>}
      <table>
        <thead>
          <tr><th>Name</th><th>Kind</th><th>Items</th><th>Last crawl</th><th>Status</th>{isAdmin && <th />}</tr>
        </thead>
        <tbody>
          {data?.sources.map((s) => (
            <tr key={s.id}>
              <td><div>{s.name}</div><div className="muted small">{s.url}</div></td>
              <td>{s.kind}{s.kind === 'site' ? ` (≤${s.max_pages})` : ''}</td>
              <td>{s.item_count}</td>
              <td className="small">{fmt(s.last_crawled_at)}<div className="muted">every {s.interval_minutes} min</div></td>
              <td className="small">{s.last_status}{s.last_error && <div className="error">{s.last_error}</div>}</td>
              {isAdmin && (
                <td className="actions">
                  <button onClick={() => crawl(s)}>Crawl now</button>
                  <button className="link danger" onClick={() => remove(s)}>Delete</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {isAdmin && (
        <form className="card inline" onSubmit={add}>
          <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input placeholder="https://… feed or docs URL" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="rss">RSS / Atom feed</option>
            <option value="site">Docs site (BFS crawl)</option>
          </select>
          {form.kind === 'site' && (
            <input type="number" min="1" max="500" title="Max pages" value={form.max_pages} onChange={(e) => setForm({ ...form, max_pages: e.target.value })} />
          )}
          <input type="number" min="5" title="Interval (minutes)" value={form.interval_minutes} onChange={(e) => setForm({ ...form, interval_minutes: e.target.value })} />
          <button type="submit">Add source</button>
        </form>
      )}
    </section>
  );
}
