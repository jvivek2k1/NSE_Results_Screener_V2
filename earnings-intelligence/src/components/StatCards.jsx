import { CalendarClock, TrendingUp, Minus, TrendingDown, Trophy } from 'lucide-react';
import { scoreColor, scoreLegend } from '../lib/format.js';

export default function StatCards({ stats }) {
  const cards = [
    {
      label: 'Results Today',
      value: stats?.resultsToday ?? 0,
      icon: CalendarClock,
      color: 'text-sky-400',
      ring: 'border-sky-500/30',
    },
    {
      label: 'Strong Results',
      value: stats?.strongResults ?? 0,
      icon: TrendingUp,
      color: 'text-emerald-400',
      ring: 'border-emerald-500/30',
    },
    {
      label: 'Average Results',
      value: stats?.averageResults ?? 0,
      icon: Minus,
      color: 'text-yellow-300',
      ring: 'border-yellow-500/30',
    },
    {
      label: 'Weak Results',
      value: stats?.weakResults ?? 0,
      icon: TrendingDown,
      color: 'text-rose-400',
      ring: 'border-rose-500/30',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
      {cards.map((c) => (
        <div
          key={c.label}
          className={`rounded-xl border ${c.ring} bg-slate-800/60 p-4 flex items-center justify-between`}
        >
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-400">{c.label}</div>
            <div className={`mt-1 text-3xl font-bold tabular-nums ${c.color}`}>{c.value}</div>
          </div>
          <c.icon className={`h-8 w-8 ${c.color} opacity-70`} />
        </div>
      ))}

      <div className="rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-slate-800/60 p-4 flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-slate-400">Highest Score Today</div>
          {stats?.highestScoreToday ? (
            <>
              <div
                className={`mt-1 text-3xl font-bold tabular-nums cursor-help ${scoreColor(stats.highestScoreToday.score)}`}
                title={scoreLegend(stats.highestScoreToday.score)}
              >
                {stats.highestScoreToday.score}
              </div>
              <div className="truncate text-xs text-slate-300">
                {stats.highestScoreToday.ticker}
              </div>
            </>
          ) : (
            <div className="mt-1 text-2xl font-bold text-slate-500">—</div>
          )}
        </div>
        <Trophy className="h-8 w-8 text-emerald-400 opacity-70" />
      </div>
    </div>
  );
}
