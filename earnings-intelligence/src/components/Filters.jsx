import { Search, SlidersHorizontal, Star } from 'lucide-react';

const RATINGS = ['Exceptional', 'Strong', 'Average', 'Weak', 'Very Weak'];

const WINDOWS = [
  { value: '1', label: 'Last 1 day' },
  { value: '3', label: 'Last 3 days' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '0', label: 'All time' },
];

export default function Filters({ filters, setFilters, sectors, watchlistOnly, setWatchlistOnly }) {
  const update = (key, value) => setFilters((f) => ({ ...f, [key]: value }));

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-3">
      <div className="flex items-center gap-2 mb-3 text-slate-300">
        <SlidersHorizontal className="h-4 w-4" />
        <span className="text-sm font-medium">Filters</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2">
        <div className="relative col-span-2 sm:col-span-1 lg:col-span-2">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-500" />
          <input
            value={filters.search}
            onChange={(e) => update('search', e.target.value)}
            placeholder="Search ticker or company"
            className="w-full rounded-md border border-slate-700 bg-slate-900 pl-8 pr-2 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
          />
        </div>

        <select
          value={filters.recentDays}
          onChange={(e) => update('recentDays', e.target.value)}
          title="Only show results announced within this window"
          className="rounded-md border border-slate-700 bg-slate-900 px-2 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none"
        >
          {WINDOWS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </select>

        <select
          value={filters.sector}
          onChange={(e) => update('sector', e.target.value)}
          className="rounded-md border border-slate-700 bg-slate-900 px-2 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none"
        >
          <option value="">All Sectors</option>
          {sectors.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <select
          value={filters.rating}
          onChange={(e) => update('rating', e.target.value)}
          className="rounded-md border border-slate-700 bg-slate-900 px-2 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none"
        >
          <option value="">All Ratings</option>
          {RATINGS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-2 py-2">
          <span className="text-xs text-slate-400 whitespace-nowrap">Min Score</span>
          <input
            type="number"
            min="0"
            max="10"
            step="0.5"
            value={filters.minScore}
            onChange={(e) => update('minScore', e.target.value)}
            className="w-full bg-transparent text-sm text-slate-200 focus:outline-none"
          />
        </div>

        <button
          onClick={() => setWatchlistOnly((v) => !v)}
          className={`flex items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-sm font-medium transition ${
            watchlistOnly
              ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
              : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-600'
          }`}
        >
          <Star className={`h-4 w-4 ${watchlistOnly ? 'fill-amber-300' : ''}`} />
          Watchlist
        </button>
      </div>
    </div>
  );
}
