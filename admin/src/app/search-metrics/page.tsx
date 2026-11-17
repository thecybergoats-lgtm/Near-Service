"use client";

// Phase 4 (item 1) — Search metrics + dedicated-tier gate.
// Live window (p50/p95 latency, zero-result rate, cache-hit rate, CTR),
// the gate decision (stay in-process vs switch on a dedicated search
// tier) with its reasons, the daily rollup, and the editable gate
// thresholds. The gate NEVER switches anything by itself — it is a
// recommendation; switching is done by setting SEARCH_SERVICE_URL /
// SEARCH_PROVIDER on the backend (see docs/phase4-search.md).
//
// This page only uses already-exported helpers from @/lib/api (API_URL,
// getToken, ApiError) — no shared lib file was edited for it. The
// matching backend endpoints live in
// backend/src/modules/search/search-admin.controller.ts.

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { DemoBanner, ErrorState, LoadingState } from "@/components/States";
import { Badge } from "@/components/Badge";
import { API_URL, ApiError, getToken } from "@/lib/api";

interface WindowStats {
  window_hours: number;
  queries: number;
  zero_result_queries: number;
  zero_result_rate: number;
  cache_hits: number;
  cache_hit_rate: number;
  clicks: number;
  click_through_rate: number | null;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  queries_per_day: number;
}

interface GateThresholds {
  p95_latency_ms: number;
  zero_result_rate: number;
  ctr_floor: number;
  queries_per_day: number;
  min_queries_for_gate: number;
  window_hours: number;
}

interface GateEvaluation {
  decision: "stay_in_process" | "switch_on_dedicated_tier";
  reasons: string[];
  breached: string[];
  stats: WindowStats;
  thresholds: GateThresholds;
  evaluated_at: string;
}

interface DailyRow {
  day: string;
  provider: string;
  queries: number;
  zero_result_queries: number;
  cache_hits: number;
  clicks: number;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
}

interface MetricsView {
  window: WindowStats;
  gate: GateEvaluation;
  daily: DailyRow[];
}

const DEMO_VIEW: MetricsView = {
  window: {
    window_hours: 24, queries: 0, zero_result_queries: 0, zero_result_rate: 0,
    cache_hits: 0, cache_hit_rate: 0, clicks: 0, click_through_rate: null,
    latency_p50_ms: null, latency_p95_ms: null, queries_per_day: 0,
  },
  gate: {
    decision: "stay_in_process",
    reasons: ["insufficient data: 0 queries in the last 24h (need 100 before the gate can judge)"],
    breached: [],
    stats: {
      window_hours: 24, queries: 0, zero_result_queries: 0, zero_result_rate: 0,
      cache_hits: 0, cache_hit_rate: 0, clicks: 0, click_through_rate: null,
      latency_p50_ms: null, latency_p95_ms: null, queries_per_day: 0,
    },
    thresholds: {
      p95_latency_ms: 500, zero_result_rate: 0.25, ctr_floor: 0.05,
      queries_per_day: 10000, min_queries_for_gate: 100, window_hours: 24,
    },
    evaluated_at: new Date().toISOString(),
  },
  daily: [],
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code || "request_failed", err?.message || `Request failed (${res.status})`);
  }
  return body as T;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export default function SearchMetricsPage() {
  const [view, setView] = useState<MetricsView | null>(null);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<GateThresholds>({
    p95_latency_ms: 500, zero_result_rate: 0.25, ctr_floor: 0.05,
    queries_per_day: 10000, min_queries_for_gate: 100, window_hours: 24,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const v = await request<MetricsView>("/admin/search/metrics?window_hours=24&days=14");
      setView(v);
      setForm(v.gate.thresholds);
      setDemo(false);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
      } else {
        // Unreachable API — labelled demo data, same as the other admin pages.
        setView(DEMO_VIEW);
        setForm(DEMO_VIEW.gate.thresholds);
        setDemo(true);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    setError(null);
    try {
      const updated = await request<GateThresholds>("/admin/search/gate/thresholds", {
        method: "PATCH",
        body: JSON.stringify(form),
      });
      setForm(updated);
      setMsg("Gate thresholds saved.");
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to save thresholds.");
    } finally {
      setSaving(false);
    }
  };

  const gate = view?.gate;
  const w = view?.window;

  return (
    <AdminShell
      title="Search metrics"
      subtitle="Phase 4 search scale-out — live latency, zero-result rate, cache hits and CTR, plus the gate that recommends whether a dedicated search tier is switched on. The gate never switches anything by itself."
    >
      {loading && <LoadingState />}
      {error && <ErrorState message={error} onRetry={load} />}
      {demo && <DemoBanner />}
      {msg && <p className="mb-4 rounded bg-green-50 px-3 py-2 text-sm text-green-800">{msg}</p>}

      {!loading && view && w && gate && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Badge tone={gate.decision === "switch_on_dedicated_tier" ? "red" : "green"}>
              {gate.decision === "switch_on_dedicated_tier"
                ? "GATE: SWITCH ON DEDICATED TIER"
                : "GATE: STAY IN-PROCESS"}
            </Badge>
            <span className="text-sm text-slate-600">
              {w.queries} queries in the last {w.window_hours}h · evaluated{" "}
              {new Date(gate.evaluated_at).toLocaleString()}
            </span>
          </div>

          <ul className="mb-6 list-disc pl-5 text-sm text-slate-700">
            {gate.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>

          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              ["p50 latency", w.latency_p50_ms == null ? "—" : `${w.latency_p50_ms} ms`],
              ["p95 latency", w.latency_p95_ms == null ? "—" : `${w.latency_p95_ms} ms`],
              ["Zero-result rate", pct(w.zero_result_rate)],
              ["Cache-hit rate", pct(w.cache_hit_rate)],
              ["Click-through rate", w.click_through_rate == null ? "no clicks recorded" : pct(w.click_through_rate)],
              ["Queries / day", String(Math.round(w.queries_per_day))],
              ["Clicks", String(w.clicks)],
              ["Breached", gate.breached.length ? gate.breached.join(", ") : "none"],
            ].map(([label, value]) => (
              <div key={label} className="rounded border border-slate-200 bg-white p-3">
                <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
                <div className="mt-1 text-lg font-semibold text-slate-900">{value}</div>
              </div>
            ))}
          </div>

          <h2 className="mb-2 text-base font-semibold text-slate-900">Gate thresholds</h2>
          <p className="mb-3 text-sm text-slate-600">
            The tier switches on when any one condition breaches (and at least{" "}
            {form.min_queries_for_gate} queries were seen in the window). CTR is only
            judged once clicks are being recorded.
          </p>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3">
            <label className="text-sm text-slate-700">
              p95 latency (ms)
              <input
                type="number" min={1} value={form.p95_latency_ms}
                onChange={(e) => setForm({ ...form, p95_latency_ms: Number(e.target.value) })}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
              />
            </label>
            <label className="text-sm text-slate-700">
              Zero-result rate (0–1)
              <input
                type="number" min={0} max={1} step={0.01} value={form.zero_result_rate}
                onChange={(e) => setForm({ ...form, zero_result_rate: Number(e.target.value) })}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
              />
            </label>
            <label className="text-sm text-slate-700">
              CTR floor (0–1)
              <input
                type="number" min={0} max={1} step={0.01} value={form.ctr_floor}
                onChange={(e) => setForm({ ...form, ctr_floor: Number(e.target.value) })}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
              />
            </label>
            <label className="text-sm text-slate-700">
              Queries / day
              <input
                type="number" min={1} value={form.queries_per_day}
                onChange={(e) => setForm({ ...form, queries_per_day: Number(e.target.value) })}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
              />
            </label>
            <label className="text-sm text-slate-700">
              Min queries for gate
              <input
                type="number" min={0} value={form.min_queries_for_gate}
                onChange={(e) => setForm({ ...form, min_queries_for_gate: Number(e.target.value) })}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
              />
            </label>
            <label className="text-sm text-slate-700">
              Window (hours)
              <input
                type="number" min={1} max={720} value={form.window_hours}
                onChange={(e) => setForm({ ...form, window_hours: Number(e.target.value) })}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
              />
            </label>
          </div>
          <button
            onClick={save} disabled={saving || demo}
            className="mb-8 rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save thresholds"}
          </button>

          <h2 className="mb-2 text-base font-semibold text-slate-900">Daily rollup (last 14 days)</h2>
          {view.daily.length === 0 ? (
            <p className="text-sm text-slate-600">No rolled-up days yet — rollups are written by SearchMetricsService.rollupDaily().</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 pr-2">Day</th>
                  <th className="py-2 pr-2">Provider</th>
                  <th className="py-2 pr-2">Queries</th>
                  <th className="py-2 pr-2">Zero-result</th>
                  <th className="py-2 pr-2">Cache hits</th>
                  <th className="py-2 pr-2">Clicks</th>
                  <th className="py-2 pr-2">p50</th>
                  <th className="py-2">p95</th>
                </tr>
              </thead>
              <tbody>
                {view.daily.map((d) => (
                  <tr key={`${d.day}-${d.provider}`} className="border-b border-slate-100">
                    <td className="py-2 pr-2">{d.day.slice(0, 10)}</td>
                    <td className="py-2 pr-2">{d.provider}</td>
                    <td className="py-2 pr-2">{d.queries}</td>
                    <td className="py-2 pr-2">{d.zero_result_queries}</td>
                    <td className="py-2 pr-2">{d.cache_hits}</td>
                    <td className="py-2 pr-2">{d.clicks}</td>
                    <td className="py-2 pr-2">{d.latency_p50_ms ?? "—"}</td>
                    <td className="py-2">{d.latency_p95_ms ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </AdminShell>
  );
}
