import { useEffect, useState } from 'react';
import { Activity, RefreshCw, Building2, Clock } from 'lucide-react';

// Returns the wall-clock time (HH:MM:SS) of the next scheduled scan, rolling
// forward whenever the previous target passes so it never gets stuck on "now".
function useNextScan(lastScanAt, intervalMs = 600000) {
  const [label, setLabel] = useState('—');
  useEffect(() => {
    const tick = () => {
      if (!lastScanAt || !intervalMs) {
        setLabel('—');
        return;
      }
      const base = new Date(lastScanAt).getTime();
      let next = base + intervalMs;
      const now = Date.now();
      if (next <= now) {
        // Roll forward to the next future interval boundary from the last scan.
        const missed = Math.ceil((now - base) / intervalMs);
        next = base + missed * intervalMs;
        if (next <= now) next += intervalMs;
      }
      setLabel(new Date(next).toLocaleTimeString('en-IN'));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lastScanAt, intervalMs]);
  return label;
}

export default function Header({ meta, connected, totalCompanies, onScan, scanning }) {
  const nextScan = useNextScan(meta?.lastScanAt, meta?.scanIntervalMs);
  const lastRefresh = meta?.lastScanAt
    ? new Date(meta.lastScanAt).toLocaleTimeString('en-IN')
    : '—';

  return (
    <header className="border-b border-slate-700 bg-slate-900/80 backdrop-blur sticky top-0 z-30">
      <div className="mx-auto max-w-[1600px] px-4 py-3 flex flex-wrap items-center gap-4 justify-between">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-emerald-500/15 border border-emerald-500/30">
            <Activity className="h-5 w-5 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-100 leading-tight">
              Indian Earnings Intelligence
            </h1>
            <p className="text-xs text-slate-400">
              AI-powered NSE / BSE quarterly results screener
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <Metric
            icon={Clock}
            label="Last Refresh"
            value={lastRefresh}
            title="Time of the most recent completed scan (auto-refreshes every 10 minutes)."
          />
          <Metric
            icon={RefreshCw}
            label="Next Scan"
            value={nextScan}
            title="Scheduled time of the next automatic scan."
          />
          <Metric
            icon={Building2}
            label="Companies"
            value={totalCompanies ?? '—'}
            title="Number of distinct companies analysed so far. This grows as more NSE filings are scanned."
          />

          <div className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                connected ? 'bg-emerald-400 live-dot' : 'bg-rose-500'
              }`}
            />
            <span className="text-xs font-medium text-slate-300">
              {connected ? 'LIVE' : 'OFFLINE'}
            </span>
          </div>

          <button
            onClick={onScan}
            disabled={scanning}
            className="flex items-center gap-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-3 py-1.5 text-xs font-semibold text-white transition"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${scanning ? 'animate-spin' : ''}`} />
            Scan Now
          </button>
        </div>
      </div>
    </header>
  );
}

function Metric({ icon: Icon, label, value, title }) {
  return (
    <div className="flex items-center gap-2" title={title}>
      <Icon className="h-4 w-4 text-slate-500" />
      <div className="leading-tight">
        <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
        <div className="text-slate-200 font-medium tabular-nums">{value}</div>
      </div>
    </div>
  );
}
