"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import AdminShell from "@/components/AdminShell";
import DataTable from "@/components/DataTable";
import { DemoBanner, ErrorState, LoadingState } from "@/components/States";
import { Badge, StatusBadge } from "@/components/Badge";
import Modal from "@/components/Modal";
import {
  ApiError,
  assignDispute,
  getDisputes,
  getStoredUser,
  resolveDispute,
} from "@/lib/api";
import type { DisputeRow } from "@/lib/types";

function pkr(n: number) {
  return "PKR " + n.toLocaleString("en-PK");
}

type ResolveOutcome = "refund" | "partial_refund" | "compensation" | "no_action";

const OUTCOME_OPTIONS: { value: ResolveOutcome; label: string }[] = [
  { value: "refund", label: "Full refund" },
  { value: "partial_refund", label: "Partial refund" },
  { value: "compensation", label: "Compensation credit" },
  { value: "no_action", label: "No action" },
];

/** Breached if the server says so, or a deadline has passed while still unresolved. */
function isBreached(d: DisputeRow): boolean {
  if (d.breached) return true;
  if (d.status === "resolved") return false;
  const now = Date.now();
  const firstDue = d.sla_first_response_at || d.sla_first_response_due;
  const resolveDue = d.sla_resolve_at || d.sla_resolution_due;
  return (
    (firstDue ? new Date(firstDue).getTime() < now : false) ||
    (resolveDue ? new Date(resolveDue).getTime() < now : false)
  );
}

function slaLabel(d: DisputeRow): { text: string; overdue: boolean } {
  const now = Date.now();
  if (d.status === "resolved") return { text: "Resolved", overdue: false };
  const firstDue = d.sla_first_response_at || d.sla_first_response_due;
  const resolveDue = d.sla_resolve_at || d.sla_resolution_due;
  if (firstDue && new Date(firstDue).getTime() < now) {
    return { text: `First response overdue since ${new Date(firstDue).toLocaleString()}`, overdue: true };
  }
  if (resolveDue && new Date(resolveDue).getTime() < now) {
    return { text: `Resolution overdue since ${new Date(resolveDue).toLocaleString()}`, overdue: true };
  }
  return { text: `Resolve by ${new Date(resolveDue).toLocaleString()}`, overdue: false };
}

/** Plain-words summary of what a resolution will do — shown in the confirm step. */
function resolutionSummary(
  outcome: ResolveOutcome,
  amount: number,
  jobAmount: number
): string {
  switch (outcome) {
    case "refund":
      return `Full refund: ${pkr(jobAmount)} back to the customer's wallet, job → REFUNDED. The provider keeps nothing from this job and the commission is reversed.`;
    case "partial_refund":
      return `Partial refund: ${pkr(amount)} back to the customer's wallet. The rest of the job amount stays settled as agreed.`;
    case "compensation":
      return `Compensation credit: ${pkr(amount)} added to the customer's wallet as credit for a future job. The job itself stays as settled.`;
    case "no_action":
      return "No action: the dispute is closed with no money moved. Both sides keep the job as it stands.";
    default:
      return "No action: the dispute is closed with no money moved.";
  }
}

export default function DisputesPage() {
  const [rows, setRows] = useState<DisputeRow[]>([]);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("all");
  const [selected, setSelected] = useState<DisputeRow | null>(null);

  // Assign
  const [assignTo, setAssignTo] = useState("");
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignMsg, setAssignMsg] = useState<string | null>(null);

  // Resolve
  const [outcome, setOutcome] = useState<ResolveOutcome>("refund");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [resolveBusy, setResolveBusy] = useState(false);
  const [resolveMsg, setResolveMsg] = useState<string | null>(null);
  const [resolveErr, setResolveErr] = useState<string | null>(null);

  const role = getStoredUser()?.role;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getDisputes();
      setRows(res.data);
      setDemo(res.demo);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load disputes.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Keep the drawer in sync after a reload (assign/resolve refresh the list).
  useEffect(() => {
    if (!selected) return;
    const fresh = rows.find((r) => r.id === selected.id);
    if (fresh && fresh !== selected) setSelected(fresh);
  }, [rows, selected]);

  const statuses = useMemo(
    () => ["all", ...Array.from(new Set(rows.map((d) => d.status)))],
    [rows]
  );
  const filtered = status === "all" ? rows : rows.filter((d) => d.status === status);
  const openCount = rows.filter((d) => d.status === "open").length;
  const breachedCount = rows.filter((d) => isBreached(d)).length;

  function openDrawer(d: DisputeRow) {
    setSelected(d);
    setAssignTo(d.assigned_to || "");
    setAssignMsg(null);
    setOutcome("refund");
    setAmount(String(d.amount_pkr));
    setNote("");
    setConfirming(false);
    setResolveMsg(null);
    setResolveErr(null);
  }

  async function doAssign() {
    if (!selected || !assignTo.trim()) return;
    setAssignBusy(true);
    setAssignMsg(null);
    try {
      if (demo) throw new Error("Demo data — connect the backend to assign disputes.");
      const updated = await assignDispute(selected.id, assignTo.trim());
      setAssignMsg(`Assigned to ${updated.assigned_to || assignTo.trim()}.`);
      await load();
    } catch (e) {
      setAssignMsg(e instanceof ApiError ? `Assign failed: ${e.message}` : e instanceof Error ? e.message : "Assign failed.");
    } finally {
      setAssignBusy(false);
    }
  }

  async function doResolve() {
    if (!selected) return;
    const amt = outcome === "partial_refund" || outcome === "compensation" ? Number(amount) : 0;
    if ((outcome === "partial_refund" || outcome === "compensation") && (!Number.isFinite(amt) || amt <= 0)) {
      setResolveErr("Enter an amount greater than 0 for this outcome.");
      return;
    }
    if (outcome === "partial_refund" && amt > selected.amount_pkr) {
      setResolveErr(`Partial refund cannot exceed the disputed amount (${pkr(selected.amount_pkr)}).`);
      return;
    }
    setResolveBusy(true);
    setResolveErr(null);
    try {
      if (demo) throw new Error("Demo data — connect the backend to resolve disputes.");
      await resolveDispute(selected.id, {
        outcome,
        ...(outcome === "partial_refund" || outcome === "compensation"
          ? { amount_pkr: amt }
          : {}),
        note: note.trim() || undefined,
      });
      setResolveMsg(
        `Dispute resolved — ${outcome.replace(/_/g, " ")}${amt > 0 ? ` (${pkr(amt)})` : ""}. Recorded in the audit log.`
      );
      setConfirming(false);
      await load();
    } catch (e) {
      setResolveErr(e instanceof ApiError ? `Resolve failed: ${e.message}` : e instanceof Error ? e.message : "Resolve failed.");
    } finally {
      setResolveBusy(false);
    }
  }

  const evidence = selected?.evidence ?? [];
  const chatCount = evidence.filter((e) => e.kind === "chat").length;
  const gpsCount = evidence.filter((e) => e.kind === "gps").length;
  const sla = selected ? slaLabel(selected) : null;
  const confirmAmount =
    outcome === "partial_refund" || outcome === "compensation" ? Number(amount) || 0 : 0;

  return (
    <AdminShell
      title="Dispute center"
      subtitle="SLA timers escalate automatically; outcomes are ledger-backed (PRD §8). Resolutions are audited — see the Audit Log."
    >
      {demo && <DemoBanner />}
      <div className="flex flex-wrap gap-3 mb-4 items-center">
        <Badge tone="red">{openCount} open</Badge>
        {breachedCount > 0 && <Badge tone="red">{breachedCount} SLA breached</Badge>}
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white"
        >
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All statuses" : s.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <span className="text-sm text-slate-500 ml-auto">
          {filtered.length} of {rows.length} shown
        </span>
      </div>
      {loading ? (
        <LoadingState text="Loading disputes…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <DataTable
          columns={["Dispute", "Opened by", "Reason", "Amount", "Evidence", "SLA", "Status", ""]}
          emptyText="No disputes match this filter."
          rows={filtered.map((d) => {
            const breached = isBreached(d);
            const s = slaLabel(d);
            return [
              <span key="id" className="font-mono text-xs">{d.id}</span>,
              <div key="ob">
                <div className="font-semibold">{d.opened_by}</div>
                <div className="text-xs text-slate-500">
                  {d.opened_by_role} · job {d.job_id}
                </div>
              </div>,
              <span key="r" className="max-w-xs block">
                {d.reason}
                {d.reason_code && <span className="block text-xs text-slate-400">{d.reason_code}</span>}
              </span>,
              <span key="a" className="whitespace-nowrap font-semibold">{pkr(d.amount_pkr)}</span>,
              <span key="e">
                {d.evidence?.length ?? d.evidence_count} item{(d.evidence?.length ?? d.evidence_count) === 1 ? "" : "s"}
              </span>,
              <span key="s1" className="text-xs whitespace-nowrap">
                {breached && <Badge tone="red">SLA breached</Badge>}
                <span className={`block mt-1 ${s.overdue ? "text-red-700 font-semibold" : "text-slate-600"}`}>
                  {s.text}
                </span>
              </span>,
              <StatusBadge key="st" status={d.status} />,
              <button key="v" onClick={() => openDrawer(d)} className="text-sm font-medium text-brand-700 hover:underline">
                View
              </button>,
            ];
          })}
        />
      )}

      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setSelected(null)}>
          <div
            className="bg-white w-full max-w-lg h-full overflow-y-auto shadow-xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Dispute {selected.id}</h2>
                <p className="text-sm text-slate-500">
                  Job{" "}
                  <Link href="/jobs" className="text-brand-700 hover:underline font-medium">
                    {selected.job_id}
                  </Link>{" "}
                  · opened {new Date(selected.created_at).toLocaleString()}
                </p>
              </div>
              <button onClick={() => setSelected(null)} className="text-slate-400 hover:text-slate-700 text-xl leading-none" aria-label="Close">
                ×
              </button>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <StatusBadge status={selected.status} />
              {isBreached(selected) && <Badge tone="red">SLA breached</Badge>}
              {selected.outcome && <Badge tone="teal">Outcome: {selected.outcome.replace(/_/g, " ")}</Badge>}
              {selected.assigned_to && <Badge tone="blue">Assigned: {selected.assigned_to}</Badge>}
            </div>

            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-slate-500">Opened by</dt><dd className="font-semibold">{selected.opened_by} ({selected.opened_by_role})</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Reason</dt><dd>{selected.reason}{selected.reason_code ? ` (${selected.reason_code})` : ""}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Amount</dt><dd className="font-semibold">{pkr(selected.amount_pkr)}</dd></div>
              <div className="flex justify-between">
                <dt className="text-slate-500">SLA first response</dt>
                <dd className={sla?.overdue ? "text-red-700 font-semibold" : ""}>
                  {new Date(selected.sla_first_response_at || selected.sla_first_response_due).toLocaleString()}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">SLA resolution</dt>
                <dd className={sla?.overdue ? "text-red-700 font-semibold" : ""}>
                  {new Date(selected.sla_resolve_at || selected.sla_resolution_due).toLocaleString()}
                </dd>
              </div>
              {selected.resolution?.resolved_at && (
                <div className="flex justify-between"><dt className="text-slate-500">Resolved</dt><dd>{new Date(selected.resolution.resolved_at).toLocaleString()}{selected.resolution.resolved_by ? ` by ${selected.resolution.resolved_by}` : ""}</dd></div>
              )}
            </dl>

            <h3 className="font-bold text-slate-900 mt-6 mb-2">Description</h3>
            <p className="text-sm text-slate-700 bg-slate-50 rounded-lg p-3">{selected.description}</p>

            <h3 className="font-bold text-slate-900 mt-6 mb-2">
              Evidence ({evidence.length || selected.evidence_count})
            </h3>
            {evidence.length === 0 ? (
              <p className="text-sm text-slate-500">
                {selected.evidence_count} evidence item{selected.evidence_count === 1 ? "" : "s"} recorded on this
                dispute, but no item details were returned by the API.
              </p>
            ) : (
              <ul className="space-y-2">
                {evidence.map((ev) => (
                  <li key={ev.id} className="text-sm bg-slate-50 rounded-lg p-3">
                    <div className="flex items-center gap-2">
                      <Badge tone={ev.kind === "photo" ? "blue" : ev.kind === "chat" ? "teal" : ev.kind === "gps" ? "amber" : "slate"}>
                        {ev.kind}
                      </Badge>
                      <code className="text-xs text-slate-500 break-all">{ev.storage_key}</code>
                    </div>
                    {ev.note && <p className="text-slate-700 mt-1.5">{ev.note}</p>}
                    <p className="text-xs text-slate-400 mt-1">{new Date(ev.created_at).toLocaleString()}</p>
                  </li>
                ))}
              </ul>
            )}

            <h3 className="font-bold text-slate-900 mt-6 mb-2">Chat &amp; GPS trail</h3>
            <p className="text-sm text-slate-600 bg-slate-50 rounded-lg p-3">
              {chatCount > 0 || gpsCount > 0
                ? `${chatCount} chat transcript${chatCount === 1 ? "" : "s"} and ${gpsCount} GPS trail${gpsCount === 1 ? "" : "s"} attached as evidence above — use them to check what was said and where the provider actually was.`
                : "No chat or GPS evidence attached to this dispute yet. The job timeline on the Jobs page shows the recorded state transitions."}
            </p>

            {selected.status !== "resolved" && (
              <>
                <h3 className="font-bold text-slate-900 mt-6 mb-2">Assign to officer</h3>
                <div className="flex gap-2">
                  <input
                    value={assignTo}
                    onChange={(e) => setAssignTo(e.target.value)}
                    placeholder="Officer name or user id"
                    className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm"
                  />
                  <button
                    onClick={doAssign}
                    disabled={assignBusy || !assignTo.trim()}
                    className="px-4 py-2 bg-brand-700 text-white rounded-lg text-sm font-semibold hover:bg-brand-800 disabled:opacity-50"
                  >
                    {assignBusy ? "Assigning…" : "Assign"}
                  </button>
                </div>
                {assignMsg && <p className="text-sm text-slate-700 mt-2">{assignMsg}</p>}

                <h3 className="font-bold text-slate-900 mt-6 mb-2">Resolve dispute</h3>
                <p className="text-xs text-slate-500 mb-3">
                  Your role: {role || "unknown"}. Every resolution is written to the audit log with your identity.
                </p>
                {resolveMsg && (
                  <div className="bg-teal-50 border border-teal-200 text-teal-900 text-sm rounded-lg px-3 py-2 mb-3">
                    {resolveMsg}
                  </div>
                )}
                {resolveErr && (
                  <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg px-3 py-2 mb-3">
                    {resolveErr}
                  </div>
                )}
                <label className="block text-sm font-medium text-slate-700">
                  Outcome
                  <select
                    value={outcome}
                    onChange={(e) => setOutcome(e.target.value as ResolveOutcome)}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 bg-white"
                  >
                    {OUTCOME_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </label>
                {(outcome === "partial_refund" || outcome === "compensation") && (
                  <label className="block text-sm font-medium text-slate-700 mt-3">
                    Amount (PKR) — max {pkr(selected.amount_pkr)} for a partial refund
                    <input
                      type="number"
                      min={1}
                      max={outcome === "partial_refund" ? selected.amount_pkr : undefined}
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2"
                    />
                  </label>
                )}
                <label className="block text-sm font-medium text-slate-700 mt-3">
                  Note (recorded in the audit log)
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={3}
                    placeholder="Why this outcome? e.g. provider confirmed the AC was not tested."
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2"
                  />
                </label>
                <button
                  onClick={() => setConfirming(true)}
                  className="mt-4 w-full px-4 py-2 bg-brand-700 text-white rounded-lg text-sm font-semibold hover:bg-brand-800"
                >
                  Review resolution
                </button>
              </>
            )}

            <div className="mt-6 pt-4 border-t border-slate-200">
              <Link href="/audit-logs" className="text-sm font-medium text-brand-700 hover:underline">
                View audit log →
              </Link>
              <p className="text-xs text-slate-400 mt-1">
                Assign and resolve actions on this dispute appear in the audit log.
              </p>
            </div>
          </div>
        </div>
      )}

      {selected && confirming && (
        <Modal title="Confirm resolution" onClose={() => setConfirming(false)}>
          <p className="text-sm text-slate-700">
            Dispute <code>{selected.id}</code> · Job {selected.job_id}
          </p>
          <div className="bg-amber-50 border border-amber-300 rounded-lg px-4 py-3 text-sm text-amber-900 mt-4">
            {resolutionSummary(outcome, confirmAmount, selected.amount_pkr)}
          </div>
          {note.trim() && (
            <p className="text-sm text-slate-600 mt-3">
              <strong>Note:</strong> {note.trim()}
            </p>
          )}
          <p className="text-xs text-slate-500 mt-3">
            This is final — the resolution is ledger-backed and written to the audit log.
          </p>
          <div className="flex gap-2 justify-end mt-5">
            <button onClick={() => setConfirming(false)} className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium">
              Back
            </button>
            <button
              onClick={doResolve}
              disabled={resolveBusy}
              className="px-4 py-2 bg-brand-700 text-white rounded-lg text-sm font-semibold hover:bg-brand-800 disabled:opacity-50"
            >
              {resolveBusy ? "Resolving…" : "Confirm resolution"}
            </button>
          </div>
        </Modal>
      )}
    </AdminShell>
  );
}
