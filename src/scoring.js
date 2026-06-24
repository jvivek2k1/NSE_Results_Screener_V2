// ============================================================
// Scoring engine: growth metrics, trend detection, and the
// weighted 0-10 earnings-quality score.
// ============================================================

export const SCORE_WEIGHTS = {
  revenueGrowth: 0.2,
  patGrowth: 0.25,
  ebitdaGrowth: 0.2,
  marginExpansion: 0.15,
  guidance: 0.1,
  debtReduction: 0.1,
};

function pct(curr, prev) {
  if (prev == null || prev === 0) return 0;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

// history: array ascending by quarterIndex (objects with revenue/ebitda/pat/...).
// Growth metrics are returned as `null` when there is no genuine comparison
// quarter available, so the UI/narrative can honestly show "n/a" instead of 0%.
export function computeMetrics(history) {
  const n = history.length;
  const latest = history[n - 1];
  const hasPrev = n >= 2;
  const hasYoY = n >= 5;
  const prev = hasPrev ? history[n - 2] : null;
  const yoy = hasYoY ? history[n - 5] : null;

  const revenueGrowthQoQ = hasPrev ? round(pct(latest.revenue, prev.revenue), 2) : null;
  const revenueGrowthYoY = hasYoY ? round(pct(latest.revenue, yoy.revenue), 2) : null;
  const ebitdaGrowthQoQ = hasPrev ? round(pct(latest.ebitda, prev.ebitda), 2) : null;
  const ebitdaGrowthYoY = hasYoY ? round(pct(latest.ebitda, yoy.ebitda), 2) : null;
  const patGrowthQoQ = hasPrev ? round(pct(latest.pat, prev.pat), 2) : null;
  const patGrowthYoY = hasYoY ? round(pct(latest.pat, yoy.pat), 2) : null;
  const marginChange =
    hasPrev && latest.ebitdaMargin != null && prev.ebitdaMargin != null
      ? round(latest.ebitdaMargin - prev.ebitdaMargin, 2)
      : null;

  // Trend over the last (up to) 4 quarters of PAT.
  const trend = detectTrend(history.slice(-4).map((h) => h.pat));

  return {
    revenueGrowthQoQ,
    revenueGrowthYoY,
    ebitdaGrowthQoQ,
    ebitdaGrowthYoY,
    patGrowthQoQ,
    patGrowthYoY,
    marginChange,
    trend,
    hasPrev,
    hasYoY,
  };
}

function detectTrend(series) {
  if (series.length < 3) return 'Stable';
  let up = 0;
  let down = 0;
  for (let i = 1; i < series.length; i++) {
    const change = pct(series[i], series[i - 1]);
    if (change > 2) up++;
    else if (change < -2) down++;
  }
  if (up >= series.length - 1) return 'Improving';
  if (down >= series.length - 1) return 'Deteriorating';
  if (up > down) return 'Improving';
  if (down > up) return 'Deteriorating';
  return 'Stable';
}

// Maps a growth percentage onto a 0-10 sub-score. A null growth (no
// comparison quarter available) maps to a neutral 5 so it neither helps
// nor hurts the score.
function growthSubScore(growthPct) {
  if (growthPct == null) return 5;
  // -20% -> 0, 0% -> 5, +30%+ -> 10
  const s = 5 + growthPct / 6;
  return clamp(s, 0, 10);
}

function marginSubScore(marginChange) {
  if (marginChange == null) return 5;
  // -3pp -> 0, 0 -> 5, +3pp -> 10
  return clamp(5 + marginChange * 1.6, 0, 10);
}

function debtSubScore(history) {
  const n = history.length;
  const latest = history[n - 1];
  const prev = history[n - 2] || latest;
  if (!latest.debt || !prev.debt) return 5;
  const change = ((latest.debt - prev.debt) / prev.debt) * 100; // negative = reduction
  return clamp(5 - change * 0.5, 0, 10);
}

// Averages the available growth figures (ignoring nulls); returns null when
// neither YoY nor QoQ is available.
function avgGrowth(yoy, qoq) {
  const vals = [yoy, qoq].filter((v) => v != null);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// Deterministic local score (used when OpenAI is not configured, and as
// a sanity anchor otherwise).
export function localScore(history, metrics) {
  const revS = growthSubScore(avgGrowth(metrics.revenueGrowthYoY, metrics.revenueGrowthQoQ));
  const patS = growthSubScore(avgGrowth(metrics.patGrowthYoY, metrics.patGrowthQoQ));
  const ebitdaS = growthSubScore(avgGrowth(metrics.ebitdaGrowthYoY, metrics.ebitdaGrowthQoQ));
  const marginS = marginSubScore(metrics.marginChange);
  const debtS = debtSubScore(history);
  // Guidance proxy: trend-driven.
  const guidanceS =
    metrics.trend === 'Improving' ? 8 : metrics.trend === 'Deteriorating' ? 3 : 5.5;

  const score =
    revS * SCORE_WEIGHTS.revenueGrowth +
    patS * SCORE_WEIGHTS.patGrowth +
    ebitdaS * SCORE_WEIGHTS.ebitdaGrowth +
    marginS * SCORE_WEIGHTS.marginExpansion +
    guidanceS * SCORE_WEIGHTS.guidance +
    debtS * SCORE_WEIGHTS.debtReduction;

  return round(clamp(score, 0, 10), 1);
}

export function ratingFromScore(score) {
  if (score >= 9) return 'Exceptional';
  if (score >= 7) return 'Strong';
  if (score >= 5) return 'Average';
  if (score >= 3) return 'Weak';
  return 'Very Weak';
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
function round(v, d = 0) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
