"use client";

// Phase 4 (item 2) — Analytics warehouse CSV exports.
// FBR/PRA/SRB-style reporting from the warehouse tables. Every file is
// labelled SUBJECT TO LEGAL REVIEW (PRD v1.1 p.32): the figures are
// derived from the warehouse as of the last ETL run and are NOT a tax
// filing — Finance / legal counsel must verify before any submission.

import { useState } from "react";
import AdminShell from "@/components/AdminShell";
import { ApiError } from "@/lib/api";
import { ANALYTICS_EXPORT_TABLES, downloadAnalyticsCsv } from "../analytics-api";

const TABLE_LABELS: Record<string, string> = {
  fact_requests: "Fact — requests (funnel source)",
  fact_jobs: "Fact — jobs (revenue / commission source)",
  fact_payments: "Fact — payments",
  fact_providers: "Fact — providers (daily snapshots)",
  revenue_by_city: "Summary — revenue / commission by city",
  revenue_by_category: "Summary — revenue / commission by category",
};

export default function AnalyticsExportsPage() {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function download(table: string) {
    setBusy(table);
    setMsg(null);
    try {
      const file = await downloadAnalyticsCsv(table);
      setMsg(`Downloaded ${file}.`);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "Export failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <AdminShell title="Analytics Exports" subtitle="Warehouse CSV exports for FBR / PRA / SRB-style reporting">
      <div className="space-y-6">
        <div className="bg-amber-50 border border-amber-300 rounded-xl px-4 py-3 text-sm text-amber-900">
          <strong>SUBJECT TO LEGAL REVIEW</strong> — these figures are derived from the Near Service
          analytics warehouse (operational data as of the last ETL run) and are <strong>not</strong> a tax
          filing. Verify with Finance / legal counsel before submitting to FBR, PRA, SRB or any other
          authority. Every downloaded file carries the same notice at the top.
        </div>
        {msg && <div className="bg-teal-50 border border-teal-200 rounded-xl px-4 py-3 text-sm text-teal-900">{msg}</div>}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm divide-y divide-slate-100">
          {ANALYTICS_EXPORT_TABLES.map((table) => (
            <div key={table} className="px-4 py-4 flex flex-wrap items-center gap-4 justify-between">
              <div>
                <div className="font-medium text-slate-900">{TABLE_LABELS[table] ?? table}</div>
                <div className="text-sm text-slate-500 font-mono">{`near-service-analytics-${table}.csv`}</div>
              </div>
              <button
                onClick={() => download(table)}
                disabled={busy !== null}
                className="text-sm font-medium bg-brand-600 text-white rounded-lg px-4 py-2 hover:bg-brand-700 disabled:opacity-50"
              >
                {busy === table ? "Downloading…" : "Download CSV"}
              </button>
            </div>
          ))}
        </div>
        <p className="text-sm text-slate-500">
          Money in these files is PKR as stored on jobs/payments. The double-entry ledger (paisa) remains
          the system of record for money — reconcile against it before filing anything.
        </p>
      </div>
    </AdminShell>
  );
}
