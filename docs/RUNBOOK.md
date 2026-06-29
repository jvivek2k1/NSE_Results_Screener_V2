# NSE Results Screener — Troubleshooting Runbook

> Operational runbook for the Azure SRE Agent and human operators.
> Each scenario lists **Symptoms → Detect (gather evidence) → Verify**. It shows how to
> observe an incident and confirm recovery — it deliberately does **not** prescribe the
> root cause or the fix. Use the evidence to reach your own diagnosis and apply the
> narrowest safe, reversible action; escalate anything destructive.
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

**Investigate**
Read the `error` string returned by `/api/health/ready` and the matching
exception/dependency messages in App Insights, then determine *why* the app cannot
reach the database. Before changing any setting, confirm how the app is **meant** to
connect so you don't undo an intentional configuration. Apply the narrowest reversible
action that restores the intended connectivity; escalate infra-level or destructive
changes for confirmation.

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

**Investigate** — a 502 / Unhealthy backend almost always points at a downstream
dependency or a configuration drift rather than the gateway itself. Localise it:
1. **DB reachability** (readiness is DB-aware) → see **Scenario 1**.
2. **AI model unreachable** (readiness is AI-aware) → see **Scenario 3**.
3. **App Service down / not started** → see **Scenario 4**.
4. **Probe / inbound config** — confirm the gateway probe and the App Service inbound
   restrictions are still as the platform intends:
   ```bash
   az network application-gateway probe show -g RG_JB_NSE_RESULTS_SCREENER \
     --gateway-name agw-aev7ydnz74wgi -n appServiceHealthProbe \
     --query "{path:path,protocol:protocol,interval:interval,unhealthyThreshold:unhealthyThreshold}" -o json
   ```
   (The App Service only accepts traffic from `snet-appgw`, default action `Deny`.)

Resolve whatever dependency or configuration drift you find with the narrowest
reversible action.

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

**Investigate** — inspect the failing AI dependency's result code and error text
(from `/api/ai-health` and App Insights) and work out why the model is unreachable.
Determine the narrowest reversible remediation from the evidence; escalate quota or
infra changes for confirmation.

**Note:** AI is a **critical dependency** — once the AI model has been unreachable past the
~120s grace window, readiness (`/api/health/ready`) returns 503 and the backend goes
Unhealthy (502s everywhere), so a sustained AI outage is a **full** outage. The grace window
absorbs single transient probe failures; the local fallback engine and the pre-first-probe
startup window never block readiness.

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

**Investigate** — read the startup / docker logs and identify why the container did not
come up. The app is designed to start and serve even when the DB is down, so a startup
failure is usually build- or code-level rather than a dependency outage. Apply the
narrowest reversible action that gets a healthy process running.

**Verify:** `/api/health` returns 200 through the gateway.

---

## Scenario 5 — WAF blocking requests (403 / blocked)

**Symptoms:** Specific requests return **403** from the WAF, or hitting the app by its raw
IP returns 403.

**Investigate**
- Accessing the app by its raw IP (numeric Host header) is blocked **by design** — always
  use the FQDN `nse-aev7ydnz74wgi.westus2.cloudapp.azure.com`, not the IP.
- For other blocks, inspect the WAF logs (App Gateway diagnostic logs / `AGWFirewallLogs`
  in Log Analytics) to find the offending request and `ruleId`, then decide on the
  narrowest change that addresses a genuine false positive. Do **not** weaken the WAF
  broadly to work around a misbehaving caller.

---

## Scenario 6 — Elevated 5xx / latency (no full outage)

**Detect**
```bash
APPID=02f28f47-f21e-4bff-99ba-c3e9ab993f7a
az monitor app-insights query --app $APPID --analytics-query \
  "requests | where timestamp>ago(1h) | summarize total=count(), failed=countif(success==false), p95=percentile(duration,95) by bin(timestamp,5m) | order by timestamp desc" \
  -o json --query "tables[0].rows"
```

**Investigate:** correlate failed-request spikes with failed `dependencies` (SQL/AI) and
`exceptions` in the same window, identify the dominant contributor, and address it with
the narrowest reversible action. Escalate capacity/scaling changes for confirmation.

---

## Scenario 7 — Wrong / stale data (e.g. belated filings reappear)

**Symptoms:** A symbol shows an implausibly old period with a far-future broadcast date
(e.g. a Q3 FY25 result "filed" months/years late), or dashboard growth columns show "—".

**Background:** NSE occasionally broadcasts **belated/backlog** filings. The app filters
these via `FILING_MAX_REPORTING_LAG_DAYS` (currently **90**): any filing whose broadcast date
lags its period-end by more than N days is **dropped on ingest** and **purged on startup**
(`purgeStaleFilings()`). "—" growth columns simply mean there is no prior quarter to compare.

**Detect**
```bash
# Inspect the staleness threshold the running app is using
az webapp config appsettings list -g RG_JB_NSE_RESULTS_SCREENER -n app-aev7ydnz74wgi \
  --query "[?name=='FILING_MAX_REPORTING_LAG_DAYS'].value" -o tsv
```

**Investigate:** decide from the data whether the filing is genuinely stale and whether the
threshold needs adjusting, then apply the narrowest reversible change and re-run the purge.

**Verify:** the stale symbol no longer resolves (e.g. `GET /api/result/<TICKER>` → 404).

---

## Scenario 8 — Azure SQL CPU saturation

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

**Investigate** — from the top-CPU query identified above, inspect its execution plan and
SQL Server's own tuning signals (Query Store, `SET STATISTICS IO`, the engine's tuning
DMVs) to understand *why* it is expensive. Determine the most cost-effective, reversible
remediation from that evidence and apply the narrowest one — prefer fixing the root cause
over merely relieving the symptom (e.g. scaling), and escalate any SKU/infra change for
confirmation.

**Verify**
- `cpu_percent` returns to baseline within a few minutes; `alert-sql-cpu-high` auto-mitigates.
- Dashboard latency recovers (`/api/health/ready` → 200; p95 back to normal).

---

## Scenario 9 — Azure SQL blocking tree

**Symptoms**
- `alert-sql-blocking-high` fires (workers elevated by a severe blocking tree, severity 1).
- Data endpoints sluggish or timing out; many sessions waiting, low CPU but rising worker
  count — a **concurrency/lock** incident, not a connectivity or CPU outage.

**Strict policy**
- **Do NOT restart, stop, or recycle App Service.** A restart is never the fix for a SQL
  blocking tree and is **forbidden as an autonomous action** — it requires explicit user
  approval even for an autonomous agent.
- Remediate **only inside Azure SQL**: identify the head blocker, explain it, and **ask the
  user** before terminating (`KILL`) any session.

**Detect / investigate.** Azure SQL is **private-only**, so use the **SQL bridge**
tools (see SRE-AGENT-INSTRUCTIONS.md → "SQL bridge tools"), not `sqlcmd`:
- `get_sql_blocking()` returns the head blockers and their victims directly.
- For any other read-only check, use `run_sql_query("SELECT …")` (single
  `SELECT`/`WITH` only; it is `db_datareader`-only and always rolls back). For
  example, the equivalent blocking-chain query:
```sql
-- Blocking chain: head blockers and their victims
SELECT r.session_id, r.blocking_session_id, r.wait_type, r.wait_time,
       r.status, t.text AS sql_text
FROM sys.dm_exec_requests r
CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE r.blocking_session_id <> 0 OR r.session_id IN
      (SELECT blocking_session_id FROM sys.dm_exec_requests WHERE blocking_session_id <> 0)
ORDER BY r.blocking_session_id;
```

**Remediate (with approval)**
1. Identify the head-blocker SPID, the lock held, and the waiting sessions.
2. Explain the impact to the user.
3. With explicit user approval, terminate the head blocker with
   `kill_sql_session(<spid>, confirm=True)` (equivalent to `KILL <spid>;`).
4. Verify the chain clears and `alert-sql-blocking-high` auto-mitigates.

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

**Safe / reversible (OK to automate):** read-only investigation (logs, metrics, App
Insights / Log Analytics queries) and **narrow, reversible** configuration changes that
return a resource to its intended state. Always prefer the smallest action that restores
service and be ready to roll it back.

**Require human confirmation:** deleting resources/databases; scaling SKUs/capacity; broad
WAF rule changes; `azd provision`/`azd up` (infra changes); anything destructive or that
affects other workloads. Prefer the narrowest fix that restores service.
