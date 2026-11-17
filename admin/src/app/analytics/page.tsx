"use client";

// Phase 4 (item 2) — Analytics warehouse dashboard.
// Funnel request → offer → accept → complete → rate, fill rate, median
// time-to-first-offer, revenue/commission by city and category, provider
// supply vs demand by city/hour, plus the latest ETL run (with
// reconciliation) and a "Run ETL now" button. All figures come from the
// warehouse facts (last 30 days by default); the ETL runs nightly at
// 02:00 PKT via the operator's scheduler — see docs/phase4-analytics.md.

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import DataTable from "@/components/DataTable";
import KpiCard from "@/components/KpiCard";
import { DemoBanner, ErrorState, LoadingState } from "@/components/States";
import { Badge } from "@/components/Badge";
import { ApiError } from "@/lib/api";
import {
  getAnalyticsEtlStatus,
  getAnalyticsFunnel,
  getAnalyticsRevenue,
  getAnalyticsSupplyDemand,
  runAnalyticsEtl,
} from "./analytics-api";
import type { EtlRun, Funnel, RevenueRow, SupplyDemand } from "./analytics-api";

function pkr(n: number) {
  return "PKR " + Math.round(n).toLocaleString("en-PK");
}
function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}
function secs(n: number | null) {
  if (n === null) return "—";
  if (n < 60) return `${n}s`;
  return `${Math.floor(n / 60)}m ${n % 60}s`;
}

export default function AnalyticsPage() {
  const [funnel, setFunnel] = useState<Funnel | null>(null);
  const [revCity, setRevCity] = useState<RevenueRow[]>([]);
  const [revCat, setRevCat] = useState<RevenueRow[]>([]);
  const [supply, setSupply] = useState<SupplyDemand | null>(null);
  const [run, setRun] = useState<EtlRun | null>(null);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [f, rc, rcat, sd, st] = await Promise.all([
        getAnalyticsFunnel(),
        getAnalyticsRevenue("city"),
        getAnalyticsRevenue("category"),
        getAnalyticsSupplyDemand(),
        getAnalyticsEtlStatus(),
      ]);
      setFunnel(f.data);
      setRevCity(rc.data);
      setRevCat(rcat.data);
      setSupply(sd.data);
      setRun(st.data);
      setDemo(f.demo || rc.demo || rcat.demo || sd.demo || st.demo);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load analytics data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function runEtlNow() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await runAnalyticsEtl();
      const mismatches = Object.entries(r.reconciliation || {}).filter(([, v]) => !v.match);
      setMsg(
        mismatches.length
          ? `ETL finished with reconciliation MISMATCH: ${mismatches.map(([k]) => k).join(", ")} — investigate before trusting the dashboards.`
          : `ETL completed for ${r.run_date}: ${r.counts.requests ?? 0} requests, ${r.counts.jobs ?? 0} jobs, ${r.counts.payments ?? 0} payments loaded; reconciliation matched.`
      );
      await load();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "ETL run failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminShell title="Analytics Warehouse" subtitle="Nightly ETL from the operational DB — funnel, revenue, supply vs demand (last 30 days)">
      {demo && <DemoBanner />}
      {loading ? (
        <LoadingState text="Loading analytics…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <div className="space-y-6">
          {msg && <div className="bg-teal-50 border border-teal-200 rounded-xl px-4 py-3 text-sm text-teal-900">{msg}</div>}

          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 flex flex-wrap items-center gap-4 justify-between">
            <div>
              <div className="font-semibold text-slate-900">Nightly ETL</div>
              <div className="text-sm text-slate-500">
                {run
                  ? `Last run ${run.run_date} · ${run.status} · triggered by ${run.triggered_by} · ${run.finished_at ? new Date(run.finished_at).toLocaleString() : "in progress"}`
                  : "No ETL run yet — run one to populate the warehouse."}
              </div>
              {run && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {Object.entries(run.reconciliation || {}).map(([k, v]) => (
                    <Badge key={k} tone={v.match ? "green" : "red"}>
                      {k}: {v.warehouse}/{v.operational} {v.match ? "✓" : "MISMATCH"}
                    </Badge>
                  ))}
                </div>
              )}
              {run?.error && <div className="text-sm text-red-700 mt-2">{run.error}</div>}
            </div>
            <button
              onClick={runEtlNow}
              disabled={busy}
              className="text-sm font-medium bg-brand-600 text-white rounded-lg px-4 py-2 hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? "Running…" : "Run ETL now"}
            </button>
          </div>

          {funnel && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                <KpiCard label="Requests" value={String(funnel.requests)} sub={`${pct(funnel.offerRate)} got offers`} />
                <KpiCard label="With offers" value={String(funnel.withOffers)} sub={`median first offer ${secs(funnel.medianTimeToFirstOfferSeconds)}`} />
                <KpiCard label="Accepted" value={String(funnel.accepted)} sub={`fill rate ${pct(funnel.fillRate)}`} tone="green" />
                <KpiCard label="Completed" value={String(funnel.completed)} sub={`${pct(funnel.completionRate)} of accepted`} tone="green" />
                <KpiCard label="Rated" value={String(funnel.rated)} sub={`${pct(funnel.ratingRate)} of completed`} />
                <KpiCard label="Fill rate" value={pct(funnel.fillRate)} sub="accepted ÷ requests" tone={funnel.fillRate >= 0.5 ? "green" : "amber"} />
              </div>
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                <div className="font-semibold text-slate-900 mb-1">Funnel — request → offer → accept → complete → rate</div>
                <div className="text-sm text-slate-500">
                  {funnel.requests} requests · {funnel.withOffers} with offers · {funnel.accepted} accepted · {funnel.completed} completed · {funnel.rated} rated. Median time to first offer: {secs(funnel.medianTimeToFirstOfferSeconds)}.
                </div>
              </div>
            </>
          )}

          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <h2 className="font-semibold text-slate-900 mb-2">Revenue / commission by city</h2>
              <DataTable
                columns={["City", "Jobs", "Completed", "Revenue", "Commission"]}
                rows={revCity.map((r) => [r.label, String(r.jobs), String(r.completedJobs), pkr(r.revenuePkr), pkr(r.commissionPkr)])}
                emptyText="No revenue yet — run the ETL."
              />
            </div>
            <div>
              <h2 className="font-semibold text-slate-900 mb-2">Revenue / commission by category</h2>
              <DataTable
                columns={["Category", "Jobs", "Completed", "Revenue", "Commission"]}
                rows={revCat.map((r) => [r.label, String(r.jobs), String(r.completedJobs), pkr(r.revenuePkr), pkr(r.commissionPkr)])}
                emptyText="No revenue yet — run the ETL."
              />
            </div>
          </div>

          {supply && (
            <div className="grid md:grid-cols-2 gap-6">
              <div>
                <h2 className="font-semibold text-slate-900 mb-2">Demand by city / hour</h2>
                <DataTable
                  columns={["City", "Hour", "Requests", "With offers"]}
                  rows={supply.demandByHour.map((d) => [d.city, `${String(d.hour).padStart(2, "0")}:00`, String(d.requests), String(d.withOffers)])}
                  emptyText="No demand yet — run the ETL."
                />
              </div>
              <div>
                <h2 className="font-semibold text-slate-900 mb-2">Provider supply by city (latest snapshot)</h2>
                <DataTable
                  columns={["City", "Providers", "Online"]}
                  rows={supply.supplyByCity.map((s) => [s.city, String(s.providersTotal), String(s.providersOnline)])}
                  emptyText="No providers in the warehouse yet — run the ETL."
                />
              </div>
            </div>
          )}

          <div className="text-sm text-slate-500">
            Exports (CSV, FBR/PRA/SRB-style, subject to legal review) live under{" "}
            <a className="text-brand-700 underline" href="/analytics/exports">Analytics → Exports</a>.
            Dashboards read warehouse facts only — they never query the live booking tables.
          </div>
        </div>
      )}
    </AdminShell>
  );
}
