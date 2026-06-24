import { Star } from 'lucide-react';
import { pct, pctClass, ratingStyle, scoreColor, scoreLegend, SCORE_SCALE } from '../lib/format.js';

const COLS = [
  { label: 'Filed to NSE', title: 'Date/time the result was disseminated to NSE (can be much later than the quarter-end for delayed filers)' },
  { label: 'Ticker' },
  { label: 'Company' },
  { label: 'Quarter' },
  { label: 'Results', title: 'Whether the financial figures for this filing are available' },
  { label: 'Rev QoQ' },
  { label: 'Rev YoY' },
  { label: 'PAT QoQ' },
  { label: 'PAT YoY' },
  { label: 'Score', title: SCORE_SCALE },
  { label: 'Rating' },
  { label: '' },
];

export default function ResultsTable({
  rows,
  flashed,
  watchedSet,
  onSelect,
  onToggleWatch,
  loading,
}) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/60 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-700 text-left text-xs uppercase tracking-wide text-slate-400">
              {COLS.map((c) => (
                <th
                  key={c.label}
                  title={c.title || undefined}
                  className={`px-3 py-2.5 font-medium whitespace-nowrap ${
                    c.title ? 'cursor-help' : ''
                  }`}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr>
                <td colSpan={COLS.length} className="px-3 py-10 text-center text-slate-500">
                  Loading results…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={COLS.length} className="px-3 py-10 text-center text-slate-500">
                  No results announced in the selected window. Try widening the time window above.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const rs = ratingStyle(r.Rating);
              const isWatched = watchedSet.has(r.Ticker);
              return (
                <tr
                  key={r.Id}
                  onClick={() => onSelect(r.Ticker)}
                  className={`border-b border-slate-800 hover:bg-slate-700/40 cursor-pointer ${
                    flashed.has(r.Ticker) ? 'flash-row' : ''
                  }`}
                >
                  <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap tabular-nums">
                    {new Date(r.AnnouncementTime).toLocaleString('en-IN', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="px-3 py-2.5 font-semibold text-slate-100 whitespace-nowrap">
                    {r.Ticker}
                  </td>
                  <td className="px-3 py-2.5 text-slate-300 max-w-[220px] truncate">
                    {r.CompanyName}
                  </td>
                  <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap">{r.Quarter}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    {r.Revenue != null ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-300">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                        Available
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-300">
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                        Awaited
                      </span>
                    )}
                  </td>
                  <td className={`px-3 py-2.5 tabular-nums ${pctClass(r.RevenueGrowthQoQ)}`}>
                    {pct(r.RevenueGrowthQoQ)}
                  </td>
                  <td className={`px-3 py-2.5 tabular-nums ${pctClass(r.RevenueGrowthYoY)}`}>
                    {pct(r.RevenueGrowthYoY)}
                  </td>
                  <td className={`px-3 py-2.5 tabular-nums ${pctClass(r.PATGrowthQoQ)}`}>
                    {pct(r.PATGrowthQoQ)}
                  </td>
                  <td className={`px-3 py-2.5 tabular-nums ${pctClass(r.PATGrowthYoY)}`}>
                    {pct(r.PATGrowthYoY)}
                  </td>
                  <td className={`px-3 py-2.5 font-bold tabular-nums cursor-help ${scoreColor(r.Score)}`} title={scoreLegend(r.Score)}>
                    {r.Score?.toFixed(1)}
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${rs.bg} ${rs.text} ${rs.border}`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${rs.dot}`} />
                      {r.Rating}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleWatch(r.Ticker, r.CompanyName, isWatched);
                      }}
                      className="text-slate-500 hover:text-amber-300"
                      title={isWatched ? 'Remove from watchlist' : 'Add to watchlist'}
                    >
                      <Star
                        className={`h-4 w-4 ${isWatched ? 'fill-amber-300 text-amber-300' : ''}`}
                      />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
