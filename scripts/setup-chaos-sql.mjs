// ============================================================
// SRE chaos demo — provision the Azure SQL objects used by the realistic
// "SQL CPU 100%" scenario: a large dbo.jb_Orders table that is deliberately
// MISSING the index its reporting queries need, plus dbo.jb_RunSalesReport, an
// untuned procedure that full-scans the table on every call.
//
// The incident: running the report in parallel pegs CPU at ~100%.
// The fix (for the SRE Agent to discover from the plan / Query Store /
// sys.dm_db_missing_index_details and apply):
//   CREATE NONCLUSTERED INDEX jb_ix_Orders_Status_Region_Date
//     ON dbo.jb_Orders (Status, Region, OrderDate) INCLUDE (Amount);
//
// Runs during `azd provision` (postprovision hook) right after the managed
// identity has been granted data-plane access. Connects as the signed-in Entra
// SQL admin via DefaultAzureCredential (az login) — no SQL passwords.
//
// Idempotent: the table is only created/seeded once and the procedure is
// CREATE OR ALTER. Query Store is enabled so the agent can find top-CPU queries.
// ============================================================
import { execSync } from 'node:child_process';
import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';

function loadAzdEnv() {
  const env = { ...process.env };
  try {
    const out = execSync('azd env get-values', { encoding: 'utf-8' });
    for (const line of out.split('\n')) {
      const i = line.indexOf('=');
      if (i === -1) continue;
      const key = line.slice(0, i).trim();
      let val = line.slice(i + 1).trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      if (key) env[key] = val;
    }
  } catch {
    /* azd not available — fall back to process.env */
  }
  return env;
}

const env = loadAzdEnv();
const serverRaw = env.AZURE_SQL_SERVER || env.SQL_SERVER;
const database = env.AZURE_SQL_DATABASE || env.SQL_DATABASE;
const ordersRows = parseInt(env.CHAOS_ORDERS_ROWS || '400000', 10);

if (!serverRaw || !database) {
  console.error('ERROR: AZURE_SQL_SERVER and AZURE_SQL_DATABASE must be set.');
  process.exit(1);
}
const server = serverRaw.includes('.') ? serverRaw : `${serverRaw}.database.windows.net`;

// Large orders table — DELIBERATELY missing the (Status, Region, OrderDate)
// index its reports need — seeded once with ~400k pseudo-random rows.
const tableBatch = `
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
    SELECT TOP (${ordersRows}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS r
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
`;

// Untuned reporting procedure — must be the only statement in its batch.
const procBatch = `
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
    -- UNTUNED: no index on (Status, Region, OrderDate) -> full clustered scan
    -- of dbo.jb_Orders on every pass. The missing covering index is the fix.
    SELECT @total = SUM(o.Amount), @cnt = COUNT_BIG(*)
    FROM dbo.jb_Orders AS o
    WHERE o.Status = N'PENDING'
      AND o.Region = @region
      AND o.OrderDate >= DATEADD(DAY, -90, SYSUTCDATETIME());
    SET @i += 1;
  END
END
`;

const credential = new DefaultAzureCredential();

async function main() {
  console.log(`Provisioning SRE CPU-saturation objects in ${server}/${database}...`);
  const token = await credential.getToken('https://database.windows.net/.default');
  const pool = new sql.ConnectionPool({
    server,
    database,
    port: 1433,
    authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
    options: { encrypt: true, trustServerCertificate: false },
    connectionTimeout: 60000,
    requestTimeout: 180000,
  });
  await pool.connect();
  // Enable Query Store so the SRE Agent can identify the top-CPU query.
  try {
    await pool.request().batch(
      `ALTER DATABASE CURRENT SET QUERY_STORE = ON ` +
        `(OPERATION_MODE = READ_WRITE, INTERVAL_LENGTH_MINUTES = 5);`
    );
  } catch (e) {
    console.warn(`  Query Store already configured or not settable: ${e.message}`);
  }
  await pool.request().batch(tableBatch);
  await pool.request().batch(procBatch);
  await pool.close();
  console.log(
    `  Created dbo.jb_Orders (~${ordersRows} rows, intentionally unindexed) and dbo.jb_RunSalesReport.`
  );
}

main().catch((err) => {
  console.error(`Failed to provision SRE CPU-saturation objects: ${err.message}`);
  // Non-fatal: the app self-heals these objects on first "SQL CPU 100%" click.
  process.exit(0);
});
