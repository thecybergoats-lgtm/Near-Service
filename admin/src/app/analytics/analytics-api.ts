// Phase 4 (item 2) — Analytics warehouse API helpers.
// NEW file: shared admin files (lib/api.ts, lib/types.ts, Sidebar.tsx)
// were NOT edited — these helpers live next to the analytics pages and
// import only the already-exported API_URL / getToken / ApiError.
// Demo fallback follows the repo pattern: labelled demo data when the API
// is unreachable; a real server error is surfaced, never masked.
import { API_URL, ApiError, getToken } from "@/lib/api";

export interface EtlRun {
  id: string;
  run_date: string;
  started_at: string;
  finished_at: string;
  status: "completed" | "failed";
  triggered_by: string;
  counts: Record<string, number>;
  reconciliation: Record<string, { operational: number; warehouse: number; match: boolean }>;
  error?: string | null;
}

export interface Funnel {
  requests: number;
  withOffers: number;
  accepted: number;
  completed: number;
  rated: number;
  offerRate: number;
  fillRate: number;
  completionRate: number;
  ratingRate: number;
  medianTimeToFirstOfferSeconds: number | null;
}

export interface RevenueRow {
  key: string;
  label: string;
  jobs: number;
  completedJobs: number;
  revenuePkr: number;
  commissionPkr: number;
}

export interface SupplyDemand {
  demandByHour: { city: string; hour: number; requests: number; withOffers: number }[];
  supplyByCity: { city: string; providersTotal: number; providersOnline: number }[];
}

export interface ApiResult<T> {
  data: T;
  demo: boolean;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code || "request_failed", err?.message || `Request failed (${res.status})`);
  }
  return body as T;
}

async function getWithDemo<T>(path: string, demo: T): Promise<ApiResult<T>> {
  try {
    return { data: await req<T>(path), demo: false };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    return { data: demo, demo: true };
  }
}

const DEMO_FUNNEL: Funnel = {
  requests: 120, withOffers: 96, accepted: 72, completed: 61, rated: 44,
  offerRate: 0.8, fillRate: 0.6, completionRate: 0.847, ratingRate: 0.721,
  medianTimeToFirstOfferSeconds: 180,
};
const DEMO_REVENUE: RevenueRow[] = [
  { key: "quetta", label: "Quetta", jobs: 61, completedJobs: 61, revenuePkr: 148500, commissionPkr: 14850 },
];
const DEMO_SUPPLY: SupplyDemand = {
  demandByHour: [
    { city: "Quetta", hour: 10, requests: 14, withOffers: 12 },
    { city: "Quetta", hour: 11, requests: 11, withOffers: 9 },
  ],
  supplyByCity: [{ city: "Quetta", providersTotal: 12, providersOnline: 8 }],
};
const DEMO_RUN: EtlRun = {
  id: "demo", run_date: new Date().toISOString().slice(0, 10),
  started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
  status: "completed", triggered_by: "nightly",
  counts: { requests: 120, jobs: 72, payments: 61, providers: 12 },
  reconciliation: {
    requests: { operational: 120, warehouse: 120, match: true },
    jobs: { operational: 72, warehouse: 72, match: true },
    payments: { operational: 61, warehouse: 61, match: true },
    providers: { operational: 12, warehouse: 12, match: true },
  },
};

function rangeParams(from?: string, to?: string): string {
  const p = new URLSearchParams();
  if (from) p.set("from", from);
  if (to) p.set("to", to);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const getAnalyticsFunnel = (from?: string, to?: string) =>
  getWithDemo<Funnel>(`/admin/analytics/funnel${rangeParams(from, to)}`, DEMO_FUNNEL);
export const getAnalyticsRevenue = (groupBy: "city" | "category", from?: string, to?: string) =>
  getWithDemo<RevenueRow[]>(`/admin/analytics/revenue?group_by=${groupBy}${rangeParams(from, to).replace("?", "&")}`, DEMO_REVENUE);
export const getAnalyticsSupplyDemand = (from?: string, to?: string) =>
  getWithDemo<SupplyDemand>(`/admin/analytics/supply-demand${rangeParams(from, to)}`, DEMO_SUPPLY);
export const getAnalyticsEtlStatus = () =>
  getWithDemo<EtlRun | null>(`/admin/analytics/etl/status`, DEMO_RUN);
export const runAnalyticsEtl = () => req<EtlRun>(`/admin/analytics/etl/run`, { method: "POST" });

export const ANALYTICS_EXPORT_TABLES = [
  "fact_requests", "fact_jobs", "fact_payments", "fact_providers", "revenue_by_city", "revenue_by_category",
] as const;

/** Download a warehouse CSV export as a file. Returns the filename. */
export async function downloadAnalyticsCsv(table: string): Promise<string> {
  const token = getToken();
  const res = await fetch(`${API_URL}/admin/analytics/export/${table}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new ApiError(res.status, "request_failed", `Export failed (${res.status})`);
  const blob = await res.blob();
  const filename = `near-service-analytics-${table}.csv`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return filename;
}
