"""
SQL bridge Function — lets the SRE Agent reach the private-endpoint Azure SQL
server without VNet-injecting the agent sandbox.

Pattern B (synchronous, agent-initiated over HTTPS, function-key protected):
  GET/POST /api/diagnose      -> read-only blocking-tree DMV report
  POST     /api/kill          -> body {"spid": <int>, "confirm": true} -> KILL one session

Pattern A (asynchronous telemetry, timer):
  every 5 min -> snapshot the blocking tree -> emit to App Insights (queryable
  by the agent via KQL in the linked Log Analytics workspace).

Security:
  - Only intent-based, parameterized operations are exposed. No arbitrary SQL.
  - Auth via Azure SQL managed identity (no secrets in code/config).
  - Inbound is locked to the agent egress IP via App Service access restrictions
    and a function key (configured at the platform layer, not here).
"""

import json
import logging
import os
import struct

import azure.functions as func
from azure.identity import DefaultAzureCredential

app = func.FunctionApp()

_SQL_SERVER = os.environ["SQL_SERVER"]
_SQL_DB = os.environ["SQL_DB"]
_SQL_COPT_SS_ACCESS_TOKEN = 1256
_TOKEN_SCOPE = "https://database.windows.net/.default"
_SNAPSHOT_MARKER = "SQL_BLOCKING_SNAPSHOT"

_BLOCKING_QUERY = """
SELECT  r.session_id,
        r.blocking_session_id,
        r.wait_type,
        r.wait_time          AS wait_time_ms,
        r.status,
        r.command,
        CONVERT(NVARCHAR(300), t.text) AS sql_text
FROM    sys.dm_exec_requests AS r
CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) AS t
WHERE   r.blocking_session_id <> 0
     OR r.session_id IN (
            SELECT blocking_session_id
            FROM   sys.dm_exec_requests
            WHERE  blocking_session_id <> 0
        )
ORDER BY r.blocking_session_id, r.session_id;
"""

_credential = DefaultAzureCredential()


def _connect():
    import pyodbc

    token = _credential.get_token(_TOKEN_SCOPE)
    token_bytes = token.token.encode("utf-16-le")
    token_struct = struct.pack(f"<I{len(token_bytes)}s", len(token_bytes), token_bytes)
    conn_str = (
        "Driver={ODBC Driver 18 for SQL Server};"
        f"Server=tcp:{_SQL_SERVER},1433;Database={_SQL_DB};"
        "Encrypt=yes;TrustServerCertificate=no;Connection Timeout=30;"
    )
    # autocommit=True so KILL runs outside a user transaction (error 6115 otherwise).
    return pyodbc.connect(
        conn_str,
        attrs_before={_SQL_COPT_SS_ACCESS_TOKEN: token_struct},
        autocommit=True,
    )


def _blocking_tree():
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(_BLOCKING_QUERY)
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]
    finally:
        conn.close()


@app.route(route="diagnose", methods=["GET", "POST"], auth_level=func.AuthLevel.FUNCTION)
def diagnose(req: func.HttpRequest) -> func.HttpResponse:
    """Read-only blocking-tree report. Always safe; never mutates the database."""
    try:
        rows = _blocking_tree()
        return func.HttpResponse(
            json.dumps({"blocking_chain": rows, "count": len(rows)}, default=str),
            mimetype="application/json",
        )
    except Exception as exc:  # noqa: BLE001 - surface error to caller
        logging.exception("diagnose failed")
        return func.HttpResponse(
            json.dumps({"error": str(exc)}), status_code=500, mimetype="application/json"
        )


@app.route(route="kill", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)
def kill(req: func.HttpRequest) -> func.HttpResponse:
    """KILL a single session. Requires an explicit confirm flag (approval gate)."""
    try:
        body = req.get_json()
    except ValueError:
        return func.HttpResponse(
            json.dumps({"error": "JSON body required: {\"spid\": <int>, \"confirm\": true}"}),
            status_code=400,
            mimetype="application/json",
        )

    spid = body.get("spid")
    confirm = body.get("confirm", False)
    if not isinstance(spid, int) or spid <= 0:
        return func.HttpResponse(
            json.dumps({"error": "spid must be a positive integer"}),
            status_code=400,
            mimetype="application/json",
        )
    if confirm is not True:
        return func.HttpResponse(
            json.dumps({"error": "confirm must be true; operator approval required"}),
            status_code=403,
            mimetype="application/json",
        )

    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(f"KILL {int(spid)};")
        logging.warning("%s killed session_id=%s", _SNAPSHOT_MARKER, spid)
        return func.HttpResponse(
            json.dumps({"killed_session_id": int(spid), "result": "ok"}),
            mimetype="application/json",
        )
    except Exception as exc:  # noqa: BLE001
        logging.exception("kill failed")
        return func.HttpResponse(
            json.dumps({"error": str(exc)}), status_code=500, mimetype="application/json"
        )
    finally:
        conn.close()


@app.timer_trigger(schedule="0 */5 * * * *", arg_name="timer", run_on_startup=False)
def snapshot(timer: func.TimerRequest) -> None:
    """Pattern A: push a blocking-tree snapshot to App Insights/Log Analytics."""
    try:
        rows = _blocking_tree()
        # Structured JSON line lands in AppTraces (Log Analytics) for KQL queries.
        logging.warning(
            "%s %s",
            _SNAPSHOT_MARKER,
            json.dumps({"count": len(rows), "blocking_chain": rows}, default=str),
        )
    except Exception:  # noqa: BLE001
        logging.exception("%s snapshot failed", _SNAPSHOT_MARKER)
