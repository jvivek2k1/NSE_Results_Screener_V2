import { useEffect, useState } from 'react';
import { Trophy, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { api } from '../api.js';
import { scoreColor, pct, pctClass } from '../lib/format.js';

export default function Leaderboard({ refreshKey, onSelect }) {
  const [tab, setTab] = useState('sectors');
  const [sectors, setSectors] = useState([]);
  const [improving, setImproving] = useState([]);
  const [deteriorating, setDeteriorating] = useState([]);

  useEffect(() => {
    api.leaderboard().then(setSectors).catch(() => {});
    api.movers('improving').then(setImproving).catch(() => {});
    api.movers('deteriorating').then(setDeteriorating).catch(() => {});
  }, [refreshKey]);

  const tabs = [
    { id: 'sectors', label: 'Sectors' },
    { id: 'improving', label: 'Improving' },
    { id: 'deteriorating', label: 'Deteriorating' },
  ];

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-3">
      <div className="mb-2 flex items-center gap-2 text-slate-200">
        <Trophy className="h-4 w-4 text-emerald-400" />
        <span className="text-sm font-medium">Leaderboards</span>
      </div>
      <div className="mb-2 flex gap-1 rounded-lg bg-slate-900/60 p-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition ${
              tab === t.id ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
        {tab === 'sectors' &&
          sectors.map((s, i) => (
            <div
              key={s.sector}
              className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-2.5 py-2"
            >
              <span className="w-5 text-xs text-slate-500">#{i + 1}</span>
              <span className="flex-1 text-xs font-medium text-slate-200">{s.sector}</span>
              <span className="text-[11px] text-slate-500">{s.companies} co.</span>
              <span className={`text-sm font-bold tabular-nums ${scoreColor(s.avgScore)}`}>
                {s.avgScore?.toFixed(1)}
              </span>
            </div>
          ))}

        {tab === 'improving' &&
          mover(improving, onSelect, true)}
        {tab === 'deteriorating' &&
          mover(deteriorating, onSelect, false)}
      </div>
    </div>
  );
}

function mover(rows, onSelect, up) {
  if (!rows.length)
    return <p className="py-4 text-center text-xs text-slate-500">No companies.</p>;
  return rows.map((r) => (
    <button
      key={r.Id}
      onClick={() => onSelect(r.Ticker)}
      className="flex w-full items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-2.5 py-2 text-left hover:border-slate-600"
    >
      {up ? (
        <ArrowUpRight className="h-4 w-4 shrink-0 text-emerald-400" />
      ) : (
        <ArrowDownRight className="h-4 w-4 shrink-0 text-rose-400" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold text-slate-200">{r.Ticker}</span>
        <span className="block truncate text-[11px] text-slate-400">{r.CompanyName}</span>
      </span>
      <span className={`text-xs tabular-nums ${pctClass(r.PATGrowthYoY)}`}>
        {pct(r.PATGrowthYoY)}
      </span>
    </button>
  ));
}
