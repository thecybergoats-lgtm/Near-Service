"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import Modal from "@/components/Modal";
import { DemoBanner, ErrorState, LoadingState } from "@/components/States";
import { Badge } from "@/components/Badge";
import { ApiError, createCategory, getCategories, getCategoryFormSchema, saveCategoryFormSchema, updateCategory, validateFormSchema } from "@/lib/api";
import type { CategoryNode } from "@/lib/types";

interface FormState {
  name_en: string;
  name_ur: string;
  name_roman: string;
  slug: string;
  icon_key: string;
  level: 1 | 2 | 3;
  parent_id: string;
  is_active: boolean;
  keywords: string; // comma-separated, locale prefix optional e.g. "roman:jild saazi"
}

const EMPTY_FORM: FormState = {
  name_en: "",
  name_ur: "",
  name_roman: "",
  slug: "",
  icon_key: "",
  level: 1,
  parent_id: "",
  is_active: true,
  keywords: "",
};

function slugify(s: string) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function parseKeywords(raw: string) {
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => {
      const [maybeLocale, ...rest] = k.split(":");
      if (rest.length > 0 && ["en", "ur", "roman"].includes(maybeLocale)) {
        return { keyword: rest.join(":").trim(), locale: maybeLocale, kind: "synonym" };
      }
      return { keyword: k, locale: "en", kind: "synonym" };
    });
}

export default function CategoriesPage() {
  const [cats, setCats] = useState<CategoryNode[]>([]);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CategoryNode | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Form-schema editor (Phase 2): per-category dynamic request form.
  const [schemaCat, setSchemaCat] = useState<CategoryNode | null>(null);
  const [schemaText, setSchemaText] = useState("");
  const [schemaDemo, setSchemaDemo] = useState(false);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaMsg, setSchemaMsg] = useState<string | null>(null);
  const [schemaSaving, setSchemaSaving] = useState(false);

  async function openSchemaEditor(c: CategoryNode) {
    setSchemaCat(c);
    setSchemaText("");
    setSchemaMsg(null);
    setSchemaDemo(false);
    setSchemaLoading(true);
    try {
      const res = await getCategoryFormSchema(c.id);
      setSchemaText(JSON.stringify(res.data.form_schema ?? { type: "object", properties: {} }, null, 2));
      setSchemaDemo(res.demo);
    } catch (e) {
      setSchemaMsg(e instanceof ApiError ? `Could not load schema: ${e.message}` : "Could not load schema.");
      setSchemaText(JSON.stringify({ type: "object", properties: {} }, null, 2));
    } finally {
      setSchemaLoading(false);
    }
  }

  function checkSchema(): string | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(schemaText);
    } catch {
      setSchemaMsg("Invalid JSON — fix the syntax before saving.");
      return "Invalid JSON.";
    }
    const err = validateFormSchema(parsed);
    setSchemaMsg(err ? `Schema invalid: ${err}` : "Schema valid: object with type \"object\" and a properties map.");
    return err;
  }

  async function saveSchema() {
    if (!schemaCat) return;
    if (checkSchema()) return;
    const parsed = JSON.parse(schemaText) as Record<string, unknown>;
    setSchemaSaving(true);
    setSchemaMsg(null);
    try {
      if (schemaDemo || demo) throw new Error("Demo data — connect the backend to save a live form schema.");
      await saveCategoryFormSchema(schemaCat.id, parsed);
      setSchemaMsg("Form schema saved. The mobile request form for this category now uses it.");
    } catch (e) {
      setSchemaMsg(e instanceof ApiError ? `Save failed: ${e.message}` : e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSchemaSaving(false);
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getCategories();
      setCats(res.data);
      setDemo(res.demo);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load categories.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openAdd() {
    setForm(EMPTY_FORM);
    setEditing(null);
    setAdding(true);
    setMsg(null);
  }

  function openEdit(c: CategoryNode) {
    setForm({
      name_en: c.name_en,
      name_ur: c.name_ur || "",
      name_roman: c.name_roman || "",
      slug: c.slug,
      icon_key: c.icon_key || "",
      level: c.level,
      parent_id: c.parent_id || "",
      is_active: c.is_active,
      keywords: (c.keywords || []).map((k) => `${k.locale}:${k.keyword}`).join(", "),
    });
    setEditing(c);
    setAdding(true);
    setMsg(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    const payload = {
      name_en: form.name_en.trim(),
      name_ur: form.name_ur.trim() || null,
      name_roman: form.name_roman.trim() || null,
      slug: form.slug.trim() || slugify(form.name_en),
      icon_key: form.icon_key.trim() || null,
      level: form.level,
      parent_id: form.level > 1 && form.parent_id ? form.parent_id : null,
      is_active: form.is_active,
      keywords: parseKeywords(form.keywords),
    };
    try {
      if (editing) {
        await updateCategory(editing.id, payload);
        setMsg("Category updated.");
      } else {
        await createCategory(payload);
        setMsg("Category created.");
      }
      setAdding(false);
      await load();
    } catch (err) {
      setMsg(err instanceof ApiError ? `Save failed: ${err.message}` : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminShell title="Catalog / Categories" subtitle="3-level taxonomy (Category › Service › Task) with synonyms, misspellings and Roman Urdu / Urdu-script aliases — editable without an app release (PRD §5).">
      {demo && <DemoBanner />}
      {msg && <div className="bg-teal-50 border border-teal-200 text-teal-900 text-sm rounded-xl px-4 py-3 mb-4">{msg}</div>}
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-slate-500">
          Launch categories (Phase 1): Book Binding, AC Repair, Electrician, Plumber, Mobile Repair.
          <span className="block mt-0.5">category_id is the UUID shown per category — never send the slug as category_id; the slug is a separate resolver field.</span>
        </p>
        <button onClick={openAdd} className="bg-brand-700 text-white text-sm font-semibold rounded-lg px-4 py-2 hover:bg-brand-800">
          + Add category
        </button>
      </div>
      {loading ? (
        <LoadingState text="Loading categories…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : cats.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-slate-500">
          No categories yet — add the 5 launch categories to get started.
        </div>
      ) : (
        <div className="space-y-3">
          {cats.map((c) => (
            <div key={c.id} className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-900 text-lg">{c.name_en}</span>
                    {c.is_active ? <Badge tone="green">Active</Badge> : <Badge tone="slate">Inactive</Badge>}
                    <Badge tone="teal">Level {c.level}</Badge>
                  </div>
                  <div className="text-sm text-slate-500 mt-1">
                    {c.name_roman && <>Roman: {c.name_roman} · </>}
                    {c.name_ur && <>Urdu: {c.name_ur} · </>}
                    slug: <code>{c.slug}</code>
                    {c.icon_key && <> · icon: <code>{c.icon_key}</code></>}
                    <div className="mt-0.5">ID (UUID): <code className="break-all">{c.id}</code></div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {(c.keywords || []).map((k, i) => (
                      <span key={i} className="text-xs bg-slate-100 text-slate-700 rounded-full px-2 py-0.5">
                        {k.locale}: {k.keyword} ({k.kind})
                      </span>
                    ))}
                    {(c.keywords || []).length === 0 && (
                      <span className="text-xs text-slate-400">No keywords / aliases yet.</span>
                    )}
                  </div>
                  {c.children && c.children.length > 0 && (
                    <div className="mt-2 text-sm text-slate-600">
                      Sub-nodes: {c.children.map((ch) => ch.name_en).join(", ")}
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-2 shrink-0">
                  <button onClick={() => openEdit(c)} className="text-sm font-medium text-brand-700 hover:underline whitespace-nowrap">
                    Edit
                  </button>
                  <button onClick={() => openSchemaEditor(c)} className="text-sm font-medium text-brand-700 hover:underline whitespace-nowrap">
                    Form schema
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <Modal title={editing ? `Edit — ${editing.name_en}` : "Add category"} onClose={() => setAdding(false)}>
          <form onSubmit={save} className="space-y-4">
            {editing && (
              <p className="text-sm text-slate-600">
                ID (UUID): <code className="break-all">{editing.id}</code>
                <span className="block text-xs text-slate-400 mt-0.5">This UUID is the category_id used everywhere in the API. The slug below is only a resolver and is never sent as category_id.</span>
              </p>
            )}
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Name (English) *</span>
              <input required value={form.name_en} onChange={(e) => setForm({ ...form, name_en: e.target.value, slug: form.slug || slugify(e.target.value) })} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Name (Roman Urdu)</span>
                <input value={form.name_roman} onChange={(e) => setForm({ ...form, name_roman: e.target.value })} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Name (Urdu script)</span>
                <input value={form.name_ur} onChange={(e) => setForm({ ...form, name_ur: e.target.value })} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" dir="rtl" />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Level *</span>
                <select
                  value={form.level}
                  onChange={(e) => setForm({ ...form, level: Number(e.target.value) as 1 | 2 | 3, parent_id: Number(e.target.value) === 1 ? "" : form.parent_id })}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 bg-white"
                >
                  <option value={1}>1 — Category</option>
                  <option value={2}>2 — Service</option>
                  <option value={3}>3 — Task</option>
                </select>
              </label>
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Parent {form.level > 1 ? "*" : "(level 1 only)"}</span>
                <select
                  value={form.parent_id}
                  disabled={form.level === 1}
                  onChange={(e) => setForm({ ...form, parent_id: e.target.value })}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 bg-white disabled:bg-slate-100"
                >
                  <option value="">— none —</option>
                  {cats
                    .filter((p) => p.level < form.level && (!editing || p.id !== editing.id))
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name_en} (Level {p.level})
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Slug</span>
                <input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Icon key</span>
                <input value={form.icon_key} onChange={(e) => setForm({ ...form, icon_key: e.target.value })} placeholder="e.g. book" className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" />
              </label>
            </div>
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Keywords / aliases (comma-separated; prefix with locale, e.g. <code>roman:jild saazi, en:book banding</code>)</span>
              <textarea value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} rows={2} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" />
            </label>
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
              Active (visible in search)
            </label>
            {msg && <p className="text-sm text-red-700">{msg}</p>}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setAdding(false)} className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium">Cancel</button>
              <button type="submit" disabled={saving} className="px-4 py-2 bg-brand-700 text-white rounded-lg text-sm font-semibold hover:bg-brand-800 disabled:opacity-50">
                {saving ? "Saving…" : editing ? "Save changes" : "Create category"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {schemaCat && (
        <Modal title={`Form schema — ${schemaCat.name_en}`} onClose={() => setSchemaCat(null)}>
          <div className="bg-amber-50 border border-amber-300 rounded-lg px-4 py-3 text-sm text-amber-900 mb-4">
            <strong>Warning:</strong> saving this schema affects the live mobile request form for{" "}
            <strong>{schemaCat.name_en}</strong> immediately — customers will see the new fields on their
            next request. Test the JSON with “Validate schema” before saving.
          </div>
          <p className="text-sm text-slate-600 mb-3">
            Category ID (UUID): <code className="break-all">{schemaCat.id}</code>
            {schemaDemo && <span className="block text-amber-700 font-semibold mt-1">DEMO DATA — showing a sample schema; the API is unreachable.</span>}
          </p>
          {schemaLoading ? (
            <p className="text-sm text-slate-500">Loading schema…</p>
          ) : (
            <>
              <label className="block">
                <span className="text-sm font-medium text-slate-700">JSON schema (must be an object with type &quot;object&quot; and a &quot;properties&quot; object)</span>
                <textarea
                  value={schemaText}
                  onChange={(e) => setSchemaText(e.target.value)}
                  rows={14}
                  spellCheck={false}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 font-mono text-xs"
                />
              </label>
              {schemaMsg && <p className="text-sm text-slate-700 mt-3">{schemaMsg}</p>}
              <div className="flex gap-2 justify-end mt-4">
                <button onClick={() => setSchemaCat(null)} className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium">
                  Close
                </button>
                <button onClick={checkSchema} className="px-4 py-2 border border-brand-700 text-brand-700 rounded-lg text-sm font-semibold hover:bg-brand-50">
                  Validate schema
                </button>
                <button
                  onClick={saveSchema}
                  disabled={schemaSaving}
                  className="px-4 py-2 bg-brand-700 text-white rounded-lg text-sm font-semibold hover:bg-brand-800 disabled:opacity-50"
                >
                  {schemaSaving ? "Saving…" : "Save schema"}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </AdminShell>
  );
}
