// ============================================================
// Grant Azure SQL data-plane access to the App Service managed identity.
// Node-based alternative to the `az sql db query` approach (works without the
// rdbms-connect CLI extension). Connects as the signed-in Entra SQL admin via
// DefaultAzureCredential (az login) and creates/permissions the app's MI user.
//
// Reads configuration from azd environment values (or process env):
//   SQL_SERVER / AZURE_SQL_SERVER  - server name or FQDN
//   SQL_DATABASE / AZURE_SQL_DATABASE - database name
//   SERVICE_WEB_NAME               - App Service name (the MI user to create)
//   SQL_GRANT_DDLADMIN             - "true" to also grant db_ddladmin
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
const appName = env.SERVICE_WEB_NAME || env.SERVICE_API_NAME;
const grantDdl = String(env.SQL_GRANT_DDLADMIN || 'false').toLowerCase() === 'true';
const resourceGroup = env.AZURE_RESOURCE_GROUP || env.RESOURCE_GROUP;

if (!serverRaw || !database || !appName) {
  console.error('ERROR: SQL_SERVER, SQL_DATABASE and SERVICE_WEB_NAME must be set.');
  process.exit(1);
}
const server = serverRaw.includes('.') ? serverRaw : `${serverRaw}.database.windows.net`;
const sqlServerShortName = server.split('.')[0];

const roles = ['db_datareader', 'db_datawriter'];
if (grantDdl) roles.push('db_ddladmin');

const batch = `
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = '${appName}')
  CREATE USER [${appName}] FROM EXTERNAL PROVIDER;
${roles
  .map(
    (r) => `IF NOT EXISTS (
  SELECT 1 FROM sys.database_role_members drm
  JOIN sys.database_principals rp ON drm.role_principal_id = rp.principal_id
  JOIN sys.database_principals mp ON drm.member_principal_id = mp.principal_id
  WHERE rp.name = '${r}' AND mp.name = '${appName}')
  ALTER ROLE ${r} ADD MEMBER [${appName}];`
  )
  .join('\n')}
-- db_datareader/db_datawriter do NOT grant EXECUTE. The app runs the chaos
-- procedure dbo.jb_RunSalesReport (created by the Entra admin during provision),
-- so the managed identity needs EXECUTE on the dbo schema to call it.
GRANT EXECUTE ON SCHEMA::dbo TO [${appName}];
-- VIEW DATABASE STATE lets the app read sys.dm_exec_requests for ALL sessions
-- (not just its own), which the SQL blocking probe needs to count blocked
-- sessions and emit the SqlBlockedSessions metric the blocking alert keys off.
GRANT VIEW DATABASE STATE TO [${appName}];
`;

const credential = new DefaultAzureCredential();

async function connectAndGrant() {
  const token = await credential.getToken('https://database.windows.net/.default');
  const pool = new sql.ConnectionPool({
    server,
    database,
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

// Azure SQL firewall errors include the exact client IP Azure sees (handles NAT/proxy).
function extractBlockedClientIp(message) {
  const m = /Client with IP address '([0-9a-fA-F:.]+)'/.exec(message || '');
  return m ? m[1] : null;
}

// Add a SQL firewall rule for the deploying machine's IP so this hook (which runs
// locally, not in Azure) can reach the server. The server otherwise only allows
// Azure services (the 0.0.0.0 "AllowAllWindowsAzureIps" rule).
function tryAddFirewallRuleForClient(clientIp) {
  if (!resourceGroup) {
    console.error('  Cannot auto-create SQL firewall rule: AZURE_RESOURCE_GROUP is not set in the azd environment.');
    return false;
  }
  const ruleName = `deploy-client-${clientIp.replace(/[:.]/g, '-')}`.slice(0, 128);
  const subArg = env.AZURE_SUBSCRIPTION_ID ? ` --subscription "${env.AZURE_SUBSCRIPTION_ID}"` : '';
  try {
    console.log(`  Adding SQL firewall rule '${ruleName}' for client IP ${clientIp}...`);
    execSync(
      `az sql server firewall-rule create -g "${resourceGroup}" -s "${sqlServerShortName}" -n "${ruleName}" --start-ip-address ${clientIp} --end-ip-address ${clientIp}${subArg} --only-show-errors`,
      { stdio: 'pipe' }
    );
    return true;
  } catch (e) {
    console.error(`  Failed to create SQL firewall rule via az: ${e.stderr?.toString?.() || e.message}`);
    return false;
  }
}

async function main() {
  console.log(`Granting SQL data-plane access to managed identity: ${appName}`);
  try {
    await connectAndGrant();
  } catch (err) {
    const clientIp = extractBlockedClientIp(err.message);
    if (!clientIp) throw err;
    console.warn(`  SQL firewall blocked this machine (client IP ${clientIp}).`);
    if (!tryAddFirewallRuleForClient(clientIp)) throw err;
    // Firewall rule changes take a few seconds to propagate; retry the connection.
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
  console.log('SQL access granted successfully.');
}

main().catch((err) => {
  console.error(`ERROR granting SQL access: ${err.message}`);
  process.exit(1);
});
