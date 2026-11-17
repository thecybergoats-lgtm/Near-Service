"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import DataTable from "@/components/DataTable";
import Modal from "@/components/Modal";
import { DemoBanner, ErrorState, LoadingState } from "@/components/States";
import { Badge } from "@/components/Badge";
import { ApiError, createCommissionRule, getCategories, getCommissionRules, updateCommissionRule } from "@/lib/api";
import type { CategoryNode, CommissionRule } from "@/lib/types";

const MIN_RATE = 5;
const MAX_RATE = 15;

interface RuleForm {
  category_id: string;
  city_id: string;
  tier: string;
  rate: string;
  valid_from: string;
  valid_to: string;
  is_promo: boolean;
}

const EMPTY_FORM: RuleForm = {
  category_id: "",
  city_id: "",
  tier: "",
  rate: "10",
  valid_from: "",
  valid_to: "",
  is_promo: false,
};

export default function CommissionPage() {
  const [rules, setRules] = useState<CommissionRule[]>([]);
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<CommissionRule | null>(null);
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, c] = await Promise.all([getCommissionRules(), getCategories()]);
      setRules(r.data);
      setCategories(c.data);
      setDemo(r.demo || c.demo);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load commission rules.");
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

  function openAdd() {
    setForm(EMPTY_FORM);
    setEditing(null);
    setMsg(null);
    setAdding(true);
  }

  function openEdit(r: CommissionRule) {
    setForm({
      category_id: r.category_id || "",
      city_id: r.city_id || "",
      tier: r.tier != null ? String(r.tier) : "",
      rate: String(r.rate),
      valid_from: r.valid_from || "",
      valid_to: r.valid_to || "",
      is_promo: r.is_promo,
    });
    setEditing(r);
    setMsg(null);
    setAdding(true);
  }

  function rateError(rate: number): string | null {
    if (!Number.isFinite(rate)) return "Rate must be a number.";
    if (rate < MIN_RATE || rate > MAX_RATE) {
      return `Rate must be between ${MIN_RATE}% and ${MAX_RATE}% — the API rejects rates outside this band.`;
    }
    return null;
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const rate = Number(form.rate);
    const err = rateError(rate);
    if (err) {
      setMsg(err);
      return;
    }
    if (form.valid_from && form.valid_to && form.valid_to < form.valid_from) {
      setMsg("Valid-to date cannot be before valid-from.");
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      if (demo) throw new Error("Demo data — connect the backend to change commission rules.");
      if (editing) {
        await updateCommissionRule(editing.id, {
          rate,
          valid_to: form.valid_to || null,
          is_promo: form.is_promo,
        });
        setMsg(`Rule updated — rate now ${rate}%.`);
      } else {
        await createCommissionRule({
          category_id: form.category_id || null,
          city_id: form.city_id.trim() || null,
          tier: form.tier ? Number(form.tier) : null,
          rate,
          valid_from: form.valid_from || new Date().toISOString().slice(0, 10),
          valid_to: form.valid_to || null,
          is_promo: form.is_promo,
        });
        setMsg(`Commission rule created at ${rate}%.`);
      }
      setAdding(false);
      setEditing(null);
      await load();
    } catch (e2) {
      setMsg(e2 instanceof ApiError ? `Save failed: ${e2.message}` : e2 instanceof Error ? e2.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminShell title="Commission rules" subtitle="Take rate per category / city / tier (PRD §9). The commission band is 5–15% — rates outside it are rejected by the API.">
      {demo && <DemoBanner />}
      {msg && <div className="bg-teal-50 border border-teal-200 text-teal-900 text-sm rounded-xl px-4 py-3 mb-4">{msg}</div>}
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-slate-500">
          {rules.length} rule{rules.length === 1 ? "" : "s"} · default take rate 10% · band {MIN_RATE}–{MAX_RATE}%
        </p>
        <button onClick={openAdd} className="bg-brand-700 text-white text-sm font-semibold rounded-lg px-4 py-2 hover:bg-brand-800">
          + Add rule
        </button>
      </div>
      {loading ? (
        <LoadingState text="Loading commission rules…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <DataTable
          columns={["Category", "City", "Tier", "Rate", "Valid", "Promo", ""]}
          emptyText="No commission rules yet — add the default 10% rule."
          rows={rules.map((r) => [
            <span key="cat" className="font-semibold">{categoryName(r.category_id)}</span>,
            <span key="city">{r.city_id || "All cities"}</span>,
            <span key="t">{r.tier != null ? `Tier ${r.tier}` : "All tiers"}</span>,
            <span key="r" className="font-semibold whitespace-nowrap">{r.rate}%</span>,
            <span key="v" className="text-xs whitespace-nowrap">{r.valid_from || "—"} → {r.valid_to || "—"}</span>,
            <span key="p">{r.is_promo ? <Badge tone="amber">Promo</Badge> : "—"}</span>,
            <button key="e" onClick={() => openEdit(r)} className="text-sm font-medium text-brand-700 hover:underline">
              Edit
            </button>,
          ])}
        />
      )}

      {adding && (
        <Modal title={editing ? "Edit commission rule" : "Add commission rule"} onClose={() => setAdding(false)}>
          <form onSubmit={save} className="space-y-4">
            <div className="bg-amber-50 border border-amber-300 rounded-lg px-4 py-3 text-sm text-amber-900">
              Commission band is <strong>{MIN_RATE}%–{MAX_RATE}%</strong>. Rates outside this band are rejected
              by the API — the form blocks them before saving.
            </div>
            {!editing && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-sm font-medium text-slate-700">Category (blank = all)</span>
                    <select value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 bg-white">
                      <option value="">All categories</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>{c.name_en}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-sm font-medium text-slate-700">City (blank = all)</span>
                    <input value={form.city_id} onChange={(e) => setForm({ ...form, city_id: e.target.value })} placeholder="e.g. Quetta" className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" />
                  </label>
                </div>
                <label className="block">
                  <span className="text-sm font-medium text-slate-700">Tier (blank = all tiers)</span>
                  <select value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value })} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 bg-white">
                    <option value="">All tiers</option>
                    <option value="0">Tier 0</option>
                    <option value="1">Tier 1</option>
                    <option value="2">Tier 2</option>
                    <option value="3">Tier 3</option>
                  </select>
                </label>
              </>
            )}
            {editing && (
              <p className="text-sm text-slate-600">
                {categoryName(editing.category_id)} · {editing.city_id || "All cities"} ·{" "}
                {editing.tier != null ? `Tier ${editing.tier}` : "All tiers"}
                <span className="block text-xs text-slate-400 mt-0.5">Category, city and tier cannot be changed on an existing rule — create a new rule instead.</span>
              </p>
            )}
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Rate (%) * — {MIN_RATE}–{MAX_RATE}%</span>
              <input
                required
                type="number"
                min={MIN_RATE}
                max={MAX_RATE}
                step={0.5}
                value={form.rate}
                onChange={(e) => setForm({ ...form, rate: e.target.value })}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Valid from</span>
                <input type="date" value={form.valid_from} disabled={!!editing} onChange={(e) => setForm({ ...form, valid_from: e.target.value })} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 disabled:bg-slate-100" />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Valid to (blank = open-ended)</span>
                <input type="date" value={form.valid_to} onChange={(e) => setForm({ ...form, valid_to: e.target.value })} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <input type="checkbox" checked={form.is_promo} onChange={(e) => setForm({ ...form, is_promo: e.target.checked })} />
              Promo rate (temporary promotional commission)
            </label>
            {msg && <p className="text-sm text-red-700">{msg}</p>}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setAdding(false)} className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium">Cancel</button>
              <button type="submit" disabled={saving} className="px-4 py-2 bg-brand-700 text-white rounded-lg text-sm font-semibold hover:bg-brand-800 disabled:opacity-50">
                {saving ? "Saving…" : editing ? "Save changes" : "Create rule"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </AdminShell>
  );
}
