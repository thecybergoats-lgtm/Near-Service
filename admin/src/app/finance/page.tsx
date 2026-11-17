"use client";

// Phase 3 (v1.5) — Escrow holds + payout finance queue + escrow config.
// Every payout response carries sandbox: true — payouts are SANDBOX ONLY
// until a live gateway lands. Never present a sandbox payout as real money.

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import DataTable from "@/components/DataTable";
import { DemoBanner, ErrorState, LoadingState } from "@/components/States";
import { Badge } from "@/components/Badge";
import {
  ApiError,
  approvePayout,
  autoReleaseEscrow,
  expireDueTenders,
  getAdminEscrowHolds,
  getAdminPayouts,
  getEscrowConfig,
  rejectPayout,
  releaseEscrowHoldAdmin,
  runDuePayouts,
  updateEscrowConfig,
} from "@/lib/api";
import type { EscrowConfigRow, EscrowHoldRow, PayoutRow } from "@/lib/types";

export default function FinancePage() {
  const [holds, setHolds] = useState<EscrowHoldRow[]>([]);
  const [payouts, setPayouts] = useState<PayoutRow[]>([]);
  const [config, setConfig] = useState<EscrowConfigRow | null>(null);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ auto_release_hours: 48, min_amount_pkr: 5000, payout_fee_flat_pkr: 0, payout_fee_rate: 0, payout_tax_rate: 0 });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [h, p, c] = await Promise.all([getAdminEscrowHolds(), getAdminPayouts(), getEscrowConfig()]);
      setHolds(h.data);
      setPayouts(p.data);
      setConfig(c.data);
      setForm({
        auto_release_hours: c.data.auto_release_hours,
        min_amount_pkr: Math.round(c.data.min_amount_paisa / 100),
        payout_fee_flat_pkr: Math.round(c.data.payout_fee_flat_paisa / 100),
        payout_fee_rate: c.data.payout_fee_rate,
        payout_tax_rate: c.data.payout_tax_rate,
      });
      setDemo(h.demo || p.demo || c.demo);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load finance data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run<T>(fn: () => Promise<T>, done: (r: T) => string) {
    setBusy(true);
    setMsg(null);
    try {
      setMsg(done(await fn()));
      await load();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveConfig(e: React.FormEvent) {
    e.preventDefault();
    await run(
      () => updateEscrowConfig({ auto_release_hours: form.auto_release_hours, min_amount_pkr: form.min_amount_pkr, payout_fee_flat_pkr: form.payout_fee_flat_pkr, payout_fee_rate: form.payout_fee_rate, payout_tax_rate: form.payout_tax_rate }),
      () => "Escrow config saved.",
    );
  }

  return (
    <AdminShell title="Finance — escrow & payouts" subtitle="Phase 3 escrow holds and the payout finance queue. SANDBOX ONLY: every payout carries sandbox: true until a live gateway lands.">
      {demo && <DemoBanner />}
      <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900 mb-5">
        Sandbox payouts — no real money moves. Approving an instant payout executes it in the sandbox gateway only.
      </div>
      {loading ? (
        <LoadingState text="Loading finance queue…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <Badge tone="slate">{holds.filter((h) => h.status === "held").length} holds open</Badge>
            <Badge tone="slate">{payouts.filter((p) => p.status === "requested").length} payouts awaiting approval</Badge>
            <div className="ml-auto flex gap-2">
              <button disabled={busy} onClick={() => run(autoReleaseEscrow, (r) => `Auto-release: ${r.released.length} released, ${r.skipped_dispute.length} skipped (open dispute).`)} className="bg-brand-700 text-white px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50">Run auto-release</button>
              <button disabled={busy} onClick={() => run(runDuePayouts, (r) => `Run-due: ${r.executed.length} executed, ${r.failed.length} failed.`)} className="bg-brand-700 text-white px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50">Run due payouts</button>
              <button disabled={busy} onClick={() => run(expireDueTenders, (r) => `Tender sweep: ${r.expired_count} expired of ${r.checked_count} checked.`)} className="bg-white border px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50">Expire due tenders</button>
            </div>
          </div>
          {msg && <div className="bg-teal-50 border border-teal-200 rounded-xl px-4 py-3 text-sm text-teal-900 mb-4">{msg}</div>}
          <h2 className="text-lg font-semibold mb-3">Escrow holds</h2>
          <DataTable
            columns={["Job", "Amount (PKR)", "Status", "Held at", "Auto-release", ""]}
            emptyText="No escrow holds."
            rows={holds.map((h) => [
              <div key="j" className="font-mono text-xs">{h.job_id.slice(0, 8)}…</div>,
              <div key="a" className="font-semibold">{h.amount_pkr.toLocaleString()}</div>,
              <Badge key="s" tone={h.status === "held" ? "amber" : "green"}>{h.status}</Badge>,
              <div key="h" className="text-xs">{new Date(h.held_at).toLocaleString()}</div>,
              <div key="ar" className="text-xs">{new Date(h.auto_release_at).toLocaleString()}</div>,
              <button
                key="r"
                disabled={busy || h.status !== "held"}
                onClick={() => run(() => releaseEscrowHoldAdmin(h.id), () => `Hold ${h.id.slice(0, 8)} released.`)}
                className="text-sm font-medium text-brand-700 hover:underline disabled:text-slate-300 disabled:no-underline"
              >
                Release
              </button>,
            ])}
          />
          <h2 className="text-lg font-semibold mt-8 mb-3">Payout queue</h2>
          <DataTable
            columns={["Amount (PKR)", "Net (PKR)", "Destination", "Kind", "Status", "Sandbox", "Created", ""]}
            emptyText="No payouts awaiting review."
            rows={payouts.map((p) => [
              <div key="a" className="font-semibold">{p.amount_pkr.toLocaleString()}</div>,
              <div key="n">{p.net_pkr.toLocaleString()}</div>,
              <div key="d" className="text-xs">{p.destination} · {p.destination_phone || "—"}</div>,
              <div key="k">{p.kind}</div>,
              <Badge key="s" tone={p.status === "requested" ? "amber" : p.status === "executed" ? "green" : p.status === "rejected" ? "red" : "slate"}>{p.status}</Badge>,
              <div key="sb">{p.sandbox ? "sandbox" : "LIVE"}</div>,
              <div key="c" className="text-xs">{new Date(p.created_at).toLocaleString()}</div>,
              <div key="x" className="flex gap-3">
                <button
                  disabled={busy || p.status !== "requested"}
                  onClick={() => run(() => approvePayout(p.id), () => `Payout ${p.id.slice(0, 8)} approved (sandbox).`)}
                  className="text-sm font-medium text-brand-700 hover:underline disabled:text-slate-300 disabled:no-underline"
                >
                  Approve
                </button>
                <button
                  disabled={busy || p.status !== "requested"}
                  onClick={() => run(() => rejectPayout(p.id), () => `Payout ${p.id.slice(0, 8)} rejected.`)}
                  className="text-sm font-medium text-red-600 hover:underline disabled:text-slate-300 disabled:no-underline"
                >
                  Reject
                </button>
              </div>,
            ])}
          />
          <h2 className="text-lg font-semibold mt-8 mb-3">Escrow config</h2>
          <form onSubmit={saveConfig} className="bg-white border rounded-xl p-4 grid grid-cols-2 md:grid-cols-5 gap-4 max-w-4xl">
            <label className="text-sm">
              <span className="block text-slate-600 mb-1">Auto-release (hours)</span>
              <input type="number" min={1} max={720} value={form.auto_release_hours} onChange={(e) => setForm({ ...form, auto_release_hours: Number(e.target.value) })} className="w-full border rounded-lg px-3 py-2" />
            </label>
            <label className="text-sm">
              <span className="block text-slate-600 mb-1">Min escrow (PKR)</span>
              <input type="number" min={0} value={form.min_amount_pkr} onChange={(e) => setForm({ ...form, min_amount_pkr: Number(e.target.value) })} className="w-full border rounded-lg px-3 py-2" />
            </label>
            <label className="text-sm">
              <span className="block text-slate-600 mb-1">Payout fee flat (PKR)</span>
              <input type="number" min={0} value={form.payout_fee_flat_pkr} onChange={(e) => setForm({ ...form, payout_fee_flat_pkr: Number(e.target.value) })} className="w-full border rounded-lg px-3 py-2" />
            </label>
            <label className="text-sm">
              <span className="block text-slate-600 mb-1">Payout fee rate</span>
              <input type="number" step={0.01} min={0} max={0.5} value={form.payout_fee_rate} onChange={(e) => setForm({ ...form, payout_fee_rate: Number(e.target.value) })} className="w-full border rounded-lg px-3 py-2" />
            </label>
            <label className="text-sm">
              <span className="block text-slate-600 mb-1">Payout tax rate</span>
              <input type="number" step={0.01} min={0} max={0.5} value={form.payout_tax_rate} onChange={(e) => setForm({ ...form, payout_tax_rate: Number(e.target.value) })} className="w-full border rounded-lg px-3 py-2" />
            </label>
            <div className="col-span-2 md:col-span-5">
              <button type="submit" disabled={busy} className="bg-brand-700 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50">Save config</button>
              {config && <span className="text-xs text-slate-400 ml-3">Stored: min {config.min_amount_paisa} paisa · fee flat {config.payout_fee_flat_paisa} paisa</span>}
            </div>
          </form>
        </>
      )}
    </AdminShell>
  );
}
