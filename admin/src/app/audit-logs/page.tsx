"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import DataTable from "@/components/DataTable";
import { DemoBanner, ErrorState, LoadingState } from "@/components/States";
import { ApiError, getAuditLogs } from "@/lib/api";
import type { AuditLogEntry } from "@/lib/types";

const PAGE_LIMIT = 20;

export default function AuditLogsPage() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getAuditLogs(null, PAGE_LIMIT);
      setEntries(res.entries);
      setNextCursor(res.nextCursor);
      setDemo(res.demo);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load audit log.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFirst();
  }, [loadFirst]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await getAuditLogs(nextCursor, PAGE_LIMIT);
      setEntries((prev) => [...prev, ...res.entries]);
      setNextCursor(res.nextCursor);
      setDemo(res.demo);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load more audit entries.");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <AdminShell title="Audit Log" subtitle="Append-only trail of every admin action (GET /admin/audit-logs, cursor-paginated). Read-only — entries are never edited or deleted.">
      {demo && <DemoBanner />}
      {loading ? (
        <LoadingState text="Loading audit log…" />
      ) : error ? (
        <ErrorState message={error} onRetry={loadFirst} />
      ) : (
        <>
          <DataTable
            columns={["Time", "Actor", "Action", "Entity", "Detail"]}
            emptyText="No audit entries yet — admin actions will appear here."
            rows={entries.map((e) => [
              <span key="t" className="text-xs whitespace-nowrap">{new Date(e.created_at).toLocaleString()}</span>,
              <div key="a">
                <div className="font-medium text-sm">{e.actor_name || e.actor_id || "—"}</div>
                {e.actor_role && <div className="text-xs text-slate-500">{e.actor_role}</div>}
              </div>,
              <code key="act" className="text-xs bg-slate-100 rounded px-1.5 py-0.5">{e.action}</code>,
              <div key="en" className="text-xs">
                {e.entity_type ? <span>{e.entity_type}</span> : "—"}
                {e.entity_id && (
                  <div className="text-slate-500 break-all font-mono text-[11px]">{e.entity_id}</div>
                )}
              </div>,
              <span key="d" className="text-xs">{e.detail || "—"}</span>,
            ])}
          />
          {nextCursor && (
            <div className="mt-4 text-center">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
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
