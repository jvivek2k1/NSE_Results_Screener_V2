// ============================================================
// AI analysis engine. Uses OpenAI when OPENAI_API_KEY is set,
// otherwise produces a deterministic local analysis with the
// same JSON shape so the platform is fully functional offline.
// ============================================================
import { config, hasOpenAI, hasAzureOpenAI } from './config.js';
import { localScore, ratingFromScore } from './scoring.js';
import { extractPdfText } from './pdf.js';

// Normalizes any provided endpoint (base resource URL or a full target URI
// like .../openai/v1/responses) into the v1 base: ".../openai/v1/".
function toV1BaseUrl(endpoint) {
  let e = endpoint.trim().replace(/\/+$/, '');
  const i = e.indexOf('/openai/');
  if (i !== -1) e = e.slice(0, i);
  return `${e}/openai/v1/`;
}

let aiClient = null;
let chatModel = config.openaiModel;
let isAzure = false;

if (hasAzureOpenAI) {
  try {
    const { default: OpenAI } = await import('openai');
    const { DefaultAzureCredential, getBearerTokenProvider } = await import('@azure/identity');
    const tokenProvider = getBearerTokenProvider(
      new DefaultAzureCredential(),
      'https://cognitiveservices.azure.com/.default'
    );
    // The Foundry v1 API uses the OpenAI-compatible /openai/v1/ surface, so we
    // use the standard OpenAI client (not AzureOpenAI, which forces the legacy
    // /openai/deployments/... routing). A custom fetch injects a fresh Entra
    // bearer token on every request (the provider caches & auto-refreshes it).
    aiClient = new OpenAI({
      baseURL: toV1BaseUrl(config.azureEndpoint),
      apiKey: 'entra', // placeholder; replaced by the Authorization header below
      defaultQuery: { 'api-version': config.azureApiVersion },
      fetch: async (url, init = {}) => {
        const token = await tokenProvider();
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${token}`);
        headers.delete('api-key');
        return fetch(url, { ...init, headers });
      },
    });
    chatModel = config.azureDeployment;
    isAzure = true;
    console.log(`[ai] Azure OpenAI (keyless) engine active — deployment: ${config.azureDeployment}`);
  } catch (err) {
    console.warn('[ai] Azure OpenAI init failed, using local engine:', err.message);
  }
}

if (!aiClient && hasOpenAI) {
  try {
    const { default: OpenAI } = await import('openai');
    aiClient = new OpenAI({ apiKey: config.openaiApiKey });
  } catch (err) {
    console.warn('[ai] openai package not available, using local engine:', err.message);
  }
}

const SYSTEM_PROMPT =
  'You are an expert Indian equity research analyst. You analyze quarterly results ' +
  'and return strictly valid JSON only, with no markdown fencing or commentary.';

function buildUserPrompt(filing, metrics, history, pdfText) {
  const hist = history
    .map(
      (h) =>
        `${h.quarter}: Rev ${h.revenue} Cr, EBITDA ${h.ebitda} Cr, PAT ${h.pat} Cr, Margin ${h.ebitdaMargin}%`
    )
    .join('\n');
  const pdfSection = pdfText
    ? `\n\nFull results document (extracted from the filed PDF — use this for segment performance, management commentary, guidance and one-off items):\n"""${pdfText}"""\n`
    : '';
  return `Analyze the quarterly results for ${filing.name} (${filing.ticker}), sector ${filing.sector}, quarter ${filing.quarter}.

Filing text:
"""${filing.rawText}"""${pdfSection}

Historical quarters (oldest to newest):
${hist}

Computed metrics:
- Revenue Growth QoQ: ${fmtPct(metrics.revenueGrowthQoQ)}
- Revenue Growth YoY: ${fmtPct(metrics.revenueGrowthYoY)}
- EBITDA Growth QoQ: ${fmtPct(metrics.ebitdaGrowthQoQ)}
- EBITDA Growth YoY: ${fmtPct(metrics.ebitdaGrowthYoY)}
- PAT Growth QoQ: ${fmtPct(metrics.patGrowthQoQ)}
- PAT Growth YoY: ${fmtPct(metrics.patGrowthYoY)}
- EBITDA Margin change vs prev quarter: ${metrics.marginChange == null ? 'n/a' : `${metrics.marginChange} pp`}
- 4-quarter trend: ${metrics.trend}

Compare the latest quarter against:
1. Previous quarter
2. Previous 3 quarters
3. Same quarter last year

Provide:
1. Overall score from 0-10
2. Classification (Exceptional 9-10, Strong 7-8.9, Average 5-6.9, Weak 3-4.9, Very Weak 0-2.9)
3. Key positives
4. Key negatives
5. Risks
6. Opportunities
7. One-paragraph investor summary

Return JSON only with this exact shape:
{
  "score": 8.4,
  "rating": "Strong",
  "positives": [],
  "negatives": [],
  "risks": [],
  "opportunities": [],
  "summary": ""
}`;
}

// Describes the active AI engine (used by health checks and /api/meta).
export const aiEngine = {
  active: !!aiClient,
  provider: aiClient ? (isAzure ? 'azure' : 'openai') : 'local',
  model: chatModel,
};

// Lightweight connectivity/auth probe against the configured AI model.
// Sends a minimal "ping" completion so a successful (non-throwing) response
// confirms the endpoint, credentials and deployment are all healthy.
// When running on the local engine there is nothing to reach, so it reports ok.
export async function checkAIHealth() {
  const checkedAt = new Date().toISOString();
  if (!aiClient) {
    return { ok: true, provider: 'local', model: null, skipped: true, checkedAt };
  }
  const provider = isAzure ? 'azure' : 'openai';
  const startedAt = Date.now();
  try {
    const params = {
      model: chatModel,
      messages: [
        { role: 'system', content: 'Health check. Reply with the single word: ok' },
        { role: 'user', content: 'ping' },
      ],
    };
    if (!isAzure) params.temperature = 0;
    await aiClient.chat.completions.create(params);
    return { ok: true, provider, model: chatModel, latencyMs: Date.now() - startedAt, checkedAt };
  } catch (err) {
    return {
      ok: false,
      provider,
      model: chatModel,
      error: err.message,
      latencyMs: Date.now() - startedAt,
      checkedAt,
    };
  }
}

export async function analyzeFiling(filing, metrics, history) {
  if (aiClient) {
    try {
      let pdfText = null;
      if (config.aiReadPdf && filing.attachment) {
        pdfText = await extractPdfText(filing.attachment, { maxChars: config.aiPdfMaxChars });
        if (pdfText) console.log(`[ai] read results PDF for ${filing.ticker} (${pdfText.length} chars)`);
      }
      const params = {
        model: chatModel,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(filing, metrics, history, pdfText) },
        ],
      };
      // GPT-5 family / reasoning models only allow the default temperature.
      if (!isAzure) params.temperature = 0.2;
      const completion = await aiClient.chat.completions.create(params);
      const text = completion.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(text);
      return normalizeAnalysis(parsed, history, metrics);
    } catch (err) {
      console.warn('[ai] AI call failed, using local analysis:', err.message);
    }
  }
  return localAnalysis(filing, metrics, history);
}

function normalizeAnalysis(a, history, metrics) {
  const score =
    typeof a.score === 'number' ? Math.round(a.score * 10) / 10 : localScore(history, metrics);
  return {
    score,
    rating: a.rating || ratingFromScore(score),
    positives: arr(a.positives),
    negatives: arr(a.negatives),
    risks: arr(a.risks),
    opportunities: arr(a.opportunities),
    summary: a.summary || '',
  };
}

function arr(x) {
  if (Array.isArray(x)) return x.filter(Boolean).map(String);
  if (typeof x === 'string' && x.trim()) return [x.trim()];
  return [];
}

// -------------------- Deterministic local analysis --------------------
function localAnalysis(filing, metrics, history) {
  const score = localScore(history, metrics);
  const rating = ratingFromScore(score);
  const positives = [];
  const negatives = [];
  const risks = [];
  const opportunities = [];

  if (metrics.revenueGrowthYoY > 12)
    positives.push(`Strong YoY revenue growth of ${metrics.revenueGrowthYoY}%`);
  else if (metrics.revenueGrowthYoY != null && metrics.revenueGrowthYoY < 0)
    negatives.push(`Revenue declined ${Math.abs(metrics.revenueGrowthYoY)}% YoY`);

  if (metrics.patGrowthYoY > 15)
    positives.push(`Profit grew ${metrics.patGrowthYoY}% YoY, reflecting strong earnings momentum`);
  else if (metrics.patGrowthYoY != null && metrics.patGrowthYoY < 0)
    negatives.push(`PAT fell ${Math.abs(metrics.patGrowthYoY)}% YoY`);

  if (metrics.marginChange > 0.5)
    positives.push(`EBITDA margin expanded by ${metrics.marginChange} pp QoQ`);
  else if (metrics.marginChange != null && metrics.marginChange < -0.5)
    negatives.push(`EBITDA margin contracted by ${Math.abs(metrics.marginChange)} pp QoQ`);

  if (metrics.ebitdaGrowthYoY > 10)
    positives.push(`Operating profit (EBITDA) up ${metrics.ebitdaGrowthYoY}% YoY`);

  if (metrics.trend === 'Improving')
    positives.push('Consistent improvement across the last several quarters');
  else if (metrics.trend === 'Deteriorating')
    negatives.push('Deteriorating profit trend over recent quarters');

  if (metrics.revenueGrowthQoQ != null && metrics.revenueGrowthQoQ < 0)
    risks.push('Sequential revenue decline signals possible demand softness');
  if (metrics.marginChange != null && metrics.marginChange < 0)
    risks.push('Margin pressure from rising input costs could persist');
  if (!metrics.hasPrev)
    risks.push(
      'Only the latest quarter is available from NSE for this company, so growth and trend comparisons are limited'
    );
  risks.push('Macro and sector headwinds could affect near-term performance');

  if (metrics.trend === 'Improving')
    opportunities.push('Operating leverage could drive further margin gains');
  opportunities.push(`Sector tailwinds in ${filing.sector} may support continued growth`);
  if (metrics.patGrowthYoY > 20)
    opportunities.push('Re-rating potential given accelerating profitability');

  const revPhrase =
    metrics.revenueGrowthYoY == null && metrics.revenueGrowthQoQ == null
      ? 'no prior-quarter data for growth comparison'
      : `${fmtPct(metrics.revenueGrowthYoY)} YoY, ${fmtPct(metrics.revenueGrowthQoQ)} QoQ`;
  const patPhrase =
    metrics.patGrowthYoY == null ? 'YoY change n/a' : `${fmtPct(metrics.patGrowthYoY)} YoY`;
  const marginPhrase =
    metrics.marginChange == null ? 'QoQ change n/a' : `${signed(metrics.marginChange)} pp QoQ`;
  const summary =
    `${filing.name} reported ${filing.quarter} revenue of Rs ${Number(filing.revenue).toLocaleString('en-IN')} Cr ` +
    `(${revPhrase}) and PAT of ` +
    `Rs ${Number(filing.pat).toLocaleString('en-IN')} Cr (${patPhrase}). ` +
    `With an EBITDA margin of ${filing.ebitdaMargin}% (${marginPhrase}) and a ` +
    `${metrics.trend.toLowerCase()} multi-quarter trend, the quarter rates as ${rating} ` +
    `with an earnings-quality score of ${score}/10.`;

  return {
    score,
    rating,
    positives: positives.length ? positives : ['Stable operating performance'],
    negatives: negatives.length ? negatives : ['No major weaknesses flagged this quarter'],
    risks,
    opportunities,
    summary,
  };
}

function signed(n) {
  return n >= 0 ? `+${n}` : `${n}`;
}

function fmtPct(n) {
  return n == null ? 'n/a' : `${signed(n)}%`;
}
