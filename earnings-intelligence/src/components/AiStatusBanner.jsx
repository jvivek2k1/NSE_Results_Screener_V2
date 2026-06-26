import { AlertTriangle, BrainCircuit } from 'lucide-react';

// Reduces a verbose error to just the first sentence (the error),
// dropping any "Reason: …" detail and "For more information…" link.
function shortError(error) {
  let text = String(error || '')
    .replace(/^\s*reason:\s*/i, '')
    .replace(/\s*reason:.*$/is, '')
    .replace(/\s*for more information.*$/is, '')
    .trim();
  const firstSentence = text.match(/^[^.]*\./);
  if (firstSentence) text = firstSentence[0];
  return text.trim();
}

// Shows a prominent banner whenever the AI model (Azure OpenAI / OpenAI) is
// unreachable. Renders nothing when the model is healthy, when running on the
// local engine (skipped), or before the first health probe has completed.
export default function AiStatusBanner({ aiStatus }) {
  // No status yet, healthy, or local engine (nothing to reach) → no banner.
  if (!aiStatus || aiStatus.ok !== false || aiStatus.skipped) return null;

  return (
    <div className="mx-auto max-w-[1600px] px-4 pt-3">
      <div className="flex items-start gap-3 rounded-lg border px-4 py-3 border-rose-500/40 bg-rose-500/10 text-rose-200">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <BrainCircuit className="h-4 w-4" />
            Connection to the OpenAI model is unavailable
          </div>
          {aiStatus.error && (
            <p className="mt-1 text-[11px] font-mono opacity-70 break-words">
              {shortError(aiStatus.error)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
