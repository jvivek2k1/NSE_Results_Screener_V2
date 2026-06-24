// ============================================================
// Data acquisition.
//   DATA_MODE=live  -> real NSE filings + real financials only
//   DATA_MODE=mock  -> synthetic demo data
//   DATA_MODE=auto  -> live, falling back to mock only if NSE is unreachable
// ============================================================
import { config } from './config.js';
import { repo } from './db.js';
import { getMockFilings, mockUniverseSize } from './mockData.js';
import { fetchQuarterlyList, fetchFinancials, fetchSymbolQuarterlyList } from './nse.js';
import { currentQuarterIndex, quarterIndexToLabel } from './quarters.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const financialsCache = new Map(); // seqNumber -> financials
const symbolHistoryCache = new Map(); // symbol -> mapped quarter items (sorted asc)
let listCache = { at: 0, items: [] };

async function getList() {
  // Cache the list briefly so back-to-back scans don't hammer NSE.
  if (Date.now() - listCache.at < 30000 && listCache.items.length) return listCache.items;
  const items = await fetchQuarterlyList();
  listCache = { at: Date.now(), items };
  return items;
}

// Group filings by symbol, de-duplicating per quarter (prefer Consolidated).
function groupBySymbol(items) {
  const bySymbol = new Map();
  for (const it of items) {
    const map = bySymbol.get(it.symbol) || new Map();
    const existing = map.get(it.quarterIndex);
    if (
      !existing ||
      (it.consolidated === 'Consolidated' && existing.consolidated !== 'Consolidated')
    ) {
      map.set(it.quarterIndex, it);
    }
    bySymbol.set(it.symbol, map);
  }
  return bySymbol;
}

async function financialsFor(item) {
  if (financialsCache.has(item.seqNumber)) return financialsCache.get(item.seqNumber);
  const fin = await fetchFinancials(item);
  financialsCache.set(item.seqNumber, fin);
  await sleep(180); // be gentle with NSE
  return fin;
}

// Build a filing object for one symbol's latest quarter. Scanning stays fast by
// using only the quarters already present in the results list; the full
// last-3-quarters history is fetched lazily on demand (see fetchSymbolHistory).
async function buildFiling(symbolQuarters, latestItem) {
  const quarters = [...symbolQuarters.values()]
    .filter((q) => q.quarterIndex <= latestItem.quarterIndex)
    .sort((a, b) => a.quarterIndex - b.quarterIndex)
    .slice(-8);

  const history = [];
  for (const q of quarters) {
    const fin = await financialsFor(q);
    if (!fin || fin.revenue == null) continue;
    history.push({
      ticker: q.symbol,
      name: q.company,
      sector: q.sector,
      mcap: null,
      quarter: q.quarter,
      quarterIndex: q.quarterIndex,
      revenue: fin.revenue,
      ebitda: fin.ebitda,
      pat: fin.pat,
      eps: fin.eps,
      ebitdaMargin: fin.ebitdaMargin,
      debt: null,
      cash: null,
      attachment: fin.attachment,
    });
  }
  if (history.length === 0) return null;

  const latest = history[history.length - 1];
  const rawText = buildRealRawText(latestItem, latest);
  return {
    ...latest,
    history,
    rawText,
    announcementTime: latestItem.broadcastISO || new Date().toISOString(),
    source: 'NSE',
  };
}

function buildRealRawText(item, fin) {
  const cr = (v) => (v == null ? 'n/a' : `Rs ${Number(v).toLocaleString('en-IN')} Cr`);
  return [
    `${fin.name} (${fin.ticker}) reported ${fin.quarter} financial results to NSE.`,
    `Revenue: ${cr(fin.revenue)}. EBITDA: ${cr(fin.ebitda)}. PAT: ${cr(fin.pat)}.`,
    `EPS: ${fin.eps != null ? `Rs ${fin.eps}` : 'n/a'}.`,
    `${item.consolidated || ''} ${item.audited || ''}.`.trim(),
    item.broadcastISO ? `Filed: ${new Date(item.broadcastISO).toLocaleString('en-IN')}.` : '',
    'Source: NSE corporate filings.',
  ]
    .filter(Boolean)
    .join(' ');
}

// Lazily fetch a single company's recent quarter history (default: last 4
// quarters) directly from NSE. Used on demand (e.g. when a detail panel opens)
// so scanning stays fast while the last-3-quarters comparison still gets real
// data. Returns history objects ascending by quarterIndex.
export async function fetchSymbolHistory(ticker, maxQuarters = 4) {
  if (config.dataMode === 'mock') return [];
  let items = symbolHistoryCache.get(ticker);
  if (!items) {
    items = await fetchSymbolQuarterlyList(ticker);
    symbolHistoryCache.set(ticker, items);
  }
  const recent = items.slice(-maxQuarters);
  const history = [];
  for (const q of recent) {
    const fin = await financialsFor(q);
    if (!fin || fin.revenue == null) continue;
    history.push({
      ticker: q.symbol,
      name: q.company,
      sector: q.sector,
      mcap: null,
      quarter: q.quarter,
      quarterIndex: q.quarterIndex,
      revenue: fin.revenue,
      ebitda: fin.ebitda,
      pat: fin.pat,
      eps: fin.eps,
      ebitdaMargin: fin.ebitdaMargin,
      debt: null,
      cash: null,
      attachment: fin.attachment,
      announcementTime: q.broadcastISO || null,
    });
  }
  return history;
}

async function getLiveFilings(limit) {
  const list = await getList();
  const bySymbol = groupBySymbol(list);

  // Latest quarterIndex per symbol.
  const latestIndex = new Map();
  for (const [symbol, qmap] of bySymbol) {
    latestIndex.set(symbol, Math.max(...qmap.keys()));
  }

  const out = [];
  const seen = new Set();
  let attempts = 0;
  const maxAttempts = limit * 4; // safety cap so we never crawl the whole universe
  // Skip filings broadcast more than `filingMaxAgeDays` ago (0 = no age limit).
  const minBroadcastMs =
    config.filingMaxAgeDays > 0 ? Date.now() - config.filingMaxAgeDays * 86400000 : null;
  // `list` is sorted newest-broadcast-first, so the freshest filings come first.
  for (const it of list) {
    if (out.length >= limit || attempts >= maxAttempts) break;
    if (seen.has(it.symbol)) continue;
    if (it.quarterIndex !== latestIndex.get(it.symbol)) continue; // not the company's latest quarter
    if (minBroadcastMs != null) {
      const ts = it.broadcastISO ? new Date(it.broadcastISO).getTime() : NaN;
      // List is newest-first, so once we pass the age cutoff everything after
      // is older too — stop scanning to avoid crawling stale filings.
      if (Number.isNaN(ts) || ts < minBroadcastMs) break;
    }
    if (await repo.existsFiling(it.symbol, it.quarter)) continue; // already processed
    seen.add(it.symbol);
    attempts++;
    try {
      const filing = await buildFiling(bySymbol.get(it.symbol), it);
      if (filing) out.push(filing);
    } catch (err) {
      console.warn(`[scraper] failed to build ${it.symbol}:`, err.message);
    }
  }
  return out;
}

// Public entry: returns an array of new filing objects.
export async function getNewFilings(limit = config.scanBatchSize) {
  const mode = config.dataMode;

  if (mode === 'mock') {
    return getMockFilings(config.mockBatchSize).map((f) => ({ ...f, source: 'MOCK' }));
  }

  try {
    const filings = await getLiveFilings(limit);
    if (filings.length > 0 || mode === 'live') return filings;
  } catch (err) {
    if (mode === 'live') {
      console.warn('[scraper] live NSE fetch failed:', err.message);
      return [];
    }
    console.warn('[scraper] live NSE fetch failed, falling back to mock:', err.message);
  }

  // auto: nothing new live (or unreachable) -> demo data so the UI isn't empty
  return getMockFilings(config.mockBatchSize).map((f) => ({ ...f, source: 'MOCK' }));
}

export function universeSize() {
  return config.dataMode === 'mock' ? mockUniverseSize() : 2000;
}

export { quarterIndexToLabel, currentQuarterIndex };
