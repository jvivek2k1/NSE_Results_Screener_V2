// Tiny fetch wrapper around the backend API (proxied via Vite to :3001).
const BASE = '/api';

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}
async function send(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.json();
}

export const api = {
  results: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v != null)
    ).toString();
    return get(`/results${qs ? `?${qs}` : ''}`);
  },
  result: (ticker) => get(`/result/${ticker}`),
  topScores: (limit = 5) => get(`/top-scores?limit=${limit}`),
  stats: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v != null)
    ).toString();
    return get(`/stats${qs ? `?${qs}` : ''}`);
  },
  meta: () => get('/meta'),
  sectors: () => get('/sectors'),
  leaderboard: () => get('/leaderboard'),
  movers: (direction) => get(`/movers?direction=${direction}`),
  alerts: (limit = 30) => get(`/alerts?limit=${limit}`),
  upcoming: (limit = 10) => get(`/upcoming?limit=${limit}`),
  notifyOpen: () => send('POST', '/notify-open'),
  watchlist: () => get('/watchlist'),
  addWatch: (ticker, companyName) => send('POST', '/watchlist', { ticker, companyName }),
  removeWatch: (ticker) => send('DELETE', `/watchlist/${ticker}`),
  pinWatch: (ticker) => send('POST', `/watchlist/${ticker}/pin`),
  scan: () => send('POST', '/scan'),
  // SRE chaos demo actions
  chaosDisableSqlPublicAccess: () => send('POST', '/chaos/disable-sql-public-access'),
  chaosRemoveAiModel: () => send('POST', '/chaos/remove-ai-model'),
  chaosSqlCpu100: () => send('POST', '/chaos/sql-cpu-100'),
};
