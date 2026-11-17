"use client";

export function LoadingState({ text = "Loading…" }: { text?: string }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-slate-500">
      <div className="animate-pulse text-brand-700 font-semibold">{text}</div>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
      <div className="font-bold text-red-800">Couldn&apos;t load data</div>
      <p className="text-sm text-red-700 mt-1">{message}</p>
      <p className="text-xs text-red-600 mt-2">
        Check that the API is running at {process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000/api/v1"}.
      </p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-4 text-sm font-medium bg-red-600 text-white rounded-lg px-4 py-2 hover:bg-red-700"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function DemoBanner() {
  return (
    <div className="bg-amber-50 border border-amber-300 rounded-xl px-4 py-3 text-sm text-amber-900 mb-5">
      <strong>DEMO DATA</strong> — the API at{" "}
      {process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000/api/v1"} is unreachable, so this page
      shows a clearly-labelled demo dataset for layout preview only. It is <strong>not live data</strong>.
      Start the backend and refresh to see real data.
    </div>
  );
}

export function EmptyState({ text }: { text: string }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-slate-500">{text}</div>
  );
}
