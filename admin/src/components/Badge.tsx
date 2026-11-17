export function Badge({
  children,
  tone = "slate",
}: {
  children: React.ReactNode;
  tone?: "slate" | "green" | "amber" | "red" | "teal" | "blue";
}) {
  const map: Record<string, string> = {
    slate: "bg-slate-100 text-slate-700",
    green: "bg-emerald-100 text-emerald-800",
    amber: "bg-amber-100 text-amber-800",
    red: "bg-red-100 text-red-800",
    teal: "bg-teal-100 text-teal-800",
    blue: "bg-blue-100 text-blue-800",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${map[tone]}`}>
      {children}
    </span>
  );
}

/** Map a job/request/dispute status string to a badge tone. */
export function statusTone(status: string): "slate" | "green" | "amber" | "red" | "teal" | "blue" {
  const s = status.toUpperCase();
  if (["COMPLETED", "PAYMENT_SETTLED", "RATED", "ACCEPTED", "APPROVED", "ACTIVE"].includes(s)) return "green";
  if (["DISPUTED", "CANCELLED_BY_CUSTOMER", "CANCELLED_BY_PROVIDER", "REJECTED", "BANNED", "SUSPENDED", "REFUNDED"].includes(s)) return "red";
  if (["BROADCASTING", "OFFERS_RECEIVED", "IN_PROGRESS", "PENDING", "OPEN", "IN_REVIEW", "PRICE_ADJUSTMENT_PENDING"].includes(s)) return "amber";
  if (["PROVIDER_EN_ROUTE", "CUSTOMER_EN_ROUTE", "ITEM_PICKED_UP", "ARRIVED", "ESCALATED"].includes(s)) return "blue";
  return "slate";
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone(status)}>{status.replace(/_/g, " ")}</Badge>;
}
