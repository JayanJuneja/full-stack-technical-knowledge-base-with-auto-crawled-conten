import { useEffect, useState } from 'react';
import { api, getToken, setToken, navigate } from './api.js';
import { Login, Home, SearchResults, PageView, PageEditor, History, ItemView, Sources } from './views.jsx';

/** Parse `location.hash` (e.g. "#/page/foo/edit?x=1") into path segments + query. */
function useHashRoute() {
  const read = () => {
    const [path, qs = ''] = (window.location.hash.slice(1) || '/').split('?');
    return { parts: path.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(qs) };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(Boolean(getToken()));
  const route = useHashRoute();
  const [q, setQ] = useState(route.query.get('q') ?? '');

  useEffect(() => {
    if (!getToken()) return;
    api('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => setToken(null))
      .finally(() => setChecking(false));
  }, []);

  // Live search: debounce keystrokes into the #/search route.
  useEffect(() => {
    if (!user) return;
    const t = setTimeout(() => {
      if (q.trim()) navigate(`/search?q=${encodeURIComponent(q)}`);
      else if (route.parts[0] === 'search') navigate('/');
    }, 200);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  if (checking) return <div className="center">Loading…</div>;
  if (!user) {
    return (
      <Login
        onLogin={(r) => {
          setToken(r.token);
          setUser(r.user);
        }}
      />
    );
  }

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setToken(null);
    setUser(null);
  };

  const [section, slug, action] = route.parts;
  let view;
  if (section === 'search') view = <SearchResults query={route.query.get('q') ?? ''} type={route.query.get('type') ?? ''} />;
  else if (section === 'new') view = <PageEditor />;
  else if (section === 'page' && action === 'edit') view = <PageEditor slug={slug} />;
  else if (section === 'page' && action === 'history') view = <History slug={slug} />;
  else if (section === 'page') view = <PageView slug={slug} user={user} />;
  else if (section === 'item') view = <ItemView id={slug} />;
  else if (section === 'sources') view = <Sources user={user} />;
  else view = <Home />;

  return (
    <div className="app">
      <header>
        <a className="brand" href="#/" onClick={() => setQ('')}>
          CrawlWiki
        </a>
        <input className="search" placeholder="Search docs and crawled sources…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <nav>
          <a href="#/new">New page</a>
          <a href="#/sources">Sources</a>
          <span className="who">
            {user.username} <small>({user.role})</small>
          </span>
          <button className="link" onClick={logout}>
            Log out
          </button>
        </nav>
      </header>
      <main>{view}</main>
    </div>
  );
}
