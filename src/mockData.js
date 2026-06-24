// ============================================================
// Mock data engine: generates realistic synthetic quarterly
// filings (and 8 quarters of history) for demo / offline use.
// ============================================================
import { currentQuarterIndex, quarterIndexToLabel } from './quarters.js';

const COMPANIES = [
  ['RELIANCE', 'Reliance Industries Ltd', 'Energy', 1900000],
  ['TCS', 'Tata Consultancy Services Ltd', 'IT', 1400000],
  ['HDFCBANK', 'HDFC Bank Ltd', 'Banking', 1200000],
  ['INFY', 'Infosys Ltd', 'IT', 650000],
  ['ICICIBANK', 'ICICI Bank Ltd', 'Banking', 800000],
  ['HINDUNILVR', 'Hindustan Unilever Ltd', 'FMCG', 580000],
  ['BHARTIARTL', 'Bharti Airtel Ltd', 'Telecom', 900000],
  ['ITC', 'ITC Ltd', 'FMCG', 560000],
  ['SBIN', 'State Bank of India', 'Banking', 720000],
  ['LT', 'Larsen & Toubro Ltd', 'Infrastructure', 480000],
  ['KOTAKBANK', 'Kotak Mahindra Bank Ltd', 'Banking', 360000],
  ['AXISBANK', 'Axis Bank Ltd', 'Banking', 340000],
  ['ASIANPAINT', 'Asian Paints Ltd', 'Chemicals', 280000],
  ['MARUTI', 'Maruti Suzuki India Ltd', 'Auto', 380000],
  ['SUNPHARMA', 'Sun Pharmaceutical Industries Ltd', 'Pharma', 350000],
  ['TITAN', 'Titan Company Ltd', 'Consumer', 300000],
  ['ULTRACEMCO', 'UltraTech Cement Ltd', 'Cement', 290000],
  ['WIPRO', 'Wipro Ltd', 'IT', 250000],
  ['NESTLEIND', 'Nestle India Ltd', 'FMCG', 230000],
  ['TATAMOTORS', 'Tata Motors Ltd', 'Auto', 320000],
  ['TATASTEEL', 'Tata Steel Ltd', 'Metals', 190000],
  ['POWERGRID', 'Power Grid Corporation of India Ltd', 'Power', 270000],
  ['NTPC', 'NTPC Ltd', 'Power', 330000],
  ['ADANIENT', 'Adani Enterprises Ltd', 'Conglomerate', 350000],
  ['BAJFINANCE', 'Bajaj Finance Ltd', 'NBFC', 440000],
  ['HCLTECH', 'HCL Technologies Ltd', 'IT', 430000],
  ['TECHM', 'Tech Mahindra Ltd', 'IT', 150000],
  ['JSWSTEEL', 'JSW Steel Ltd', 'Metals', 220000],
  ['COALINDIA', 'Coal India Ltd', 'Mining', 280000],
  ['DRREDDY', "Dr Reddy's Laboratories Ltd", 'Pharma', 100000],
  ['CIPLA', 'Cipla Ltd', 'Pharma', 120000],
  ['GRASIM', 'Grasim Industries Ltd', 'Cement', 160000],
  ['BRITANNIA', 'Britannia Industries Ltd', 'FMCG', 130000],
  ['DIVISLAB', "Divi's Laboratories Ltd", 'Pharma', 150000],
  ['HEROMOTOCO', 'Hero MotoCorp Ltd', 'Auto', 90000],
  ['BAJAJ-AUTO', 'Bajaj Auto Ltd', 'Auto', 250000],
  ['EICHERMOT', 'Eicher Motors Ltd', 'Auto', 130000],
  ['DMART', 'Avenue Supermarts Ltd', 'Retail', 270000],
  ['PIDILITIND', 'Pidilite Industries Ltd', 'Chemicals', 150000],
  ['DABUR', 'Dabur India Ltd', 'FMCG', 95000],
];

const emitted = new Set(); // `${ticker}:${quarterIndex}`
let queue = [];

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

// Build an 8-quarter financial trajectory for a company so charts have history.
function buildHistory(company, latestIdx) {
  const [ticker, name, sector, mcap] = company;
  // Base revenue scaled loosely to market cap.
  let revenue = Math.max(500, mcap / rand(8, 16));
  const history = [];
  const driftBias = rand(-0.04, 0.08); // company-level growth tendency
  for (let i = 7; i >= 0; i--) {
    const qIdx = latestIdx - i;
    const qoqGrowth = driftBias + rand(-0.06, 0.1);
    revenue = revenue * (1 + qoqGrowth);
    const ebitdaMargin = clamp(rand(0.12, 0.34) + driftBias / 2, 0.05, 0.45);
    const ebitda = revenue * ebitdaMargin;
    const patMargin = clamp(ebitdaMargin - rand(0.03, 0.12), 0.02, 0.35);
    const pat = revenue * patMargin;
    const shares = rand(50, 800);
    const eps = (pat * 10) / shares; // crore -> rough EPS scaling
    history.push({
      ticker,
      name,
      sector,
      mcap,
      quarterIndex: qIdx,
      quarter: quarterIndexToLabel(qIdx),
      revenue: round(revenue),
      ebitda: round(ebitda),
      pat: round(pat),
      eps: round(eps, 2),
      ebitdaMargin: round(ebitdaMargin * 100, 2),
      debt: round(revenue * rand(0.2, 1.5)),
      cash: round(revenue * rand(0.1, 0.8)),
    });
  }
  return history;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
function round(v, d = 0) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

// Produce a filing object containing the latest quarter + its history.
function makeFiling(company) {
  const latestIdx = currentQuarterIndex();
  const history = buildHistory(company, latestIdx);
  const latest = history[history.length - 1];
  const rawText = buildRawText(latest, history);
  return { ...latest, history, rawText, announcementTime: new Date().toISOString() };
}

function buildRawText(latest, history) {
  const prev = history[history.length - 2];
  const yoy = history[history.length - 5];
  const fmt = (n) => `Rs ${Number(n).toLocaleString('en-IN')} Cr`;
  const commentary = pick([
    'Management remains optimistic on demand recovery and operating leverage.',
    'The company guided for steady margin expansion driven by premiumization.',
    'Order book remains healthy; management reaffirmed full-year guidance.',
    'Cost optimization and digital initiatives are expected to aid profitability.',
    'Near-term input cost pressure persists but pricing actions are underway.',
  ]);
  return [
    `${latest.name} (${latest.ticker}) — Unaudited Financial Results for ${latest.quarter}.`,
    `Revenue from operations stood at ${fmt(latest.revenue)} versus ${fmt(prev.revenue)} in the preceding quarter and ${fmt(yoy.revenue)} in the corresponding quarter of the previous year.`,
    `EBITDA was ${fmt(latest.ebitda)} with an EBITDA margin of ${latest.ebitdaMargin}%.`,
    `Profit After Tax (PAT) was ${fmt(latest.pat)}. Earnings Per Share (EPS) for the quarter was Rs ${latest.eps}.`,
    `Net debt stood at ${fmt(latest.debt)} with cash and equivalents of ${fmt(latest.cash)}.`,
    `Management commentary: ${commentary}`,
  ].join(' ');
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Public: get a batch of "newly announced" filings not seen before.
export function getMockFilings(batchSize = 3) {
  if (queue.length === 0) {
    queue = [...COMPANIES].sort(() => Math.random() - 0.5);
  }
  const out = [];
  while (out.length < batchSize && queue.length > 0) {
    const company = queue.shift();
    const latestIdx = currentQuarterIndex();
    const key = `${company[0]}:${latestIdx}`;
    if (emitted.has(key)) continue;
    emitted.add(key);
    out.push(makeFiling(company));
  }
  return out;
}

export function mockUniverseSize() {
  return COMPANIES.length;
}
