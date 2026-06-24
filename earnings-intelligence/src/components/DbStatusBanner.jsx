import { AlertTriangle, Database, Loader2 } from 'lucide-react';

// Shows a prominent banner whenever the data store (Azure SQL serverless) is
// unreachable or resuming. Renders nothing while the database is healthy.
export default function DbStatusBanner({ dbStatus }) {
  if (!dbStatus || dbStatus.ok) return null;

  const resuming = dbStatus.state === 'connecting';
  const Icon = resuming ? Loader2 : AlertTriangle;
  const tone = resuming
    ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
    : 'border-rose-500/40 bg-rose-500/10 text-rose-200';

  const title = resuming
    ? 'Connecting to the database…'
    : 'Database connection issue';
  const detail = resuming
    ? `The ${dbStatus.database || ''} serverless database may be paused and is resuming. Retrying automatically…`
    : `Cannot reach ${dbStatus.database || 'the database'}${
        dbStatus.server ? ` on ${dbStatus.server}` : ''
      }. Showing the last loaded data; retrying automatically.`;

  return (
    <div className={`mx-auto max-w-[1600px] px-4 pt-3`}>
      <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${tone}`}>
        <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${resuming ? 'animate-spin' : ''}`} />
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Database className="h-4 w-4" />
            {title}
          </div>
          <p className="mt-0.5 text-xs opacity-90">{detail}</p>
          {dbStatus.error && !resuming && (
            <p className="mt-1 text-[11px] font-mono opacity-70 break-words">
              {dbStatus.error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
