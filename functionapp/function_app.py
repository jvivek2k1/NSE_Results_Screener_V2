"""
SQL bridge Function — lets the SRE Agent reach the private-endpoint Azure SQL
server without VNet-injecting the agent sandbox.

Pattern B (synchronous, agent-initiated over HTTPS, function-key protected):
  GET/POST /api/diagnose      -> read-only blocking-tree DMV report
  POST     /api/kill          -> body {"spid": <int>, "confirm": true} -> KILL one session
  POST     /api/query         -> body {"sql": "SELECT ...", "max_rows": 100}
                                 -> guarded READ-ONLY adhoc query (SELECT/WITH only)

Pattern A (asynchronous telemetry, timer):
  every 5 min -> snapshot the blocking tree -> emit to App Insights (queryable
  by the agent via KQL in the linked Log Analytics workspace).

Security:
  - diagnose/kill are intent-based, parameterized operations.
  - /api/query allows adhoc SQL but is guarded by layered controls so it cannot
    mutate data or escalate privilege:
      1. DB-enforced least privilege  - the managed identity holds only
         db_datareader (+ VIEW DATABASE STATE/KILL), so writes/DDL/EXEC are
         rejected by SQL Server itself.
      2. Always-rollback transaction  - the query runs in a transaction that is
         unconditionally rolled back, so nothing can ever persist.
      3. Statement allowlist           - only a single SELECT/WITH statement is
         accepted; a keyword denylist, no-comments and length caps block
         multi-statement / obfuscated payloads.
      4. Resource caps                 - query timeout + row cap limit DoS.
  - Auth via Azure SQL managed identity (no secrets in code/config).
  - Inbound is locked to the agent egress IP via App Service access restrictions
    and a function key (configured at the platform layer, not here).
"""

import json
import logging
import os
import re
import struct

import azure.functions as func
from azure.identity import DefaultAzureCredential

app = func.FunctionApp()

_SQL_SERVER = os.environ["SQL_SERVER"]
_SQL_DB = os.environ["SQL_DB"]
_SQL_COPT_SS_ACCESS_TOKEN = 1256
_TOKEN_SCOPE = "https://database.windows.net/.default"
_SNAPSHOT_MARKER = "SQL_BLOCKING_SNAPSHOT"

# ---- Guardrails for the adhoc read-only /api/query endpoint ----
_DEFAULT_MAX_ROWS = 100
_MAX_ROWS_CAP = 1000
_MAX_SQL_LEN = 5000
_QUERY_TIMEOUT_SECONDS = 30

# Statements must start with one of these (read-only entry points only).
_ALLOWED_PREFIX = re.compile(r"^\s*(select|with)\b", re.IGNORECASE)

# Any of these tokens (matched on whole words, after string literals are
# stripped) rejects the query. Covers DML, DDL, exec, security and DoS verbs.
_FORBIDDEN = re.compile(
    r"\b("
    r"insert|update|delete|merge|drop|alter|create|truncate|"
    r"exec|execute|grant|revoke|deny|kill|shutdown|reconfigure|"
    r"backup|restore|bulk|waitfor|into|"
    r"openrowset|openquery|opendatasource|openxml"
    r")\b",
    re.IGNORECASE,
)
# sp_/xp_ extended & system stored procedures (e.g. xp_cmdshell).
_FORBIDDEN_PROC = re.compile(r"\b(sp|xp)_\w+", re.IGNORECASE)

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


def _connect(autocommit: bool = True):
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
    # The adhoc query path passes autocommit=False so it can run inside a
    # transaction that is always rolled back (never persists).
    return pyodbc.connect(
        conn_str,
        attrs_before={_SQL_COPT_SS_ACCESS_TOKEN: token_struct},
        autocommit=autocommit,
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


def _strip_literals(sql: str) -> str:
    """Remove single-quoted string literals so keyword checks can't be fooled by
    text inside literals (e.g. a column value 'drop table')."""
    return re.sub(r"'(?:[^']|'')*'", "''", sql)


def _validate_readonly_sql(sql) -> str:
    """Validate that ``sql`` is a single, read-only SELECT/WITH statement.

    Raises ValueError with a caller-safe message if any guard fails. Returns the
    sanitized statement (trailing semicolon stripped) on success. This is
    defense-in-depth only: the managed identity is also db_datareader-only and
    the query runs in an always-rollback transaction.
    """
    if not isinstance(sql, str) or not sql.strip():
        raise ValueError("sql is required and must be a non-empty string")
    s = sql.strip()
    if len(s) > _MAX_SQL_LEN:
        raise ValueError(f"query too long (max {_MAX_SQL_LEN} chars)")
    if "--" in s or "/*" in s or "*/" in s:
        raise ValueError("SQL comments are not allowed")

    # Work on a copy with string literals removed for structural checks.
    body = _strip_literals(s).rstrip()
    if body.endswith(";"):
        body = body[:-1]
    if ";" in body:
        raise ValueError("only a single statement is allowed (no ';')")
    if not _ALLOWED_PREFIX.match(body):
        raise ValueError("only SELECT / WITH (CTE) queries are allowed")
    bad = _FORBIDDEN.search(body) or _FORBIDDEN_PROC.search(body)
    if bad:
        raise ValueError(f"forbidden keyword in query: {bad.group(0)}")

    return s[:-1].rstrip() if s.endswith(";") else s


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


@app.route(route="query", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)
def query(req: func.HttpRequest) -> func.HttpResponse:
    """Guarded READ-ONLY adhoc query. Accepts a single SELECT/WITH statement and
    runs it inside an always-rollback transaction under a db_datareader-only
    identity, so it can never mutate data or escalate privilege."""
    try:
        body = req.get_json()
    except ValueError:
        return func.HttpResponse(
            json.dumps({"error": "JSON body required: {\"sql\": \"SELECT ...\", \"max_rows\": 100}"}),
            status_code=400,
            mimetype="application/json",
        )

    max_rows = body.get("max_rows", _DEFAULT_MAX_ROWS)
    if not isinstance(max_rows, int) or max_rows <= 0:
        max_rows = _DEFAULT_MAX_ROWS
    max_rows = min(max_rows, _MAX_ROWS_CAP)

    try:
        safe_sql = _validate_readonly_sql(body.get("sql"))
    except ValueError as ve:
        return func.HttpResponse(
            json.dumps({"error": str(ve)}), status_code=400, mimetype="application/json"
        )

    # Audit: every adhoc query lands in App Insights / Log Analytics (AppTraces).
    logging.warning(
        "%s adhoc_query %s",
        _SNAPSHOT_MARKER,
        json.dumps({"sql": safe_sql, "max_rows": max_rows}),
    )

    conn = _connect(autocommit=False)
    try:
        conn.timeout = _QUERY_TIMEOUT_SECONDS  # query (command) timeout in seconds
        cur = conn.cursor()
        # READ UNCOMMITTED avoids taking shared locks (no impact on the workload).
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;")
        cur.execute(safe_sql)
        if cur.description is None:
            raise ValueError("statement returned no result set")
        cols = [c[0] for c in cur.description]
        fetched = cur.fetchmany(max_rows + 1)
        truncated = len(fetched) > max_rows
        rows = [dict(zip(cols, r)) for r in fetched[:max_rows]]
        return func.HttpResponse(
            json.dumps(
                {"columns": cols, "rows": rows, "row_count": len(rows), "truncated": truncated},
                default=str,
            ),
            mimetype="application/json",
        )
    except Exception as exc:  # noqa: BLE001 - surface error to caller
        logging.exception("query failed")
        return func.HttpResponse(
            json.dumps({"error": str(exc)}), status_code=500, mimetype="application/json"
        )
    finally:
        # Never persist anything, regardless of what ran.
        try:
            conn.rollback()
        except Exception:  # noqa: BLE001
            pass
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
