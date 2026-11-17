"use client";

// Phase 3 (v1.5) — Subscription plans + subscriptions + expire sweep.
// Paid plans bill from the provider's wallet; a plan multiplies the
// commission rate (clamped 0.05–0.15) and Business enables featured
// ("Sponsored") placement.

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import DataTable from "@/components/DataTable";
import { DemoBanner, ErrorState, LoadingState } from "@/components/States";
import { Badge } from "@/components/Badge";
import {
  ApiError,
  createSubscriptionPlan,
  expireSubscriptions,
  getAdminSubscriptions,
  getSubscriptionPlans,
  updateSubscriptionPlan,
} from "@/lib/api";
import type { SubscriptionPlanRow, SubscriptionRow } from "@/lib/types";

export default function SubscriptionsPage() {
  const [plans, setPlans] = useState<SubscriptionPlanRow[]>([]);
  const [subs, setSubs] = useState<SubscriptionRow[]>([]);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ code: "", name: "", price_pkr: 0, commission_multiplier: 1, max_staff_accounts: 0, featured: false, analytics_enabled: false });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, s] = await Promise.all([getSubscriptionPlans(), getAdminSubscriptions()]);
      setPlans(p.data);
      setSubs(s.data);
      setDemo(p.demo || s.demo);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load subscriptions.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createPlan(e: React.FormEvent) {
    e.preventDefault();
    if (!form.code.trim() || !form.name.trim()) return;
    setSaving(true);
    setMsg(null);
    try {
      await createSubscriptionPlan(form);
      setMsg("Plan created.");
      setForm({ code: "", name: "", price_pkr: 0, commission_multiplier: 1, max_staff_accounts: 0, featured: false, analytics_enabled: false });
      await load();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Create failed.");
    } finally {
      setSaving(false);
    }
  }

  async function togglePlan(plan: SubscriptionPlanRow) {
    setMsg(null);
    try {
      await updateSubscriptionPlan(plan.id, { is_active: !plan.is_active });
      await load();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Update failed.");
    }
  }

  async function runExpire() {
    setMsg(null);
    try {
      const r = await expireSubscriptions();
      setMsg(`Expire sweep processed ${r.processed} subscription(s).`);
      await load();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Sweep failed.");
    }
  }

  return (
    <AdminShell title="Subscriptions" subtitle="Phase 3 plans (Free / Pro / Business) — plan-discounted commission, featured placement, provider analytics.">
      {demo && <DemoBanner />}
      {loading ? (
        <LoadingState text="Loading subscriptions…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <>
          <div className="flex items-center gap-3 mb-4">
            <Badge tone="slate">{plans.length} plans</Badge>
            <Badge tone="slate">{subs.length} subscriptions</Badge>
            <button onClick={runExpire} className="ml-auto bg-brand-700 text-white px-4 py-2 rounded-lg text-sm font-medium">
              Run expire sweep
            </button>
          </div>
          {msg && <div className="bg-teal-50 border border-teal-200 rounded-xl px-4 py-3 text-sm text-teal-900 mb-4">{msg}</div>}
          <h2 className="text-lg font-semibold mb-3">Plans</h2>
          <DataTable
            columns={["Code", "Name", "Price (PKR)", "Commission ×", "Staff seats", "Featured", "Analytics", "Active", ""]}
            emptyText="No plans yet."
            rows={plans.map((p) => [
              <div key="c" className="font-semibold">{p.code}</div>,
              <div key="n">{p.name}</div>,
              <div key="p">{p.price_pkr}</div>,
              <div key="m">{p.commission_multiplier}</div>,
              <div key="s">{p.max_staff_accounts}</div>,
              <div key="f">{p.featured ? "Sponsored" : "—"}</div>,
              <div key="a">{p.analytics_enabled ? "Yes" : "No"}</div>,
              <Badge key="ac" tone={p.is_active ? "green" : "slate"}>{p.is_active ? "active" : "inactive"}</Badge>,
              <button key="t" onClick={() => togglePlan(p)} className="text-sm font-medium text-brand-700 hover:underline">
                {p.is_active ? "Deactivate" : "Activate"}
              </button>,
            ])}
          />
          <h2 className="text-lg font-semibold mt-8 mb-3">New plan</h2>
          <form onSubmit={createPlan} className="bg-white border rounded-xl p-4 grid grid-cols-2 md:grid-cols-4 gap-4 max-w-4xl">
            <label className="text-sm">
              <span className="block text-slate-600 mb-1">Code</span>
              <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className="w-full border rounded-lg px-3 py-2" placeholder="e.g. pro" />
            </label>
            <label className="text-sm">
              <span className="block text-slate-600 mb-1">Name</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full border rounded-lg px-3 py-2" placeholder="e.g. Pro" />
            </label>
            <label className="text-sm">
              <span className="block text-slate-600 mb-1">Price (PKR)</span>
              <input type="number" min={0} value={form.price_pkr} onChange={(e) => setForm({ ...form, price_pkr: Number(e.target.value) })} className="w-full border rounded-lg px-3 py-2" />
            </label>
            <label className="text-sm">
              <span className="block text-slate-600 mb-1">Commission × (0.01–1)</span>
              <input type="number" step={0.01} min={0.01} max={1} value={form.commission_multiplier} onChange={(e) => setForm({ ...form, commission_multiplier: Number(e.target.value) })} className="w-full border rounded-lg px-3 py-2" />
            </label>
            <label className="text-sm">
              <span className="block text-slate-600 mb-1">Staff seats</span>
              <input type="number" min={0} max={100} value={form.max_staff_accounts} onChange={(e) => setForm({ ...form, max_staff_accounts: Number(e.target.value) })} className="w-full border rounded-lg px-3 py-2" />
            </label>
            <label className="text-sm flex items-center gap-2 pt-6">
              <input type="checkbox" checked={form.featured} onChange={(e) => setForm({ ...form, featured: e.target.checked })} />
              Featured (Sponsored)
            </label>
            <label className="text-sm flex items-center gap-2 pt-6">
              <input type="checkbox" checked={form.analytics_enabled} onChange={(e) => setForm({ ...form, analytics_enabled: e.target.checked })} />
              Analytics
            </label>
            <div className="flex items-end">
              <button type="submit" disabled={saving} className="bg-brand-700 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50">
                {saving ? "Creating…" : "Create plan"}
              </button>
            </div>
          </form>
          <h2 className="text-lg font-semibold mt-8 mb-3">Subscriptions</h2>
          <DataTable
            columns={["Provider", "Plan", "Status", "Period", "Cancel at period end"]}
            emptyText="No subscriptions yet."
            rows={subs.map((s) => [
              <div key="p" className="font-mono text-xs">{s.provider_id.slice(0, 8)}…</div>,
              <div key="pl" className="font-semibold">{s.plan_code}</div>,
              <Badge key="st" tone={s.status === "active" ? "green" : "slate"}>{s.status}</Badge>,
              <div key="per" className="text-xs">
                {s.current_period_start ? new Date(s.current_period_start).toLocaleDateString() : "—"} →{" "}
                {s.current_period_end ? new Date(s.current_period_end).toLocaleDateString() : "—"}
              </div>,
              <div key="c">{s.cancel_at_period_end ? "Yes" : "No"}</div>,
            ])}
          />
        </>
      )}
    </AdminShell>
  );
}
