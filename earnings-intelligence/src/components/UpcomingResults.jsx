import { useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { api } from '../api.js';

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function daysUntil(iso) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  const n = Math.round((d - today) / 86400000);
  if (n <= 0) return 'today';
  if (n === 1) return 'in 1 day';
  return `in ${n} days`;
}

export default function UpcomingResults({ onSelect }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api
      .upcoming(10)
      .then((data) => alive && setItems(data))
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-3">
      <div className="mb-2 flex items-center gap-2 text-slate-200">
        <CalendarClock className="h-4 w-4 text-sky-300" />
        <span className="text-sm font-medium">Upcoming Results</span>
        {items.length > 0 && (
          <span className="ml-auto rounded-full bg-sky-500/15 px-2 py-0.5 text-xs text-sky-300">
            {items.length}
          </span>
        )}
      </div>
      <p className="mb-2 text-[11px] text-slate-500">
        Companies that have informed NSE of a board meeting to approve results.
      </p>
      <div className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
        {loading && <p className="py-4 text-center text-xs text-slate-500">Loading…</p>}
        {!loading && items.length === 0 && (
          <p className="py-4 text-center text-xs text-slate-500">
            No upcoming results in NSE's current calendar.
          </p>
        )}
        {items.map((u) => (
          <button
            key={`${u.ticker}-${u.meetingDate}`}
            onClick={() => onSelect?.(u.ticker)}
            className="flex w-full items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-2.5 py-2 text-left hover:border-slate-600"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold text-slate-200">{u.ticker}</span>
              <span className="block truncate text-[11px] text-slate-400">{u.company}</span>
              {u.quarter && (
                <span className="text-[10px] text-slate-500">{u.quarter}</span>
              )}
            </span>
            <span className="shrink-0 text-right">
              <span className="block text-xs font-medium text-sky-300 tabular-nums">
                {formatDate(u.meetingDate)}
              </span>
              <span className="block text-[10px] text-slate-500">{daysUntil(u.meetingDate)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
