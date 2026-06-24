// Formatting + style helpers shared across components.

export function crore(value) {
  if (value == null) return '—';
  const n = Number(value);
  if (n >= 100000) return `₹${(n / 1000).toFixed(1)}K Cr`;
  return `₹${n.toLocaleString('en-IN')} Cr`;
}

export function pct(value) {
  if (value == null) return '—';
  const n = Number(value);
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

export function pctClass(value) {
  if (value == null) return 'text-slate-400';
  return Number(value) >= 0 ? 'text-emerald-400' : 'text-rose-400';
}

// Rating -> tailwind color set
export function ratingStyle(rating) {
  switch (rating) {
    case 'Exceptional':
      return { text: 'text-emerald-300', bg: 'bg-emerald-500/15', border: 'border-emerald-500/40', dot: 'bg-emerald-400' };
    case 'Strong':
      return { text: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', dot: 'bg-emerald-400' };
    case 'Average':
      return { text: 'text-yellow-300', bg: 'bg-yellow-500/10', border: 'border-yellow-500/30', dot: 'bg-yellow-400' };
    case 'Weak':
      return { text: 'text-rose-300', bg: 'bg-rose-500/10', border: 'border-rose-500/30', dot: 'bg-rose-400' };
    default:
      return { text: 'text-rose-400', bg: 'bg-rose-500/15', border: 'border-rose-500/40', dot: 'bg-rose-500' };
  }
}

export function scoreColor(score) {
  if (score >= 9) return 'text-emerald-300';
  if (score >= 7) return 'text-emerald-400';
  if (score >= 5) return 'text-yellow-300';
  if (score >= 3) return 'text-rose-300';
  return 'text-rose-400';
}

// The 0–10 earnings-quality scale, used for hover tooltips.
export const SCORE_SCALE =
  'Earnings-quality score (0–10): 0–2 Very Weak · 3–4 Weak · 5–6 Average · 7–8 Strong · 9–10 Exceptional';

export function scoreBand(score) {
  if (score == null) return 'No score';
  if (score >= 9) return 'Exceptional';
  if (score >= 7) return 'Strong';
  if (score >= 5) return 'Average';
  if (score >= 3) return 'Weak';
  return 'Very Weak';
}

// Tooltip text for an individual score, e.g.
// "8.4 / 10 — Strong.  Scale: 0–2 Very Weak · 3–4 Weak · ..."
export function scoreLegend(score) {
  if (score == null) return SCORE_SCALE;
  return `${Number(score).toFixed(1)} / 10 — ${scoreBand(score)}.\n${SCORE_SCALE}`;
}

export function trendStyle(trend) {
  switch (trend) {
    case 'Improving':
      return 'text-emerald-400';
    case 'Deteriorating':
      return 'text-rose-400';
    default:
      return 'text-slate-300';
  }
}
