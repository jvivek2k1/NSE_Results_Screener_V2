import { Star, X, Pin } from 'lucide-react';
import { scoreColor } from '../lib/format.js';

export default function WatchlistPanel({ items, onSelect, onRemove, onPin }) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-3">
      <div className="mb-2 flex items-center gap-2 text-slate-200">
        <Star className="h-4 w-4 text-amber-300" />
        <span className="text-sm font-medium">Watchlist</span>
        {items.length > 0 && (
          <span className="ml-auto rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">
            {items.length}
          </span>
        )}
      </div>
      <div className="max-h-60 space-y-1.5 overflow-y-auto pr-1">
        {items.length === 0 && (
          <p className="py-4 text-center text-xs text-slate-500">
            Star a company to track it here.
          </p>
        )}
        {items.map((w) => (
          <div
            key={w.Ticker}
            className="group flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-2.5 py-2"
          >
            <button onClick={() => onPin(w.Ticker)} title="Pin">
              <Pin
                className={`h-3.5 w-3.5 ${
                  w.Pinned ? 'fill-amber-300 text-amber-300' : 'text-slate-500 hover:text-amber-300'
                }`}
              />
            </button>
            <button
              onClick={() => onSelect(w.Ticker)}
              className="min-w-0 flex-1 text-left"
            >
              <span className="block text-xs font-semibold text-slate-200">{w.Ticker}</span>
              <span className="block truncate text-[11px] text-slate-400">{w.CompanyName}</span>
            </button>
            <button
              onClick={() => onRemove(w.Ticker)}
              className="text-slate-500 opacity-0 transition hover:text-rose-400 group-hover:opacity-100"
              title="Remove"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
