"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import KpiCard from "@/components/KpiCard";
import { DemoBanner, ErrorState, LoadingState } from "@/components/States";
import { ApiError, getDisputes, getJobs, getKpis, normalizeKpis } from "@/lib/api";
import type { DisputeRow, JobRow, Kpis } from "@/lib/types";
import { StatusBadge } from "@/components/Badge";

function pkr(n: number) {
  return "PKR " + n.toLocaleString("en-PK");
}

export default function DashboardPage() {
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [disputes, setDisputes] = useState<DisputeRow[]>([]);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [k, j, d] = await Promise.all([getKpis(), getJobs(), getDisputes()]);
      // GET /admin/kpis is the live source; normalizeKpis maps the Phase 2
      // contract names (take_rate / acceptance_rate / cancellation_rate) onto
      // the *_pct fields the cards use. Demo fallback only when unreachable.
      setKpis(normalizeKpis(k.data));
      setJobs(j.data);
      setDisputes(d.data);
      setDemo(k.demo || j.demo || d.demo);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load dashboard data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Simple SVG bar chart: jobs by category (from the jobs list).
  const byCategory = jobs.reduce<Record<string, number>>((acc, j) => {
    acc[j.category_name] = (acc[j.category_name] || 0) + 1;
    return acc;
  }, {});
  const chartEntries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  const chartMax = Math.max(1, ...chartEntries.map(([, v]) => v));

  return (
    <AdminShell title="Dashboard" subtitle="Quetta pilot · operations at a glance (PRD §12)">
      {demo && <DemoBanner />}
      {loading ? (
        <LoadingState text="Loading KPIs…" />
      ) : error || !kpis ? (
        <ErrorState message={error || "No KPI data returned."} onRetry={load} />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard label="GMV" value={pkr(kpis.gmv_pkr)} sub={`${kpis.jobs_total} jobs total`} tone="teal" />
            <KpiCard label="Take rate" value={`${kpis.take_rate_pct}%`} sub="Commission band 5–15% (PRD §9)" tone="amber" />
            <KpiCard label="Active users" value={kpis.active_users.toLocaleString()} sub={`${kpis.active_providers} active providers`} />
            <KpiCard label="Acceptance rate" value={`${kpis.acceptance_rate_pct}%`} sub={`Target fill rate > 70%`} tone="green" />
            <KpiCard label="Time to first offer" value={`${kpis.time_to_first_offer_seconds}s`} sub="Target < 60s median" tone={kpis.time_to_first_offer_seconds <= 60 ? "green" : "red"} />
            <KpiCard label="Cancellation rate" value={`${kpis.cancellation_rate_pct}%`} sub="Pilot target < 5%" tone={kpis.cancellation_rate_pct < 5 ? "green" : "red"} />
            <KpiCard label="NPS" value={kpis.nps != null ? String(kpis.nps) : "—"} sub="Pilot health signal" />
            <KpiCard label="Open disputes" value={String(kpis.disputes_open ?? disputes.filter((d) => d.status === "open" || d.status === "in_review").length)} sub={`${kpis.verifications_pending ?? "—"} verifications pending`} tone="amber" />
          </div>

          <div className="grid lg:grid-cols-2 gap-4 mt-6">
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
              <h2 className="font-bold text-slate-900 mb-4">Jobs by category</h2>
              {chartEntries.length === 0 ? (
                <p className="text-sm text-slate-500">No jobs yet.</p>
              ) : (
                <svg viewBox={`0 0 400 ${chartEntries.length * 36 + 10}`} className="w-full">
                  {chartEntries.map(([name, value], i) => (
                    <g key={name}>
                      <text x="0" y={i * 36 + 18} fontSize="12" fill="#334155">
                        {name}
                      </text>
                      <rect
                        x="140"
                        y={i * 36 + 6}
                        width={Math.max(4, (value / chartMax) * 220)}
                        height="16"
                        rx="4"
                        fill="#0F766E"
                      />
                      <text x={150 + Math.max(4, (value / chartMax) * 220)} y={i * 36 + 19} fontSize="12" fill="#0f172a" fontWeight="bold">
                        {value}
                      </text>
                    </g>
                  ))}
                </svg>
              )}
              <p className="text-xs text-slate-400 mt-3">Counts from the jobs list on this page{demo ? " (demo data)" : ""}.</p>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
              <h2 className="font-bold text-slate-900 mb-4">Latest jobs</h2>
              {jobs.length === 0 ? (
                <p className="text-sm text-slate-500">No jobs yet.</p>
              ) : (
                <ul className="divide-y divide-slate-100 text-sm">
                  {jobs.slice(0, 5).map((j) => (
                    <li key={j.id} className="py-3 flex items-center justify-between gap-3">
                      <div>
                        <div className="font-semibold text-slate-800">{j.provider_name}</div>
                        <div className="text-xs text-slate-500">
                          {j.category_name} · {j.customer_name} · {pkr(j.agreed_price_pkr)}
                        </div>
                      </div>
                      <StatusBadge status={j.state} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 mt-6">
            <h2 className="font-bold text-slate-900 mb-4">Open disputes needing attention</h2>
            {disputes.filter((d) => d.status === "open" || d.status === "in_review").length === 0 ? (
              <p className="text-sm text-slate-500">No open disputes. 🎉</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {disputes
                  .filter((d) => d.status === "open" || d.status === "in_review")
                  .slice(0, 5)
                  .map((d) => (
                    <li key={d.id} className="py-3 flex items-center justify-between gap-3">
                      <div>
                        <div className="font-semibold text-slate-800">{d.reason}</div>
                        <div className="text-xs text-slate-500">
                          {d.opened_by} · {pkr(d.amount_pkr)} · SLA resolution due{" "}
                          {new Date(d.sla_resolution_due).toLocaleDateString()}
                        </div>
                      </div>
                      <StatusBadge status={d.status} />
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </>
      )}
    </AdminShell>
  );
}
