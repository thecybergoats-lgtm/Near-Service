"use client";

// Phase 4 (item 5) — Partner integrations: parts-supplier affiliate
// ordering (AC parts, hardware), disclosed in-app.
//
// WIRING NOTE (integrator — this page is new, but it is NOT linked yet):
//   * Add a Sidebar entry pointing at /partners (Sidebar.tsx is shared —
//     this piece does not edit it).
//   * Add the matching helpers to admin/src/lib/api.ts and row types to
//     admin/src/lib/types.ts (both shared — this piece does not edit
//     them). Until then this page calls the API directly with its own
//     local fetch helpers below (API_URL + getToken from @/lib/api).
//   * The backend routes (GET/POST/PATCH /admin/partners…,
//     GET /admin/partners/affiliate-fees) land when PartnersModule is
//     wired into AppModule + openapi.yaml — see docs/phase4-partners.md.
// Until the API is reachable the page shows the error state, not demo
// data: partner orders are real money records and must never be faked.

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import DataTable from "@/components/DataTable";
import { ErrorState, LoadingState } from "@/components/States";
import { StatusBadge } from "@/components/Badge";
import { API_URL, ApiError, getToken } from "@/lib/api";

// Local row types (move to @/lib/types.ts when the api.ts helpers land).
interface PartnerRow {
  id: string;
  name: string;
  slug: string;
  kind: string;
  city: string | null;
  affiliate_fee_rate: number;
  is_active: boolean;
}
interface PartnerOrderRow {
  id: string;
  job_id: string;
  partner_name: string;
  status: string;
  total_pkr: number;
  affiliate_fee_pkr: number;
  placed_at: string;
  partner_disclosure: { text: string };
}
interface FeeReportRow {
  partner_id: string;
  partner_name: string;
  orders_placed: number;
  orders_confirmed: number;
  orders_delivered: number;
  orders_cancelled: number;
  gross_parts_pkr: number;
  affiliate_fee_earned_pkr: number;
}
interface FeeReport {
  partners: FeeReportRow[];
  totals: { gross_parts_paisa: number; affiliate_fee_earned_paisa: number; orders: number };
  ledger_check: { txns_checked: number; mismatches: { txn_id: string; diff_paisa: number }[] };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code || "request_failed", err?.message || `Request failed (${res.status})`);
  }
  return body as T;
}

export default function PartnersPage() {
  const [partners, setPartners] = useState<PartnerRow[]>([]);
  const [orders, setOrders] = useState<PartnerOrderRow[]>([]);
  const [report, setReport] = useState<FeeReport | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", slug: "", kind: "parts_supplier", city: "Quetta", affiliate_fee_rate: 0.05 });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, o, r] = await Promise.all([
        api<PartnerRow[]>("/admin/partners"),
        api<{ items: PartnerOrderRow[]; total: number }>(
          `/admin/partners/orders?limit=50${statusFilter ? `&status=${statusFilter}` : ""}`
        ),
        api<FeeReport>("/admin/partners/affiliate-fees"),
      ]);
      setPartners(p);
      setOrders(o.items);
      setReport(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load partners");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(orderId: string, action: "confirm" | "deliver" | "cancel") {
    setBusyId(orderId);
    setMsg(null);
    try {
      await api(`/admin/partners/orders/${orderId}/${action}`, {
        method: "POST",
        body: JSON.stringify(action === "cancel" ? { reason: "Cancelled by admin" } : {}),
      });
      setMsg(`Order ${action}ed.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : `${action} failed`);
    } finally {
      setBusyId(null);
    }
  }

  async function createPartner(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api("/admin/partners", { method: "POST", body: JSON.stringify(form) });
      setMsg(`Partner ${form.name} created.`);
      setForm({ name: "", slug: "", kind: "parts_supplier", city: "Quetta", affiliate_fee_rate: 0.05 });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    }
  }

  return (
    <AdminShell title="Partners">
      <p className="text-sm text-slate-500 mb-4">
        Parts-supplier affiliate ordering. Every order is disclosed in-app to customer and provider; the affiliate fee
        (default 5% of the order total) is recorded in the ledger when an order is confirmed, and reversed if a
        confirmed order is cancelled. Local catalog only — no live supplier is wired yet (see docs/phase4-partners.md).
      </p>
      {loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <>
          {msg && <div className="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-2 text-sm text-emerald-800">{msg}</div>}
          {report && (
            <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="bg-white rounded-xl border border-slate-200 p-4">
                <div className="text-xs uppercase text-slate-500">Affiliate fees earned</div>
                <div className="text-xl font-bold">PKR {(report.totals.affiliate_fee_earned_paisa / 100).toLocaleString()}</div>
              </div>
              <div className="bg-white rounded-xl border border-slate-200 p-4">
                <div className="text-xs uppercase text-slate-500">Partner orders</div>
                <div className="text-xl font-bold">{report.totals.orders}</div>
              </div>
              <div className="bg-white rounded-xl border border-slate-200 p-4">
                <div className="text-xs uppercase text-slate-500">Ledger check</div>
                <div className="text-xl font-bold">
                  {report.ledger_check.mismatches.length === 0
                    ? `Balanced (${report.ledger_check.txns_checked} txns)`
                    : `${report.ledger_check.mismatches.length} mismatched txns`}
                </div>
              </div>
            </div>
          )}
          <h2 className="font-semibold mb-2">Partners</h2>
          <DataTable
            columns={["Name", "Slug", "Kind", "City", "Fee rate", "Active"]}
            rows={partners.map((p) => [
              p.name,
              p.slug,
              p.kind,
              p.city ?? "—",
              `${(p.affiliate_fee_rate * 100).toFixed(1)}%`,
              p.is_active ? "Yes" : "No",
            ])}
          />
          <form onSubmit={createPartner} className="mt-4 mb-6 flex flex-wrap gap-2 items-end">
            <label className="text-sm">
              Name
              <input className="block border rounded px-2 py-1" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </label>
            <label className="text-sm">
              Slug
              <input className="block border rounded px-2 py-1" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} required />
            </label>
            <label className="text-sm">
              City
              <input className="block border rounded px-2 py-1" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </label>
            <label className="text-sm">
              Fee rate
              <input className="block border rounded px-2 py-1 w-20" type="number" step="0.01" min="0" max="0.99" value={form.affiliate_fee_rate} onChange={(e) => setForm({ ...form, affiliate_fee_rate: Number(e.target.value) })} />
            </label>
            <button type="submit" className="rounded bg-slate-900 text-white px-4 py-2 text-sm">Add partner</button>
          </form>
          <div className="flex items-center gap-2 mb-2">
            <h2 className="font-semibold">Orders</h2>
            <select className="border rounded px-2 py-1 text-sm" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">All statuses</option>
              <option value="placed">Placed</option>
              <option value="confirmed">Confirmed</option>
              <option value="delivered">Delivered</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <DataTable
            columns={["Order", "Partner", "Status", "Total", "Affiliate fee", "Placed", "Disclosure", "Actions"]}
            rows={orders.map((o) => [
              <span key="id" className="font-mono text-xs">{o.id.slice(0, 8)}</span>,
              o.partner_name,
              <StatusBadge key="s" status={o.status} />,
              `PKR ${o.total_pkr.toLocaleString()}`,
              `PKR ${o.affiliate_fee_pkr.toLocaleString()}`,
              new Date(o.placed_at).toLocaleString(),
              <span key="d" className="text-xs text-slate-500">{o.partner_disclosure.text}</span>,
              <span key="a" className="flex gap-1">
                {o.status === "placed" && (
                  <button disabled={busyId === o.id} className="rounded bg-emerald-600 text-white px-2 py-1 text-xs" onClick={() => act(o.id, "confirm")}>Confirm</button>
                )}
                {o.status === "confirmed" && (
                  <button disabled={busyId === o.id} className="rounded bg-blue-600 text-white px-2 py-1 text-xs" onClick={() => act(o.id, "deliver")}>Deliver</button>
                )}
                {(o.status === "placed" || o.status === "confirmed") && (
                  <button disabled={busyId === o.id} className="rounded bg-red-600 text-white px-2 py-1 text-xs" onClick={() => act(o.id, "cancel")}>Cancel</button>
                )}
              </span>,
            ])}
          />
          {report && report.partners.length > 0 && (
            <>
              <h2 className="font-semibold mt-6 mb-2">Affiliate fees by partner</h2>
              <DataTable
                columns={["Partner", "Placed", "Confirmed", "Delivered", "Cancelled", "Parts gross", "Fees earned"]}
                rows={report.partners.map((r) => [
                  r.partner_name,
                  String(r.orders_placed),
                  String(r.orders_confirmed),
                  String(r.orders_delivered),
                  String(r.orders_cancelled),
                  `PKR ${r.gross_parts_pkr.toLocaleString()}`,
                  `PKR ${r.affiliate_fee_earned_pkr.toLocaleString()}`,
                ])}
              />
            </>
          )}
        </>
      )}
    </AdminShell>
  );
}
