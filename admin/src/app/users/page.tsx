"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import AdminShell from "@/components/AdminShell";
import DataTable from "@/components/DataTable";
import { DemoBanner, ErrorState, LoadingState } from "@/components/States";
import { Badge, StatusBadge } from "@/components/Badge";
import Modal from "@/components/Modal";
import { ApiError, getStoredUser, getUsers, suspendUser } from "@/lib/api";
import type { AdminUserRow } from "@/lib/types";

export default function UsersPage() {
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "customers" | "providers" | "suspended">("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmUser, setConfirmUser] = useState<AdminUserRow | null>(null);

  const role = getStoredUser()?.role;
  const canSuspend = role === "super_admin" || role === "support_agent";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getUsers();
      setUsers(res.data);
      setDemo(res.demo);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load users.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      if (filter === "customers" && u.is_provider) return false;
      if (filter === "providers" && !u.is_provider) return false;
      if (filter === "suspended" && u.status !== "suspended") return false;
      if (!q) return true;
      return (
        u.full_name.toLowerCase().includes(q) ||
        u.phone.toLowerCase().includes(q) ||
        u.roles.join(" ").toLowerCase().includes(q)
      );
    });
  }, [users, query, filter]);

  async function toggleSuspend(u: AdminUserRow) {
    const suspend = u.status !== "suspended";
    setBusyId(u.id);
    setNotice(null);
    try {
      if (demo) throw new Error("Demo data — connect the backend to suspend users.");
      // PATCH /admin/users/:id/suspend { suspended } — real endpoint, then refresh.
      const updated = await suspendUser(u.id, suspend);
      setNotice(
        `${updated.full_name} ${updated.status === "suspended" ? "suspended" : "unsuspended"}. The action was written to the audit log.`
      );
      setConfirmUser(null);
      await load();
    } catch (e) {
      setNotice(
        e instanceof ApiError
          ? `Failed: ${e.message}`
          : e instanceof Error
            ? e.message
            : "Suspend action failed."
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AdminShell title="Users & Providers" subtitle="One phone number = one account (PRD §4), one wallet per user (profile-level, Phase 2). Suspend/unsuspend is audited; bans and wallet adjustments are server-side only.">
      {demo && <DemoBanner />}
      {!canSuspend && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-900 mb-5">
          Read-only for your role ({role || "unknown"}). Suspend/unsuspend is limited to Super Admin and
          Support Agent. Server-side RBAC still applies.
        </div>
      )}
      {notice && <div className="bg-teal-50 border border-teal-200 text-teal-900 text-sm rounded-xl px-4 py-3 mb-4">{notice}</div>}
      <div className="flex flex-wrap gap-3 mb-4">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, phone or role…"
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm w-72 focus:outline-none focus:ring-2 focus:ring-brand-600"
        />
        {(["all", "customers", "providers", "suspended"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`text-sm font-medium rounded-full px-3 py-1.5 border ${
              filter === f ? "bg-brand-700 text-white border-brand-700" : "bg-white text-slate-700 border-slate-300"
            }`}
          >
            {f === "all" ? "All" : f[0].toUpperCase() + f.slice(1)}
          </button>
        ))}
        <span className="text-sm text-slate-500 self-center ml-auto">{filtered.length} of {users.length} shown</span>
      </div>
      {loading ? (
        <LoadingState text="Loading users…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <DataTable
          columns={["Name", "Phone", "Roles", "Type", "Tier", "City", "Jobs", "Rating", "Status", "Joined", ""]}
          emptyText="No users match this search."
          rows={filtered.map((u) => [
            <span key="n" className="font-semibold">{u.full_name}</span>,
            <span key="p" className="whitespace-nowrap">{u.phone}</span>,
            <span key="r" className="space-x-1">{u.roles.map((r) => <Badge key={r}>{r}</Badge>)}</span>,
            <span key="t">{u.is_provider ? "Provider" : "Customer"}</span>,
            <span key="tier">{u.is_provider ? `Tier ${u.provider_tier ?? 0}` : "—"}</span>,
            <span key="c">{u.city}</span>,
            <span key="j">{u.jobs_completed}</span>,
            <span key="rt">{u.rating_avg > 0 ? u.rating_avg.toFixed(1) : "—"}</span>,
            <StatusBadge key="s" status={u.status} />,
            <span key="jd" className="text-xs whitespace-nowrap">{new Date(u.created_at).toLocaleDateString()}</span>,
            <button
              key="a"
              onClick={() => setConfirmUser(u)}
              disabled={!canSuspend || busyId === u.id}
              className="text-sm font-medium text-red-700 hover:underline disabled:text-slate-300 disabled:no-underline whitespace-nowrap"
            >
              {busyId === u.id ? "…" : u.status === "suspended" ? "Unsuspend" : "Suspend"}
            </button>,
          ])}
        />
      )}

      {confirmUser && (
        <Modal
          title={`${confirmUser.status === "suspended" ? "Unsuspend" : "Suspend"} ${confirmUser.full_name}?`}
          onClose={() => setConfirmUser(null)}
        >
          <p className="text-sm text-slate-700">
            {confirmUser.full_name} ({confirmUser.phone}) · {confirmUser.is_provider ? `Provider, Tier ${confirmUser.provider_tier ?? 0}` : "Customer"} ·{" "}
            {confirmUser.jobs_completed} jobs completed.
          </p>
          <p className="text-sm text-slate-700 mt-3">
            {confirmUser.status === "suspended"
              ? "Unsuspending restores this account: the user can post requests / accept work again immediately."
              : "Suspending blocks this account immediately: the user cannot post requests or accept work until unsuspended."}
          </p>
          <p className="text-xs text-slate-500 mt-3">
            This calls PATCH /admin/users/:id/suspend and is written to the audit log.
          </p>
          <div className="flex gap-2 justify-end mt-5">
            <button onClick={() => setConfirmUser(null)} className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium">
              Cancel
            </button>
            <button
              onClick={() => toggleSuspend(confirmUser)}
              disabled={busyId === confirmUser.id}
              className="px-4 py-2 bg-red-700 text-white rounded-lg text-sm font-semibold hover:bg-red-800 disabled:opacity-50"
            >
              {busyId === confirmUser.id
                ? "Working…"
                : confirmUser.status === "suspended"
                  ? "Confirm unsuspend"
                  : "Confirm suspend"}
            </button>
          </div>
        </Modal>
      )}
    </AdminShell>
  );
}
