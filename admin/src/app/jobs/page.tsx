"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import AdminShell from "@/components/AdminShell";
import DataTable from "@/components/DataTable";
import { DemoBanner, ErrorState, LoadingState } from "@/components/States";
import { StatusBadge } from "@/components/Badge";
import { ApiError, closeReviewWindows, getJobs } from "@/lib/api";
import type { JobRow } from "@/lib/types";

function pkr(n: number) {
  return "PKR " + n.toLocaleString("en-PK");
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<string>("all");
  const [selected, setSelected] = useState<JobRow | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getJobs();
      setJobs(res.data);
      setDemo(res.demo);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load jobs.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Fix B — manual trigger for the nightly review-window sweep: every
  // PAYMENT_SETTLED job older than the review window (default 7 days)
  // moves to RATED. Idempotent; reloads the list so closed jobs show RATED.
  const runCloseReviewWindows = useCallback(async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await closeReviewWindows();
      setMsg(`Review windows closed: ${r.closed_count} job(s) moved to RATED (window ${r.review_window_days} days).`);
      await load();
    } catch (e) {
      setMsg(e instanceof ApiError ? `Close failed: ${e.message}` : "Close failed.");
    } finally {
      setBusy(false);
    }
  }, [load]);

  useEffect(() => {
    load();
  }, [load]);

  const states = useMemo(() => ["all", ...Array.from(new Set(jobs.map((j) => j.state)))], [jobs]);
  const filtered = state === "all" ? jobs : jobs.filter((j) => j.state === state);

  return (
    <AdminShell title="Jobs" subtitle="Accepted work, tracked through the strict state machine — every transition is logged in job_events (PRD §7).">
      {demo && <DemoBanner />}
      <div className="flex flex-wrap gap-3 mb-4">
        <select value={state} onChange={(e) => setState(e.target.value)} className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white">
          {states.map((s) => (
            <option key={s} value={s}>{s === "all" ? "All states" : s.replace(/_/g, " ")}</option>
          ))}
        </select>
        <button disabled={busy} onClick={runCloseReviewWindows} className="bg-brand-700 text-white px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50">Close review windows</button>
        <span className="text-sm text-slate-500 self-center ml-auto">{filtered.length} of {jobs.length} shown</span>
      </div>
      {msg && <div className="bg-teal-50 border border-teal-200 rounded-xl px-4 py-3 text-sm text-teal-900 mb-4">{msg}</div>}
      {loading ? (
        <LoadingState text="Loading jobs…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <DataTable
          columns={["Job", "Customer → Provider", "Category", "Agreed price", "Commission", "Payment", "State", "Created", ""]}
          emptyText="No jobs match this state filter."
          rows={filtered.map((j) => [
            <span key="id" className="font-mono text-xs">{j.id}</span>,
            <div key="cp">
              <div className="font-semibold">{j.customer_name}</div>
              <div className="text-xs text-slate-500">→ {j.provider_name}</div>
            </div>,
            <span key="cat">{j.category_name}</span>,
            <span key="pr" className="whitespace-nowrap font-semibold">{pkr(j.agreed_price_pkr)}</span>,
            <span key="com" className="text-xs whitespace-nowrap">{pkr(j.commission_amount_pkr)} ({Math.round(j.commission_rate * 100)}%)</span>,
            <span key="pay" className="text-xs">{j.payment_method} · {j.payment_status}</span>,
            <StatusBadge key="s" status={j.state} />,
            <span key="c" className="text-xs whitespace-nowrap">{new Date(j.created_at).toLocaleDateString()}</span>,
            <button key="v" onClick={() => setSelected(j)} className="text-sm font-medium text-brand-700 hover:underline">View</button>,
          ])}
        />
      )}

      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setSelected(null)}>
          <div
            className="bg-white w-full max-w-lg h-full overflow-y-auto shadow-xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Job {selected.id}</h2>
                <p className="text-sm text-slate-500">Request {selected.request_id}</p>
              </div>
              <button onClick={() => setSelected(null)} className="text-slate-400 hover:text-slate-700 text-xl leading-none" aria-label="Close">×</button>
            </div>

            <div className="mt-4">
              <StatusBadge status={selected.state} />
            </div>

            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-slate-500">Customer</dt><dd className="font-semibold">{selected.customer_name}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Provider</dt><dd className="font-semibold">{selected.provider_name}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Category</dt><dd>{selected.category_name}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">City</dt><dd>{selected.city}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Agreed price</dt><dd className="font-semibold">{pkr(selected.agreed_price_pkr)}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Final price</dt><dd>{pkr(selected.final_price_pkr)}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Commission</dt><dd>{pkr(selected.commission_amount_pkr)} ({Math.round(selected.commission_rate * 100)}%)</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Payment</dt><dd>{selected.payment_method} · {selected.payment_status}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Created</dt><dd>{new Date(selected.created_at).toLocaleString()}</dd></div>
              {selected.completed_at && (
                <div className="flex justify-between"><dt className="text-slate-500">Completed</dt><dd>{new Date(selected.completed_at).toLocaleString()}</dd></div>
              )}
            </dl>

            <h3 className="font-bold text-slate-900 mt-6 mb-3">Timeline (job_events)</h3>
            {!selected.events || selected.events.length === 0 ? (
              <p className="text-sm text-slate-500">No events recorded for this job yet.</p>
            ) : (
              <ol className="relative border-l-2 border-brand-600/30 ml-2 space-y-5">
                {selected.events.map((ev) => (
                  <li key={ev.id} className="ml-4">
                    <span className="absolute -left-[7px] mt-1.5 h-3 w-3 rounded-full bg-brand-600 border-2 border-white" />
                    <div className="font-semibold text-sm text-slate-900">
                      {ev.from_state ? `${ev.from_state.replace(/_/g, " ")} → ` : ""}{ev.to_state.replace(/_/g, " ")}
                    </div>
                    <div className="text-xs text-slate-500">
                      {new Date(ev.created_at).toLocaleString()}
                      {ev.actor_name ? ` · ${ev.actor_name}` : ""}
                      {ev.actor_role ? ` (${ev.actor_role})` : ""}
                    </div>
                    {ev.note && <p className="text-sm text-slate-600 mt-0.5">{ev.note}</p>}
                  </li>
                ))}
              </ol>
            )}
            <p className="text-xs text-slate-400 mt-6">
              Illegal transitions are rejected by the API (409) and still written to job_events (PRD §7).
            </p>
          </div>
        </div>
      )}
    </AdminShell>
  );
}
