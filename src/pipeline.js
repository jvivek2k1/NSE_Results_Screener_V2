// ============================================================
// Processing pipeline: filing -> persist history -> metrics ->
// AI analysis -> persist latest -> alerts -> live broadcast.
// ============================================================
import { repo } from './db.js';
import { config } from './config.js';
import { getNewFilings, fetchSymbolHistory } from './scraper.js';
import { fetchUpcomingResults, fetchSymbolQuarterlyList } from './nse.js';
import { computeMetrics, localScore, ratingFromScore } from './scoring.js';
import { quarterIndexToPeriodEnd } from './quarters.js';
import { analyzeFiling } from './ai.js';
import { broadcast } from './sse.js';
import { trackError } from './telemetry.js';

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

// Check NSE whether a company's result is now published, i.e. a quarterly
// filing exists with a broadcast date on/after its board-meeting date. Returns
// the matching filing summary, or null if not yet published / on error.
async function checkResultPublished(ticker, meetingDateISO) {
  try {
    const list = await fetchSymbolQuarterlyList(ticker);
    if (!list.length) return null;
    const meetingDay = (meetingDateISO || '').slice(0, 10);
    // List is ascending by quarter; scan newest-first for a recent filing.
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      if (!it.broadcastISO) continue;
      if (it.broadcastISO.slice(0, 10) >= meetingDay) {
        return { quarter: it.quarter, broadcastISO: it.broadcastISO };
      }
    }
    return null;
  } catch (err) {
    console.warn(`[pipeline] publish-check failed for ${ticker}:`, err.message);
    return null;
  }
}

// Persist NSE's forthcoming-results (board-meeting) calendar into the data
// store, then for every board meeting scheduled for TODAY that is still
// pending, check whether the result has actually been published on NSE. When
// it has, mark it published and raise an alert.
export async function syncUpcoming() {
  let list = [];
  try {
    list = await fetchUpcomingResults();
  } catch (err) {
    console.warn('[pipeline] upcoming fetch failed:', err.message);
  }

  let upserted = 0;
  for (const u of list) {
    try {
      await repo.upsertUpcoming({
        Ticker: u.ticker,
        CompanyName: u.company,
        Sector: u.sector,
        MeetingDate: u.meetingDate,
        Quarter: u.quarter,
        Purpose: u.purpose,
      });
      upserted++;
    } catch (err) {
      console.warn(`[pipeline] upcoming upsert failed for ${u.ticker}:`, err.message);
    }
  }

  // For each board meeting due today, verify if the result is now on NSE.
  let dueToday = [];
  try {
    dueToday = await repo.getUpcomingDueToday();
  } catch (err) {
    console.warn('[pipeline] due-today query failed:', err.message);
  }

  let published = 0;
  for (const u of dueToday) {
    const hit = await checkResultPublished(u.Ticker, u.MeetingDate);
    if (!hit) continue;
    try {
      await repo.markUpcomingPublished(
        u.Ticker,
        u.MeetingDate,
        hit.broadcastISO || new Date().toISOString()
      );
      published++;
      const alert = await repo.insertAlert({
        ticker: u.Ticker,
        companyName: u.CompanyName,
        type: 'Result Published',
        message: `${u.Ticker} has published its ${u.Quarter || 'quarterly'} results to NSE.`,
        score: null,
      });
      broadcast('alert', alert);
    } catch (err) {
      console.warn(`[pipeline] mark-published failed for ${u.Ticker}:`, err.message);
    }
  }

  broadcast('upcoming', { upserted, published, at: new Date().toISOString() });
  if (published) console.log(`[pipeline] ${published} due-today result(s) now published on NSE`);
  return { upserted, published };
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

    // Persist NSE's board-meeting calendar and, for any board meeting due
    // today, check whether the result has actually been published yet.
    await syncUpcoming();
  } catch (err) {
    console.error('[pipeline] scan error:', err);
    trackError(err, { source: 'runScan' });
  } finally {
    lastScanAt = new Date().toISOString();
    scanning = false;
  }
  broadcast('scan', { lastScanAt, processed: processed.length });
  return { lastScanAt, processed: processed.length, results: processed };
}

// Remove already-stored belated/backlog filings whose broadcast (announcement)
// date lags the quarter's period-end by more than `filingMaxReportingLagDays`.
// Complements the ingestion-time guard in scraper.js so existing rows (e.g. a
// years-late Videocon filing) also disappear from the dashboard. Idempotent.
export async function purgeStaleFilings() {
  const maxLagDays = config.filingMaxReportingLagDays;
  if (!maxLagDays || maxLagDays <= 0) return 0;
  const maxLagMs = maxLagDays * 86400000;
  let keys;
  try {
    keys = await repo.getAllFilingKeys();
  } catch (err) {
    console.warn('[pipeline] purge skipped (DB unavailable):', err.message);
    return 0;
  }
  let removed = 0;
  for (const k of keys || []) {
    if (k.QuarterIndex == null || !k.AnnouncementTime) continue;
    const periodEnd = quarterIndexToPeriodEnd(k.QuarterIndex).getTime();
    const broadcast = new Date(k.AnnouncementTime).getTime();
    if (Number.isNaN(broadcast) || broadcast - periodEnd <= maxLagMs) continue;
    try {
      removed += (await repo.deleteFiling(k.Ticker, k.Quarter)) || 0;
    } catch (err) {
      console.warn(`[pipeline] purge failed for ${k.Ticker} ${k.Quarter}:`, err.message);
    }
  }
  if (removed) console.log(`[pipeline] purged ${removed} stale/belated filing(s)`);
  return removed;
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
