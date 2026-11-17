export default function KpiCard({
  label,
  value,
  sub,
  tone = "teal",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "teal" | "amber" | "red" | "green";
}) {
  const bar =
    tone === "amber"
      ? "bg-amber-500"
      : tone === "red"
        ? "bg-red-500"
        : tone === "green"
          ? "bg-emerald-500"
          : "bg-brand-600";
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 overflow-hidden">
      <div className={`h-1 -mx-5 -mt-5 mb-4 ${bar}`} />
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-2xl font-bold text-slate-900 mt-1">{value}</div>
      {sub && <div className="text-sm text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}
