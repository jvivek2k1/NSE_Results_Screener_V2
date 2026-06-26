// ============================================================
// Application Insights instrumentation. Loaded FIRST (before express, mssql,
// axios, etc.) so the SDK can auto-capture:
//   - incoming HTTP requests (with status codes / latency)
//   - outgoing dependencies: Azure SQL (tedious), HTTP calls to NSE/OpenAI
//   - unhandled exceptions and unhandled promise rejections
//   - console.warn / console.error as traces
// Enabled only when APPLICATIONINSIGHTS_CONNECTION_STRING is present (it is
// injected as an App Service setting); a no-op locally if unset.
// ============================================================
import appInsights from 'applicationinsights';

let client = null;
const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || '';

if (connectionString) {
  try {
    appInsights
      .setup(connectionString)
      .setAutoCollectRequests(true)
      .setAutoCollectPerformance(true, true)
      .setAutoCollectDependencies(true) // captures failed SQL connections/queries
      .setAutoCollectExceptions(true) // uncaught exceptions
      .setAutoCollectConsole(true, true) // console.error/warn -> traces
      .setSendLiveMetrics(false)
      .setInternalLogging(false, false)
      .start();
    client = appInsights.defaultClient;
    client.context.tags[client.context.keys.cloudRole] = 'nse-screener-api';
    console.log('[telemetry] Application Insights enabled');
  } catch (err) {
    console.warn('[telemetry] App Insights init failed:', err?.message || err);
  }
} else {
  console.log('[telemetry] App Insights disabled (no connection string)');
}

// Explicitly record a handled error (e.g. a caught DB failure in a route) so it
// surfaces in App Insights even though the request returned a controlled 503.
export function trackError(error, properties = {}) {
  if (!client || !error) return;
  try {
    const exception = error instanceof Error ? error : new Error(String(error));
    client.trackException({
      exception,
      properties: Object.fromEntries(
        Object.entries(properties).map(([k, v]) => [k, v == null ? '' : String(v)])
      ),
    });
  } catch {
    /* telemetry must never break the request path */
  }
}

export function flushTelemetry() {
  try {
    client?.flush();
  } catch {
    /* ignore */
  }
}

export const telemetryEnabled = Boolean(client);
