"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import AdminShell from "@/components/AdminShell";
import DataTable from "@/components/DataTable";
import { DemoBanner, ErrorState, LoadingState } from "@/components/States";
import { StatusBadge } from "@/components/Badge";
import { ApiError, getRequestsPaged } from "@/lib/api";
import type { ServiceRequestRow } from "@/lib/types";

function pkr(n: number | null) {
  return n == null ? "—" : "PKR " + n.toLocaleString("en-PK");
}

const PAGE_LIMIT = 20;

export default function RequestsPage() {
  const [rows, setRows] = useState<ServiceRequestRow[]>([]);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string | null) => {
      if (cursor) setLoadingMore(true);
      else {
        setLoading(true);
        setError(null);
      }
      try {
        const res = await getRequestsPaged({ status, cursor: cursor ?? null, limit: PAGE_LIMIT });
        setRows((prev) => (cursor ? [...prev, ...res.items] : res.items));
        setNextCursor(res.nextCursor);
        setDemo(res.demo);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Failed to load requests.");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [status]
  );

  // Fresh load whenever the status filter changes (cursor resets).
  useEffect(() => {
    load(null);
  }, [load]);

  const statuses = useMemo(
    () => ["all", "DRAFT", "BROADCASTING", "OFFERS_RECEIVED", "ACCEPTED", "EXPIRED", "CANCELLED"],
    []
  );

  const filtered = rows.filter((r) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      r.customer_name.toLowerCase().includes(q) ||
      r.category_name.toLowerCase().includes(q) ||
      r.description.toLowerCase().includes(q)
    );
  });

  return (
    <AdminShell title="Service requests" subtitle="Posted demand, broadcast in waves (PRD §6). Max 3 negotiation rounds, 10-min default TTL for “Now” requests.">
      {demo && <DemoBanner />}
      <div className="flex flex-wrap gap-3 mb-4">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search customer, category, description…"
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm w-72 focus:outline-none focus:ring-2 focus:ring-brand-600"
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white">
          {statuses.map((s) => (
            <option key={s} value={s}>{s === "all" ? "All statuses" : s.replace(/_/g, " ")}</option>
          ))}
        </select>
        <span className="text-sm text-slate-500 self-center ml-auto">{filtered.length} of {rows.length} loaded</span>
      </div>
      {loading ? (
        <LoadingState text="Loading requests…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => load(null)} />
      ) : (
        <>
          <DataTable
            columns={["Customer", "Category", "Description", "Offer", "Fair-price range", "Fulfilment", "Offers", "Status", "Posted"]}
            emptyText="No requests match this filter."
            rows={filtered.map((r) => [
              <div key="cu">
                <div className="font-semibold">{r.customer_name}</div>
                <div className="text-xs text-slate-500">{r.customer_phone} · {r.city}</div>
              </div>,
              <span key="cat">{r.category_name}</span>,
              <span key="d" className="max-w-xs block">{r.description}</span>,
              <span key="o" className="whitespace-nowrap font-semibold">{r.customer_offer_pkr == null ? "Get quotes" : pkr(r.customer_offer_pkr)}</span>,
              <span key="f" className="text-xs whitespace-nowrap">{pkr(r.fair_min_pkr)} – {pkr(r.fair_max_pkr)}{r.fair_typical_pkr != null ? ` (typical ${pkr(r.fair_typical_pkr)})` : ""}</span>,
              <span key="fu">{r.fulfillment.replace(/_/g, " ")}</span>,
              <span key="oc">{r.offers_count}</span>,
              <StatusBadge key="s" status={r.status} />,
              <span key="p" className="text-xs whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</span>,
            ])}
          />
          {nextCursor && (
            <div className="flex justify-center mt-4">
              <button
                onClick={() => load(nextCursor)}
                disabled={loadingMore}
                className="px-4 py-2 bg-white border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </AdminShell>
  );
}
