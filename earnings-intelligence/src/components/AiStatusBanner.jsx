import { AlertTriangle, BrainCircuit } from 'lucide-react';

// Shows a prominent banner whenever the AI model (Azure OpenAI / OpenAI) is
// unreachable. Renders nothing when the model is healthy, when running on the
// local engine (skipped), or before the first health probe has completed.
export default function AiStatusBanner({ aiStatus }) {
  // No status yet, healthy, or local engine (nothing to reach) → no banner.
  if (!aiStatus || aiStatus.ok !== false || aiStatus.skipped) return null;

  const provider = aiStatus.provider === 'azure' ? 'Azure OpenAI' : 'OpenAI';

  return (
    <div className="mx-auto max-w-[1600px] px-4 pt-3">
      <div className="flex items-start gap-3 rounded-lg border px-4 py-3 border-rose-500/40 bg-rose-500/10 text-rose-200">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <BrainCircuit className="h-4 w-4" />
            Connection to the OpenAI model is unavailable
          </div>
          <p className="mt-0.5 text-xs opacity-90">
            Cannot reach the {provider} model
            {aiStatus.model ? ` "${aiStatus.model}"` : ''}. AI analysis is paused —
            showing the last loaded data and falling back to the local scoring
            engine. Retrying automatically.
          </p>
          {aiStatus.error && (
            <p className="mt-1 text-[11px] font-mono opacity-70 break-words">
              {aiStatus.error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
