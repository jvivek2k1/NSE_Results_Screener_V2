// ============================================================
// SRE chaos demo — fault-injection actions wired to the dashboard menu.
//
// These deliberately break a production dependency so the SRE Agent can detect,
// root-cause and remediate the incident. Three scenarios are supported:
//
//   1. disableSqlPublicAccess() — sets the Azure SQL logical server's
//      publicNetworkAccess to 'Disabled' (management plane). The app then loses
//      its database connection and the db-connectivity alert fires.
//   2. removeAiModel()          — deletes the Azure OpenAI / Foundry model
//      deployment (management plane). AI calls start failing and the
//      ai-connectivity alert fires.
//   3. runSqlCpu100()           — fires several CPU-burning stored procedures in
//      parallel against Azure SQL (data plane), saturating the serverless vCores
//      so CPU pegs at ~100% and the app's responses degrade badly. The SQL CPU
//      metric alert (>= 85%) fires and routes to the action group.
//
// Management-plane calls authenticate with the App Service managed identity via
// DefaultAzureCredential (ARM scope). The identity is granted "SQL Server
// Contributor" and "Cognitive Services Contributor" by infra/modules/chaos-access.bicep.
// ============================================================
import { DefaultAzureCredential } from '@azure/identity';
import { config } from './config.js';
import { runRawBatch } from './azuresql.js';

const credential = new DefaultAzureCredential();
const ARM_BASE = 'https://management.azure.com';
const ARM_SCOPE = 'https://management.azure.com/.default';

function requireConfig(...keys) {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length) {
    throw new Error(
      `Chaos action not configured — missing app setting(s): ${missing.join(', ')}`
    );
  }
}

async function armRequest(method, url, body) {
  const token = await credential.getToken(ARM_SCOPE);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ARM ${method} ${res.status}: ${text || res.statusText}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

// -------------------- 1) Disable SQL public network access --------------------
export async function disableSqlPublicAccess() {
  requireConfig('azureSubscriptionId', 'azureResourceGroup', 'azureSqlServerName');
  const url =
    `${ARM_BASE}/subscriptions/${config.azureSubscriptionId}` +
    `/resourceGroups/${config.azureResourceGroup}` +
    `/providers/Microsoft.Sql/servers/${config.azureSqlServerName}` +
    `?api-version=2023-08-01-preview`;
  await armRequest('PATCH', url, { properties: { publicNetworkAccess: 'Disabled' } });
  return {
    action: 'disable-sql-public-access',
    target: config.azureSqlServerName,
    message:
      `Azure SQL public network access is being disabled on '${config.azureSqlServerName}'. ` +
      'The app will lose database connectivity within ~1 minute and the ' +
      'db-connectivity alert will fire.',
  };
}

// -------------------- 2) Remove the AI model deployment --------------------
export async function removeAiModel() {
  requireConfig(
    'azureSubscriptionId',
    'azureResourceGroup',
    'azureAiAccountName',
    'azureDeployment'
  );
  const url =
    `${ARM_BASE}/subscriptions/${config.azureSubscriptionId}` +
    `/resourceGroups/${config.azureResourceGroup}` +
    `/providers/Microsoft.CognitiveServices/accounts/${config.azureAiAccountName}` +
    `/deployments/${config.azureDeployment}` +
    `?api-version=2024-10-01`;
  await armRequest('DELETE', url);
  return {
    action: 'remove-ai-model',
    target: `${config.azureAiAccountName}/${config.azureDeployment}`,
    message:
      `AI model deployment '${config.azureDeployment}' is being removed from ` +
      `'${config.azureAiAccountName}'. AI calls will start failing and the ` +
      'ai-connectivity alert will fire.',
  };
}

// -------------------- 3) Drive Azure SQL CPU to 100% (realistic) --------------------
// This is a real-world "untuned query" incident, not an artificial spin loop.
// A large dbo.jb_Orders table is created WITHOUT the index its reporting queries
// need, so dbo.jb_RunSalesReport repeatedly full-scans every row. Running it in
// parallel saturates the serverless vCores -> CPU ~100% and the app degrades.
//
// The fix the SRE Agent must discover (via the execution plan / Query Store /
// sys.dm_db_missing_index_details) and apply is the missing covering index:
//
//   CREATE NONCLUSTERED INDEX jb_ix_Orders_Status_Region_Date
//     ON dbo.jb_Orders (Status, Region, OrderDate) INCLUDE (Amount);
//
// Once it exists the scans become seeks and CPU drops sharply. (See the
// "SQL CPU saturation" scenario in docs/RUNBOOK.md.)
const CPU_BURN_SECONDS = parseInt(process.env.CHAOS_CPU_SECONDS || '120', 10);
const CPU_BURN_PARALLELISM = parseInt(process.env.CHAOS_CPU_PARALLELISM || '6', 10);
// Number of unindexed report passes per stored-proc call. Kept small enough that
// a single call stays under the pool's request timeout (30s); workers re-fire
// until the total CPU_BURN_SECONDS budget elapses.
const CPU_REPORT_ITERATIONS = parseInt(process.env.CHAOS_CPU_ITERATIONS || '25', 10);
// Rows seeded into the (deliberately unindexed) orders table.
const CPU_ORDERS_ROWS = parseInt(process.env.CHAOS_ORDERS_ROWS || '400000', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Create the orders table (UNINDEXED on the report predicate, on purpose) and
// the untuned reporting procedure if the deployment script has not already done
// so. Idempotent. NOTE: this intentionally does NOT create the tuning index —
// adding that index is the remediation the SRE Agent is expected to figure out.
export async function ensureChaosSchema() {
  await runRawBatch(`
IF OBJECT_ID('dbo.jb_Orders', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.jb_Orders (
    OrderId    BIGINT IDENTITY(1,1) CONSTRAINT jb_PK_Orders PRIMARY KEY,
    CustomerId INT           NOT NULL,
    Region     NVARCHAR(40)  NOT NULL,
    Status     NVARCHAR(20)  NOT NULL,
    Amount     DECIMAL(12,2) NOT NULL,
    OrderDate  DATETIME2(0)  NOT NULL,
    Notes      NVARCHAR(200) NULL
  );
  ;WITH n AS (
    SELECT TOP (${CPU_ORDERS_ROWS}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS r
    FROM sys.all_objects a CROSS JOIN sys.all_objects b
  )
  INSERT INTO dbo.jb_Orders (CustomerId, Region, Status, Amount, OrderDate, Notes)
  SELECT
    (ABS(CHECKSUM(NEWID())) % 50000) + 1,
    CHOOSE((ABS(CHECKSUM(NEWID())) % 5) + 1, N'North', N'South', N'East', N'West', N'Central'),
    CHOOSE((ABS(CHECKSUM(NEWID())) % 5) + 1, N'PENDING', N'PAID', N'SHIPPED', N'CANCELLED', N'REFUNDED'),
    CAST((ABS(CHECKSUM(NEWID())) % 1000000) / 100.0 AS DECIMAL(12,2)),
    DATEADD(DAY, -(ABS(CHECKSUM(NEWID())) % 730), SYSUTCDATETIME()),
    NULL
  FROM n;
END
`);
  // CREATE/ALTER PROCEDURE must be the only statement in its batch.
  await runRawBatch(`
CREATE OR ALTER PROCEDURE dbo.jb_RunSalesReport
  @Iterations INT = 25
AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @i INT = 0;
  DECLARE @region NVARCHAR(40);
  DECLARE @total DECIMAL(38,2);
  DECLARE @cnt BIGINT;
  WHILE @i < @Iterations
  BEGIN
    SET @region = CHOOSE((@i % 5) + 1, N'North', N'South', N'East', N'West', N'Central');
    -- "Pending revenue for a region over the last 90 days." UNTUNED: there is no
    -- index on (Status, Region, OrderDate), so this full-scans dbo.jb_Orders on
    -- every pass. The missing covering index is the remediation (see runbook).
    SELECT @total = SUM(o.Amount), @cnt = COUNT_BIG(*)
    FROM dbo.jb_Orders AS o
    WHERE o.Status = N'PENDING'
      AND o.Region = @region
      AND o.OrderDate >= DATEADD(DAY, -90, SYSUTCDATETIME());
    SET @i += 1;
  END
END
`);
}

// One worker: keep running the untuned report until the deadline passes.
async function burnWorker(deadline) {
  while (Date.now() < deadline) {
    try {
      await runRawBatch(`EXEC dbo.jb_RunSalesReport @Iterations = ${CPU_REPORT_ITERATIONS};`);
    } catch {
      // Timeouts / pool starvation / throttling are expected under load — back
      // off briefly so we don't hot-loop, then keep the pressure on.
      await sleep(250);
    }
  }
}

export async function runSqlCpu100() {
  await ensureChaosSchema();
  // Fire the report workers without awaiting so the HTTP request returns
  // immediately while CPU stays pegged for the configured duration.
  const deadline = Date.now() + CPU_BURN_SECONDS * 1000;
  for (let i = 0; i < CPU_BURN_PARALLELISM; i++) {
    burnWorker(deadline).catch(() => {});
  }
  return {
    action: 'sql-cpu-100',
    parallelism: CPU_BURN_PARALLELISM,
    seconds: CPU_BURN_SECONDS,
    message:
      `Launched ${CPU_BURN_PARALLELISM} untuned sales-report loops (full table ` +
      `scans of dbo.jb_Orders) for ${CPU_BURN_SECONDS}s. Azure SQL CPU will climb ` +
      'to ~100%, app responses will degrade, and the SQL CPU alert (>= 85%) will ' +
      'fire. Remediation: add the missing covering index (see runbook).',
  };
}
