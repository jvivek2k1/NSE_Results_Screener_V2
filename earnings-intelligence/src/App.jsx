import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { api } from './api.js';
import { useLive } from './hooks/useLive.js';
import Header from './components/Header.jsx';
import StatCards from './components/StatCards.jsx';
import Filters from './components/Filters.jsx';
import ResultsTable from './components/ResultsTable.jsx';
import DetailPanel from './components/DetailPanel.jsx';
import AlertsPanel from './components/AlertsPanel.jsx';
import Leaderboard from './components/Leaderboard.jsx';
import WatchlistPanel from './components/WatchlistPanel.jsx';
import UpcomingResults from './components/UpcomingResults.jsx';
import DbStatusBanner from './components/DbStatusBanner.jsx';
import AiStatusBanner from './components/AiStatusBanner.jsx';

const PAGE_SIZE = 25;

export default function App() {
  const [meta, setMeta] = useState(null);
  const [stats, setStats] = useState(null);
  const [sectors, setSectors] = useState([]);
  const [results, setResults] = useState([]);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  const [filters, setFilters] = useState({ search: '', sector: '', rating: '', minScore: '', recentDays: '1' });
  const [watchlistOnly, setWatchlistOnly] = useState(false);

  const [alerts, setAlerts] = useState([]);
  const [watchlist, setWatchlist] = useState([]);
  const [selectedTicker, setSelectedTicker] = useState(null);
  const [flashed, setFlashed] = useState(new Set());
  const [refreshKey, setRefreshKey] = useState(0);
  const [toasts, setToasts] = useState([]);

  const watchedSet = new Set(watchlist.map((w) => w.Ticker));

  // ---- Loaders ----
  const loadResults = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.results({
        page,
        limit: PAGE_SIZE,
        search: filters.search,
        sector: filters.sector,
        rating: filters.rating,
        minScore: filters.minScore,
        recentDays: filters.recentDays,
        watchlist: watchlistOnly ? 'true' : '',
      });
      setResults(res.rows);
      setTotalPages(res.totalPages);
    } finally {
      setLoading(false);
    }
  }, [page, filters, watchlistOnly]);

  const loadStats = useCallback(
    () =>
      api
        .stats({
          search: filters.search,
          sector: filters.sector,
          rating: filters.rating,
          minScore: filters.minScore,
          recentDays: filters.recentDays,
          watchlist: watchlistOnly ? 'true' : '',
        })
        .then(setStats)
        .catch(() => {}),
    [filters, watchlistOnly]
  );
  const loadMeta = useCallback(() => api.meta().then(setMeta).catch(() => {}), []);
  const loadAlerts = useCallback(() => api.alerts(30).then(setAlerts).catch(() => {}), []);
  const loadWatchlist = useCallback(
    () => api.watchlist().then(setWatchlist).catch(() => {}),
    []
  );
  const loadSectors = useCallback(() => api.sectors().then(setSectors).catch(() => {}), []);

  useEffect(() => {
    loadSectors();
    loadMeta();
    loadAlerts();
    loadWatchlist();
  }, [loadSectors, loadMeta, loadAlerts, loadWatchlist]);

  // Send the "application opened" email once, when the dashboard first loads.
  useEffect(() => {
    api.notifyOpen().catch(() => {});
  }, []);

  // Debounce filter-driven reloads. Stats mirror the same filters so the
  // summary cards (Results Today / Strong / Average / Weak / Highest) always
  // reflect exactly what the table is showing for the selected day window.
  useEffect(() => {
    const id = setTimeout(() => {
      loadResults();
      loadStats();
    }, 250);
    return () => clearTimeout(id);
  }, [loadResults, loadStats]);

  // Dynamic auto-refresh: re-pull everything every 10 minutes so the dashboard
  // stays current (the backend re-scans NSE, reads new result PDFs and rescores
  // against the last quarters continuously).
  useEffect(() => {
    const REFRESH_MS = 10 * 60 * 1000;
    const id = setInterval(() => {
      loadResults();
      loadStats();
      loadMeta();
      loadAlerts();
      loadWatchlist();
      setRefreshKey((k) => k + 1);
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [loadResults, loadStats, loadMeta, loadAlerts, loadWatchlist]);

  // Hard auto-refresh: reload the whole page every 15 seconds. This keeps the
  // dashboard self-healing during transient backend/DB outages — once the
  // backend recovers, the next reload pulls a healthy page instead of leaving
  // the user stuck on a stale view or a gateway 502.
  useEffect(() => {
    const PAGE_RELOAD_MS = 15 * 1000;
    const id = setInterval(() => {
      window.location.reload();
    }, PAGE_RELOAD_MS);
    return () => clearInterval(id);
  }, []);

  // Reset to page 1 when filters change.
  useEffect(() => {
    setPage(1);
  }, [filters, watchlistOnly]);

  // ---- Live updates (SSE) ----
  const flash = useCallback((ticker) => {
    setFlashed((prev) => new Set(prev).add(ticker));
    setTimeout(() => {
      setFlashed((prev) => {
        const next = new Set(prev);
        next.delete(ticker);
        return next;
      });
    }, 2600);
  }, []);

  const pushToast = useCallback((toast) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, ...toast }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const { connected, dbStatus: liveDbStatus, aiStatus: liveAiStatus } = useLive({
    onResult: (row) => {
      flash(row.Ticker);
      loadResults();
      loadStats();
      setRefreshKey((k) => k + 1);
    },
    onAlert: (alert) => {
      setAlerts((a) => [alert, ...a].slice(0, 30));
      pushToast({ title: `${alert.Type}: ${alert.Ticker}`, body: alert.Message });
    },
    onScan: () => {
      loadMeta();
    },
    onConnect: () => {
      // Fires when the SSE stream connects (API now reachable). Re-pull all
      // dashboard data so a slow backend startup doesn't leave the UI empty.
      loadResults();
      loadStats();
      loadMeta();
      loadSectors();
      loadAlerts();
      loadWatchlist();
    },
  });

  // Prefer the live SSE status; fall back to the value embedded in /api/meta.
  const dbStatus = liveDbStatus ?? meta?.dbStatus ?? null;
  const aiStatus = liveAiStatus ?? meta?.aiHealth ?? null;

  // The dashboard is only "LIVE" when the SSE stream is connected AND neither
  // the database nor the AI model connection has explicitly failed. A failure
  // of either dependency flips the header indicator from LIVE to OFFLINE.
  const dbDown = dbStatus?.ok === false;
  const aiDown = aiStatus?.ok === false && !aiStatus?.skipped;
  const isLive = connected && !dbDown && !aiDown;

  // ---- Actions ----
  const handleScan = async () => {
    setScanning(true);
    try {
      await api.scan();
      await Promise.all([loadResults(), loadStats(), loadMeta()]);
      setRefreshKey((k) => k + 1);
    } finally {
      setScanning(false);
    }
  };

  const toggleWatch = async (ticker, companyName, isWatched) => {
    if (isWatched) await api.removeWatch(ticker);
    else await api.addWatch(ticker, companyName);
    loadWatchlist();
  };

  // ---- SRE chaos demo ----
  const [chaosBusy, setChaosBusy] = useState(false);
  const handleChaos = async (action) => {
    const spec = {
      'disable-sql-public-access': {
        call: api.chaosDisableSqlPublicAccess,
        confirm:
          'Disable Azure SQL public network access? The app will lose its database connection and the db-connectivity alert will fire.',
        title: 'Disabling SQL public access',
      },
      'remove-ai-model': {
        call: api.chaosRemoveAiModel,
        confirm:
          'Remove the AI model deployment? AI calls will start failing and the ai-connectivity alert will fire.',
        title: 'Removing AI model',
      },
      'sql-cpu-100': {
        call: api.chaosSqlCpu100,
        confirm:
          'Drive Azure SQL CPU to 100%? Untuned report queries will full-scan a large table in parallel, app responses will degrade, and the SQL CPU alert (>= 85%) will fire. The SRE Agent diagnoses and remediates it.',
        title: 'Spiking SQL CPU to 100%',
      },
    }[action];
    if (!spec) return;
    if (!window.confirm(spec.confirm)) return;
    setChaosBusy(true);
    try {
      const res = await spec.call();
      pushToast({ title: spec.title, body: res?.message || 'Action triggered.' });
    } catch (err) {
      pushToast({ title: `${spec.title} — failed`, body: err?.message || 'Request failed.' });
    } finally {
      setChaosBusy(false);
    }
  };

  const exportAllCSV = () => {
    const header = [
      'Ticker', 'Company', 'Sector', 'Quarter', 'Revenue', 'EBITDA', 'PAT', 'EPS',
      'RevGrowthQoQ', 'RevGrowthYoY', 'PATGrowthQoQ', 'PATGrowthYoY', 'Score', 'Rating',
    ];
    const lines = results.map((r) =>
      [r.Ticker, r.CompanyName, r.Sector, r.Quarter, r.Revenue, r.EBITDA, r.PAT, r.EPS,
       r.RevenueGrowthQoQ, r.RevenueGrowthYoY, r.PATGrowthQoQ, r.PATGrowthYoY, r.Score, r.Rating]
        .map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')
    );
    const csv = [header.join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'earnings_results.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200">
      <Header
        meta={meta}
        connected={isLive}
        totalCompanies={meta?.companiesProcessed ?? stats?.companiesProcessed}
        onScan={handleScan}
        scanning={scanning}
        onChaos={handleChaos}
        chaosBusy={chaosBusy}
      />

      <DbStatusBanner dbStatus={dbStatus} />
      <AiStatusBanner aiStatus={aiStatus} />

      <main className="mx-auto max-w-[1600px] px-4 py-5 space-y-5">
        <StatCards stats={stats} />

        <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-5">
          {/* Left: filters + table */}
          <div className="space-y-4 min-w-0">
            <Filters
              filters={filters}
              setFilters={setFilters}
              sectors={sectors}
              watchlistOnly={watchlistOnly}
              setWatchlistOnly={setWatchlistOnly}
            />

            <div className="flex items-center justify-between">
              <p className="text-sm text-slate-400">
                Sorted by score · page {page} of {totalPages}
              </p>
              <button
                onClick={exportAllCSV}
                className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-300 hover:border-slate-600"
              >
                <Download className="h-3.5 w-3.5" />
                Export CSV
              </button>
            </div>

            <ResultsTable
              rows={results}
              flashed={flashed}
              watchedSet={watchedSet}
              onSelect={setSelectedTicker}
              onToggleWatch={toggleWatch}
              loading={loading}
            />

            <div className="flex items-center justify-center gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm disabled:opacity-40 hover:border-slate-600"
              >
                <ChevronLeft className="h-4 w-4" /> Prev
              </button>
              <span className="text-sm text-slate-400 tabular-nums">
                {page} / {totalPages}
              </span>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm disabled:opacity-40 hover:border-slate-600"
              >
                Next <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Right: sidebar */}
          <aside className="space-y-4">
            <UpcomingResults onSelect={setSelectedTicker} />
            <AlertsPanel alerts={alerts} onSelect={setSelectedTicker} />
            <WatchlistPanel
              items={watchlist}
              onSelect={setSelectedTicker}
              onRemove={async (t) => {
                await api.removeWatch(t);
                loadWatchlist();
              }}
              onPin={async (t) => {
                await api.pinWatch(t);
                loadWatchlist();
              }}
            />
            <Leaderboard refreshKey={refreshKey} onSelect={setSelectedTicker} />
          </aside>
        </div>
      </main>

      <footer className="border-t border-slate-700 py-5 text-center text-sm text-slate-500">
        JBSWiki
      </footer>

      {selectedTicker && (
        <DetailPanel
          ticker={selectedTicker}
          onClose={() => setSelectedTicker(null)}
          onToggleWatch={async (t, name, isW) => {
            await toggleWatch(t, name, isW);
            setSelectedTicker((cur) => cur); // keep open
          }}
        />
      )}

      {/* Toasts */}
      <div className="fixed bottom-4 right-4 z-[60] space-y-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="w-72 rounded-lg border border-emerald-500/40 bg-slate-800 px-4 py-3 shadow-lg"
          >
            <div className="text-sm font-semibold text-emerald-300">{t.title}</div>
            <div className="text-xs text-slate-300">{t.body}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
