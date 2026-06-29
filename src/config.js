// Lightweight .env loader (avoids extra dependency).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function loadEnvFile() {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf-8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  // Azure OpenAI / AI Foundry (keyless via Entra ID). Endpoint may be the
  // base resource URL or the full v1 target URI — it is normalized at use.
  azureEndpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
  azureDeployment: process.env.AZURE_OPENAI_DEPLOYMENT || '',
  azureApiVersion: process.env.AZURE_OPENAI_API_VERSION || 'preview',
  // When true (default), the AI engine downloads each filing's results PDF and
  // feeds the extracted text to the model for deeper segment/guidance analysis.
  aiReadPdf: (process.env.AI_READ_PDF || 'true').toLowerCase() !== 'false',
  aiPdfMaxChars: parseInt(process.env.AI_PDF_MAX_CHARS || '12000', 10),
  dataMode: (process.env.DATA_MODE || 'live').toLowerCase(), // live | mock | auto
  mockBatchSize: parseInt(process.env.MOCK_BATCH_SIZE || '3', 10),
  scanBatchSize: parseInt(process.env.SCAN_BATCH_SIZE || '8', 10),
  // -------------------- Data store --------------------
  // Which persistence backend to use: 'azure-sql' | 'sqlite' | 'memory'.
  // Azure SQL stores results centrally so they are not re-fetched from the
  // internet every run; the pipeline only fetches+stores filings not already
  // present (freshness comparison), then the dashboard reads from the DB.
  dbBackend: (process.env.DB_BACKEND || 'azure-sql').toLowerCase(),
  // Azure SQL (serverless) connection. Auth is Entra ID only (no SQL auth) via
  // @azure/identity DefaultAzureCredential — az login locally, or a managed
  // identity when hosted. No passwords are ever read or stored.
  azureSqlServer: process.env.AZURE_SQL_SERVER || 'sql-aev7ydnz74wgi.database.windows.net',
  azureSqlDatabase: process.env.AZURE_SQL_DATABASE || 'JBDB',
  azureSqlPort: parseInt(process.env.AZURE_SQL_PORT || '1433', 10),
  // Connection timeout per attempt — generous so a paused serverless DB has
  // time to resume during the first (re)connection.
  azureSqlConnectTimeoutMs: parseInt(process.env.AZURE_SQL_CONNECT_TIMEOUT_MS || '30000', 10),
  // Exponential-backoff retry budget when the serverless DB is paused/resuming.
  azureSqlMaxRetries: parseInt(process.env.AZURE_SQL_MAX_RETRIES || '6', 10),
  azureSqlRetryBaseMs: parseInt(process.env.AZURE_SQL_RETRY_BASE_MS || '1000', 10),
  azureSqlRetryMaxMs: parseInt(process.env.AZURE_SQL_RETRY_MAX_MS || '30000', 10),
  // Active health-probe cadence: how often to actively ping the DB and AI model
  // so an outage (e.g. SQL public access disabled, AI deployment removed) is
  // detected within seconds even when no user traffic is flowing.
  dbHealthIntervalMs: parseInt(process.env.DB_HEALTH_INTERVAL_MS || '5000', 10),
  aiHealthIntervalMs: parseInt(process.env.AI_HEALTH_INTERVAL_MS || '5000', 10),
  // SQL blocking probe: how often the app counts blocked sessions (DMV) and
  // emits the `SqlBlockedSessions` custom metric, plus the threshold at/above
  // which it logs a warning. A log-query alert fires on the same metric.
  blockingProbeIntervalMs: parseInt(process.env.BLOCKING_PROBE_INTERVAL_MS || '30000', 10),
  blockingAlertThreshold: parseInt(process.env.BLOCKING_ALERT_THRESHOLD || '20', 10),
  // Only seed/scan filings broadcast within this many days (0 = no age limit).
  // Keeps the AI from spending tokens on stale quarterly filings.
  filingMaxAgeDays: parseInt(process.env.FILING_MAX_AGE_DAYS || '1', 10),
  // Skip belated/backlog filings whose broadcast date is more than this many
  // days after the quarter's period-end (0 = no limit). Defaults to ~6 months,
  // well beyond SEBI's 45-day reporting deadline, so distressed companies
  // dumping years-old results (e.g. firms under insolvency such as Videocon)
  // don't surface on the dashboard as if they were fresh quarterly results.
  filingMaxReportingLagDays: parseInt(process.env.FILING_MAX_REPORTING_LAG_DAYS || '180', 10),
  // Auto-refresh cadence: every 10 minutes by default.
  scanCron: process.env.SCAN_CRON || '*/10 * * * *',
  scanIntervalMs: parseInt(process.env.SCAN_INTERVAL_MS || '600000', 10),
  // Email-on-open notification (Yahoo SMTP). Credentials live in .env only.
  emailHost: process.env.EMAIL_HOST || 'smtp.mail.yahoo.com',
  emailPort: parseInt(process.env.EMAIL_PORT || '465', 10),
  emailUser: process.env.EMAIL_USER || '',
  emailPassword: process.env.EMAIL_APP_PASSWORD || '',
  emailFrom: process.env.EMAIL_FROM || process.env.EMAIL_USER || '',
  emailTo: process.env.EMAIL_TO || process.env.EMAIL_USER || '',
  // Throttle: don't send more than one "opened" email per this many minutes.
  emailThrottleMinutes: parseInt(process.env.EMAIL_THROTTLE_MINUTES || '10', 10),
  // -------------------- SRE chaos demo (management-plane actions) --------------------
  // Azure resource coordinates used by the SRE demo menu to (a) disable Azure
  // SQL public network access, (b) delete the AI model deployment, and (c)
  // drive Azure SQL CPU to 100%. Populated as App Service settings by Bicep.
  azureSubscriptionId: process.env.AZURE_SUBSCRIPTION_ID || '',
  azureResourceGroup: process.env.AZURE_RESOURCE_GROUP || '',
  // Short SQL server name (no domain). Falls back to deriving it from the FQDN.
  azureSqlServerName:
    process.env.AZURE_SQL_SERVER_NAME ||
    (process.env.AZURE_SQL_SERVER || '').split('.')[0] ||
    '',
  // Azure AI Services (Foundry) account short name hosting the model deployment.
  azureAiAccountName: process.env.AZURE_AI_ACCOUNT_NAME || '',
  rootDir,
};

export const hasAzureOpenAI = Boolean(config.azureEndpoint && config.azureDeployment);
export const hasOpenAI = Boolean(config.openaiApiKey);
export const hasEmail = Boolean(config.emailUser && config.emailPassword);
export const useAzureSql =
  config.dbBackend === 'azure-sql' ||
  config.dbBackend === 'azuresql' ||
  config.dbBackend === 'mssql';