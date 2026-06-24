import { Bell } from 'lucide-react';

const TYPE_COLOR = {
  'Revenue Surge': 'text-sky-400 border-sky-500/30 bg-sky-500/10',
  'Profit Surge': 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
  'High Score': 'text-amber-300 border-amber-500/30 bg-amber-500/10',
  'All-Time High Score': 'text-fuchsia-300 border-fuchsia-500/30 bg-fuchsia-500/10',
};

export default function AlertsPanel({ alerts, onSelect }) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-3">
      <div className="mb-2 flex items-center gap-2 text-slate-200">
        <Bell className="h-4 w-4 text-amber-300" />
        <span className="text-sm font-medium">Alerts</span>
        {alerts.length > 0 && (
          <span className="ml-auto rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">
            {alerts.length}
          </span>
        )}
      </div>
      <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
        {alerts.length === 0 && (
          <p className="py-4 text-center text-xs text-slate-500">No alerts yet.</p>
        )}
        {alerts.map((a) => (
          <button
            key={a.Id}
            onClick={() => onSelect(a.Ticker)}
            className="flex w-full items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-2.5 py-2 text-left hover:border-slate-600"
          >
            <span
              className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
                TYPE_COLOR[a.Type] || 'text-slate-300 border-slate-600 bg-slate-700/40'
              }`}
            >
              {a.Type}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold text-slate-200">{a.Ticker}</span>
              <span className="block truncate text-[11px] text-slate-400">{a.Message}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
