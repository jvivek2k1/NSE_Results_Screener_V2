// ============================================================
// SRE chaos demo — provision the Azure SQL objects used by the realistic
// "SQL CPU 100%" scenario: a large dbo.jb_Orders table created with NO index on
// CustomerId, plus dbo.jb_RunSalesReport, a "customer account summary" lookup
// that full-scans the table on every call because that index is missing.
//
// The incident: running the report in parallel pegs CPU at ~100%. Diagnosing the
// root cause and applying the appropriate, reversible remediation is left to the
// SRE Agent.
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
const ordersRows = parseInt(env.CHAOS_ORDERS_ROWS || '2000000', 10);

if (!serverRaw || !database) {
  console.error('ERROR: AZURE_SQL_SERVER and AZURE_SQL_DATABASE must be set.');
  process.exit(1);
}
const server = serverRaw.includes('.') ? serverRaw : `${serverRaw}.database.windows.net`;

// Large orders table — DELIBERATELY missing the index on CustomerId that its
// lookup query needs. Created once, then idempotently TOPPED UP to the target
// row count so re-running the script (or raising CHAOS_ORDERS_ROWS) grows an
// existing table instead of leaving it small.
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
END;

DECLARE @have BIGINT = (SELECT COUNT_BIG(*) FROM dbo.jb_Orders);
DECLARE @need BIGINT = ${ordersRows} - @have;
IF @need > 0
BEGIN
  ;WITH n AS (
    SELECT TOP (@need) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS r
    FROM sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_columns c
  )
  INSERT INTO dbo.jb_Orders (CustomerId, Region, Status, Amount, OrderDate, Notes)
  SELECT
    ((CHECKSUM(NEWID()) & 0x7FFFFFFF) % 50000) + 1,
    CASE (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 5
      WHEN 0 THEN N'North' WHEN 1 THEN N'South' WHEN 2 THEN N'East' WHEN 3 THEN N'West' ELSE N'Central' END,
    CASE (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 5
      WHEN 0 THEN N'PENDING' WHEN 1 THEN N'PAID' WHEN 2 THEN N'SHIPPED' WHEN 3 THEN N'CANCELLED' ELSE N'REFUNDED' END,
    CAST(((CHECKSUM(NEWID()) & 0x7FFFFFFF) % 1000000) / 100.0 AS DECIMAL(12,2)),
    DATEADD(DAY, -((CHECKSUM(NEWID()) & 0x7FFFFFFF) % 730), SYSUTCDATETIME()),
    NULL
  FROM n;
END
`;

// Missing-index lookup procedure — must be the only statement in its batch.
const procBatch = `
CREATE OR ALTER PROCEDURE dbo.jb_RunSalesReport
  @Iterations INT = 50
AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @i INT = 0;
  DECLARE @CustomerId INT;
  DECLARE @total DECIMAL(38,2);
  DECLARE @cnt BIGINT;
  WHILE @i < @Iterations
  BEGIN
    SET @CustomerId = (ABS(CHECKSUM(NEWID())) % 50000) + 1;
    SELECT @total = SUM(o.Amount), @cnt = COUNT_BIG(*)
    FROM dbo.jb_Orders AS o
    WHERE o.CustomerId = @CustomerId;
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
    `  Ensured dbo.jb_Orders (~${ordersRows} rows, intentionally unindexed) and dbo.jb_RunSalesReport.`
  );
}

main().catch((err) => {
  console.error(`Failed to provision SRE CPU-saturation objects: ${err.message}`);
  // Non-fatal: the app self-heals these objects on first "SQL CPU 100%" click.
  process.exit(0);
});
