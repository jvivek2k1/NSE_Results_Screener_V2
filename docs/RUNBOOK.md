# NSE Results Screener — Troubleshooting Runbook

> Operational runbook for the Azure SRE Agent and human operators.
> Each scenario lists **Symptoms → Detect (queries) → Diagnose → Remediate → Verify**.
> See `docs/ARCHITECTURE.md` for component/dependency context.

## Quick reference

| Item | Value |
|---|---|
| Resource group | `RG_JB_NSE_RESULTS_SCREENER` (region `westus2`) |
| Public URL (use FQDN) | `http://nse-aev7ydnz74wgi.westus2.cloudapp.azure.com` |
| App Service | `app-aev7ydnz74wgi` |
| App Gateway | `agw-aev7ydnz74wgi` |
| Azure SQL | `sql-aev7ydnz74wgi.database.windows.net` / `JBDB` |
| App Insights | `appi-aev7ydnz74wgi` (appId `02f28f47-f21e-4bff-99ba-c3e9ab993f7a`) |
| Alert | `alert-appgw-unhealthy-backend` |
| Action group | `ag-aev7ydnz74wgi` |

### First-look triage (run these first)

```bash
# 1. Liveness vs readiness (liveness ignores deps; readiness reflects DB + AI)
curl -s -o /dev/null -w "health=%{http_code}\n" http://nse-aev7ydnz74wgi.westus2.cloudapp.azure.com/api/health
curl -s -w "\nready=%{http_code}\n"            http://nse-aev7ydnz74wgi.westus2.cloudapp.azure.com/api/health/ready

# 2. App Gateway backend health
az network application-gateway show-backend-health -g RG_JB_NSE_RESULTS_SCREENER -n agw-aev7ydnz74wgi \
  --query "backendAddressPools[].backendHttpSettingsCollection[].servers[].{address:address,health:health}" -o json

# 3. Recent failures in App Insights (NOTE: use -o json, not -o table)
APPID=02f28f47-f21e-4bff-99ba-c3e9ab993f7a
az monitor app-insights query --app $APPID --analytics-query \
  "union (requests | where success==false),(dependencies | where success==false),exceptions | where timestamp>ago(1h) | summarize n=count() by itemType=tostring(itemType), problem=coalesce(outerMessage,name) | order by n desc | take 20" \
  -o json --query "tables[0].rows"
```

> **App Insights CLI gotcha:** `-o table` with `summarize ... by` can render **empty** even
> when rows exist. Always query with `-o json --query "tables[0].rows"`.

---

## Scenario 1 — Database connection failure (most common)

**Symptoms**
- Dashboard loads but data is empty / "database connection issue" banner.
- Data endpoints (`/api/results`, `/api/meta`, `/api/sectors`, …) return **503**
  (`{"error":"Data store unavailable", ...}`) or **504** (gateway timeout during retries).
- `/api/health/ready` returns **503**; `/api/health` still **200**.
- After ~90s, App Gateway backend goes **Unhealthy** and `alert-appgw-unhealthy-backend` fires.

**Detect**
```bash
APPID=02f28f47-f21e-4bff-99ba-c3e9ab993f7a
# Exceptions (the DB error verbatim)
az monitor app-insights query --app $APPID --analytics-query \
  "exceptions | where timestamp>ago(1h) | summarize n=count() by type, outerMessage | order by n desc | take 10" \
  -o json --query "tables[0].rows"
# Failed requests
az monitor app-insights query --app $APPID --analytics-query \
  "requests | where timestamp>ago(1h) and success==false | summarize n=count() by name, resultCode | order by n desc" \
  -o json --query "tables[0].rows"
```
Check live DB status as the app sees it:
```bash
curl -s http://nse-aev7ydnz74wgi.westus2.cloudapp.azure.com/api/health/ready
# -> {"ok":false,"db":{"state":"error","error":"...reason...", ...}}
```

**Diagnose** — read the `error` string / exception message:

| Error text contains | Root cause | Go to |
|---|---|---|
| `Deny Public Network Access is set to Yes` | SQL **Public network access disabled** | 1a |
| `Client with IP address ... is not allowed` | SQL **firewall** missing the caller IP | 1b |
| `Login failed` / `token` / `AADSTS` | **Entra auth / managed identity / role** issue | 1c |
| `paused` / `resuming` / `not currently available` | **Serverless resume** (usually transient) | 1d |
| `ETIMEOUT` / `ESOCKET` only | Network/transient; retry/backoff should recover | 1d |

> **Check for a Private Endpoint first (before any public-access / firewall change).**
> Determine how the app is *meant* to reach SQL. If a private endpoint exists, the
> app connects over the VNet and **public access being disabled is expected** —
> re-enabling it is the wrong fix and would mask a broken private link / DNS.
> ```bash
> # Private endpoints in the RG that target this SQL server
> az network private-endpoint list -g RG_JB_NSE_RESULTS_SCREENER \
>   --query "[?contains(to_string(privateLinkServiceConnections[].privateLinkServiceId),'sql-aev7ydnz74wgi')].{name:name,status:privateLinkServiceConnections[0].privateLinkServiceConnectionState.status}" -o json
> # And the SQL server's own private endpoint connections
> az sql server show -g RG_JB_NSE_RESULTS_SCREENER -n sql-aev7ydnz74wgi \
>   --query "privateEndpointConnections[].properties.privateEndpointConnectionState.status" -o json
> ```
> - **Private endpoint present** → do **not** re-enable public access or touch the
>   firewall. The intended path is the private link — go to **1e**.
> - **No private endpoint** → public connectivity is the intended path; proceed
>   with **1a–1d** below.

### 1a. Public network access disabled (only when there is NO private endpoint)
```bash
az sql server show -g RG_JB_NSE_RESULTS_SCREENER -n sql-aev7ydnz74wgi --query publicNetworkAccess -o tsv
# If "Disabled" AND no private endpoint exists (see precheck above):
az sql server update -g RG_JB_NSE_RESULTS_SCREENER -n sql-aev7ydnz74wgi --enable-public-network true
```
Also ensure "Allow Azure services" is on (firewall rule `AllowAllWindowsAzureIps`, start/end `0.0.0.0`):
```bash
az sql server firewall-rule create -g RG_JB_NSE_RESULTS_SCREENER -s sql-aev7ydnz74wgi \
  -n AllowAllWindowsAzureIps --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0
```

### 1b. Firewall blocks the caller (usually local dev, not the App Service)
The App Service egresses as an "Azure service", covered by `AllowAllWindowsAzureIps`. A
specific blocked IP is typically a developer machine. Add a temporary rule, then remove it:
```bash
az sql server firewall-rule create -g RG_JB_NSE_RESULTS_SCREENER -s sql-aev7ydnz74wgi \
  -n local-dev --start-ip-address <IP> --end-ip-address <IP>
# cleanup when done:
az sql server firewall-rule delete -g RG_JB_NSE_RESULTS_SCREENER -s sql-aev7ydnz74wgi -n local-dev
```

### 1c. Entra auth / managed identity not authorized
- Confirm the web app has a system-assigned identity and that it is a DB user with rights.
- Re-grant DB access (idempotent):
  ```bash
  node ./scripts/grant-sql-access.mjs
  ```
- The DB is **Entra-only** (`azureADOnlyAuthentication: true`) — SQL logins will never work.

### 1d. Serverless resume / transient
- Usually self-heals within seconds via the app's connect backoff. The readiness endpoint's
  90s grace prevents flapping. If the DB was paused, the first query resumes it.
- Confirm the DB isn't paused:
  ```bash
  az sql db show -g RG_JB_NSE_RESULTS_SCREENER -s sql-aev7ydnz74wgi -n JBDB --query status -o tsv
  ```
- If `Paused`, any query resumes it; the 10-min cron normally keeps it warm.

### 1e. Private endpoint present but DB unreachable
When a private endpoint is in use, connectivity problems are almost always **private
link / DNS**, not public-access settings. **Do not** enable public network access as a
workaround — it bypasses the intended secure path and hides the real fault.
- Confirm the private endpoint connection is approved/healthy:
  ```bash
  az sql server show -g RG_JB_NSE_RESULTS_SCREENER -n sql-aev7ydnz74wgi \
    --query "privateEndpointConnections[].properties.privateEndpointConnectionState" -o json   # expect status: Approved
  ```
- Confirm private DNS resolves the SQL FQDN to the **private** IP (not a public one):
  ```bash
  az network private-dns record-set a list -g RG_JB_NSE_RESULTS_SCREENER \
    -z privatelink.database.windows.net -o table
  ```
- Ensure the private DNS zone `privatelink.database.windows.net` is **linked to the app's
  VNet**, the private endpoint NIC has a healthy private IP, and the app subnet's NSG /
  route table allows egress to it.
- If the private endpoint is missing/misprovisioned, re-apply infra (`azd provision`) —
  this is an infra change requiring confirmation, not a quick CLI toggle.

**Remediate** — apply the matching fix above.

**Verify**
```bash
curl -s -w "\nready=%{http_code}\n" http://nse-aev7ydnz74wgi.westus2.cloudapp.azure.com/api/health/ready  # expect 200
az network application-gateway show-backend-health -g RG_JB_NSE_RESULTS_SCREENER -n agw-aev7ydnz74wgi \
  --query "backendAddressPools[0].backendHttpSettingsCollection[0].servers[0].health" -o tsv               # expect Healthy
```
The alert auto-mitigates once the backend is Healthy.

---

## Scenario 2 — App Gateway returns 502 / backend Unhealthy

**Symptoms:** Every route (including the static UI) returns **502 Bad Gateway** from
`Microsoft-Azure-Application-Gateway`. `alert-appgw-unhealthy-backend` is firing.

**Detect**
```bash
az network application-gateway show-backend-health -g RG_JB_NSE_RESULTS_SCREENER -n agw-aev7ydnz74wgi -o json
```

**Diagnose**
1. **Most likely a DB outage** (the readiness probe is DB-aware) → go to **Scenario 1**.
2. **AI model unreachable** (readiness is now AI-aware too) → go to **Scenario 3**.
3. **App Service down / not started** → go to **Scenario 4**.
4. **Probe misconfiguration** — verify it targets `/api/health/ready` over HTTPS:
   ```bash
   az network application-gateway probe show -g RG_JB_NSE_RESULTS_SCREENER \
     --gateway-name agw-aev7ydnz74wgi -n appServiceHealthProbe \
     --query "{path:path,protocol:protocol,interval:interval,unhealthyThreshold:unhealthyThreshold}" -o json
   ```
4. **Inbound access restriction** — App Service only accepts traffic from `snet-appgw`.
   If the gateway can't reach it, confirm the App Service IP restrictions still allow the
   App Gateway subnet (default action `Deny`).

**Remediate:** fix the underlying DB/app issue; if the probe drifted, repoint it:
```bash
az network application-gateway probe update -g RG_JB_NSE_RESULTS_SCREENER \
  --gateway-name agw-aev7ydnz74wgi -n appServiceHealthProbe --path /api/health/ready
```

**Verify:** backend health `Healthy`; gateway serves 200 on `/api/health`.

---

## Scenario 3 — AI / LLM model unreachable (critical dependency)

**Symptoms:** The AI status banner shows degraded and `/api/ai-health` reports not OK.
**AI is a critical dependency:** after a short grace window (~120s) of failed AI probes,
`/api/health/ready` returns **503**, the App Gateway backend goes **Unhealthy**, and both
`alert-ai-connectivity-loss` and `alert-appgw-unhealthy-backend` fire (502s on all routes).
Within the grace window, data still serves and only AI enrichment is missing.

**Detect**
```bash
curl -s http://nse-aev7ydnz74wgi.westus2.cloudapp.azure.com/api/ai-health
APPID=02f28f47-f21e-4bff-99ba-c3e9ab993f7a
az monitor app-insights query --app $APPID --analytics-query \
  "dependencies | where timestamp>ago(1h) and target has 'services.ai.azure.com' and success==false | summarize n=count() by resultCode | order by n desc" \
  -o json --query "tables[0].rows"
```

**Diagnose**
- `401/403` → managed identity lost its role on `nse-results-screener-resource`.
- `429` → model throttling / quota.
- `404` / `DeploymentNotFound` → deployment `NSE_RESULTS_SCREENER_MODEL` missing/renamed.
- Timeouts → endpoint/network.

**Remediate**
- Role: re-grant the app MI the OpenAI user role on the AI account (or re-run `azd provision`,
  which applies the `ai-access` module).
- Quota/throttle: reduce call rate or raise quota in the Foundry resource.
- Deployment: confirm `AZURE_OPENAI_DEPLOYMENT` matches an existing deployment.

**Note:** AI is a **critical dependency** — once the AI model has been unreachable past the
~120s grace window, readiness (`/api/health/ready`) returns 503 and the backend goes
Unhealthy (502s everywhere), so a sustained AI outage is a **full** outage. The grace window
absorbs single transient probe failures; the local fallback engine and the pre-first-probe
startup window never block readiness. Quote the AI `error` (e.g. `DeploymentNotFound`, 429,
401/403) from `/api/ai-health` or App Insights to drive the fix.

---

## Scenario 4 — App Service won't start / container timeout

**Symptoms:** Deployment "succeeds" but the site 502s; startup logs show
`Container did not start within expected time limit` or exit code 1.

**Detect**
```bash
az webapp log download -g RG_JB_NSE_RESULTS_SCREENER -n app-aev7ydnz74wgi --log-file applog.zip
# inspect LogFiles/StartupLogs/*_success.log and *_docker.log
```
Look for the expected healthy startup lines:
```
[telemetry] Application Insights enabled
[db] Using azure-sql backend
[ai] Azure OpenAI (keyless) engine active
[server] serving frontend from .../earnings-intelligence/dist
```

**Diagnose / Remediate**
- **Missing build output** (`dist/` not present) → ensure the build ran; redeploy with
  `azd deploy` (Oryx build is enabled via `SCM_DO_BUILD_DURING_DEPLOYMENT=true`).
- **Module load error** (e.g. missing `applicationinsights`) → check `package.json`
  dependencies and redeploy.
- **Crash on startup** unrelated to DB (the app is designed to start and serve even when the
  DB is down) → read the stack trace in the docker log.
- **Restart** if needed:
  ```bash
  az webapp restart -g RG_JB_NSE_RESULTS_SCREENER -n app-aev7ydnz74wgi
  ```

**Verify:** `/api/health` returns 200 through the gateway.

---

## Scenario 5 — WAF blocking requests (403 / blocked)

**Symptoms:** Specific requests return **403** from the WAF, or hitting the app by its raw
IP returns 403.

**Diagnose**
- **Numeric Host header** is blocked (OWASP rule `920350`). Always use the FQDN
  `nse-aev7ydnz74wgi.westus2.cloudapp.azure.com`, not `20.3.118.43`.
- Legitimate traffic blocked by a managed rule → inspect WAF logs (App Gateway diagnostic
  logs / `AGWFirewallLogs` in Log Analytics) to find the `ruleId`.

**Remediate**
- For false positives, add a targeted WAF exclusion/disabled-rule in `waf-aev7ydnz74wgi`
  (policy is OWASP 3.2, **Prevention** mode). Prefer narrow exclusions over disabling rules.
- Do **not** weaken the WAF broadly to work around the numeric-host case — fix the caller.

---

## Scenario 6 — Elevated 5xx / latency (no full outage)

**Detect**
```bash
APPID=02f28f47-f21e-4bff-99ba-c3e9ab993f7a
az monitor app-insights query --app $APPID --analytics-query \
  "requests | where timestamp>ago(1h) | summarize total=count(), failed=countif(success==false), p95=percentile(duration,95) by bin(timestamp,5m) | order by timestamp desc" \
  -o json --query "tables[0].rows"
```

**Diagnose:** correlate failed-request spikes with failed `dependencies` (SQL/AI) and
`exceptions` in the same window. Most 5xx trace back to Scenario 1 (DB) or Scenario 3 (AI).

**Remediate:** address the dominant failing dependency. If CPU/memory bound, consider scaling
the `plan-aev7ydnz74wgi` (P1v3) up/out.

---

## Scenario 7 — Wrong / stale data (e.g. belated filings reappear)

**Symptoms:** A symbol shows an implausibly old period with a far-future broadcast date
(e.g. a Q3 FY25 result "filed" months/years late), or dashboard growth columns show "—".

**Background:** NSE occasionally broadcasts **belated/backlog** filings. The app filters
these via `FILING_MAX_REPORTING_LAG_DAYS` (currently **90**): any filing whose broadcast date
lags its period-end by more than N days is **dropped on ingest** and **purged on startup**
(`purgeStaleFilings()`). "—" growth columns simply mean there is no prior quarter to compare.

**Detect / Remediate**
```bash
# Confirm the threshold on the running app
az webapp config appsettings list -g RG_JB_NSE_RESULTS_SCREENER -n app-aev7ydnz74wgi \
  --query "[?name=='FILING_MAX_REPORTING_LAG_DAYS'].value" -o tsv
# Tighten/loosen if needed, then restart to re-run the purge
az webapp config appsettings set -g RG_JB_NSE_RESULTS_SCREENER -n app-aev7ydnz74wgi \
  --settings FILING_MAX_REPORTING_LAG_DAYS=90
az webapp restart -g RG_JB_NSE_RESULTS_SCREENER -n app-aev7ydnz74wgi
```
Persist the value in `infra/modules/appservice.bicep` so it survives `azd provision`.

**Verify:** the stale symbol no longer resolves (e.g. `GET /api/result/<TICKER>` → 404).

---

## Scenario 8 — Azure SQL CPU saturation (untuned query / missing index)

**Symptoms**
- `alert-sql-cpu-high` fires (SQL database CPU ≥ 85%, severity 1).
- Dashboard is slow or times out; data endpoints (`/api/results`, `/api/stats`, …) are
  sluggish or return **503/504**; the app may flap Unhealthy under sustained load.
- App Insights shows **SQL dependencies with high `duration`** (not failures) and rising
  request latency — a performance incident, **not** a connectivity outage (Scenario 1).

**Detect**
```bash
RG=RG_JB_NSE_RESULTS_SCREENER; SQL=sql-aev7ydnz74wgi; DB=JBDB
# Confirm the CPU spike on the database
az monitor metrics list --resource \
  "/subscriptions/<sub>/resourceGroups/$RG/providers/Microsoft.Sql/servers/$SQL/databases/$DB" \
  --metric cpu_percent --interval PT1M --aggregation Average -o table
```
Find the top-CPU query (run against `JBDB` with Entra auth — sqlcmd `-G`, ADS, or the portal Query editor):
```sql
-- Top CPU consumers from Query Store (last hour)
SELECT TOP 10 qt.query_sql_text,
       SUM(rs.count_executions)                       AS execs,
       SUM(rs.avg_cpu_time * rs.count_executions)/1000 AS total_cpu_ms
FROM sys.query_store_query_text qt
JOIN sys.query_store_query q   ON q.query_text_id = qt.query_text_id
JOIN sys.query_store_plan p    ON p.query_id = q.query_id
JOIN sys.query_store_runtime_stats rs ON rs.plan_id = p.plan_id
JOIN sys.query_store_runtime_stats_interval i ON i.runtime_stats_interval_id = rs.runtime_stats_interval_id
WHERE i.start_time > DATEADD(HOUR, -1, SYSUTCDATETIME())
GROUP BY qt.query_sql_text
ORDER BY total_cpu_ms DESC;
```

**Diagnose** — the top query is the unindexed sales report over `dbo.jb_Orders`:
```sql
SELECT SUM(o.Amount), COUNT_BIG(*)
FROM dbo.jb_Orders AS o
WHERE o.Status = N'PENDING' AND o.Region = @region
  AND o.OrderDate >= DATEADD(DAY, -90, SYSUTCDATETIME());
```
Its plan is a **Clustered Index Scan** of all ~400k rows on every execution. SQL Server's
own missing-index DMVs confirm the fix and quantify the win:
```sql
SELECT mid.statement AS [table],
       mid.equality_columns, mid.inequality_columns, mid.included_columns,
       migs.avg_user_impact, migs.user_seeks + migs.user_scans AS hits
FROM sys.dm_db_missing_index_details mid
JOIN sys.dm_db_missing_index_groups mig ON mig.index_handle = mid.index_handle
JOIN sys.dm_db_missing_index_group_stats migs ON migs.group_handle = mig.index_group_handle
WHERE mid.statement LIKE '%jb_Orders%'
ORDER BY migs.avg_user_impact DESC;
```

**Remediate (the tuning fix)** — create the missing covering index so the scans become
seeks. This is **online**, reversible, and scoped to this app's table:
```sql
CREATE NONCLUSTERED INDEX jb_ix_Orders_Status_Region_Date
  ON dbo.jb_Orders (Status, Region, OrderDate)
  INCLUDE (Amount)
  WITH (ONLINE = ON, DATA_COMPRESSION = PAGE);
```
> Prefer the index over scaling the database SKU: scaling masks the regression and costs
> more; the index removes the root cause. Only consider a temporary vCore bump if CPU must
> be relieved *before* the index build completes.

**Verify**
- Re-run the top query → plan now shows an **Index Seek** on `jb_ix_Orders_Status_Region_Date`;
  logical reads and CPU per execution drop by orders of magnitude.
- `cpu_percent` returns to baseline within a few minutes; `alert-sql-cpu-high` auto-mitigates.
- Dashboard latency recovers (`/api/health/ready` → 200; p95 back to normal).

> **Reset for a repeat demo:** drop the index to restore the untuned state —
> `DROP INDEX jb_ix_Orders_Status_Region_Date ON dbo.jb_Orders;`

---

## Appendix A — Useful App Insights queries (Portal → Logs)

```kql
// Everything failing in the last hour
union exceptions,
      (requests | where success == false),
      (dependencies | where success == false),
      (traces | where severityLevel >= 2)
| where timestamp > ago(1h)
| project timestamp, itemType, problem = coalesce(outerMessage, name, message), resultCode
| order by timestamp desc
```
```kql
// DB dependency failures only
dependencies
| where timestamp > ago(6h) and (type == "SQL" or target has "database.windows.net")
| summarize failures = countif(success == false), total = count() by bin(timestamp, 5m)
| order by timestamp desc
```
> Ignore `CredentialUnavailableError` / `EnvironmentCredential` exceptions — that is the
> normal `DefaultAzureCredential` chain falling through to managed identity, not a fault.

## Appendix B — Safe-action policy for automated remediation

**Safe / reversible (OK to automate):** read logs and metrics; query App Insights;
`az webapp restart`; re-enable SQL public network access; add/remove a SQL firewall rule;
repoint the App Gateway probe; re-run `node ./scripts/grant-sql-access.mjs`; `azd deploy`.

**Require human confirmation:** deleting resources/databases; scaling SKUs; changing WAF
rules broadly; `azd provision`/`azd up` (infra changes); anything destructive or that
affects other workloads. Prefer the narrowest fix that restores service.
