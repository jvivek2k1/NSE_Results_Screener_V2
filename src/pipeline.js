// ============================================================
// Processing pipeline: filing -> persist history -> metrics ->
// AI analysis -> persist latest -> alerts -> live broadcast.
// ============================================================
import { repo } from './db.js';
import { getNewFilings, fetchSymbolHistory } from './scraper.js';
import { computeMetrics, localScore, ratingFromScore } from './scoring.js';
import { analyzeFiling } from './ai.js';
import { broadcast } from './sse.js';

let lastScanAt = null;
let scanning = false;

function buildRow(q, metrics, analysis, filing) {
  return {
    Ticker: q.ticker,
    CompanyName: q.name,
    Sector: q.sector,
    MarketCap: q.mcap,
    AnnouncementTime: filing.announcementTime || new Date().toISOString(),
    Quarter: q.quarter,
    QuarterIndex: q.quarterIndex,
    Revenue: q.revenue,
    EBITDA: q.ebitda,
    PAT: q.pat,
    EPS: q.eps,
    EBITDAMargin: q.ebitdaMargin,
    Debt: q.debt,
    Cash: q.cash,
    RevenueGrowthQoQ: metrics.revenueGrowthQoQ,
    RevenueGrowthYoY: metrics.revenueGrowthYoY,
    EBITDAGrowthQoQ: metrics.ebitdaGrowthQoQ,
    EBITDAGrowthYoY: metrics.ebitdaGrowthYoY,
    PATGrowthQoQ: metrics.patGrowthQoQ,
    PATGrowthYoY: metrics.patGrowthYoY,
    MarginChange: metrics.marginChange,
    Trend: metrics.trend,
    Score: analysis.score,
    Rating: analysis.rating,
    Reasoning: analysis.summary,
    AnalysisJson: JSON.stringify(analysis),
    RawText: filing.rawText,
  };
}

// Persist the historical quarters (older than latest) with quick local
// scoring so charts (revenue/PAT/EBITDA/score trend) have data.
async function persistHistory(filing) {
  const history = filing.history || [];
  for (let i = 0; i < history.length - 1; i++) {
    const q = history[i];
    if (await repo.existsFiling(q.ticker, q.quarter)) continue;
    const sub = history.slice(0, i + 1);
    const metrics = computeMetrics(sub);
    const score = localScore(sub, metrics);
    const analysis = {
      score,
      rating: ratingFromScore(score),
      positives: [],
      negatives: [],
      risks: [],
      opportunities: [],
      summary: '',
    };
    await repo.insertResult(buildRow(q, metrics, analysis, { ...filing, rawText: '' }));
  }
}

// On-demand: ensure a ticker has its previous quarters stored so the
// last-3-quarters comparison has real data. Fetches from NSE only when fewer
// than 2 quarters are stored, then persists the older quarters with quick
// local scoring. Safe to call repeatedly (no-ops once history exists).
const backfilling = new Set();
export async function backfillHistory(ticker) {
  const existing = await repo.getHistory(ticker, 8);
  if (existing.length >= 2) return existing.length; // already have history
  if (backfilling.has(ticker)) return existing.length; // in progress
  backfilling.add(ticker);
  try {
    const history = await fetchSymbolHistory(ticker, 4);
    if (history.length < 2) return existing.length;
    for (let i = 0; i < history.length; i++) {
      const q = history[i];
      if (await repo.existsFiling(q.ticker, q.quarter)) continue;
      const sub = history.slice(0, i + 1);
      const metrics = computeMetrics(sub);
      const score = localScore(sub, metrics);
      const analysis = {
        score,
        rating: ratingFromScore(score),
        positives: [],
        negatives: [],
        risks: [],
        opportunities: [],
        summary: '',
      };
      await repo.insertResult(
        buildRow(q, metrics, analysis, {
          announcementTime: q.announcementTime || new Date().toISOString(),
          rawText: '',
        })
      );
    }
    return (await repo.getHistory(ticker, 8)).length;
  } catch (err) {
    console.warn(`[pipeline] backfill failed for ${ticker}:`, err.message);
    return existing.length;
  } finally {
    backfilling.delete(ticker);
  }
}

async function generateAlerts(row) {
  const alerts = [];
  if (row.RevenueGrowthYoY > 20)
    alerts.push({ type: 'Revenue Surge', message: `Revenue up ${row.RevenueGrowthYoY}% YoY` });
  if (row.PATGrowthYoY > 25)
    alerts.push({ type: 'Profit Surge', message: `PAT up ${row.PATGrowthYoY}% YoY` });
  if (row.Score > 8)
    alerts.push({ type: 'High Score', message: `Earnings score ${row.Score}/10` });
  if (row.Score >= (await repo.maxScore()))
    alerts.push({ type: 'All-Time High Score', message: `New top score ${row.Score}/10` });

  const out = [];
  for (const a of alerts) {
    const saved = await repo.insertAlert({
      ticker: row.Ticker,
      companyName: row.CompanyName,
      type: a.type,
      message: a.message,
      score: row.Score,
    });
    out.push(saved);
    broadcast('alert', saved);
  }
  return out;
}

export async function runScan() {
  if (scanning) return { skipped: true };
  scanning = true;
  const processed = [];
  try {
    const filings = await getNewFilings();
    for (const filing of filings) {
      const latest = filing.history[filing.history.length - 1];
      if (await repo.existsFiling(latest.ticker, latest.quarter)) continue;

      await persistHistory(filing);

      const metrics = computeMetrics(filing.history);
      const analysis = await analyzeFiling(filing, metrics, filing.history);
      const row = buildRow(latest, metrics, analysis, filing);
      const inserted = await repo.insertResult(row);
      if (!inserted) continue;

      await generateAlerts(inserted);
      const payload = enrich(inserted);
      broadcast('result', payload);
      processed.push(payload);
    }
  } catch (err) {
    console.error('[pipeline] scan error:', err);
  } finally {
    lastScanAt = new Date().toISOString();
    scanning = false;
  }
  broadcast('scan', { lastScanAt, processed: processed.length });
  return { lastScanAt, processed: processed.length, results: processed };
}

// Attach parsed analysis JSON onto a DB row for API consumers.
export function enrich(row) {
  if (!row) return row;
  let analysis = null;
  if (row.AnalysisJson) {
    try {
      analysis = JSON.parse(row.AnalysisJson);
    } catch {
      analysis = null;
    }
  }
  return { ...row, analysis };
}

export function getLastScanAt() {
  return lastScanAt;
}
