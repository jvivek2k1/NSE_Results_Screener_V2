// Grant the SRE SQL-bridge MI a user in JBDB so the broker (connected to JBDB)
// can read the per-database blocking DMVs and run KILL. In Azure SQL Database,
// KILL is authorized by the DB-scoped KILL DATABASE CONNECTION permission.
import { execSync } from 'node:child_process';
import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';

// Pull configuration from the azd environment (falls back to process.env), so
// the script works for any deployment / resource token without edits.
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
const serverRaw = env.SQL_SERVER || env.AZURE_SQL_SERVER || env.BRIDGE_SQL_SERVER;
const database = env.GRANT_DB || env.SQL_DATABASE || env.AZURE_SQL_DATABASE || 'JBDB';
const miName = env.BRIDGE_MI_NAME || env.SQL_BRIDGE_FUNCTION_NAME;

if (!serverRaw || !miName) {
  console.error('ERROR: SQL_SERVER (or AZURE_SQL_SERVER) and SQL_BRIDGE_FUNCTION_NAME (or BRIDGE_MI_NAME) must be set.');
  process.exit(1);
}
const server = serverRaw.includes('.') ? serverRaw : `${serverRaw}.database.windows.net`;

const batch = `
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = '${miName}')
  CREATE USER [${miName}] FROM LOGIN [${miName}];
GRANT VIEW DATABASE STATE TO [${miName}];
GRANT KILL DATABASE CONNECTION TO [${miName}];
`;

const credential = new DefaultAzureCredential();
const token = (await credential.getToken('https://database.windows.net/.default')).token;
const pool = new sql.ConnectionPool({
  server, database, port: 1433,
  authentication: { type: 'azure-active-directory-access-token', options: { token } },
  options: { encrypt: true, trustServerCertificate: false },
  connectionTimeout: 60000, requestTimeout: 60000,
});
await pool.connect();
await pool.request().batch(batch);
await pool.close();
console.log(`Granted ${miName} VIEW DATABASE STATE + KILL DATABASE CONNECTION in ${database}.`);
