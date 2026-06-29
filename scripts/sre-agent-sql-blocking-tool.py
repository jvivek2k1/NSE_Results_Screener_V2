"""
SRE Agent tool — Azure SQL blocking diagnostics & remediation via the SQL bridge.

The agent sandbox cannot reach the private-endpoint Azure SQL server directly
(its VNet is closed). Instead it calls the VNet-integrated "SQL bridge" Azure
Function over HTTPS. The Function authenticates to SQL with its managed identity
and exposes intent-based operations plus a guarded read-only adhoc query.

Configure these as the agent's Python tools. Provide the two secrets/config
values via environment variables (do NOT hardcode the key):

    BROKER_BASE_URL   e.g. https://func-sqlbridge-290626114703.azurewebsites.net
    BROKER_FUNCTION_KEY   the Function host/function key (treat as a secret)

Endpoints called:
    GET  /api/diagnose            -> read-only blocking-tree report (always safe)
    POST /api/kill {spid,confirm} -> KILL one session (approval-gated)
    POST /api/query {sql,max_rows}-> guarded READ-ONLY adhoc query (SELECT/WITH);
                                     db_datareader-only + always-rollback, so it
                                     cannot mutate data.
"""

import os
import json
import urllib.request
import urllib.error

_BASE_URL = os.environ.get("BROKER_BASE_URL", "").rstrip("/")
_FUNCTION_KEY = os.environ.get("BROKER_FUNCTION_KEY", "")
_TIMEOUT_SECONDS = 150


def _require_config() -> None:
    if not _BASE_URL:
        raise RuntimeError("BROKER_BASE_URL environment variable is not set.")
    if not _FUNCTION_KEY:
        raise RuntimeError("BROKER_FUNCTION_KEY environment variable is not set.")


def _request(path: str, method: str, body: dict | None = None) -> dict:
    _require_config()
    url = f"{_BASE_URL}/api/{path}?code={_FUNCTION_KEY}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(detail)
        except ValueError:
            pass
        return {"error": f"HTTP {exc.code}", "detail": detail}
    except urllib.error.URLError as exc:
        return {"error": "connection_failed", "detail": str(exc.reason)}


def get_sql_blocking() -> dict:
    """Return the current Azure SQL blocking tree.

    Read-only and always safe. Use this first to identify the head blocker.

    Returns:
        dict with keys:
          - blocking_chain: list of rows {session_id, blocking_session_id,
            wait_type, wait_time_ms, status, command, sql_text}
          - count: number of rows
        or {"error": ...} on failure.
    """
    return _request("diagnose", "GET")


def kill_sql_session(spid: int, confirm: bool = False) -> dict:
    """KILL a single Azure SQL session (the head blocker).

    This is a mutating, disruptive action. It is approval-gated: the broker
    rejects the call unless confirm is True. Always run get_sql_blocking()
    first and confirm the spid is the head blocker before calling this.

    Args:
        spid: positive session_id to terminate.
        confirm: must be True to actually execute the KILL.

    Returns:
        dict {"killed_session_id": spid, "result": "ok"} on success,
        or {"error": ...} on failure / missing confirmation.
    """
    return _request("kill", "POST", {"spid": int(spid), "confirm": bool(confirm)})


def run_sql_query(sql: str, max_rows: int = 100) -> dict:
    """Run a READ-ONLY adhoc SQL query via the bridge.

    Only a single SELECT / WITH (CTE) statement is accepted. The bridge enforces
    layered guards: the managed identity is db_datareader-only, the query runs in
    an always-rollback transaction, and the statement is validated (single
    statement, no comments, keyword denylist, length + row caps). It therefore
    cannot mutate data or escalate privilege.

    Args:
        sql: a single read-only SELECT/WITH statement.
        max_rows: max rows to return (capped server-side, default 100, max 1000).

    Returns:
        dict {"columns": [...], "rows": [...], "row_count": n, "truncated": bool}
        on success, or {"error": ...} if validation fails or the query errors.
    """
    return _request("query", "POST", {"sql": str(sql), "max_rows": int(max_rows)})


if __name__ == "__main__":
    # Local smoke test: prints the current blocking tree.
    print(json.dumps(get_sql_blocking(), indent=2, default=str))
