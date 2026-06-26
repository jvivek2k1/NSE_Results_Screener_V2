/* ============================================================================
   Azure SQL setup for the NSE Results Screener  (Entra ID auth only — no SQL auth)
   Server   : jbsserver.database.windows.net
   Database : JBDB
   ----------------------------------------------------------------------------
   The app authenticates with @azure/identity DefaultAzureCredential. The DB
   principal it acts as must match whoever is signed in when the backend runs:

     • Local development  -> your Entra user from `az login`
                             (here: admin@MngEnvMCAP083130.onmicrosoft.com)
     • Azure-hosted app   -> the App Service / Container App MANAGED IDENTITY
                             name (system-assigned = the resource name;
                             user-assigned = the identity resource name)

   NOTE on your case: admin@MngEnvMCAP083130.onmicrosoft.com is the Microsoft
   Entra admin / sysadmin on this server, so it is ALREADY a privileged principal
   (effectively dbo) in JBDB. You do NOT need CREATE USER or any role grants for
   local development — just run STEP 1 to create the tables and you are done.

   All app-owned objects are prefixed with `jb_` (tables, indexes, constraint).
   (A database USER must match a real Entra identity by name, so principals can
   NOT be arbitrarily prefixed — only the schema objects below carry `jb_`.)

   How to connect (to the JBDB database, NOT master):
     sqlcmd -S jbsserver.database.windows.net -d JBDB -G
   or Azure Data Studio / SSMS with "Microsoft Entra MFA" authentication.
   ============================================================================ */


/* ---------------------------------------------------------------------------
   STEP 1 — Create the schema (jb_-prefixed). Run WHILE CONNECTED TO JBDB.
   Safe to run repeatedly (guarded by IF OBJECT_ID / sys.indexes checks).
   As the Entra admin you can run this directly; the app will also create these
   automatically on first run if they do not yet exist.
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.jb_QuarterlyResults', 'U') IS NULL
CREATE TABLE dbo.jb_QuarterlyResults (
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
    CREATE INDEX jb_idx_qr_ticker ON dbo.jb_QuarterlyResults (Ticker);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'jb_idx_qr_score')
    CREATE INDEX jb_idx_qr_score ON dbo.jb_QuarterlyResults (Score);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'jb_idx_qr_time')
    CREATE INDEX jb_idx_qr_time ON dbo.jb_QuarterlyResults (AnnouncementTime);

IF OBJECT_ID('dbo.jb_Watchlist', 'U') IS NULL
CREATE TABLE dbo.jb_Watchlist (
    Ticker NVARCHAR(32) PRIMARY KEY,
    CompanyName NVARCHAR(256) NULL,
    Pinned INT NOT NULL DEFAULT 0,
    AddedAt NVARCHAR(40) NULL
);

IF OBJECT_ID('dbo.jb_Alerts', 'U') IS NULL
CREATE TABLE dbo.jb_Alerts (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    Ticker NVARCHAR(32) NULL,
    CompanyName NVARCHAR(256) NULL,
    Type NVARCHAR(64) NULL,
    Message NVARCHAR(512) NULL,
    Score FLOAT NULL,
    CreatedAt NVARCHAR(40) NULL
);

/* Forthcoming results: companies that have informed NSE of a board meeting to
   approve financial results. One row per (Ticker, MeetingDate). Status is
   'pending' until the actual result is detected on the NSE website, then
   'published'. */
IF OBJECT_ID('dbo.jb_UpcomingResults', 'U') IS NULL
CREATE TABLE dbo.jb_UpcomingResults (
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
    CREATE INDEX jb_idx_upcoming_date ON dbo.jb_UpcomingResults (MeetingDate);


/* ---------------------------------------------------------------------------
   STEP 2 (ONLY for a hosted app using a managed identity) — skip for local dev.
   When you later deploy to Azure, create a least-privilege user for the app's
   managed identity. Replace <MANAGED_IDENTITY_NAME> with the identity's name.
   --------------------------------------------------------------------------- */
-- CREATE USER [<MANAGED_IDENTITY_NAME>] FROM EXTERNAL PROVIDER;
-- ALTER ROLE db_datareader ADD MEMBER [<MANAGED_IDENTITY_NAME>];
-- ALTER ROLE db_datawriter ADD MEMBER [<MANAGED_IDENTITY_NAME>];
-- The tables already exist (STEP 1), so the app needs NO db_ddladmin.


/* ---------------------------------------------------------------------------
   STEP 3 — Verify the jb_ objects and any external principals.
   --------------------------------------------------------------------------- */
SELECT name AS object_name, type_desc
FROM sys.objects
WHERE name LIKE 'jb[_]%'
ORDER BY name;

SELECT dp.name        AS principal_name,
       dp.type_desc   AS principal_type,
       r.name         AS role_name
FROM sys.database_principals dp
LEFT JOIN sys.database_role_members rm ON rm.member_principal_id = dp.principal_id
LEFT JOIN sys.database_principals r    ON r.principal_id = rm.role_principal_id
WHERE dp.type IN ('E', 'X')   -- E = external user, X = external group
ORDER BY dp.name;
