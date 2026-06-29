// ============================================================
// Bootstrap: grant the SRE SQL-bridge Function's managed identity the least
// privilege it needs on the Azure SQL *server* (in the master database):
//   - VIEW SERVER STATE  (read the blocking-tree DMVs server-wide)  -> diagnose
//   - ALTER SERVER STATE (run KILL <spid>)                          -> kill
// Both are provided by the built-in Azure SQL server role
// ##MS_ServerStateManager##.
//
// Connects as the signed-in Entra SQL admin (az login) via DefaultAzureCredential.
// Auto-adds a SQL firewall rule for this machine's public IP if blocked.
//
// Usage (SQL public access must be temporarily Enabled first):
//   node scripts/grant-sre-bridge-sql.mjs
// ============================================================
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
const resourceGroup = env.AZURE_RESOURCE_GROUP || env.RESOURCE_GROUP;
const miName = env.BRIDGE_MI_NAME || env.SQL_BRIDGE_FUNCTION_NAME;

if (!serverRaw || !miName) {
  console.error('ERROR: SQL_SERVER (or AZURE_SQL_SERVER) and SQL_BRIDGE_FUNCTION_NAME (or BRIDGE_MI_NAME) must be set.');
  process.exit(1);
}
const server = serverRaw.includes('.') ? serverRaw : `${serverRaw}.database.windows.net`;
const sqlServerShortName = server.split('.')[0];

const batch = `
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = '${miName}')
  DROP USER [${miName}];
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = '${miName}')
  CREATE LOGIN [${miName}] FROM EXTERNAL PROVIDER;
IF NOT EXISTS (
  SELECT 1 FROM sys.server_role_members rm
  JOIN sys.server_principals r ON rm.role_principal_id = r.principal_id
  JOIN sys.server_principals m ON rm.member_principal_id = m.principal_id
  WHERE r.name = '##MS_ServerStateManager##' AND m.name = '${miName}')
  ALTER SERVER ROLE [##MS_ServerStateManager##] ADD MEMBER [${miName}];
CREATE USER [${miName}] FROM LOGIN [${miName}];
`;

const credential = new DefaultAzureCredential();

async function connectAndGrant() {
  const token = await credential.getToken('https://database.windows.net/.default');
  const pool = new sql.ConnectionPool({
    server,
    database: 'master',
    port: 1433,
    authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
    options: { encrypt: true, trustServerCertificate: false },
    connectionTimeout: 60000,
    requestTimeout: 60000,
  });
  await pool.connect();
  await pool.request().batch(batch);
  await pool.close();
}

function extractBlockedClientIp(message) {
  const m = /Client with IP address '([0-9a-fA-F:.]+)'/.exec(message || '');
  return m ? m[1] : null;
}

function tryAddFirewallRuleForClient(clientIp) {
  const ruleName = `bridge-bootstrap-${clientIp.replace(/[:.]/g, '-')}`.slice(0, 128);
  try {
    console.log(`  Adding SQL firewall rule '${ruleName}' for client IP ${clientIp}...`);
    execSync(
      `az sql server firewall-rule create -g "${resourceGroup}" -s "${sqlServerShortName}" -n "${ruleName}" --start-ip-address ${clientIp} --end-ip-address ${clientIp} --only-show-errors`,
      { stdio: 'pipe' }
    );
    return true;
  } catch (e) {
    console.error(`  Failed to create SQL firewall rule via az: ${e.stderr?.toString?.() || e.message}`);
    return false;
  }
}

async function main() {
  console.log(`Granting server-state role to managed identity: ${miName} (on ${server})`);
  try {
    await connectAndGrant();
  } catch (err) {
    const clientIp = extractBlockedClientIp(err.message);
    if (!clientIp) throw err;
    console.warn(`  SQL firewall blocked this machine (client IP ${clientIp}).`);
    if (!tryAddFirewallRuleForClient(clientIp)) throw err;
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        await connectAndGrant();
        lastErr = null;
        break;
      } catch (retryErr) {
        lastErr = retryErr;
        console.log(`  Waiting for firewall rule to take effect (attempt ${attempt}/3)...`);
      }
    }
    if (lastErr) throw lastErr;
  }
  console.log('Server-state role granted successfully.');
}

main().catch((err) => {
  console.error(`ERROR granting bridge SQL access: ${err.message}`);
  process.exit(1);
});
