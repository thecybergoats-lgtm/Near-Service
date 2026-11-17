"use client";

// Phase 4 (item 4) — Warranty Product: claims queue + fee config + rules.
// NEW PAGE — not yet linked from the sidebar and its calls are NOT yet in
// lib/api.ts / lib/types.ts (shared files owned by the integrator — see
// docs/phase4-warranty.md). Until that wiring lands this page calls the
// API directly with the same token/base-URL conventions as lib/api.ts
// (NEXT_PUBLIC_API_URL, localStorage ns_admin_token). To finish wiring:
//   1. Move the fetch helpers below into lib/api.ts and the row types
//      into lib/types.ts (shapes are in docs/phase4-warranty.md).
//   2. Add a "Warranty" entry to the sidebar pointing at /warranty.
//   3. Add the routes to backend/openapi.yaml (integrator-owned).
// Endpoints (all under /api/v1, roles super_admin / finance / support_agent):
//   GET   /admin/warranty/claims?status=filed
//   POST  /admin/warranty/claims/:id/review | offer-rework | reject | approve-refund
//   GET/PATCH /admin/warranty/config   GET/PUT /admin/warranty/rules
//   POST  /admin/warranty/expire-due

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import DataTable from "@/components/DataTable";
import { ErrorState, LoadingState } from "@/components/States";
import { Badge } from "@/components/Badge";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000/api/v1";

type ClaimRow = {
  id: string;
  job_id: string;
  customer_id: string;
  provider_id: string;
  status: string;
  reason: string;
  description: string;
  rework_note: string | null;
  refund_amount_pkr: number | null;
  decision_reason: string | null;
  filed_at: string;
};

type WarrantyConfig = {
  fee_rate: number;
  fee_flat_paisa: number;
  fee_min_paisa: number;
  fee_max_paisa: number;
  claim_window_days: number;
};

async function call(path: string, method = "GET", body?: unknown) {
  const token = typeof window === "undefined" ? null : localStorage.getItem("ns_admin_token");
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Request failed (${res.status})`);
  return data;
}

const STATUS_FILTERS = ["filed", "under_review", "rework_offered", "rework_done", "rework_failed", "refunded", "rejected", "closed"];

// Badge tones for the warranty claim states (Badge has no "info" tone).
const CLAIM_TONES: Record<string, "slate" | "green" | "amber" | "red" | "teal" | "blue"> = {
  filed: "amber",
  under_review: "blue",
  rework_offered: "blue",
  rework_done: "teal",
  rework_failed: "red",
  refunded: "green",
  rejected: "red",
  closed: "slate",
};

export default function WarrantyPage() {
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [config, setConfig] = useState<WarrantyConfig | null>(null);
  const [rules, setRules] = useState<{ version: number; title: string; body_md: string } | null>(null);
  const [status, setStatus] = useState("filed");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [form, setForm] = useState({ fee_rate: 0.05, fee_flat_pkr: 0, fee_min_pkr: 50, fee_max_pkr: 500, claim_window_days: 7 });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [claimRows, cfg, r] = await Promise.all([
        call(`/admin/warranty/claims?status=${status}&limit=50`),
        call("/admin/warranty/config"),
        call("/admin/warranty/rules"),
      ]);
      setClaims(Array.isArray(claimRows) ? claimRows : []);
      setConfig(cfg);
      setForm({
        fee_rate: cfg.fee_rate,
        fee_flat_pkr: cfg.fee_flat_paisa / 100,
        fee_min_pkr: cfg.fee_min_paisa / 100,
        fee_max_pkr: cfg.fee_max_paisa / 100,
        claim_window_days: cfg.claim_window_days,
      });
      setRules(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load warranty data");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(claimId: string, action: string, needsReason: boolean) {
    if (needsReason && !reason.trim()) {
      setError("A reason is required for this decision — it is recorded in the audit log.");
      return;
    }
    setBusyId(claimId);
    setError(null);
    setMsg(null);
    try {
      await call(`/admin/warranty/claims/${claimId}/${action}`, "POST", { reason: reason.trim() || undefined });
      setMsg(`Claim ${action} recorded.`);
      setReason("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  async function saveConfig() {
    setError(null);
    setMsg(null);
    try {
      await call("/admin/warranty/config", "PATCH", form);
      setMsg("Warranty fee config saved. New opt-ins use the new fee; existing warranties keep theirs.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function saveRules() {
    if (!rules) return;
    setError(null);
    setMsg(null);
    try {
      const updated = await call("/admin/warranty/rules", "PUT", { title: rules.title, body_md: rules.body_md });
      setRules(updated);
      setMsg(`Published rules v${updated.version}. The previous version stays in the database (versioned).`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    }
  }

  if (loading) return <AdminShell title="Warranty" subtitle="7-day workmanship guarantee on Tier 3 (Trusted Pro) jobs."><LoadingState /></AdminShell>;
  if (error && !claims.length && !config) return <AdminShell title="Warranty" subtitle="7-day workmanship guarantee on Tier 3 (Trusted Pro) jobs."><ErrorState message={error} onRetry={load} /></AdminShell>;

  return (
    <AdminShell title="Warranty" subtitle="Tier 3 (Trusted Pro) jobs only. Rework is offered first; a refund (full job price + warranty fee) is only possible after rework fails or is refused. Every decision records a reason and an audit log row.">
      {error && <div className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {msg && <div className="mb-3 rounded bg-green-50 px-3 py-2 text-sm text-green-700">{msg}</div>}

      <div className="mb-3 flex gap-2 flex-wrap">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`rounded-full px-3 py-1 text-xs ${status === s ? "bg-black text-white" : "bg-gray-100"}`}
          >
            {s}
          </button>
        ))}
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Decision reason (required for reject / refund)"
          className="flex-1 min-w-64 rounded border px-3 py-1 text-sm"
        />
      </div>

      <DataTable
        columns={["Claim", "Status", "Reason", "Description", "Refund (PKR)", "Filed", ""]}
        emptyText="No claims in this state."
        rows={claims.map((r) => [
          <div key="id" className="font-mono text-xs">{r.id.slice(0, 8)}…</div>,
          <Badge key="s" tone={CLAIM_TONES[r.status] ?? "slate"}>{r.status}</Badge>,
          <div key="r">{r.reason}</div>,
          <div key="d" className="max-w-xs truncate">{r.description}</div>,
          <div key="rf">{r.refund_amount_pkr == null ? "—" : `PKR ${r.refund_amount_pkr}`}</div>,
          <div key="f" className="text-xs">{new Date(r.filed_at).toLocaleString()}</div>,
          <div key="a" className="flex gap-2">
            {r.status === "filed" && (
              <button disabled={busyId === r.id} onClick={() => act(r.id, "review", false)} className="text-xs underline">Review</button>
            )}
            {r.status === "under_review" && (
              <>
                <button disabled={busyId === r.id} onClick={() => act(r.id, "offer-rework", true)} className="text-xs underline">Offer rework</button>
                <button disabled={busyId === r.id} onClick={() => act(r.id, "reject", true)} className="text-xs underline">Reject</button>
              </>
            )}
            {r.status === "rework_failed" && (
              <button disabled={busyId === r.id} onClick={() => act(r.id, "approve-refund", true)} className="text-xs underline">Approve refund</button>
            )}
          </div>,
        ])}
      />

      <h2 className="mt-8 text-lg font-semibold">Fee config</h2>
      <p className="text-sm text-gray-500 mb-2">
        Fee = clamp(flat + job price × rate, min, max). Current: {config ? `${(config.fee_rate * 100).toFixed(0)}% · min PKR ${config.fee_min_paisa / 100} · max PKR ${config.fee_max_paisa / 100} · ${config.claim_window_days}-day window` : "—"}
      </p>
      <div className="flex gap-3 flex-wrap items-end">
        {([
          ["fee_rate", "Rate (0–0.5)"],
          ["fee_flat_pkr", "Flat fee (PKR)"],
          ["fee_min_pkr", "Min fee (PKR)"],
          ["fee_max_pkr", "Max fee (PKR)"],
          ["claim_window_days", "Claim window (days)"],
        ] as const).map(([key, label]) => (
          <label key={key} className="text-xs">
            {label}
            <input
              type="number"
              step="any"
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })}
              className="mt-1 block rounded border px-2 py-1 text-sm"
            />
          </label>
        ))}
        <button onClick={saveConfig} className="rounded bg-black px-4 py-2 text-sm text-white">Save config</button>
        <button
          onClick={async () => {
            try {
              const out = await call("/admin/warranty/expire-due", "POST");
              setMsg(`Expiry sweep done — ${out.expired?.length ?? 0} warranties expired.`);
            } catch (e) {
              setError(e instanceof Error ? e.message : "Sweep failed");
            }
          }}
          className="rounded border px-4 py-2 text-sm"
        >
          Run expiry sweep
        </button>
      </div>

      <h2 className="mt-8 text-lg font-semibold">Published rules {rules ? `(v${rules.version})` : ""}</h2>
      {rules && (
        <div className="mt-2 flex flex-col gap-2">
          <input value={rules.title} onChange={(e) => setRules({ ...rules, title: e.target.value })} className="rounded border px-3 py-2 text-sm" />
          <textarea
            value={rules.body_md}
            onChange={(e) => setRules({ ...rules, body_md: e.target.value })}
            rows={12}
            className="rounded border px-3 py-2 font-mono text-sm"
          />
          <button onClick={saveRules} className="self-start rounded bg-black px-4 py-2 text-sm text-white">Publish new version</button>
        </div>
      )}
    </AdminShell>
  );
}
