import { useEffect, useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import {
  X,
  Star,
  ThumbsUp,
  ThumbsDown,
  AlertTriangle,
  Lightbulb,
  FileDown,
  Sheet,
} from 'lucide-react';
import { api } from '../api.js';
import { crore, pct, pctClass, ratingStyle, scoreColor, scoreLegend, trendStyle } from '../lib/format.js';

export default function DetailPanel({ ticker, onClose, onToggleWatch }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api
      .result(ticker)
      .then((d) => active && setData(d))
      .catch(() => active && setData(null))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [ticker]);

  const analysis = data?.analysis;
  const rs = data ? ratingStyle(data.Rating) : null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative h-full w-full max-w-2xl overflow-y-auto border-l border-slate-700 bg-slate-900 shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-slate-700 bg-slate-900/95 backdrop-blur px-5 py-4">
          {loading ? (
            <div className="text-slate-400">Loading {ticker}…</div>
          ) : !data ? (
            <div>
              <h2 className="text-xl font-bold text-slate-100">{ticker}</h2>
              <p className="text-sm text-slate-400">No reported results yet</p>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold text-slate-100">{data.Ticker}</h2>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${rs.bg} ${rs.text} ${rs.border}`}
                >
                  {data.Rating}
                </span>
                <span className={`text-lg font-bold cursor-help ${scoreColor(data.Score)}`} title={scoreLegend(data.Score)}>
                  {data.Score?.toFixed(1)}
                </span>
              </div>
              <p className="text-sm text-slate-400">
                {data.CompanyName} · {data.Sector} · {data.Quarter}
              </p>
            </div>
          )}
          <div className="flex items-center gap-1">
            {data && (
              <>
                <button
                  onClick={() => exportCSV(data)}
                  title="Export CSV (Excel)"
                  className="rounded-md p-2 text-slate-400 hover:bg-slate-800 hover:text-emerald-400"
                >
                  <Sheet className="h-4 w-4" />
                </button>
                <button
                  onClick={() => window.print()}
                  title="Export PDF (print)"
                  className="rounded-md p-2 text-slate-400 hover:bg-slate-800 hover:text-emerald-400"
                >
                  <FileDown className="h-4 w-4" />
                </button>
                <button
                  onClick={() => onToggleWatch(data.Ticker, data.CompanyName, data.watched)}
                  title="Toggle watchlist"
                  className="rounded-md p-2 text-slate-400 hover:bg-slate-800 hover:text-amber-300"
                >
                  <Star className={`h-4 w-4 ${data.watched ? 'fill-amber-300 text-amber-300' : ''}`} />
                </button>
              </>
            )}
            <button
              onClick={onClose}
              className="rounded-md p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {!loading && !data && (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
            <AlertTriangle className="h-10 w-10 text-amber-400/80" />
            <p className="text-base font-semibold text-slate-200">No results reported yet</p>
            <p className="max-w-sm text-sm text-slate-400">
              {ticker} has an upcoming board meeting to approve its financial results, but
              hasn't filed them with NSE yet. Detailed metrics, charts and AI analysis will
              appear here once the results are published.
            </p>
          </div>
        )}

        {data && (
          <div className="space-y-5 p-5">
            {/* Financial metrics */}
            <Section title="Financial Metrics">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Metric label="Revenue" value={crore(data.Revenue)} />
                <Metric label="EBITDA" value={crore(data.EBITDA)} />
                <Metric label="PAT" value={crore(data.PAT)} />
                <Metric label="EPS" value={data.EPS == null ? '—' : `₹${data.EPS.toFixed(2)}`} />
                <Metric label="EBITDA Margin" value={data.EBITDAMargin == null ? '—' : `${data.EBITDAMargin.toFixed(1)}%`} />
                <Metric label="Debt" value={crore(data.Debt)} />
                <Metric label="Cash" value={crore(data.Cash)} />
                <Metric label="Trend" value={data.Trend} valueClass={trendStyle(data.Trend)} />
              </div>
            </Section>

            {/* Growth metrics */}
            <Section title="Growth Metrics">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Metric label="Revenue QoQ" value={pct(data.RevenueGrowthQoQ)} valueClass={pctClass(data.RevenueGrowthQoQ)} />
                <Metric label="Revenue YoY" value={pct(data.RevenueGrowthYoY)} valueClass={pctClass(data.RevenueGrowthYoY)} />
                <Metric label="EBITDA QoQ" value={pct(data.EBITDAGrowthQoQ)} valueClass={pctClass(data.EBITDAGrowthQoQ)} />
                <Metric label="EBITDA YoY" value={pct(data.EBITDAGrowthYoY)} valueClass={pctClass(data.EBITDAGrowthYoY)} />
                <Metric label="PAT QoQ" value={pct(data.PATGrowthQoQ)} valueClass={pctClass(data.PATGrowthQoQ)} />
                <Metric label="PAT YoY" value={pct(data.PATGrowthYoY)} valueClass={pctClass(data.PATGrowthYoY)} />
                <Metric label="Margin Δ" value={data.MarginChange == null ? '—' : `${data.MarginChange >= 0 ? '+' : ''}${data.MarginChange.toFixed(1)} pp`} valueClass={pctClass(data.MarginChange)} />
              </div>
            </Section>

            {/* Last 3 quarters comparison */}
            <QuarterComparison history={data.history} />

            {/* Charts */}
            <Section title="Trends (recent quarters)">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Chart title="Revenue" type="bar" data={data.history} dataKey="revenue" color="#38bdf8" />
                <Chart title="PAT" type="bar" data={data.history} dataKey="pat" color="#34d399" />
                <Chart title="EBITDA" type="bar" data={data.history} dataKey="ebitda" color="#a78bfa" />
                <Chart title="Earnings Score" type="line" data={data.history} dataKey="score" color="#fbbf24" domain={[0, 10]} />
              </div>
            </Section>

            {/* AI analysis */}
            {analysis && (
              <Section title="AI Analysis">
                {analysis.summary && (
                  <p className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-sm leading-relaxed text-slate-300">
                    {analysis.summary}
                  </p>
                )}
                <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <ListBlock title="Positives" items={analysis.positives} icon={ThumbsUp} color="text-emerald-400" />
                  <ListBlock title="Negatives" items={analysis.negatives} icon={ThumbsDown} color="text-rose-400" />
                  <ListBlock title="Risks" items={analysis.risks} icon={AlertTriangle} color="text-amber-400" />
                  <ListBlock title="Opportunities" items={analysis.opportunities} icon={Lightbulb} color="text-sky-400" />
                </div>
              </Section>
            )}

            {data.RawText && (
              <Section title="Filing Text">
                <p className="rounded-lg border border-slate-700 bg-slate-800/40 p-3 text-xs leading-relaxed text-slate-400">
                  {data.RawText}
                </p>
              </Section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h3>
      {children}
    </section>
  );
}

// Side-by-side comparison of the latest quarter vs the previous 3 quarters,
// with QoQ deltas so you can judge the trajectory at a glance.
function QuarterComparison({ history }) {
  const quarters = (history || []).slice(-4); // latest + previous 3
  if (quarters.length < 2) {
    return (
      <Section title="Last 3 Quarters Comparison">
        <p className="rounded-lg border border-slate-700 bg-slate-800/40 p-3 text-xs text-slate-400">
          Only one quarter is available from NSE for this company, so a multi-quarter comparison
          isn't possible yet.
        </p>
      </Section>
    );
  }

  const rows = [
    { key: 'revenue', label: 'Revenue', fmt: crore, pctDelta: true },
    { key: 'ebitda', label: 'EBITDA', fmt: crore, pctDelta: true },
    { key: 'pat', label: 'PAT', fmt: crore, pctDelta: true },
    { key: 'eps', label: 'EPS', fmt: (v) => (v == null ? '—' : `₹${Number(v).toFixed(2)}`), pctDelta: true },
    { key: 'ebitdaMargin', label: 'EBITDA Margin', fmt: (v) => (v == null ? '—' : `${Number(v).toFixed(1)}%`), ppDelta: true },
    { key: 'score', label: 'Score', fmt: (v) => (v == null ? '—' : Number(v).toFixed(1)), scoreCell: true },
  ];

  return (
    <Section title="Last 3 Quarters Comparison">
      <div className="overflow-x-auto rounded-lg border border-slate-700 bg-slate-800/60">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-700 text-left text-slate-400">
              <th className="px-3 py-2 font-medium">Metric</th>
              {quarters.map((q, i) => (
                <th key={q.quarter} className="px-3 py-2 font-medium whitespace-nowrap text-right">
                  {q.quarter}
                  {i === quarters.length - 1 && (
                    <span className="ml-1 rounded bg-emerald-500/15 px-1 text-[9px] text-emerald-300">latest</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-slate-800 last:border-0">
                <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{row.label}</td>
                {quarters.map((q, i) => {
                  const val = q[row.key];
                  const prev = i > 0 ? quarters[i - 1][row.key] : null;
                  let delta = null;
                  if (i > 0 && val != null && prev != null) {
                    if (row.ppDelta) delta = { text: `${val - prev >= 0 ? '+' : ''}${(val - prev).toFixed(1)} pp`, up: val - prev >= 0 };
                    else if (row.pctDelta && prev !== 0) {
                      const d = ((val - prev) / Math.abs(prev)) * 100;
                      delta = { text: `${d >= 0 ? '+' : ''}${d.toFixed(0)}%`, up: d >= 0 };
                    }
                  }
                  return (
                    <td key={q.quarter} className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
                      <span className={row.scoreCell ? scoreColor(val) : 'text-slate-200'} title={row.scoreCell ? scoreLegend(val) : undefined}>
                        {row.fmt(val)}
                      </span>
                      {delta && (
                        <span className={`ml-1.5 text-[10px] ${delta.up ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {delta.text}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[10px] text-slate-500">
        Deltas show the change versus the immediately preceding quarter (QoQ).
      </p>
    </Section>
  );
}

function Metric({ label, value, valueClass = 'text-slate-100' }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-2.5">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}

function ListBlock({ title, items, icon: Icon, color }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
      <div className={`mb-2 flex items-center gap-1.5 text-sm font-medium ${color}`}>
        <Icon className="h-4 w-4" />
        {title}
      </div>
      <ul className="space-y-1.5">
        {(items?.length ? items : ['—']).map((it, i) => (
          <li key={i} className="flex gap-2 text-xs text-slate-300">
            <span className={`mt-1.5 h-1 w-1 shrink-0 rounded-full ${color.replace('text', 'bg')}`} />
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Chart({ title, type, data, dataKey, color, domain }) {
  const chartData = (data || []).map((d) => ({ ...d, label: d.quarter?.replace(' FY', "'") }));
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
      <div className="mb-2 text-xs font-medium text-slate-300">{title}</div>
      <ResponsiveContainer width="100%" height={140}>
        {type === 'bar' ? (
          <BarChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: '#94a3b8', fontSize: 10 }} />
            <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} />
            <Tooltip
              contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: '#e2e8f0' }}
            />
            <Bar dataKey={dataKey} fill={color} radius={[3, 3, 0, 0]} />
          </BarChart>
        ) : (
          <LineChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: '#94a3b8', fontSize: 10 }} />
            <YAxis domain={domain || ['auto', 'auto']} tick={{ fill: '#94a3b8', fontSize: 10 }} />
            <Tooltip
              contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: '#e2e8f0' }}
            />
            <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} dot={{ r: 3, fill: color }} />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

function exportCSV(data) {
  const rows = [
    ['Metric', 'Value'],
    ['Ticker', data.Ticker],
    ['Company', data.CompanyName],
    ['Sector', data.Sector],
    ['Quarter', data.Quarter],
    ['Revenue (Cr)', data.Revenue],
    ['EBITDA (Cr)', data.EBITDA],
    ['PAT (Cr)', data.PAT],
    ['EPS', data.EPS],
    ['EBITDA Margin %', data.EBITDAMargin],
    ['Revenue Growth QoQ %', data.RevenueGrowthQoQ],
    ['Revenue Growth YoY %', data.RevenueGrowthYoY],
    ['PAT Growth QoQ %', data.PATGrowthQoQ],
    ['PAT Growth YoY %', data.PATGrowthYoY],
    ['Score', data.Score],
    ['Rating', data.Rating],
  ];
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${data.Ticker}_${data.Quarter.replace(/\s/g, '_')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
