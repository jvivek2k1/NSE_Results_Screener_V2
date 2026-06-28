// ============================================================
// Azure SQL (serverless) data layer — Entra ID auth only.
//
// • Auth: @azure/identity DefaultAzureCredential (az login locally, or a
//   managed identity when hosted). No SQL passwords are ever used or stored.
// • Resilience: the serverless DB can be paused. Every (re)connection uses
//   exponential backoff with jitter so a resuming database is retried instead
//   of surfacing an error. Connection-state changes are broadcast to the
//   dashboard via SSE ('db-status') so the UI can show a clear banner.
// • API parity: exposes the same repository surface as the SQLite/memory
//   backends so the rest of the app is backend-agnostic. Methods are async.
// ============================================================
import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';
import { config } from './config.js';
import { broadcast } from './sse.js';

const DB_TOKEN_SCOPE = 'https://database.windows.net/.default';
const credential = new DefaultAzureCredential();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------- Connection status (for the dashboard) --------------------
let status = {
  ok: false,
  backend: 'azure-sql',
  state: 'connecting', // connecting | connected | error
  error: null,
  since: new Date().toISOString(),
  server: config.azureSqlServer,
  database: config.azureSqlDatabase,
};

function setStatus(state, error = null) {
  const ok = state === 'connected';
  const changed = status.state !== state || status.ok !== ok;
  status = {
    ...status,
    ok,
    state,
    error: error ? String(error.message || error) : null,
    since: changed ? new Date().toISOString() : status.since,
  };
  if (changed) {
    if (state === 'connected') console.log('[azure-sql] connection established');
    else if (state === 'error')
      console.warn(`[azure-sql] connection issue: ${status.error}`);
    broadcast('db-status', status);
  }
}

export function getStatus() {
  return status;
}

// -------------------- Connection pool with backoff --------------------
let pool = null;
let connecting = null;
let schemaReady = false;

function isConnectionError(err) {
  if (!err) return false;
  const code = err.code || err.originalError?.code;
  const name = err.name || '';
  const msg = String(err.message || '').toLowerCase();
  return (
    name === 'ConnectionError' ||
    [
      'ETIMEOUT',
      'ETIMEDOUT',
      'ESOCKET',
      'ECONNCLOSED',
      'ECONNRESET',
      'ELOGIN',
      'EALREADYCONNECTED',
      'ENOTOPEN',
    ].includes(code) ||
    msg.includes('paused') ||
    msg.includes('not currently available') ||
    msg.includes('resuming') ||
    msg.includes('connection is closed') ||
    msg.includes('login failed')
  );
}

function resetPool() {
  schemaReady = false;
  if (pool) {
    try {
      pool.removeAllListeners?.('error');
      pool.close();
    } catch {
      /* ignore */
    }
  }
  pool = null;
}

async function buildPool() {
  // A fresh Entra access token per connection — DefaultAzureCredential caches
  // and refreshes the underlying token, so this is cheap on the hot path.
  const tokenResponse = await credential.getToken(DB_TOKEN_SCOPE);
  const newPool = new sql.ConnectionPool({
    server: config.azureSqlServer,
    database: config.azureSqlDatabase,
    port: config.azureSqlPort,
    authentication: {
      type: 'azure-active-directory-access-token',
      options: { token: tokenResponse.token },
    },
    options: {
      encrypt: true,
      trustServerCertificate: false,
    },
    connectionTimeout: config.azureSqlConnectTimeoutMs,
    requestTimeout: config.azureSqlConnectTimeoutMs,
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
  });
  newPool.on('error', (err) => {
    setStatus('error', err);
    resetPool();
  });
  await newPool.connect();
  return newPool;
}

async function connectWithBackoff() {
  const maxAttempts = Math.max(1, config.azureSqlMaxRetries);
  let delay = config.azureSqlRetryBaseMs;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      setStatus('connecting');
      const newPool = await buildPool();
      pool = newPool;
      if (!schemaReady) {
        await ensureSchema(pool);
        schemaReady = true;
      }
      setStatus('connected');
      return pool;
    } catch (err) {
      lastErr = err;
      setStatus('error', err);
      resetPool();
      if (attempt < maxAttempts) {
        const jitter = Math.floor(Math.random() * 300);
        const wait = Math.min(delay, config.azureSqlRetryMaxMs) + jitter;
        console.warn(
          `[azure-sql] connect attempt ${attempt}/${maxAttempts} failed ` +
            `(${err.message}); retrying in ${wait}ms ` +
            '(serverless DB may be resuming)'
        );
        await sleep(wait);
        delay *= 2;
      }
    }
  }
  throw lastErr || new Error('Azure SQL: unable to establish a connection');
}

async function ensureReady() {
  if (pool && pool.connected) return pool;
  if (connecting) return connecting;
  connecting = connectWithBackoff().finally(() => {
    connecting = null;
  });
  return connecting;
}

// Run a query builder against a ready pool, transparently reconnecting once if
// the connection was dropped (e.g. the serverless DB paused mid-session).
async function query(build) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const activePool = await ensureReady();
    try {
      const result = await build(activePool.request());
      return result;
    } catch (err) {
      lastErr = err;
      if (attempt === 0 && isConnectionError(err)) {
        resetPool();
        continue;
      }
      setStatus('error', err);
      throw err;
    }
  }
  throw lastErr;
}

// Exposed for the SRE chaos demo: run an arbitrary T-SQL batch on the shared
// connection pool (used to create the CPU-load objects and to execute the
// CPU-burning stored procedure during the "SQL CPU 100%" scenario). Reuses the
// same reconnect-on-drop behaviour as every other query in this module.
export async function runRawBatch(batchText) {
  return query((request) => request.batch(batchText));
}

// -------------------- Schema --------------------
// All app-owned database objects are prefixed with `jb_` so they are easy to
// identify alongside other objects in the shared JBDB database.
const T_RESULTS = 'dbo.jb_QuarterlyResults';
const T_WATCHLIST = 'dbo.jb_Watchlist';
const T_ALERTS = 'dbo.jb_Alerts';
const T_UPCOMING = 'dbo.jb_UpcomingResults';

async function ensureSchema(activePool) {
  await activePool.request().batch(`
    IF OBJECT_ID('${T_RESULTS}', 'U') IS NULL
    CREATE TABLE ${T_RESULTS} (
      Id INT IDENTITY(1,1) PRIMARY KEY,
      Ticker NVARCHAR(32) NOT NULL,
      CompanyName NVARCHAR(256) NULL,
      Sector NVARCHAR(128) NULL,
      MarketCap FLOAT NULL,
      AnnouncementTime NVARCHAR(40) NULL,
      Quarter NVARCHAR(32) NULL,
      QuarterIndex INT NULL,
      Revenue FLOAT NULL,
      EBITDA FLOAT NULL,
      PAT FLOAT NULL,
      EPS FLOAT NULL,
      EBITDAMargin FLOAT NULL,
      Debt FLOAT NULL,
      Cash FLOAT NULL,
      RevenueGrowthQoQ FLOAT NULL,
      RevenueGrowthYoY FLOAT NULL,
      EBITDAGrowthQoQ FLOAT NULL,
      EBITDAGrowthYoY FLOAT NULL,
      PATGrowthQoQ FLOAT NULL,
      PATGrowthYoY FLOAT NULL,
      MarginChange FLOAT NULL,
      Trend NVARCHAR(32) NULL,
      Score FLOAT NULL,
      Rating NVARCHAR(32) NULL,
      Reasoning NVARCHAR(MAX) NULL,
      AnalysisJson NVARCHAR(MAX) NULL,
      RawText NVARCHAR(MAX) NULL,
      CONSTRAINT jb_UQ_QuarterlyResults_Ticker_Quarter UNIQUE (Ticker, Quarter)
    );

    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'jb_idx_qr_ticker')
      CREATE INDEX jb_idx_qr_ticker ON ${T_RESULTS} (Ticker);
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'jb_idx_qr_score')
      CREATE INDEX jb_idx_qr_score ON ${T_RESULTS} (Score);
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'jb_idx_qr_time')
      CREATE INDEX jb_idx_qr_time ON ${T_RESULTS} (AnnouncementTime);

    IF OBJECT_ID('${T_WATCHLIST}', 'U') IS NULL
    CREATE TABLE ${T_WATCHLIST} (
      Ticker NVARCHAR(32) PRIMARY KEY,
      CompanyName NVARCHAR(256) NULL,
      Pinned INT NOT NULL DEFAULT 0,
      AddedAt NVARCHAR(40) NULL
    );

    IF OBJECT_ID('${T_ALERTS}', 'U') IS NULL
    CREATE TABLE ${T_ALERTS} (
      Id INT IDENTITY(1,1) PRIMARY KEY,
      Ticker NVARCHAR(32) NULL,
      CompanyName NVARCHAR(256) NULL,
      Type NVARCHAR(64) NULL,
      Message NVARCHAR(512) NULL,
      Score FLOAT NULL,
      CreatedAt NVARCHAR(40) NULL
    );

    IF OBJECT_ID('${T_UPCOMING}', 'U') IS NULL
    CREATE TABLE ${T_UPCOMING} (
      Ticker NVARCHAR(32) NOT NULL,
      CompanyName NVARCHAR(256) NULL,
      Sector NVARCHAR(128) NULL,
      MeetingDate NVARCHAR(40) NOT NULL,
      Quarter NVARCHAR(32) NULL,
      Purpose NVARCHAR(256) NULL,
      Status NVARCHAR(32) NOT NULL DEFAULT 'pending',
      PublishedAt NVARCHAR(40) NULL,
      FirstSeenAt NVARCHAR(40) NULL,
      UpdatedAt NVARCHAR(40) NULL,
      CONSTRAINT jb_PK_UpcomingResults PRIMARY KEY (Ticker, MeetingDate)
    );

    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'jb_idx_upcoming_date')
      CREATE INDEX jb_idx_upcoming_date ON ${T_UPCOMING} (MeetingDate);
  `);
}

// -------------------- Column type map (for typed parameters) --------------------
const QR_COLUMNS = {
  Ticker: sql.NVarChar(32),
  CompanyName: sql.NVarChar(256),
  Sector: sql.NVarChar(128),
  MarketCap: sql.Float,
  AnnouncementTime: sql.NVarChar(40),
  Quarter: sql.NVarChar(32),
  QuarterIndex: sql.Int,
  Revenue: sql.Float,
  EBITDA: sql.Float,
  PAT: sql.Float,
  EPS: sql.Float,
  EBITDAMargin: sql.Float,
  Debt: sql.Float,
  Cash: sql.Float,
  RevenueGrowthQoQ: sql.Float,
  RevenueGrowthYoY: sql.Float,
  EBITDAGrowthQoQ: sql.Float,
  EBITDAGrowthYoY: sql.Float,
  PATGrowthQoQ: sql.Float,
  PATGrowthYoY: sql.Float,
  MarginChange: sql.Float,
  Trend: sql.NVarChar(32),
  Score: sql.Float,
  Rating: sql.NVarChar(32),
  Reasoning: sql.NVarChar(sql.MAX),
  AnalysisJson: sql.NVarChar(sql.MAX),
  RawText: sql.NVarChar(sql.MAX),
};
const QR_COLUMN_NAMES = Object.keys(QR_COLUMNS);

// Latest-quarter-per-ticker predicate reused across read queries.
const LATEST_PREDICATE = `q.QuarterIndex = (
  SELECT MAX(x.QuarterIndex) FROM ${T_RESULTS} x WHERE x.Ticker = q.Ticker
)`;

function buildFilters(filters = {}) {
  const { rating, sector, minScore, search, watchlistOnly, recentDays } = filters;
  const where = [];
  const inputs = [];
  if (rating) {
    where.push('q.Rating = @rating');
    inputs.push(['rating', sql.NVarChar(32), rating]);
  }
  if (sector) {
    where.push('q.Sector = @sector');
    inputs.push(['sector', sql.NVarChar(128), sector]);
  }
  if (minScore != null) {
    where.push('q.Score >= @minScore');
    inputs.push(['minScore', sql.Float, minScore]);
  }
  if (recentDays != null) {
    where.push('q.AnnouncementTime >= @sinceIso');
    inputs.push([
      'sinceIso',
      sql.NVarChar(40),
      new Date(Date.now() - recentDays * 86400000).toISOString(),
    ]);
  }
  if (search) {
    where.push('(q.Ticker LIKE @search OR q.CompanyName LIKE @search)');
    inputs.push(['search', sql.NVarChar(256), `%${search}%`]);
  }
  const watchJoin = watchlistOnly
    ? `JOIN ${T_WATCHLIST} w ON w.Ticker = q.Ticker`
    : '';
  const whereSql = where.length ? 'AND ' + where.join(' AND ') : '';
  return { whereSql, watchJoin, inputs };
}

function applyInputs(request, inputs) {
  for (const [name, type, value] of inputs) request.input(name, type, value);
  return request;
}

// -------------------- Repository --------------------
export function createAzureSqlRepo() {
  // Kick off the first connection in the background so server startup is not
  // blocked; methods await readiness on demand.
  ensureReady().catch(() => {
    /* status already reflects the failure; methods will retry */
  });

  return {
    backend: 'azure-sql',
    getStatus,

    async existsFiling(ticker, quarter) {
      const rs = await query((req) =>
        req
          .input('ticker', sql.NVarChar(32), ticker)
          .input('quarter', sql.NVarChar(32), quarter)
          .query(
            `SELECT TOP 1 1 AS x FROM ${T_RESULTS} WHERE Ticker = @ticker AND Quarter = @quarter`
          )
      );
      return rs.recordset.length > 0;
    },

    async getAllFilingKeys() {
      const rs = await query((req) =>
        req.query(`SELECT Ticker, Quarter, QuarterIndex, AnnouncementTime FROM ${T_RESULTS}`)
      );
      return rs.recordset;
    },

    async deleteFiling(ticker, quarter) {
      const rs = await query((req) =>
        req
          .input('ticker', sql.NVarChar(32), ticker)
          .input('quarter', sql.NVarChar(32), quarter)
          .query(`DELETE FROM ${T_RESULTS} WHERE Ticker = @ticker AND Quarter = @quarter`)
      );
      return rs.rowsAffected?.[0] ?? 0;
    },

    async insertResult(r) {
      const row = normalizeForInsert(r);
      const cols = QR_COLUMN_NAMES;
      const colList = cols.join(', ');
      const valList = cols.map((c) => `@${c}`).join(', ');
      const result = await query((req) => {
        for (const c of cols) req.input(c, QR_COLUMNS[c], row[c]);
        return req.query(`
          IF NOT EXISTS (
            SELECT 1 FROM ${T_RESULTS} WHERE Ticker = @Ticker AND Quarter = @Quarter
          )
          BEGIN
            INSERT INTO ${T_RESULTS} (${colList}) VALUES (${valList});
            SELECT * FROM ${T_RESULTS} WHERE Id = SCOPE_IDENTITY();
          END
        `);
      });
      return result.recordset && result.recordset.length ? result.recordset[0] : null;
    },

    async getById(id) {
      const rs = await query((req) =>
        req
          .input('id', sql.Int, id)
          .query(`SELECT * FROM ${T_RESULTS} WHERE Id = @id`)
      );
      return rs.recordset[0];
    },

    async getHistory(ticker, limit = 8) {
      const rs = await query((req) =>
        req
          .input('ticker', sql.NVarChar(32), ticker)
          .input('limit', sql.Int, limit)
          .query(
            `SELECT TOP (@limit) * FROM ${T_RESULTS}
             WHERE Ticker = @ticker ORDER BY QuarterIndex ASC`
          )
      );
      return rs.recordset;
    },

    async getLatestByTicker(ticker) {
      const rs = await query((req) =>
        req
          .input('ticker', sql.NVarChar(32), ticker)
          .query(
            `SELECT TOP 1 * FROM ${T_RESULTS}
             WHERE Ticker = @ticker ORDER BY QuarterIndex DESC`
          )
      );
      return rs.recordset[0];
    },

    async getResults({
      page = 1,
      limit = 25,
      rating,
      sector,
      minScore,
      search,
      watchlistOnly,
      recentDays,
    }) {
      const { whereSql, watchJoin, inputs } = buildFilters({
        rating,
        sector,
        minScore,
        search,
        watchlistOnly,
        recentDays,
      });
      const base = `
        FROM ${T_RESULTS} q
        ${watchJoin}
        WHERE ${LATEST_PREDICATE}
        ${whereSql}
      `;
      const totalRs = await query((req) =>
        applyInputs(req, inputs).query(`SELECT COUNT(*) AS c ${base}`)
      );
      const total = totalRs.recordset[0].c;
      const rowsRs = await query((req) => {
        applyInputs(req, inputs);
        req.input('limit', sql.Int, limit);
        req.input('offset', sql.Int, (page - 1) * limit);
        return req.query(
          `SELECT q.* ${base}
           ORDER BY q.Score DESC, q.AnnouncementTime DESC
           OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`
        );
      });
      return { rows: rowsRs.recordset, total, page, limit };
    },

    async getTopScores(limit = 10) {
      const rs = await query((req) =>
        req.input('limit', sql.Int, limit).query(
          `SELECT TOP (@limit) q.* FROM ${T_RESULTS} q
           WHERE ${LATEST_PREDICATE}
           ORDER BY q.Score DESC, q.AnnouncementTime DESC`
        )
      );
      return rs.recordset;
    },

    async getStats(filters = {}) {
      const { whereSql, watchJoin, inputs } = buildFilters(filters);
      const rs = await query((req) =>
        applyInputs(req, inputs).query(`
          SELECT q.* FROM ${T_RESULTS} q
          ${watchJoin}
          WHERE ${LATEST_PREDICATE}
          ${whereSql}
        `)
      );
      return computeStats(rs.recordset);
    },

    async getSectorLeaderboard() {
      const rs = await query((req) =>
        req.query(
          `SELECT q.Sector AS sector, COUNT(*) AS companies,
                  ROUND(AVG(q.Score), 2) AS avgScore
           FROM ${T_RESULTS} q
           WHERE ${LATEST_PREDICATE}
           GROUP BY q.Sector ORDER BY avgScore DESC`
        )
      );
      return rs.recordset;
    },

    async getTrendMovers(direction = 'improving', limit = 10) {
      const trend = direction === 'improving' ? 'Improving' : 'Deteriorating';
      const rs = await query((req) =>
        req
          .input('trend', sql.NVarChar(32), trend)
          .input('limit', sql.Int, limit)
          .query(
            `SELECT TOP (@limit) q.* FROM ${T_RESULTS} q
             WHERE ${LATEST_PREDICATE} AND q.Trend = @trend
             ORDER BY q.PATGrowthYoY DESC`
          )
      );
      return rs.recordset;
    },

    async getSectors() {
      const rs = await query((req) =>
        req.query(
          `SELECT DISTINCT Sector FROM ${T_RESULTS}
           WHERE Sector IS NOT NULL ORDER BY Sector`
        )
      );
      return rs.recordset.map((r) => r.Sector);
    },

    // -------- Alerts --------
    async insertAlert(a) {
      const rs = await query((req) =>
        req
          .input('ticker', sql.NVarChar(32), a.ticker ?? null)
          .input('companyName', sql.NVarChar(256), a.companyName ?? null)
          .input('type', sql.NVarChar(64), a.type ?? null)
          .input('message', sql.NVarChar(512), a.message ?? null)
          .input('score', sql.Float, a.score ?? null)
          .input('createdAt', sql.NVarChar(40), new Date().toISOString())
          .query(`
            INSERT INTO ${T_ALERTS} (Ticker, CompanyName, Type, Message, Score, CreatedAt)
            VALUES (@ticker, @companyName, @type, @message, @score, @createdAt);
            SELECT * FROM ${T_ALERTS} WHERE Id = SCOPE_IDENTITY();
          `)
      );
      return rs.recordset[0];
    },

    async getAlerts(limit = 50) {
      const rs = await query((req) =>
        req
          .input('limit', sql.Int, limit)
          .query(
            `SELECT TOP (@limit) * FROM ${T_ALERTS} ORDER BY CreatedAt DESC, Id DESC`
          )
      );
      return rs.recordset;
    },

    // -------- Watchlist --------
    async getWatchlist() {
      const rs = await query((req) =>
        req.query(
          `SELECT * FROM ${T_WATCHLIST} ORDER BY Pinned DESC, AddedAt DESC`
        )
      );
      return rs.recordset;
    },

    async addWatch(ticker, companyName) {
      await query((req) =>
        req
          .input('ticker', sql.NVarChar(32), ticker)
          .input('companyName', sql.NVarChar(256), companyName || ticker)
          .input('addedAt', sql.NVarChar(40), new Date().toISOString())
          .query(`
            IF NOT EXISTS (SELECT 1 FROM ${T_WATCHLIST} WHERE Ticker = @ticker)
              INSERT INTO ${T_WATCHLIST} (Ticker, CompanyName, Pinned, AddedAt)
              VALUES (@ticker, @companyName, 0, @addedAt);
          `)
      );
      return this.getWatchlist();
    },

    async removeWatch(ticker) {
      await query((req) =>
        req
          .input('ticker', sql.NVarChar(32), ticker)
          .query(`DELETE FROM ${T_WATCHLIST} WHERE Ticker = @ticker`)
      );
      return this.getWatchlist();
    },

    async togglePin(ticker) {
      await query((req) =>
        req
          .input('ticker', sql.NVarChar(32), ticker)
          .query(
            `UPDATE ${T_WATCHLIST} SET Pinned = 1 - Pinned WHERE Ticker = @ticker`
          )
      );
      return this.getWatchlist();
    },

    async isWatched(ticker) {
      const rs = await query((req) =>
        req
          .input('ticker', sql.NVarChar(32), ticker)
          .query(`SELECT TOP 1 1 AS x FROM ${T_WATCHLIST} WHERE Ticker = @ticker`)
      );
      return rs.recordset.length > 0;
    },

    async count() {
      const rs = await query((req) =>
        req.query(
          `SELECT COUNT(DISTINCT Ticker) AS c FROM ${T_RESULTS}`
        )
      );
      return rs.recordset[0].c;
    },

    async maxScore() {
      const rs = await query((req) =>
        req.query(`SELECT MAX(Score) AS m FROM ${T_RESULTS}`)
      );
      return rs.recordset[0].m || 0;
    },

    // -------- Upcoming results (NSE board-meeting calendar) --------
    async upsertUpcoming(u) {
      const now = new Date().toISOString();
      const rs = await query((req) =>
        req
          .input('Ticker', sql.NVarChar(32), u.Ticker)
          .input('CompanyName', sql.NVarChar(256), u.CompanyName ?? null)
          .input('Sector', sql.NVarChar(128), u.Sector ?? null)
          .input('MeetingDate', sql.NVarChar(40), u.MeetingDate)
          .input('Quarter', sql.NVarChar(32), u.Quarter ?? null)
          .input('Purpose', sql.NVarChar(256), u.Purpose ?? null)
          .input('now', sql.NVarChar(40), now)
          .query(`
            IF EXISTS (SELECT 1 FROM ${T_UPCOMING} WHERE Ticker = @Ticker AND MeetingDate = @MeetingDate)
              UPDATE ${T_UPCOMING}
                SET CompanyName = @CompanyName, Sector = @Sector,
                    Quarter = @Quarter, Purpose = @Purpose, UpdatedAt = @now
              WHERE Ticker = @Ticker AND MeetingDate = @MeetingDate;
            ELSE
              INSERT INTO ${T_UPCOMING}
                (Ticker, CompanyName, Sector, MeetingDate, Quarter, Purpose, Status, PublishedAt, FirstSeenAt, UpdatedAt)
              VALUES
                (@Ticker, @CompanyName, @Sector, @MeetingDate, @Quarter, @Purpose, 'pending', NULL, @now, @now);
            SELECT * FROM ${T_UPCOMING} WHERE Ticker = @Ticker AND MeetingDate = @MeetingDate;
          `)
      );
      return rs.recordset[0];
    },

    async getUpcoming(limit = 10) {
      const today = new Date().toLocaleDateString('en-CA');
      const rs = await query((req) =>
        req
          .input('today', sql.NVarChar(10), today)
          .input('limit', sql.Int, limit)
          .query(
            `SELECT TOP (@limit) * FROM ${T_UPCOMING}
             WHERE LEFT(MeetingDate, 10) >= @today
             ORDER BY MeetingDate ASC`
          )
      );
      return rs.recordset;
    },

    async getUpcomingDueToday() {
      const today = new Date().toLocaleDateString('en-CA');
      const rs = await query((req) =>
        req
          .input('today', sql.NVarChar(10), today)
          .query(
            `SELECT * FROM ${T_UPCOMING}
             WHERE LEFT(MeetingDate, 10) = @today AND Status <> 'published'`
          )
      );
      return rs.recordset;
    },

    async markUpcomingPublished(ticker, meetingDate, publishedAt) {
      const now = new Date().toISOString();
      await query((req) =>
        req
          .input('ticker', sql.NVarChar(32), ticker)
          .input('meetingDate', sql.NVarChar(40), meetingDate)
          .input('publishedAt', sql.NVarChar(40), publishedAt || now)
          .input('now', sql.NVarChar(40), now)
          .query(
            `UPDATE ${T_UPCOMING}
               SET Status = 'published', PublishedAt = @publishedAt, UpdatedAt = @now
             WHERE Ticker = @ticker AND MeetingDate = @meetingDate`
          )
      );
      return { ticker, meetingDate, status: 'published', publishedAt: publishedAt || now };
    },
  };
}

// -------------------- Shared helpers (mirror src/db.js) --------------------
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
