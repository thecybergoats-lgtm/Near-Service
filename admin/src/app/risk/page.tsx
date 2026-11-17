"use client";

// Phase 3 (v1.5) — Risk review queue + engine settings.
// Scores are admin/support-visible ONLY, never customer-visible. A score at
// or above the block threshold only flags the account for review — the
// engine never suspends anyone by itself.

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import DataTable from "@/components/DataTable";
import { DemoBanner, ErrorState, LoadingState } from "@/components/States";
import { Badge } from "@/components/Badge";
import {
  ApiError,
  getRiskReviewQueue,
  getRiskSettings,
  updateRiskSettings,
} from "@/lib/api";
import type { RiskScoreRow, RiskSettings } from "@/lib/types";

const LEVEL_TONE: Record<string, "slate" | "amber" | "red" | "green"> = {
  low: "green",
  medium: "amber",
  high: "red",
  critical: "red",
};

export default function RiskPage() {
  const [queue, setQueue] = useState<RiskScoreRow[]>([]);
  const [settings, setSettings] = useState<RiskSettings | null>(null);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ review_threshold: 60, block_threshold: 85, hold_hours: 24, window_days: 90, velocity_max_requests_per_hour: 10 });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [q, s] = await Promise.all([getRiskReviewQueue(), getRiskSettings()]);
      setQueue(q.data);
      setSettings(s.data);
      setForm({
        review_threshold: s.data.review_threshold,
        block_threshold: s.data.block_threshold,
        hold_hours: s.data.hold_hours,
        window_days: s.data.window_days,
        velocity_max_requests_per_hour: s.data.velocity_max_requests_per_hour,
      });
      setDemo(q.demo || s.demo);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load risk data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      const updated = await updateRiskSettings(form);
      setSettings(updated);
      setMsg("Settings saved (audited as risk.settings.update).");
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminShell title="Risk review" subtitle="Phase 3 risk engine — users at/above the review threshold, highest score first. Scores are never customer-visible; blocking is an explicit admin decision, never automatic.">
      {demo && <DemoBanner />}
      {loading ? (
        <LoadingState text="Loading risk queue…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <>
          <div className="flex items-center gap-3 mb-4">
            <Badge tone="red">{queue.length} in review queue</Badge>
            {settings && <Badge tone="slate">Review ≥ {settings.review_threshold} · Block ≥ {settings.block_threshold}</Badge>}
          </div>
          <DataTable
            columns={["User", "Score", "Level", "Top signals", "Hold until", "Updated"]}
            emptyText="Review queue is empty — no user is at/above the review threshold."
            rows={queue.map((r) => [
              <div key="u">
                <div className="font-semibold">{r.full_name || r.user_id.slice(0, 8)}</div>
                <div className="text-xs text-slate-500">{r.phone || r.user_id}</div>
              </div>,
              <div key="s" className="font-semibold">{r.score} / 100</div>,
              <Badge key="l" tone={LEVEL_TONE[r.level] || "slate"}>{r.level}</Badge>,
              <div key="b" className="text-xs">
                {Object.entries(r.breakdown || {})
                  .filter(([, v]) => v.points > 0)
                  .sort((a, b) => b[1].points - a[1].points)
                  .slice(0, 3)
                  .map(([k, v]) => `${k} +${v.points}`)
                  .join(", ") || "—"}
              </div>,
              <div key="h" className="text-xs">{r.hold_until ? new Date(r.hold_until).toLocaleString() : "—"}</div>,
              <div key="u2" className="text-xs">{r.updated_at ? new Date(r.updated_at).toLocaleString() : "—"}</div>,
            ])}
          />
          <h2 className="text-lg font-semibold mt-8 mb-3">Engine settings</h2>
          <form onSubmit={saveSettings} className="bg-white border rounded-xl p-4 grid grid-cols-2 md:grid-cols-5 gap-4 max-w-4xl">
            {(
              [
                ["review_threshold", "Review threshold", 0, 100],
                ["block_threshold", "Block threshold", 0, 100],
                ["hold_hours", "Hold hours", 0, 720],
                ["window_days", "Window (days)", 1, 365],
                ["velocity_max_requests_per_hour", "Velocity max / hour", 1, 1000],
              ] as const
            ).map(([key, label, min, max]) => (
              <label key={key} className="text-sm">
                <span className="block text-slate-600 mb-1">{label}</span>
                <input
                  type="number"
                  min={min}
                  max={max}
                  value={form[key]}
                  onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })}
                  className="w-full border rounded-lg px-3 py-2"
                />
              </label>
            ))}
            <div className="col-span-2 md:col-span-5 flex items-center gap-3">
              <button type="submit" disabled={saving} className="bg-brand-700 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50">
                {saving ? "Saving…" : "Save settings"}
              </button>
              {msg && <span className="text-sm text-slate-600">{msg}</span>}
            </div>
          </form>
          <p className="text-xs text-slate-400 mt-3">
            Ranking uses the stored score only: a high-risk provider sinks in search results but is never silently hidden.
          </p>
        </>
      )}
    </AdminShell>
  );
}
