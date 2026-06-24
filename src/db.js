// ============================================================
// Data layer: pluggable backend — Azure SQL (Entra ID auth),
// SQLite (better-sqlite3), or in-memory fallback. Selected via
// config.dbBackend. Exposes a repository API so the rest of the
// app never writes raw SQL directly.
// ============================================================
import path from 'node:path';
import { config, useAzureSql } from './config.js';
import { createAzureSqlRepo } from './azuresql.js';

let Database = null;
try {
  const mod = await import('better-sqlite3');
  Database = mod.default;
} catch (err) {
  console.warn(
    '[db] better-sqlite3 not available, falling back to in-memory store. ' +
      'Install it with: npm install better-sqlite3'
  );
}

// -------------------- SQLite backend --------------------
function createSqliteRepo() {
  const dbPath = path.join(config.rootDir, 'earnings.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS QuarterlyResults (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      Ticker TEXT NOT NULL,
      CompanyName TEXT,
      Sector TEXT,
      MarketCap REAL,
      AnnouncementTime DATETIME,
      Quarter TEXT,
      QuarterIndex INTEGER,
      Revenue REAL,
      EBITDA REAL,
      PAT REAL,
      EPS REAL,
      EBITDAMargin REAL,
      Debt REAL,
      Cash REAL,
      RevenueGrowthQoQ REAL,
      RevenueGrowthYoY REAL,
      EBITDAGrowthQoQ REAL,
      EBITDAGrowthYoY REAL,
      PATGrowthQoQ REAL,
      PATGrowthYoY REAL,
      MarginChange REAL,
      Trend TEXT,
      Score REAL,
      Rating TEXT,
      Reasoning TEXT,
      AnalysisJson TEXT,
      RawText TEXT,
      UNIQUE (Ticker, Quarter)
    );
    CREATE INDEX IF NOT EXISTS idx_qr_ticker ON QuarterlyResults (Ticker);
    CREATE INDEX IF NOT EXISTS idx_qr_score ON QuarterlyResults (Score);
    CREATE INDEX IF NOT EXISTS idx_qr_time ON QuarterlyResults (AnnouncementTime);

    CREATE TABLE IF NOT EXISTS Watchlist (
      Ticker TEXT PRIMARY KEY,
      CompanyName TEXT,
      Pinned INTEGER DEFAULT 0,
      AddedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS Alerts (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      Ticker TEXT,
      CompanyName TEXT,
      Type TEXT,
      Message TEXT,
      Score REAL,
      CreatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO QuarterlyResults
      (Ticker, CompanyName, Sector, MarketCap, AnnouncementTime, Quarter, QuarterIndex,
       Revenue, EBITDA, PAT, EPS, EBITDAMargin, Debt, Cash,
       RevenueGrowthQoQ, RevenueGrowthYoY, EBITDAGrowthQoQ, EBITDAGrowthYoY,
       PATGrowthQoQ, PATGrowthYoY, MarginChange, Trend,
       Score, Rating, Reasoning, AnalysisJson, RawText)
    VALUES
      (@Ticker, @CompanyName, @Sector, @MarketCap, @AnnouncementTime, @Quarter, @QuarterIndex,
       @Revenue, @EBITDA, @PAT, @EPS, @EBITDAMargin, @Debt, @Cash,
       @RevenueGrowthQoQ, @RevenueGrowthYoY, @EBITDAGrowthQoQ, @EBITDAGrowthYoY,
       @PATGrowthQoQ, @PATGrowthYoY, @MarginChange, @Trend,
       @Score, @Rating, @Reasoning, @AnalysisJson, @RawText)
  `);

  return {
    backend: 'sqlite',
    existsFiling(ticker, quarter) {
      const row = db
        .prepare('SELECT 1 FROM QuarterlyResults WHERE Ticker = ? AND Quarter = ?')
        .get(ticker, quarter);
      return Boolean(row);
    },
    insertResult(r) {
      const info = insertStmt.run(normalizeForInsert(r));
      if (info.changes === 0) return null;
      return this.getById(info.lastInsertRowid);
    },
    getById(id) {
      return db.prepare('SELECT * FROM QuarterlyResults WHERE Id = ?').get(id);
    },
    getHistory(ticker, limit = 8) {
      return db
        .prepare(
          'SELECT * FROM QuarterlyResults WHERE Ticker = ? ORDER BY QuarterIndex ASC LIMIT ?'
        )
        .all(ticker, limit);
    },
    getLatestByTicker(ticker) {
      return db
        .prepare(
          'SELECT * FROM QuarterlyResults WHERE Ticker = ? ORDER BY QuarterIndex DESC LIMIT 1'
        )
        .get(ticker);
    },
    getResults({ page = 1, limit = 25, rating, sector, minScore, search, watchlistOnly, recentDays }) {
      // Only the latest quarter per ticker.
      const where = [];
      const params = {};
      if (rating) {
        where.push('q.Rating = @rating');
        params.rating = rating;
      }
      if (sector) {
        where.push('q.Sector = @sector');
        params.sector = sector;
      }
      if (minScore != null) {
        where.push('q.Score >= @minScore');
        params.minScore = minScore;
      }
      if (recentDays != null) {
        where.push('q.AnnouncementTime >= @sinceIso');
        params.sinceIso = new Date(Date.now() - recentDays * 86400000).toISOString();
      }
      if (search) {
        where.push('(q.Ticker LIKE @search OR q.CompanyName LIKE @search)');
        params.search = `%${search}%`;
      }
      let watchJoin = '';
      if (watchlistOnly) {
        watchJoin = 'JOIN Watchlist w ON w.Ticker = q.Ticker';
      }
      const whereSql = where.length ? 'AND ' + where.join(' AND ') : '';
      const base = `
        FROM QuarterlyResults q
        ${watchJoin}
        WHERE q.QuarterIndex = (
          SELECT MAX(QuarterIndex) FROM QuarterlyResults x WHERE x.Ticker = q.Ticker
        )
        ${whereSql}
      `;
      const total = db.prepare(`SELECT COUNT(*) AS c ${base}`).get(params).c;
      const rows = db
        .prepare(
          `SELECT q.* ${base} ORDER BY q.Score DESC, q.AnnouncementTime DESC LIMIT @limit OFFSET @offset`
        )
        .all({ ...params, limit, offset: (page - 1) * limit });
      return { rows, total, page, limit };
    },
    getTopScores(limit = 10) {
      return db
        .prepare(
          `SELECT q.* FROM QuarterlyResults q
           WHERE q.QuarterIndex = (
             SELECT MAX(QuarterIndex) FROM QuarterlyResults x WHERE x.Ticker = q.Ticker
           )
           ORDER BY q.Score DESC, q.AnnouncementTime DESC LIMIT ?`
        )
        .all(limit);
    },
    getStats(filters = {}) {
      const { rating, sector, minScore, search, watchlistOnly, recentDays } = filters;
      const where = [];
      const params = {};
      if (rating) {
        where.push('q.Rating = @rating');
        params.rating = rating;
      }
      if (sector) {
        where.push('q.Sector = @sector');
        params.sector = sector;
      }
      if (minScore != null) {
        where.push('q.Score >= @minScore');
        params.minScore = minScore;
      }
      if (recentDays != null) {
        where.push('q.AnnouncementTime >= @sinceIso');
        params.sinceIso = new Date(Date.now() - recentDays * 86400000).toISOString();
      }
      if (search) {
        where.push('(q.Ticker LIKE @search OR q.CompanyName LIKE @search)');
        params.search = `%${search}%`;
      }
      const watchJoin = watchlistOnly ? 'JOIN Watchlist w ON w.Ticker = q.Ticker' : '';
      const whereSql = where.length ? 'AND ' + where.join(' AND ') : '';
      const latest = db.prepare(`
        SELECT q.* FROM QuarterlyResults q
        ${watchJoin}
        WHERE q.QuarterIndex = (
          SELECT MAX(QuarterIndex) FROM QuarterlyResults x WHERE x.Ticker = q.Ticker
        )
        ${whereSql}
      `).all(params);
      return computeStats(latest);
    },    getSectorLeaderboard() {
      return db
        .prepare(
          `SELECT q.Sector AS sector, COUNT(*) AS companies, ROUND(AVG(q.Score),2) AS avgScore
           FROM QuarterlyResults q
           WHERE q.QuarterIndex = (
             SELECT MAX(QuarterIndex) FROM QuarterlyResults x WHERE x.Ticker = q.Ticker
           )
           GROUP BY q.Sector ORDER BY avgScore DESC`
        )
        .all();
    },
    getTrendMovers(direction = 'improving', limit = 10) {
      const trend = direction === 'improving' ? 'Improving' : 'Deteriorating';
      return db
        .prepare(
          `SELECT q.* FROM QuarterlyResults q
           WHERE q.QuarterIndex = (
             SELECT MAX(QuarterIndex) FROM QuarterlyResults x WHERE x.Ticker = q.Ticker
           ) AND q.Trend = ?
           ORDER BY q.PATGrowthYoY DESC LIMIT ?`
        )
        .all(trend, limit);
    },
    getSectors() {
      return db
        .prepare('SELECT DISTINCT Sector FROM QuarterlyResults WHERE Sector IS NOT NULL ORDER BY Sector')
        .all()
        .map((r) => r.Sector);
    },
    // Alerts
    insertAlert(a) {
      const info = db
        .prepare(
          'INSERT INTO Alerts (Ticker, CompanyName, Type, Message, Score) VALUES (?,?,?,?,?)'
        )
        .run(a.ticker, a.companyName, a.type, a.message, a.score);
      return db.prepare('SELECT * FROM Alerts WHERE Id = ?').get(info.lastInsertRowid);
    },
    getAlerts(limit = 50) {
      return db.prepare('SELECT * FROM Alerts ORDER BY CreatedAt DESC LIMIT ?').all(limit);
    },
    // Watchlist
    getWatchlist() {
      return db.prepare('SELECT * FROM Watchlist ORDER BY Pinned DESC, AddedAt DESC').all();
    },
    addWatch(ticker, companyName) {
      db.prepare(
        'INSERT OR IGNORE INTO Watchlist (Ticker, CompanyName) VALUES (?, ?)'
      ).run(ticker, companyName || ticker);
      return this.getWatchlist();
    },
    removeWatch(ticker) {
      db.prepare('DELETE FROM Watchlist WHERE Ticker = ?').run(ticker);
      return this.getWatchlist();
    },
    togglePin(ticker) {
      db.prepare('UPDATE Watchlist SET Pinned = 1 - Pinned WHERE Ticker = ?').run(ticker);
      return this.getWatchlist();
    },
    isWatched(ticker) {
      return Boolean(db.prepare('SELECT 1 FROM Watchlist WHERE Ticker = ?').get(ticker));
    },
    count() {
      return db.prepare('SELECT COUNT(DISTINCT Ticker) AS c FROM QuarterlyResults').get().c;
    },
    maxScore() {
      const r = db.prepare('SELECT MAX(Score) AS m FROM QuarterlyResults').get();
      return r.m || 0;
    },
  };
}

// -------------------- In-memory fallback --------------------
function createMemoryRepo() {
  const results = []; // each row
  let nextId = 1;
  const watchlist = new Map();
  const alerts = [];
  let alertId = 1;

  const latestPerTicker = () => {
    const map = new Map();
    for (const r of results) {
      const cur = map.get(r.Ticker);
      if (!cur || r.QuarterIndex > cur.QuarterIndex) map.set(r.Ticker, r);
    }
    return [...map.values()];
  };

  return {
    backend: 'memory',
    existsFiling(ticker, quarter) {
      return results.some((r) => r.Ticker === ticker && r.Quarter === quarter);
    },
    insertResult(r) {
      if (this.existsFiling(r.Ticker, r.Quarter)) return null;
      const row = { Id: nextId++, ...normalizeForInsert(r) };
      results.push(row);
      return row;
    },
    getById(id) {
      return results.find((r) => r.Id === id);
    },
    getHistory(ticker, limit = 8) {
      return results
        .filter((r) => r.Ticker === ticker)
        .sort((a, b) => a.QuarterIndex - b.QuarterIndex)
        .slice(-limit);
    },
    getLatestByTicker(ticker) {
      return this.getHistory(ticker, 999).slice(-1)[0];
    },
    getResults({ page = 1, limit = 25, rating, sector, minScore, search, watchlistOnly, recentDays }) {
      let rows = latestPerTicker();
      if (rating) rows = rows.filter((r) => r.Rating === rating);
      if (sector) rows = rows.filter((r) => r.Sector === sector);
      if (minScore != null) rows = rows.filter((r) => r.Score >= minScore);
      if (recentDays != null) {
        const sinceIso = new Date(Date.now() - recentDays * 86400000).toISOString();
        rows = rows.filter((r) => r.AnnouncementTime >= sinceIso);
      }
      if (search) {
        const s = search.toLowerCase();
        rows = rows.filter(
          (r) =>
            r.Ticker.toLowerCase().includes(s) ||
            (r.CompanyName || '').toLowerCase().includes(s)
        );
      }
      if (watchlistOnly) rows = rows.filter((r) => watchlist.has(r.Ticker));
      rows.sort((a, b) => b.Score - a.Score);
      const total = rows.length;
      const start = (page - 1) * limit;
      return { rows: rows.slice(start, start + limit), total, page, limit };
    },
    getTopScores(limit = 10) {
      return latestPerTicker()
        .sort((a, b) => b.Score - a.Score)
        .slice(0, limit);
    },
    getStats(filters = {}) {
      const { rating, sector, minScore, search, watchlistOnly, recentDays } = filters;
      let rows = latestPerTicker();
      if (rating) rows = rows.filter((r) => r.Rating === rating);
      if (sector) rows = rows.filter((r) => r.Sector === sector);
      if (minScore != null) rows = rows.filter((r) => r.Score >= minScore);
      if (recentDays != null) {
        const sinceIso = new Date(Date.now() - recentDays * 86400000).toISOString();
        rows = rows.filter((r) => r.AnnouncementTime >= sinceIso);
      }
      if (search) {
        const s = search.toLowerCase();
        rows = rows.filter(
          (r) =>
            r.Ticker.toLowerCase().includes(s) ||
            (r.CompanyName || '').toLowerCase().includes(s)
        );
      }
      if (watchlistOnly) rows = rows.filter((r) => watchlist.has(r.Ticker));
      return computeStats(rows);
    },
    getSectorLeaderboard() {
      const map = new Map();
      for (const r of latestPerTicker()) {
        const e = map.get(r.Sector) || { sector: r.Sector, companies: 0, sum: 0 };
        e.companies += 1;
        e.sum += r.Score;
        map.set(r.Sector, e);
      }
      return [...map.values()]
        .map((e) => ({
          sector: e.sector,
          companies: e.companies,
          avgScore: Math.round((e.sum / e.companies) * 100) / 100,
        }))
        .sort((a, b) => b.avgScore - a.avgScore);
    },
    getTrendMovers(direction = 'improving', limit = 10) {
      const trend = direction === 'improving' ? 'Improving' : 'Deteriorating';
      return latestPerTicker()
        .filter((r) => r.Trend === trend)
        .sort((a, b) => b.PATGrowthYoY - a.PATGrowthYoY)
        .slice(0, limit);
    },
    getSectors() {
      return [...new Set(results.map((r) => r.Sector).filter(Boolean))].sort();
    },
    insertAlert(a) {
      const row = {
        Id: alertId++,
        Ticker: a.ticker,
        CompanyName: a.companyName,
        Type: a.type,
        Message: a.message,
        Score: a.score,
        CreatedAt: new Date().toISOString(),
      };
      alerts.unshift(row);
      return row;
    },
    getAlerts(limit = 50) {
      return alerts.slice(0, limit);
    },
    getWatchlist() {
      return [...watchlist.values()].sort(
        (a, b) => b.Pinned - a.Pinned || (a.AddedAt < b.AddedAt ? 1 : -1)
      );
    },
    addWatch(ticker, companyName) {
      if (!watchlist.has(ticker)) {
        watchlist.set(ticker, {
          Ticker: ticker,
          CompanyName: companyName || ticker,
          Pinned: 0,
          AddedAt: new Date().toISOString(),
        });
      }
      return this.getWatchlist();
    },
    removeWatch(ticker) {
      watchlist.delete(ticker);
      return this.getWatchlist();
    },
    togglePin(ticker) {
      const w = watchlist.get(ticker);
      if (w) w.Pinned = w.Pinned ? 0 : 1;
      return this.getWatchlist();
    },
    isWatched(ticker) {
      return watchlist.has(ticker);
    },
    count() {
      return new Set(results.map((r) => r.Ticker)).size;
    },
    maxScore() {
      return results.reduce((m, r) => Math.max(m, r.Score || 0), 0);
    },
  };
}

// -------------------- Shared helpers --------------------
function normalizeForInsert(r) {
  return {
    Ticker: r.Ticker,
    CompanyName: r.CompanyName ?? null,
    Sector: r.Sector ?? null,
    MarketCap: r.MarketCap ?? null,
    AnnouncementTime: r.AnnouncementTime ?? new Date().toISOString(),
    Quarter: r.Quarter ?? null,
    QuarterIndex: r.QuarterIndex ?? 0,
    Revenue: r.Revenue ?? null,
    EBITDA: r.EBITDA ?? null,
    PAT: r.PAT ?? null,
    EPS: r.EPS ?? null,
    EBITDAMargin: r.EBITDAMargin ?? null,
    Debt: r.Debt ?? null,
    Cash: r.Cash ?? null,
    RevenueGrowthQoQ: r.RevenueGrowthQoQ ?? null,
    RevenueGrowthYoY: r.RevenueGrowthYoY ?? null,
    EBITDAGrowthQoQ: r.EBITDAGrowthQoQ ?? null,
    EBITDAGrowthYoY: r.EBITDAGrowthYoY ?? null,
    PATGrowthQoQ: r.PATGrowthQoQ ?? null,
    PATGrowthYoY: r.PATGrowthYoY ?? null,
    MarginChange: r.MarginChange ?? null,
    Trend: r.Trend ?? null,
    Score: r.Score ?? null,
    Rating: r.Rating ?? null,
    Reasoning: r.Reasoning ?? null,
    AnalysisJson: r.AnalysisJson ?? null,
    RawText: r.RawText ?? null,
  };
}

function computeStats(latest) {
  const today = new Date().toISOString().slice(0, 10);
  const todays = latest.filter(
    (r) => (r.AnnouncementTime || '').slice(0, 10) === today
  );
  const strong = latest.filter((r) => r.Score >= 7).length;
  const average = latest.filter((r) => r.Score >= 5 && r.Score < 7).length;
  const weak = latest.filter((r) => r.Score < 5).length;
  const highest = latest.reduce(
    (best, r) => (r.Score > (best?.Score ?? -1) ? r : best),
    null
  );
  return {
    companiesProcessed: latest.length,
    resultsToday: todays.length,
    strongResults: strong,
    averageResults: average,
    weakResults: weak,
    highestScoreToday: highest
      ? { ticker: highest.Ticker, company: highest.CompanyName, score: highest.Score }
      : null,
  };
}

export const repo = useAzureSql
  ? createAzureSqlRepo()
  : Database
    ? createSqliteRepo()
    : createMemoryRepo();
console.log(`[db] Using ${repo.backend} backend`);

// Connection/health status for the dashboard. Azure SQL reports live state
// (the serverless DB can pause); local backends are always "connected".
export function getDbStatus() {
  if (typeof repo.getStatus === 'function') return repo.getStatus();
  return { ok: true, backend: repo.backend, state: 'connected', error: null };
}