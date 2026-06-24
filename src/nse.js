// ============================================================
// Real NSE data client.
//
// Uses two public NSE endpoints (no login required):
//   1. /api/corporates-financial-results        -> list of filings
//   2. /api/corporates-financial-results-data    -> per-filing financials
//
// All monetary figures from NSE are reported in Rs Lakh; we convert
// to Rs Crore (÷100) to match the rest of the platform.
// ============================================================
import axios from 'axios';

const BASE = 'https://www.nseindia.com';
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.nseindia.com/companies-listing/corporate-filings-financial-results',
};

let cookie = '';

async function refreshCookie() {
  try {
    const res = await axios.get(BASE, { headers: HEADERS, timeout: 10000 });
    const sc = res.headers['set-cookie'] || [];
    cookie = sc.map((c) => c.split(';')[0]).join('; ');
  } catch {
    /* NSE often 403s the homepage; the APIs still work without a cookie */
  }
}

async function nseGet(url) {
  try {
    return await axios.get(url, {
      headers: { ...HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
      timeout: 15000,
    });
  } catch (err) {
    if ([401, 403].includes(err.response?.status)) {
      await refreshCookie();
      return axios.get(url, {
        headers: { ...HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
        timeout: 15000,
      });
    }
    throw err;
  }
}

const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

// "31-Dec-2024" -> Date
function parseNseDate(str) {
  if (!str) return null;
  const m = /(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(str);
  if (!m) return null;
  return new Date(Date.UTC(+m[3], MONTHS[m[2]] ?? 0, +m[1]));
}

// "05-Jun-2026 11:36:08" -> ISO string
function parseNseDateTime(str) {
  if (!str) return null;
  const m = /(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/.exec(str);
  if (!m) {
    const d = parseNseDate(str);
    return d ? d.toISOString() : null;
  }
  return new Date(+m[3], MONTHS[m[2]] ?? 0, +m[1], +m[4], +m[5], +m[6]).toISOString();
}

// Quarter (Indian fiscal year, FY labelled by ending year) from period-end date.
function periodEndToQuarter(date) {
  const month = date.getUTCMonth();
  const year = date.getUTCFullYear();
  let q, fy;
  if (month <= 2) {
    q = 4; fy = year; // Jan-Mar
  } else if (month <= 5) {
    q = 1; fy = year + 1; // Apr-Jun
  } else if (month <= 8) {
    q = 2; fy = year + 1; // Jul-Sep
  } else {
    q = 3; fy = year + 1; // Oct-Dec
  }
  return { quarter: `Q${q} FY${String(fy).slice(-2)}`, quarterIndex: fy * 4 + (q - 1) };
}

function num(v) {
  if (v == null || v === '' || v === '-') return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
// lakh -> crore
const toCr = (lakh) => (lakh == null ? null : Math.round((lakh / 100) * 100) / 100);

export function mapListItem(raw) {
  const periodEnd = parseNseDate(raw.toDate || raw.periodEndDT);
  if (!periodEnd) return null;
  const { quarter, quarterIndex } = periodEndToQuarter(periodEnd);
  return {
    symbol: raw.symbol,
    company: raw.companyName || raw.sm_name || raw.symbol,
    isin: raw.isin,
    industry: raw.industry ?? '', // raw value required by the detail API (often "-")
    sector: raw.industry && raw.industry !== '-' ? raw.industry : 'Other', // for display
    consolidated: raw.consolidated,
    audited: raw.audited,
    params: raw.params,
    seqNumber: raw.seqNumber,
    indAs: raw.indAs,
    format: raw.format,
    broadcastISO: parseNseDateTime(raw.broadCastDate || raw.exchdisstime || raw.filingDate),
    periodEnd,
    quarter,
    quarterIndex,
  };
}

// Pull the quarterly results list (real filings, newest first).
export async function fetchQuarterlyList() {
  const url = `${BASE}/api/corporates-financial-results?index=equities&period=Quarterly`;
  const res = await nseGet(url);
  const data = Array.isArray(res.data) ? res.data : res.data?.data || [];
  const items = data.map(mapListItem).filter((x) => x && x.symbol && x.broadcastISO);
  items.sort((a, b) => new Date(b.broadcastISO) - new Date(a.broadcastISO));
  return items;
}

// Pull the FULL quarterly filing history for a single symbol (many quarters),
// de-duplicated to one item per quarter (prefer Consolidated). Used to build
// the last-3-quarters comparison when the main list only carries the latest
// quarter for a company.
export async function fetchSymbolQuarterlyList(symbol) {
  const url = `${BASE}/api/corporates-financial-results?index=equities&period=Quarterly&symbol=${encodeURIComponent(symbol)}`;
  const res = await nseGet(url);
  const data = Array.isArray(res.data) ? res.data : res.data?.data || [];
  const byQuarter = new Map();
  for (const raw of data) {
    const it = mapListItem(raw);
    if (!it || !it.symbol) continue;
    const existing = byQuarter.get(it.quarterIndex);
    if (!existing || (it.consolidated === 'Consolidated' && existing.consolidated !== 'Consolidated')) {
      byQuarter.set(it.quarterIndex, it);
    }
  }
  return [...byQuarter.values()].sort((a, b) => a.quarterIndex - b.quarterIndex);
}

// Fetch the real financial line-items for a single filing.
export async function fetchFinancials(item) {
  const qp = new URLSearchParams({
    index: 'equities',
    params: item.params,
    seq_id: item.seqNumber,
    industry: item.industry || '',
    ind: item.indAs || '',
    format: item.format || 'New',
  });
  const url = `${BASE}/api/corporates-financial-results-data?${qp.toString()}`;
  const res = await nseGet(url);
  const d = res.data?.resultsData2;
  if (!d || typeof d !== 'object') return null;

  // Revenue: net sales (industrials) -> interest earned (banks) -> total income.
  const revenueLakh = num(d.re_net_sale) ?? num(d.re_int_earned) ?? num(d.re_total_inc);
  const patLakh = num(d.re_net_profit) ?? num(d.re_con_pro_loss) ?? num(d.re_proloss_ord_act);
  const totalIncLakh = num(d.re_total_inc) ?? num(d.re_tot_inc) ?? revenueLakh;
  const totalExpLakh = num(d.re_oth_tot_exp);
  const interestLakh = num(d.re_int_new) ?? num(d.re_int) ?? 0;
  const deprLakh = num(d.re_depr_und_exp) ?? 0;

  // Derived operating EBITDA (excl. exceptional items) when expense data exists.
  let ebitdaLakh = null;
  if (totalIncLakh != null && totalExpLakh != null) {
    ebitdaLakh = totalIncLakh - totalExpLakh + (interestLakh || 0) + (deprLakh || 0);
  }

  const eps =
    num(d.re_basic_eps_for_cont_dic_opr) ??
    num(d.re_basic_eps) ??
    num(d.re_dilut_eps_for_cont_dic_opr);

  const revenue = toCr(revenueLakh);
  const ebitda = toCr(ebitdaLakh);
  const pat = toCr(patLakh);
  const ebitdaMargin =
    ebitda != null && revenue ? Math.round((ebitda / revenue) * 10000) / 100 : null;

  return {
    revenue,
    ebitda,
    pat,
    eps,
    ebitdaMargin,
    interest: toCr(interestLakh),
    depreciation: toCr(deprLakh),
    faceValue: num(d.re_face_val),
    attachment: res.data?.attachment_filename || null,
    periodEndLabel: res.data?.periodEndDT || null,
  };
}

// Derive an Indian-fiscal quarter label from a results-meeting description,
// e.g. "...Quarterly ended March 2026...", "period ended March 31, 2026" or
// "quarter ending 30th June 2026". Anchors on the period that follows
// "ended/ending" so it doesn't pick up the meeting date (e.g. 29-Jun-2026).
function quarterFromDesc(desc) {
  if (!desc) return null;
  const lower = desc.toLowerCase();
  const idx = Math.max(lower.lastIndexOf('ended'), lower.lastIndexOf('ending'));
  const hay = idx >= 0 ? desc.slice(idx) : desc;
  const m =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b[\s\S]{0,12}?(\d{4})/i.exec(hay);
  if (!m) return null;
  const monKey = m[1].slice(0, 3).replace(/^./, (c) => c.toUpperCase());
  const month = MONTHS[monKey];
  if (month == null) return null;
  return periodEndToQuarter(new Date(Date.UTC(+m[2], month, 28))).quarter;
}

// Forthcoming results: companies that have informed NSE of a board meeting to
// approve financial results. Returns upcoming (future-dated) entries, one per
// company (earliest future meeting), sorted by date ascending.
export async function fetchUpcomingResults() {
  const url = `${BASE}/api/corporate-board-meetings?index=equities`;
  let data;
  try {
    const res = await nseGet(url);
    data = Array.isArray(res.data) ? res.data : res.data?.data || [];
  } catch {
    return [];
  }

  const isResults = (m) => /result/i.test(`${m.bm_purpose || ''} ${m.bm_desc || ''}`);
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);

  const seen = new Set();
  const out = [];
  for (const m of data) {
    if (!isResults(m)) continue;
    const date = parseNseDate(m.bm_date);
    if (!date || date < startToday) continue;
    const symbol = m.bm_symbol || m.symbol;
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({
      ticker: symbol,
      company: m.sm_name || symbol,
      sector: m.sm_indusrty && m.sm_indusrty !== '-' ? m.sm_indusrty : 'Other',
      meetingDate: date.toISOString(),
      quarter: quarterFromDesc(m.bm_desc) || null,
      purpose: (m.bm_purpose || 'Financial Results').trim(),
    });
  }
  out.sort((a, b) => new Date(a.meetingDate) - new Date(b.meetingDate));
  return out;
}
