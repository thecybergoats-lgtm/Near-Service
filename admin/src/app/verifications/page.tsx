"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import DataTable from "@/components/DataTable";
import Modal from "@/components/Modal";
import { DemoBanner, ErrorState, LoadingState } from "@/components/States";
import { Badge, StatusBadge } from "@/components/Badge";
import { ApiError, decideVerification, getProviderEvidence, getStoredUser, getVerifications } from "@/lib/api";
import type { ProviderEvidence, VerificationItem } from "@/lib/types";

const TIER_NAMES = ["Tier 0 — Unverified", "Tier 1 — ID Verified", "Tier 2 — Address Verified", "Tier 3 — Trusted Pro"];

export default function VerificationsPage() {
  const [items, setItems] = useState<VerificationItem[]>([]);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<VerificationItem | null>(null);
  const [evidence, setEvidence] = useState<ProviderEvidence | null>(null);
  const [evidenceDemo, setEvidenceDemo] = useState(false);
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const role = getStoredUser()?.role;
  // Verification queue is for super_admin + verification_officer; other roles see it read-only.
  const canDecide = role === "super_admin" || role === "verification_officer";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getVerifications();
      setItems(res.data);
      setDemo(res.demo);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load verification queue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openDecide(item: VerificationItem) {
    setSelected(item);
    setDecision("approved");
    setReason("");
    setActionMsg(null);
    // Phase 3: advisory assists (face-match / liveness / OCR) for this
    // provider — supporting evidence only, never a decision by itself.
    setEvidence(null);
    getProviderEvidence(item.provider_id)
      .then((res) => {
        setEvidence(res.data);
        setEvidenceDemo(res.demo);
      })
      .catch(() => setEvidence(null));
  }

  async function submitDecision(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    if (!reason.trim()) {
      setActionMsg("A reason is required for every decision (audit trail).");
      return;
    }
    setSaving(true);
    setActionMsg(null);
    try {
      // Contract: POST /admin/verifications/{documentId}/decide { decision: approved|rejected, note }
      await decideVerification(selected.id, decision, reason.trim());
      setActionMsg("Decision saved.");
      setSelected(null);
      await load();
    } catch (err) {
      setActionMsg(err instanceof ApiError ? err.message : "Decision failed.");
    } finally {
      setSaving(false);
    }
  }

  const pending = items.filter((i) => i.status === "pending");

  return (
    <AdminShell title="Verification queue" subtitle="Manual review in Phase 1 (PRD v1.1) — OCR / face-match / liveness move to Phase 2/3. CNIC + selfie checked by an officer; every decision needs a reason.">
      {demo && <DemoBanner />}
      {!canDecide && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-900 mb-5">
          Read-only for your role ({role || "unknown"}). Approve / reject is limited to Super Admin and
          Verification Officer. Server-side RBAC still applies.
        </div>
      )}
      {loading ? (
        <LoadingState text="Loading verification queue…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <>
          <div className="flex items-center gap-3 mb-4">
            <Badge tone="amber">{pending.length} pending</Badge>
            <Badge tone="slate">{items.length} total in queue</Badge>
          </div>
          <DataTable
            columns={["Provider", "Type / City", "Categories", "Tier", "Docs", "Submitted", "Status", ""]}
            emptyText="Verification queue is empty — no providers awaiting review."
            rows={items.map((it) => [
              <div key="n">
                <div className="font-semibold">{it.provider_name}</div>
                <div className="text-xs text-slate-500">{it.phone}</div>
              </div>,
              <div key="t">
                {it.provider_type}
                <div className="text-xs text-slate-500">{it.city}</div>
              </div>,
              <div key="c" className="text-xs">{it.categories.join(", ")}</div>,
              <div key="tier">
                <div className="text-xs">Now: {TIER_NAMES[it.current_tier]}</div>
                <div className="text-xs text-slate-500">Requested: {TIER_NAMES[it.tier_requested]}</div>
              </div>,
              <div key="d" className="text-xs space-y-0.5">
                {it.documents.map((d) => (
                  <div key={d.doc_type} className="flex items-center gap-1.5">
                    <StatusBadge status={d.review_status} />
                    <span>{d.doc_type.replace(/_/g, " ")}</span>
                  </div>
                ))}
              </div>,
              <div key="s" className="text-xs whitespace-nowrap">{new Date(it.submitted_at).toLocaleString()}</div>,
              <StatusBadge key="st" status={it.status} />,
              <button
                key="a"
                onClick={() => openDecide(it)}
                disabled={!canDecide || it.status !== "pending"}
                className="text-sm font-medium text-brand-700 hover:underline disabled:text-slate-300 disabled:no-underline"
              >
                Review
              </button>,
            ])}
          />
          <p className="text-xs text-slate-400 mt-3">
            Decisions are manual: open a case and compare the CNIC photo with the selfie and the
            shop photos yourself. Phase 3 automated assists (face-match / liveness / OCR) appear
            inside the case as advisory evidence only — they never approve or reject anything.
          </p>
          {selected && (
            <Modal title={`Review — ${selected.provider_name}`} onClose={() => setSelected(null)}>
              <form onSubmit={submitDecision} className="space-y-4">
                <div className="text-sm text-slate-600 space-y-1">
                  <p><strong>Phone:</strong> {selected.phone}</p>
                  <p><strong>Categories:</strong> {selected.categories.join(", ")}</p>
                  <p><strong>Tier requested:</strong> {TIER_NAMES[selected.tier_requested]} (current: {TIER_NAMES[selected.current_tier]})</p>
                  {selected.review_note && <p className="bg-amber-50 border border-amber-200 rounded px-2 py-1 text-amber-900">{selected.review_note}</p>}
                </div>
                {/* Phase 1 manual review: CNIC front / CNIC back / selfie side-by-side for a human decision. */}
                <div>
                  <p className="text-sm font-medium text-slate-700 mb-2">Documents — compare side-by-side</p>
                  <div className="grid grid-cols-3 gap-2">
                    {selected.documents.map((d) => (
                      <div key={d.doc_type} className="border border-slate-200 rounded-lg overflow-hidden">
                        <div className="bg-slate-50 px-2 py-1.5 text-xs font-medium text-slate-700 flex items-center justify-between gap-1">
                          <span>{d.doc_type.replace(/_/g, " ")}</span>
                          <StatusBadge status={d.review_status} />
                        </div>
                        {d.url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={d.url} alt={d.doc_type.replace(/_/g, " ")} className="w-full aspect-[4/3] object-cover" />
                        ) : (
                          <div className="aspect-[4/3] bg-slate-100 flex items-center justify-center text-center text-xs text-slate-400 px-2">
                            No image URL supplied — backend serves a signed URL here
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-slate-400 mt-1.5">
                    Compare the CNIC photo with the selfie yourself. Phase 3 automated assists below
                    are advisory evidence only — they never approve or reject anything.
                  </p>
                </div>
                {/* Phase 3 (v1.5): advisory verification evidence for this provider. */}
                {evidence && (
                  <div className="border border-slate-200 rounded-lg p-3 bg-slate-50">
                    <p className="text-sm font-medium text-slate-700 mb-2">
                      Automated assists — advisory only{evidenceDemo ? " (DEMO DATA)" : ""}
                    </p>
                    <div className="text-sm text-slate-600 space-y-1">
                      <p>
                        <strong>Face-match:</strong>{" "}
                        {evidence.face_match
                          ? `${evidence.face_match.verdict ?? "—"} (score ${evidence.face_match.face_match_score ?? "—"}, ${evidence.face_match.engine ?? "local-heuristic"})`
                          : "no result yet"}
                      </p>
                      <p>
                        <strong>Liveness:</strong>{" "}
                        {evidence.liveness ? evidence.liveness.status ?? "—" : "no challenge yet"}
                      </p>
                      <p>
                        <strong>OCR extractions:</strong> {evidence.ocr_extractions.length}
                      </p>
                      <p className="text-xs text-slate-400">{evidence.rule}</p>
                    </div>
                  </div>
                )}
                <label className="block">
                  <span className="text-sm font-medium text-slate-700">Decision</span>
                  <select
                    value={decision}
                    onChange={(e) => setDecision(e.target.value as "approved" | "rejected")}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2"
                  >
                    <option value="approved">Approve</option>
                    <option value="rejected">Reject</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-sm font-medium text-slate-700">Reason / note (required, written to audit log)</span>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={3}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2"
                    placeholder="e.g. CNIC photo matches selfie; shop photo shows premises in Satellite Town."
                    required
                  />
                </label>
                {actionMsg && <p className="text-sm text-red-700">{actionMsg}</p>}
                <div className="flex gap-2 justify-end">
                  <button type="button" onClick={() => setSelected(null)} className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium">Cancel</button>
                  <button type="submit" disabled={saving} className="px-4 py-2 bg-brand-700 text-white rounded-lg text-sm font-semibold hover:bg-brand-800 disabled:opacity-50">
                    {saving ? "Saving…" : "Save decision"}
                  </button>
                </div>
              </form>
            </Modal>
          )}
        </>
      )}
    </AdminShell>
  );
}
