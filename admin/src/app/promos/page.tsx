"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import DataTable from "@/components/DataTable";
import Modal from "@/components/Modal";
import { DemoBanner, ErrorState, LoadingState } from "@/components/States";
import { Badge } from "@/components/Badge";
import { ApiError, createPromo, getCategories, getPromos, updatePromo } from "@/lib/api";
import type { CategoryNode, Promo } from "@/lib/types";

interface PromoForm {
  code: string;
  kind: "percent" | "fixed";
  value: string;
  max_uses: string;
  per_user_limit: string;
  valid_from: string;
  valid_to: string;
  category_id: string;
  city_id: string;
  first_job_only: boolean;
}

const EMPTY_FORM: PromoForm = {
  code: "",
  kind: "percent",
  value: "",
  max_uses: "",
  per_user_limit: "",
  valid_from: "",
  valid_to: "",
  category_id: "",
  city_id: "",
  first_job_only: false,
};

export default function PromosPage() {
  const [promos, setPromos] = useState<Promo[]>([]);
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<PromoForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, c] = await Promise.all([getPromos(), getCategories()]);
      setPromos(p.data);
      setCategories(c.data);
      setDemo(p.demo || c.demo);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load promos.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function categoryName(id?: string | null) {
    if (!id) return "All categories";
    return categories.find((c) => c.id === id)?.name_en || id;
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const value = Number(form.value);
    if (!Number.isFinite(value) || value <= 0) {
      setMsg("Value must be greater than 0.");
      return;
    }
    if (form.kind === "percent" && value > 100) {
      setMsg("A percent promo cannot exceed 100%.");
      return;
    }
    if (form.valid_from && form.valid_to && form.valid_to < form.valid_from) {
      setMsg("Valid-to date cannot be before valid-from.");
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      if (demo) throw new Error("Demo data — connect the backend to create promos.");
      await createPromo({
        code: form.code.trim().toUpperCase(),
        kind: form.kind,
        value,
        max_uses: form.max_uses ? Number(form.max_uses) : null,
        per_user_limit: form.per_user_limit ? Number(form.per_user_limit) : null,
        valid_from: form.valid_from || null,
        valid_to: form.valid_to || null,
        category_id: form.category_id || null,
        city_id: form.city_id.trim() || null,
        first_job_only: form.first_job_only,
      });
      setMsg(`Promo ${form.code.trim().toUpperCase()} created.`);
      setAdding(false);
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      setMsg(err instanceof ApiError ? `Create failed: ${err.message}` : err instanceof Error ? err.message : "Create failed.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(p: Promo) {
    setBusyId(p.id);
    setMsg(null);
    try {
      if (demo) throw new Error("Demo data — connect the backend to change promos.");
      const updated = await updatePromo(p.id, { is_active: !p.is_active });
      setMsg(`Promo ${updated.code} ${updated.is_active ? "activated" : "deactivated"}.`);
      await load();
    } catch (err) {
      setMsg(err instanceof ApiError ? `Update failed: ${err.message}` : err instanceof Error ? err.message : "Update failed.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AdminShell title="Promos" subtitle="Promo codes for customers — percent or flat PKR off, with usage limits, date windows and category / city scope (Phase 2).">
      {demo && <DemoBanner />}
      {msg && <div className="bg-teal-50 border border-teal-200 text-teal-900 text-sm rounded-xl px-4 py-3 mb-4">{msg}</div>}
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-slate-500">{promos.length} promo{promos.length === 1 ? "" : "s"} · {promos.filter((p) => p.is_active).length} active</p>
        <button onClick={() => { setForm(EMPTY_FORM); setMsg(null); setAdding(true); }} className="bg-brand-700 text-white text-sm font-semibold rounded-lg px-4 py-2 hover:bg-brand-800">
          + Create promo
        </button>
      </div>
      {loading ? (
        <LoadingState text="Loading promos…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <DataTable
          columns={["Code", "Kind", "Value", "Uses", "Limits", "Valid", "Scope", "Status", ""]}
          emptyText="No promos yet — create the first one."
          rows={promos.map((p) => [
            <span key="c" className="font-mono font-semibold">{p.code}</span>,
            <span key="k">{p.kind === "percent" ? "Percent" : "Fixed (PKR)"}</span>,
            <span key="v" className="font-semibold whitespace-nowrap">{p.kind === "percent" ? `${p.value}%` : `PKR ${p.value.toLocaleString("en-PK")}`}</span>,
            <span key="u">{p.uses_count ?? "—"}{p.max_uses != null ? ` / ${p.max_uses}` : " (unlimited)"}</span>,
            <span key="l" className="text-xs">{p.per_user_limit != null ? `max ${p.per_user_limit} per user` : "no per-user limit"}{p.first_job_only ? " · first job only" : ""}</span>,
            <span key="vd" className="text-xs whitespace-nowrap">{p.valid_from || "—"} → {p.valid_to || "—"}</span>,
            <span key="s" className="text-xs">{categoryName(p.category_id)}{p.city_id ? ` · ${p.city_id}` : ""}</span>,
            <span key="st">{p.is_active ? <Badge tone="green">Active</Badge> : <Badge tone="slate">Inactive</Badge>}</span>,
            <button
              key="t"
              onClick={() => toggleActive(p)}
              disabled={busyId === p.id}
              className="text-sm font-medium text-brand-700 hover:underline disabled:text-slate-300 whitespace-nowrap"
            >
              {busyId === p.id ? "…" : p.is_active ? "Deactivate" : "Activate"}
            </button>,
          ])}
        />
      )}

      {adding && (
        <Modal title="Create promo" onClose={() => setAdding(false)}>
          <form onSubmit={save} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Code *</span>
                <input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="WELCOME100" className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 font-mono" />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Kind *</span>
                <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as "percent" | "fixed" })} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 bg-white">
                  <option value="percent">Percent (%)</option>
                  <option value="fixed">Fixed (PKR)</option>
                </select>
              </label>
            </div>
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Value * {form.kind === "percent" ? "(1–100 %)" : "(PKR)"}</span>
              <input required type="number" min={1} max={form.kind === "percent" ? 100 : undefined} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Max uses (blank = unlimited)</span>
                <input type="number" min={1} value={form.max_uses} onChange={(e) => setForm({ ...form, max_uses: e.target.value })} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Per-user limit (blank = none)</span>
                <input type="number" min={1} value={form.per_user_limit} onChange={(e) => setForm({ ...form, per_user_limit: e.target.value })} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Valid from</span>
                <input type="date" value={form.valid_from} onChange={(e) => setForm({ ...form, valid_from: e.target.value })} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Valid to</span>
                <input type="date" value={form.valid_to} onChange={(e) => setForm({ ...form, valid_to: e.target.value })} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Category scope</span>
                <select value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 bg-white">
                  <option value="">All categories</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name_en}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-sm font-medium text-slate-700">City scope (blank = all)</span>
                <input value={form.city_id} onChange={(e) => setForm({ ...form, city_id: e.target.value })} placeholder="e.g. Quetta" className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <input type="checkbox" checked={form.first_job_only} onChange={(e) => setForm({ ...form, first_job_only: e.target.checked })} />
              First job only
            </label>
            {msg && <p className="text-sm text-red-700">{msg}</p>}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setAdding(false)} className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium">Cancel</button>
              <button type="submit" disabled={saving} className="px-4 py-2 bg-brand-700 text-white rounded-lg text-sm font-semibold hover:bg-brand-800 disabled:opacity-50">
                {saving ? "Creating…" : "Create promo"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </AdminShell>
  );
}
