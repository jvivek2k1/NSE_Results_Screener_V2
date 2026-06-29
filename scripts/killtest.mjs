// ============================================================
// Controlled KILL test for the SRE SQL-bridge broker.
//
// 1. Creates a throwaway table in JBDB and a deliberate blocking chain
//    (blocker holds an X lock in an open transaction; victim blocks on it).
// 2. Calls the broker /api/diagnose to confirm it SEES the chain (proves
//    cross-database DMV visibility from master via ##MS_ServerStateManager##).
// 3. Calls the broker /api/kill {spid: blocker, confirm:true} (proves the
//    managed identity can actually terminate a session through the broker).
// 4. Confirms the victim unblocks, then cleans up.
//
// Connects to JBDB as the signed-in Entra SQL admin (az login).
// Requires SQL public access + this machine allowed on the broker (temporary).
// ============================================================
import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';

const server = 'sql-290626114703.database.windows.net';
const database = 'JBDB';
const brokerBase = 'https://func-sqlbridge-290626114703.azurewebsites.net';
const key = process.env.BROKER_KEY;
if (!key) throw new Error('Set BROKER_KEY env var (the function key).');

const credential = new DefaultAzureCredential();

function makePool(token) {
  return new sql.ConnectionPool({
    server,
    database,
    port: 1433,
    authentication: { type: 'azure-active-directory-access-token', options: { token } },
    options: { encrypt: true, trustServerCertificate: false },
    connectionTimeout: 60000,
    requestTimeout: 120000,
    pool: { max: 2, min: 1 },
  });
}

async function callBroker(path, body) {
  const url = `${brokerBase}/api/${path}?code=${key}`;
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const token = (await credential.getToken('https://database.windows.net/.default')).token;

  // Admin pool: setup + observation.
  const admin = makePool(token);
  await admin.connect();
  console.log('Connected to JBDB.');

  await admin.request().batch(`
    IF OBJECT_ID('dbo._killtest','U') IS NOT NULL DROP TABLE dbo._killtest;
    CREATE TABLE dbo._killtest (id INT PRIMARY KEY, val INT);
    INSERT INTO dbo._killtest (id, val) VALUES (1, 100);
  `);
  console.log('Throwaway table dbo._killtest created.');

  // Blocker: hold an X lock on row id=1 in an open transaction.
  const blockerPool = makePool(token);
  await blockerPool.connect();
  const blockerTx = new sql.Transaction(blockerPool);
  await blockerTx.begin();
  const spidRow = await new sql.Request(blockerTx).query('SELECT @@SPID AS spid');
  const blockerSpid = spidRow.recordset[0].spid;
  await new sql.Request(blockerTx).query('UPDATE dbo._killtest SET val = 200 WHERE id = 1;');
  console.log(`Blocker session ${blockerSpid} holds an X lock (uncommitted).`);

  // Victim: try to update the same row -> blocks. Do NOT await yet.
  const victimPool = makePool(token);
  await victimPool.connect();
  let victimDone = false;
  let victimError = null;
  const victimPromise = victimPool.request()
    .query('UPDATE dbo._killtest SET val = 300 WHERE id = 1;')
    .then(() => { victimDone = true; })
    .catch((e) => { victimError = e; });

  await sleep(4000); // let the block establish
  console.log(`Victim blocked? ${!victimDone} (expected: true)`);

  // Confirm the broker SEES the chain (cross-DB DMV visibility from master).
  const diag = await callBroker('diagnose');
  console.log(`\n[broker diagnose] HTTP ${diag.status}`);
  console.log(JSON.stringify(diag.json, null, 2));
  const sawBlocker = Array.isArray(diag.json.blocking_chain) &&
    diag.json.blocking_chain.some((r) => r.session_id === blockerSpid || r.blocking_session_id === blockerSpid);
  console.log(`Broker sees blocker spid ${blockerSpid}: ${sawBlocker}`);

  // KILL the blocker through the broker.
  const kill = await callBroker('kill', { spid: blockerSpid, confirm: true });
  console.log(`\n[broker kill spid=${blockerSpid}] HTTP ${kill.status}`);
  console.log(JSON.stringify(kill.json, null, 2));

  // Wait for the victim to unblock (proves the KILL actually took effect).
  await Promise.race([victimPromise, sleep(15000)]);
  console.log(`\nVictim unblocked after KILL: ${victimDone} (expected: true)`);
  if (victimError) console.log(`Victim ended with: ${victimError.message}`);

  // Cleanup.
  try { await blockerTx.rollback(); } catch { /* session already killed */ }
  await blockerPool.close().catch(() => {});
  await victimPool.close().catch(() => {});
  await admin.request().batch(`IF OBJECT_ID('dbo._killtest','U') IS NOT NULL DROP TABLE dbo._killtest;`);
  await admin.close();
  console.log('\nCleanup done (table dropped, pools closed).');

  // Verdict.
  const passed = kill.status === 200 && kill.json.result === 'ok' && victimDone;
  console.log(`\n==== KILL TEST ${passed ? 'PASSED' : 'FAILED'} ====`);
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(`KILL TEST ERROR: ${err.message}`);
  process.exit(1);
});
