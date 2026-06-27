// ============================================================
// Indian Earnings Intelligence — Backend API server
// Run:  node server.js   (listens on port 3001)
// ============================================================
import './src/telemetry.js'; // MUST be first: instruments http/sql/exceptions
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, hasAzureOpenAI, hasOpenAI, hasEmail } from './src/config.js';
import { trackError } from './src/telemetry.js';
import { repo } from './src/db.js';
import { addClient, broadcast, clientCount } from './src/sse.js';
import { runScan, getLastScanAt, enrich, backfillHistory, purgeStaleFilings } from './src/pipeline.js';
import { universeSize } from './src/scraper.js';
import { fetchUpcomingResults } from './src/nse.js';
import { sendOpenNotification } from './src/mailer.js';
import { checkAIHealth, aiEngine } from './src/ai.js';
import { getDbStatus } from './src/db.js';

const app = express();
app.use(cors());
app.use(express.json());

// ---------------- Helpers ----------------
function parseIntOr(v, d) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? d : n;
}
function parseFloatOr(v, d) {
  const n = parseFloat(v);
  return Number.isNaN(n) ? d : n;
}

// Wrap an async route handler so a data-store failure (e.g. the serverless
// Azure SQL database is paused/unreachable after exhausting retries) returns a
// clean 503 with the current DB status instead of crashing the request. The
// dashboard uses this to show a "database connection issue" banner.
function wrap(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      // Record the handled failure (e.g. Azure SQL unreachable) in App Insights.
      trackError(err, { route: req.originalUrl, method: req.method, db: getDbStatus()?.state });
      if (res.headersSent) return;
      res.status(503).json({
        error: 'Data store unavailable',
        detail: err?.message || String(err),
        db: getDbStatus(),
      });
    });
  };
}

// Latest AI model connectivity status, refreshed every 60s (see startup).
let lastAIHealth = { ok: null, provider: aiEngine.provider, model: aiEngine.model, checkedAt: null };
// Timestamp (ms) of the first failing AI probe in the current outage, or null
// when AI is healthy/skipped. Drives the readiness grace window so a single
// transient probe failure does not immediately flap the gateway backend.
let aiUnhealthySince = null;

// ---------------- Results ----------------
app.get('/api/results', wrap(async (req, res) => {
  const { page, limit, rating, sector, minScore, search, watchlist, recentDays } = req.query;
  // Default to the last 1 day of announced results; pass recentDays=0 for all.
  const days = recentDays != null ? parseIntOr(recentDays, 1) : 1;
  const data = await repo.getResults({
    page: parseIntOr(page, 1),
    limit: Math.min(parseIntOr(limit, 25), 200),
    rating: rating || undefined,
    sector: sector || undefined,
    minScore: minScore != null ? parseFloatOr(minScore, null) : undefined,
    search: search || undefined,
    watchlistOnly: watchlist === 'true' || watchlist === '1',
    recentDays: days > 0 ? days : undefined,
  });
  res.json({
    ...data,
    rows: data.rows.map(enrich),
    totalPages: Math.ceil(data.total / data.limit) || 1,
  });
}));

app.get('/api/result/:ticker', wrap(async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const latest = await repo.getLatestByTicker(ticker);
  if (!latest) return res.status(404).json({ error: 'Not found' });
  // Lazily ensure prior quarters exist so the comparison table has real data.
  try {
    await backfillHistory(ticker);
  } catch {
    /* non-fatal: fall back to whatever history we have */
  }
  const history = await repo.getHistory(ticker, 8);
  res.json({
    ...enrich(latest),
    watched: await repo.isWatched(ticker),
    history: history.map((h) => ({
      quarter: h.Quarter,
      quarterIndex: h.QuarterIndex,
      revenue: h.Revenue,
      ebitda: h.EBITDA,
      pat: h.PAT,
      eps: h.EPS,
      ebitdaMargin: h.EBITDAMargin,
      score: h.Score,
    })),
  });
}));

app.get('/api/top-scores', wrap(async (req, res) => {
  const limit = Math.min(parseIntOr(req.query.limit, 10), 50);
  res.json((await repo.getTopScores(limit)).map(enrich));
}));

app.get('/api/stats', wrap(async (req, res) => {
  const { rating, sector, minScore, search, watchlist, recentDays } = req.query;
  // Mirror the /api/results filters so the summary cards reflect exactly what
  // the table is showing. Default to the same 1-day window as the table.
  const days = recentDays != null ? parseIntOr(recentDays, 1) : 1;
  res.json(
    await repo.getStats({
      rating: rating || undefined,
      sector: sector || undefined,
      minScore: minScore != null ? parseFloatOr(minScore, null) : undefined,
      search: search || undefined,
      watchlistOnly: watchlist === 'true' || watchlist === '1',
      recentDays: days > 0 ? days : undefined,
    })
  );
}));

app.get('/api/sectors', wrap(async (req, res) => {
  res.json(await repo.getSectors());
}));

app.get('/api/leaderboard', wrap(async (req, res) => {
  res.json(await repo.getSectorLeaderboard());
}));

app.get('/api/movers', wrap(async (req, res) => {
  const direction = req.query.direction === 'deteriorating' ? 'deteriorating' : 'improving';
  const limit = Math.min(parseIntOr(req.query.limit, 10), 50);
  res.json((await repo.getTrendMovers(direction, limit)).map(enrich));
}));

app.get('/api/alerts', wrap(async (req, res) => {
  const limit = Math.min(parseIntOr(req.query.limit, 50), 200);
  res.json(await repo.getAlerts(limit));
}));

// ---------------- Upcoming results (NSE board-meeting calendar) ----------------
// Served from the data store (populated by the scan pipeline's syncUpcoming).
// Falls back to a live NSE fetch if the table has not been populated yet.
let upcomingCache = { at: 0, data: [] };
app.get('/api/upcoming', wrap(async (req, res) => {
  const limit = Math.min(parseIntOr(req.query.limit, 10), 50);
  let rows = [];
  try {
    rows = await repo.getUpcoming(limit);
  } catch {
    rows = [];
  }
  if (rows && rows.length > 0) {
    return res.json(
      rows.map((r) => ({
        ticker: r.Ticker,
        company: r.CompanyName,
        sector: r.Sector,
        meetingDate: r.MeetingDate,
        quarter: r.Quarter,
        purpose: r.Purpose,
        status: r.Status,
        publishedAt: r.PublishedAt,
      }))
    );
  }
  // Fallback: live NSE fetch (cached 10 min) until the store is seeded.
  if (Date.now() - upcomingCache.at > 10 * 60 * 1000) {
    upcomingCache = { at: Date.now(), data: await fetchUpcomingResults() };
  }
  res.json(upcomingCache.data.slice(0, limit));
}));

// ---------------- Email notification on app open ----------------
app.post('/api/notify-open', async (req, res) => {
  try {
    const stats = await repo.getStats({ recentDays: 1 });
    const result = await sendOpenNotification(stats);
    res.json(result);
  } catch (err) {
    res.status(500).json({ sent: false, reason: 'error', detail: err.message });
  }
});

// ---------------- Watchlist ----------------
app.get('/api/watchlist', wrap(async (req, res) => {
  res.json(await repo.getWatchlist());
}));
app.post('/api/watchlist', wrap(async (req, res) => {
  const { ticker, companyName } = req.body || {};
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  res.json(await repo.addWatch(ticker.toUpperCase(), companyName));
}));
app.delete('/api/watchlist/:ticker', wrap(async (req, res) => {
  res.json(await repo.removeWatch(req.params.ticker.toUpperCase()));
}));
app.post('/api/watchlist/:ticker/pin', wrap(async (req, res) => {
  res.json(await repo.togglePin(req.params.ticker.toUpperCase()));
}));

// ---------------- Meta / control ----------------
app.get('/api/meta', wrap(async (req, res) => {
  let companiesProcessed = 0;
  try {
    companiesProcessed = await repo.count();
  } catch {
    /* DB may be paused/resuming — surface status, keep meta responsive */
  }
  res.json({
    lastScanAt: getLastScanAt(),
    scanCron: config.scanCron,
    scanIntervalMs: config.scanIntervalMs,
    universeSize: universeSize(),
    companiesProcessed,
    dataMode: config.dataMode,
    dbBackend: repo.backend,
    dbStatus: getDbStatus(),
    liveClients: clientCount(),
    aiHealth: lastAIHealth,
  });
}));

app.post('/api/scan', async (req, res) => {
  const result = await runScan();
  res.json(result);
});

// ---------------- SSE live stream ----------------
app.get('/api/live', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  res.write(
    `event: connected\ndata: ${JSON.stringify({
      lastScanAt: getLastScanAt(),
      dbStatus: getDbStatus(),
      aiHealth: lastAIHealth,
    })}\n\n`
  );
  addClient(res);

  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 25000);
  req.on('close', () => clearInterval(keepAlive));
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Readiness probe: unlike /api/health (liveness), this reflects the critical
// dependencies the app cannot serve correctly without. Returns 503 when the
// backing database OR the AI model is unreachable so the App Gateway probe marks
// the backend Unhealthy and the connectivity alerts fire.
//
// A serverless Azure SQL database can briefly enter a transient "connecting"
// state while it resumes. We treat that as healthy for a short grace window so a
// normal resume does not flap the gateway backend; only a hard "error" state or
// a connection that stays stuck "connecting" past the grace window reports 503.
//
// The AI model is treated as a critical dependency: once it has been unreachable
// for longer than READY_AI_GRACE_MS, readiness reports 503. The local engine
// (no real endpoint to reach) and the pre-first-probe startup window never block
// readiness.
const READY_CONNECTING_GRACE_MS = 90000;
const READY_AI_GRACE_MS = 120000;

function getAiReadiness() {
  // Local engine or not-yet-probed at startup: never block readiness.
  if (lastAIHealth.skipped || lastAIHealth.ok === null) return { ready: true };
  if (lastAIHealth.ok) return { ready: true };
  // AI is failing — allow a short grace window before failing readiness.
  const sinceMs = aiUnhealthySince ? Date.now() - aiUnhealthySince : 0;
  return { ready: sinceMs < READY_AI_GRACE_MS };
}

app.get('/api/health/ready', (req, res) => {
  const db = getDbStatus();
  let dbReady = !!db?.ok;
  if (!dbReady && db?.state === 'connecting') {
    const sinceMs = db.since ? Date.now() - new Date(db.since).getTime() : 0;
    dbReady = sinceMs < READY_CONNECTING_GRACE_MS;
  }
  const aiReady = getAiReadiness().ready;
  const ai = {
    ok: lastAIHealth.ok,
    provider: lastAIHealth.provider,
    model: lastAIHealth.model,
    error: lastAIHealth.error,
    skipped: !!lastAIHealth.skipped,
    checkedAt: lastAIHealth.checkedAt,
  };
  if (dbReady && aiReady) {
    return res.json({ ok: true, db, ai });
  }
  return res.status(503).json({ ok: false, db, ai });
});

app.get('/api/ai-health', (req, res) => res.json(lastAIHealth));

// ---------------- Static frontend (production / single-host deploy) ----------------
// In production the built React app (earnings-intelligence/dist) is served by
// this same Express process so the UI and API share one origin (one App
// Service). All non-/api GET routes fall back to index.html for SPA routing.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.join(__dirname, 'earnings-intelligence', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(webDist, 'index.html')));
  console.log(`[server] serving frontend from ${webDist}`);
}

// ---------------- Startup ----------------
async function seedInitialData(iterations = 5) {
  console.log('[server] seeding initial data from NSE...');
  await purgeStaleFilings(); // drop any previously-stored belated/backlog filings
  for (let i = 0; i < iterations; i++) {
    const r = await runScan();
    if (!r || r.processed === 0) break;
  }
  try {
    console.log(`[server] seeded ${await repo.count()} companies`);
  } catch (err) {
    console.warn(`[server] seed count unavailable (DB issue): ${err.message}`);
  }
}

app.listen(config.port, async () => {
  console.log(`\n  Indian Earnings Intelligence API`);
  console.log(`  http://localhost:${config.port}`);
  const engine = hasAzureOpenAI
    ? `Azure GPT-5.1 (keyless: ${config.azureDeployment})`
    : hasOpenAI
      ? 'OpenAI'
      : 'local engine';
  console.log(`  Data mode: ${config.dataMode} | DB: ${repo.backend} | AI: ${engine}`);
  console.log(`  Email on open: ${hasEmail ? `on (${config.emailTo})` : 'off'}\n`);

  await seedInitialData();

  // Auto-refresh engine — runs on the configured cron schedule (default: every minute).
  cron.schedule(config.scanCron, async () => {
    const r = await runScan();
    if (r?.processed) console.log(`[cron] scan processed ${r.processed} new filing(s)`);
  });
  console.log(`[server] auto-refresh engine active (cron: ${config.scanCron})`);

  // AI model health monitor — probes the configured AI engine every 60s,
  // logs status changes and pushes the result to connected dashboards.
  async function runAIHealthCheck() {
    const prevOk = lastAIHealth.ok;
    lastAIHealth = await checkAIHealth();
    if (lastAIHealth.skipped) {
      aiUnhealthySince = null;
      return; // local engine: nothing to monitor
    }
    if (lastAIHealth.ok) {
      aiUnhealthySince = null;
      if (prevOk !== true) {
        console.log(
          `[ai-health] OK — ${lastAIHealth.provider} model "${lastAIHealth.model}" reachable (${lastAIHealth.latencyMs}ms)`
        );
      }
    } else {
      if (!aiUnhealthySince) aiUnhealthySince = Date.now();
      const downForMs = Date.now() - aiUnhealthySince;
      console.warn(
        `[ai-health] FAILED — ${lastAIHealth.provider} model "${lastAIHealth.model}" unreachable for ${Math.round(downForMs / 1000)}s: ${lastAIHealth.error}` +
          (downForMs >= READY_AI_GRACE_MS ? ' [readiness now 503 - AI is a critical dependency]' : ' [within grace window]')
      );
    }
    broadcast('ai-health', lastAIHealth);
  }
  await runAIHealthCheck();
  setInterval(runAIHealthCheck, 60_000);
  console.log('[server] AI model health monitor active (every 60s)');
});
