// Near Service Admin — typed API client.
// Base URL: NEXT_PUBLIC_API_URL (default http://localhost:3000/api/v1).
// Auth: JWT stored in localStorage (MVP — see README; move to httpOnly cookies in Phase 2).
// Error shape from the API: { error: { code, message } }.
// DEMO fallback: when the API is unreachable, list endpoints return a clearly-labelled
// demo dataset so the layout can be previewed. Demo data is NEVER presented as live:
// every page shows a "DEMO DATA" banner when it is in use.

import type {
  AdminUserRow,
  AnalyticsFunnel,
  AnalyticsRevenueRow,
  AnalyticsSupplyDemand,
  AuditLogEntry,
  AuthUser,
  CategoryFormSchema,
  CategoryNode,
  City,
  CityCategoryOverride,
  CityChecklistItem,
  CityEffectiveCommission,
  CityFairPrice,
  CityGateConfig,
  CityGateEvaluation,
  CityStatus,
  CommissionRule,
  DisputeRow,
  EscrowConfigRow,
  EscrowHoldRow,
  EtlRun,
  JobRow,
  Kpis,
  PartnerFeeReport,
  PartnerOrderRow,
  PartnerRow,
  PayoutRow,
  Promo,
  ProviderEvidence,
  RiskScoreRow,
  RiskSettings,
  SearchGateEvaluation,
  SearchGateThresholds,
  SearchMetricsView,
  ServiceRequestRow,
  SubscriptionPlanRow,
  SubscriptionRow,
  VerificationItem,
  WarrantyClaimRow,
  WarrantyConfigRow,
  WarrantyRulesRow,
} from "./types";

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000/api/v1";

const TOKEN_KEY = "ns_admin_token";
const USER_KEY = "ns_admin_user";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

export function storeAuth(token: string, user: AuthUser) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
    throw new ApiError(
      res.status,
      err?.code || "request_failed",
      err?.message || `Request failed (${res.status})`
    );
  }
  return body as T;
}

/** Result wrapper: `demo: true` means the payload is the labelled demo dataset. */
export interface ApiResult<T> {
  data: T;
  demo: boolean;
}

/** GET with demo fallback. `isNetworkError` distinguishes unreachable API from HTTP errors. */
async function getWithDemo<T>(path: string, demo: T): Promise<ApiResult<T>> {
  try {
    const data = await request<T>(path);
    return { data, demo: false };
  } catch (e) {
    if (e instanceof ApiError) throw e; // real server error — surface it, don't mask with demo
    return { data: demo, demo: true };
  }
}

/** GET a list with demo fallback. The contract returns { items, next_cursor }
 *  (FIX 7, v1.3); a bare array (pre-FIX-7 shape) is tolerated. */
async function getListWithDemo<T>(path: string, demo: T[]): Promise<ApiResult<T[]>> {
  try {
    const body = await request<unknown>(path);
    if (Array.isArray(body)) return { data: body as T[], demo: false };
    const env = body as { items?: T[]; data?: T[] };
    return { data: env.items ?? env.data ?? [], demo: false };
  } catch (e) {
    if (e instanceof ApiError) throw e; // real server error — surface it, don't mask with demo
    return { data: demo, demo: true };
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function requestOtp(phone: string): Promise<{ sent: boolean; dev_otp?: string }> {
  return request<{ sent: boolean; dev_otp?: string }>("/auth/otp/request", {
    method: "POST",
    body: JSON.stringify({ phone }),
  });
}

export async function verifyOtp(
  phone: string,
  otp: string
): Promise<{ token: string; user: AuthUser }> {
  return request<{ token: string; user: AuthUser }>("/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ phone, otp }),
  });
}

// ---------------------------------------------------------------------------
// Admin endpoints
// ---------------------------------------------------------------------------

export const getKpis = () => getWithDemo<Kpis>("/admin/kpis", DEMO_KPIS);

/**
 * Normalise the Phase 2 KPI contract: the backend may return `take_rate`,
 * `acceptance_rate`, `cancellation_rate` instead of the Phase 1 `*_pct` names.
 * Values are percents in both spellings.
 */
export function normalizeKpis(k: Kpis): Kpis {
  return {
    ...k,
    take_rate_pct: k.take_rate_pct ?? k.take_rate ?? 0,
    acceptance_rate_pct: k.acceptance_rate_pct ?? k.acceptance_rate ?? 0,
    cancellation_rate_pct: k.cancellation_rate_pct ?? k.cancellation_rate ?? 0,
  };
}
export const getVerifications = () =>
  getListWithDemo<VerificationItem>("/admin/verifications", DEMO_VERIFICATIONS);
export const getUsers = () => getListWithDemo<AdminUserRow>("/admin/users", DEMO_USERS);
export const getCategories = () =>
  getListWithDemo<CategoryNode>("/admin/categories", DEMO_CATEGORIES);
export const getRequests = () =>
  getWithDemo<ServiceRequestRow[]>("/admin/requests", DEMO_REQUESTS);

export interface RequestsPageResult {
  items: ServiceRequestRow[];
  nextCursor: string | null;
  demo: boolean;
}

/**
 * Cursor-paginated requests (Phase 2: GET /admin/requests?status=&cursor=&limit=).
 * The contract returns { items, next_cursor }; a bare array (Phase 1 shape) is
 * tolerated. Demo fallback filters the labelled demo set by status and paginates
 * it with an index cursor so the UI behaves identically offline.
 */
export async function getRequestsPaged(opts?: {
  status?: string;
  cursor?: string | null;
  limit?: number;
}): Promise<RequestsPageResult> {
  const limit = opts?.limit ?? 20;
  const params = new URLSearchParams({ limit: String(limit) });
  if (opts?.status && opts.status !== "all") params.set("status", opts.status);
  if (opts?.cursor) params.set("cursor", opts.cursor);
  try {
    const body = await request<unknown>(`/admin/requests?${params.toString()}`);
    if (Array.isArray(body)) {
      return { items: body as ServiceRequestRow[], nextCursor: null, demo: false };
    }
    const env = body as { items?: ServiceRequestRow[]; next_cursor?: string | null };
    return { items: env.items ?? [], nextCursor: env.next_cursor ?? null, demo: false };
  } catch (e) {
    if (e instanceof ApiError) throw e; // real server error — surface it, don't mask with demo
    const filtered =
      opts?.status && opts.status !== "all"
        ? DEMO_REQUESTS.filter((r) => r.status === opts.status)
        : DEMO_REQUESTS;
    const start = opts?.cursor ? parseInt(opts.cursor, 10) || 0 : 0;
    const page = filtered.slice(start, start + limit);
    const next = start + limit < filtered.length ? String(start + limit) : null;
    return { items: page, nextCursor: next, demo: true };
  }
}
export const getJobs = () => getListWithDemo<JobRow>("/admin/jobs", DEMO_JOBS);

/** Fix B — close elapsed review windows (POST /admin/jobs/close-review-windows).
 *  Moves every PAYMENT_SETTLED job older than the review window
 *  (feature_flags review_window_days, default 7) to RATED. Idempotent;
 *  normally called nightly by an external scheduler, this is the manual
 *  trigger from the Jobs page. */
export interface CloseReviewWindowsResult {
  closed_count: number;
  closed_job_ids: string[];
  review_window_days: number;
  checked_at: string;
}
export async function closeReviewWindows(): Promise<CloseReviewWindowsResult> {
  return request<CloseReviewWindowsResult>("/admin/jobs/close-review-windows", { method: "POST", body: JSON.stringify({}) });
}
export const getDisputes = () => getListWithDemo<DisputeRow>("/admin/disputes", DEMO_DISPUTES);

/**
 * Audit log (GET /admin/audit-logs, cursor-paginated, read-only).
 * Contract response is the { items, next_cursor } envelope (FIX 7, v1.3);
 * a `{ data, next_cursor }` envelope or a bare array is tolerated.
 * Demo fallback returns the labelled demo entries with no next cursor.
 */
export interface AuditLogResult {
  entries: AuditLogEntry[];
  nextCursor: string | null;
  demo: boolean;
}

export async function getAuditLogs(cursor?: string | null, limit = 20): Promise<AuditLogResult> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  try {
    const body = await request<unknown>(`/admin/audit-logs?${params.toString()}`);
    if (Array.isArray(body)) return { entries: body as AuditLogEntry[], nextCursor: null, demo: false };
    const env = body as { items?: AuditLogEntry[]; data?: AuditLogEntry[]; next_cursor?: string | null };
    if (Array.isArray(env?.items)) {
      return { entries: env.items, nextCursor: env.next_cursor ?? null, demo: false };
    }
    if (Array.isArray(env?.data)) {
      return { entries: env.data, nextCursor: env.next_cursor ?? null, demo: false };
    }
    return { entries: [], nextCursor: null, demo: false };
  } catch (e) {
    if (e instanceof ApiError) throw e; // real server error — surface it, don't mask with demo
    return { entries: DEMO_AUDIT_LOGS, nextCursor: null, demo: true };
  }
}

/**
 * Decide a verification (POST /admin/verifications/{documentId}/decide).
 * Contract body (OpenAPI adminDecideVerification): { decision: "approved" | "rejected", note }.
 * No tier field in Phase 1 — the tier granted on approve is decided server-side.
 */
export async function decideVerification(
  documentId: string,
  decision: "approved" | "rejected",
  note: string | null
): Promise<VerificationItem> {
  return request<VerificationItem>(`/admin/verifications/${documentId}/decide`, {
    method: "POST",
    body: JSON.stringify({ decision, note }),
  });
}

export async function suspendUser(id: string, suspend: boolean): Promise<AdminUserRow> {
  return request<AdminUserRow>(`/admin/users/${id}/suspend`, {
    method: "PATCH",
    body: JSON.stringify({ suspended: suspend }),
  });
}

export async function createCategory(
  payload: Partial<CategoryNode> & { keywords?: { keyword: string; locale: string; kind: string }[] }
): Promise<CategoryNode> {
  return request<CategoryNode>("/admin/categories", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateCategory(
  id: string,
  payload: Partial<CategoryNode> & { keywords?: { keyword: string; locale: string; kind: string }[] }
): Promise<CategoryNode> {
  return request<CategoryNode>(`/admin/categories/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// Disputes (Phase 2 — fully wired: assign + resolve)
// ---------------------------------------------------------------------------

export async function resolveDispute(
  id: string,
  payload: {
    outcome: "refund" | "partial_refund" | "compensation" | "no_action";
    amount_pkr?: number;
    note?: string;
  }
): Promise<DisputeRow> {
  return request<DisputeRow>(`/admin/disputes/${id}/resolve`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function assignDispute(id: string, assignedTo: string): Promise<DisputeRow> {
  return request<DisputeRow>(`/admin/disputes/${id}/assign`, {
    method: "POST",
    body: JSON.stringify({ assigned_to: assignedTo }),
  });
}

// ---------------------------------------------------------------------------
// Commission rules (Phase 2, PRD §9 — rate band 5–15%, enforced server-side)
// ---------------------------------------------------------------------------

export const getCommissionRules = () =>
  getListWithDemo<CommissionRule>("/admin/commission-rules", DEMO_COMMISSION_RULES);

export async function createCommissionRule(payload: {
  category_id?: string | null;
  city_id?: string | null;
  tier?: number | null;
  rate: number;
  valid_from: string;
  valid_to?: string | null;
  is_promo?: boolean;
}): Promise<CommissionRule> {
  return request<CommissionRule>("/admin/commission-rules", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateCommissionRule(
  id: string,
  payload: { rate?: number; valid_to?: string | null; is_promo?: boolean }
): Promise<CommissionRule> {
  return request<CommissionRule>(`/admin/commission-rules/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// Promos (Phase 2)
// ---------------------------------------------------------------------------

export const getPromos = () => getListWithDemo<Promo>("/admin/promos", DEMO_PROMOS);

export async function createPromo(payload: {
  code: string;
  kind: "percent" | "fixed";
  value: number;
  max_uses?: number | null;
  per_user_limit?: number | null;
  valid_from?: string | null;
  valid_to?: string | null;
  category_id?: string | null;
  city_id?: string | null;
  first_job_only?: boolean;
}): Promise<Promo> {
  return request<Promo>("/admin/promos", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updatePromo(
  id: string,
  payload: { is_active?: boolean; valid_to?: string | null }
): Promise<Promo> {
  return request<Promo>(`/admin/promos/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// Category form schemas (Phase 2, PRD §5 — drives the live mobile request form)
// ---------------------------------------------------------------------------

export async function getCategoryFormSchema(
  categoryId: string
): Promise<ApiResult<CategoryFormSchema>> {
  const demo: CategoryFormSchema = {
    category_id: categoryId,
    slug: "",
    name_en: "",
    form_schema: {
      type: "object",
      properties: {
        details: { type: "string", title: "Service details" },
        quantity: { type: "number", title: "Quantity" },
      },
      required: ["details"],
    },
  };
  try {
    const data = await request<CategoryFormSchema>(`/categories/${categoryId}/form-schema`);
    return { data, demo: false };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    return { data: demo, demo: true };
  }
}

export async function saveCategoryFormSchema(
  categoryId: string,
  schema: Record<string, unknown>
): Promise<CategoryFormSchema> {
  return request<CategoryFormSchema>(`/admin/categories/${categoryId}/form-schema`, {
    method: "PUT",
    body: JSON.stringify({ schema }),
  });
}

/** Client-side check: schema must be an object with type 'object' and a properties object. */
export function validateFormSchema(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "Schema must be a JSON object.";
  }
  const obj = value as Record<string, unknown>;
  if (obj.type !== "object") return "Schema must have \"type\": \"object\" at the top level.";
  if (typeof obj.properties !== "object" || obj.properties === null || Array.isArray(obj.properties)) {
    return "Schema must have a \"properties\" object listing the form fields.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Demo datasets — clearly labelled DEMO in the UI whenever used.
// Values are plausible Quetta-pilot fixtures, NOT live data.
// ---------------------------------------------------------------------------

export const DEMO_KPIS: Kpis = {
  gmv_pkr: 1284500,
  jobs_total: 486,
  take_rate_pct: 10,
  active_users: 1240,
  active_providers: 212,
  acceptance_rate_pct: 78.4,
  time_to_first_offer_seconds: 47,
  cancellation_rate_pct: 4.1,
  nps: 42,
  disputes_open: 6,
  verifications_pending: 9,
};

export const DEMO_VERIFICATIONS: VerificationItem[] = [
  {
    id: "3f8a1c2e-7b4d-4a91-9e2c-1d5f6a7b8c01",
    provider_id: "a1b2c3d4-1111-4000-8000-000000000101",
    provider_name: "Ahmed Binding House",
    provider_type: "SHOP",
    phone: "+92 300 1234567",
    city: "Quetta",
    categories: ["Book Binding"],
    tier_requested: 1,
    current_tier: 0,
    documents: [
      { doc_type: "cnic_front", review_status: "pending" },
      { doc_type: "cnic_back", review_status: "pending" },
      { doc_type: "selfie", review_status: "pending" },
    ],
    submitted_at: "2026-11-17T06:12:00+05:00",
    status: "pending",
  },
  {
    id: "3f8a1c2e-7b4d-4a91-9e2c-1d5f6a7b8c02",
    provider_id: "a1b2c3d4-1111-4000-8000-000000000102",
    provider_name: "Bilal AC Services",
    provider_type: "INDIVIDUAL",
    phone: "+92 333 9876543",
    city: "Quetta",
    categories: ["AC Repair"],
    tier_requested: 2,
    current_tier: 1,
    documents: [
      { doc_type: "cnic_front", review_status: "approved" },
      { doc_type: "cnic_back", review_status: "approved" },
      { doc_type: "selfie", review_status: "pending" },
      { doc_type: "shop_photo", review_status: "pending" },
    ],
    submitted_at: "2026-11-16T18:40:00+05:00",
    status: "pending",
  },
  {
    id: "3f8a1c2e-7b4d-4a91-9e2c-1d5f6a7b8c03",
    provider_id: "a1b2c3d4-1111-4000-8000-000000000103",
    provider_name: "Sana Mobile Repair",
    provider_type: "SHOP",
    phone: "+92 321 5550198",
    city: "Quetta",
    categories: ["Mobile Repair"],
    tier_requested: 1,
    current_tier: 0,
    documents: [
      { doc_type: "cnic_front", review_status: "pending" },
      { doc_type: "cnic_back", review_status: "pending" },
      { doc_type: "selfie", review_status: "pending" },
    ],
    submitted_at: "2026-11-16T11:05:00+05:00",
    status: "pending",
    review_note: "Selfie looks older than the CNIC photo — compare both images carefully before deciding.",
  },
];

export const DEMO_AUDIT_LOGS: AuditLogEntry[] = [
  { id: "e1a2b3c4-0001-4000-8000-000000000001", actor_id: "a1b2c3d4-2222-4000-8000-000000000001", actor_name: "Admin (Super)", actor_role: "super_admin", action: "verification.decide", entity_type: "verification", entity_id: "3f8a1c2e-7b4d-4a91-9e2c-1d5f6a7b8c01", detail: "Approved — CNIC photo matches selfie; shop photo shows premises.", created_at: "2026-11-16T19:02:00+05:00" },
  { id: "e1a2b3c4-0002-4000-8000-000000000002", actor_id: "a1b2c3d4-2222-4000-8000-000000000002", actor_name: "Verification Officer", actor_role: "verification_officer", action: "verification.decide", entity_type: "verification", entity_id: "3f8a1c2e-7b4d-4a91-9e2c-1d5f6a7b8c02", detail: "Rejected — CNIC back image unreadable; re-upload requested.", created_at: "2026-11-16T17:40:00+05:00" },
  { id: "e1a2b3c4-0003-4000-8000-000000000003", actor_id: "a1b2c3d4-2222-4000-8000-000000000001", actor_name: "Admin (Super)", actor_role: "super_admin", action: "user.suspend", entity_type: "user", entity_id: "a1b2c3d4-1111-4000-8000-000000000105", detail: "Suspended — repeated no-shows reported by customers.", created_at: "2026-11-15T12:25:00+05:00" },
  { id: "e1a2b3c4-0004-4000-8000-000000000004", actor_id: "a1b2c3d4-2222-4000-8000-000000000003", actor_name: "Support Agent", actor_role: "support_agent", action: "category.update", entity_type: "category", entity_id: "c1d2e3f4-1111-4000-8000-000000000001", detail: "Updated keywords for Book Binding (added roman alias 'jild saazi').", created_at: "2026-11-14T10:12:00+05:00" },
  { id: "e1a2b3c4-0005-4000-8000-000000000005", actor_id: "a1b2c3d4-2222-4000-8000-000000000001", actor_name: "Admin (Super)", actor_role: "super_admin", action: "user.unsuspend", entity_type: "user", entity_id: "a1b2c3d4-1111-4000-8000-000000000105", detail: "Unsuspended after provider appeal and warning.", created_at: "2026-11-13T09:48:00+05:00" },
];

export const DEMO_USERS: AdminUserRow[] = [
  { id: "a1b2c3d4-1111-4000-8000-000000000101", phone: "+92 300 1234567", full_name: "Ahmed Khan", roles: ["provider"], status: "active", is_provider: true, provider_tier: 0, city: "Quetta", jobs_completed: 12, rating_avg: 4.6, created_at: "2026-11-02T10:00:00+05:00" },
  { id: "a1b2c3d4-1111-4000-8000-000000000102", phone: "+92 333 9876543", full_name: "Bilal Ahmed", roles: ["provider"], status: "active", is_provider: true, provider_tier: 1, city: "Quetta", jobs_completed: 48, rating_avg: 4.8, created_at: "2026-10-28T09:30:00+05:00" },
  { id: "a1b2c3d4-1111-4000-8000-000000000103", phone: "+92 321 5550198", full_name: "Sana Malik", roles: ["provider"], status: "active", is_provider: true, provider_tier: 0, city: "Quetta", jobs_completed: 3, rating_avg: 4.2, created_at: "2026-11-15T14:20:00+05:00" },
  { id: "a1b2c3d4-1111-4000-8000-000000000104", phone: "+92 345 2223344", full_name: "Fatima Noor", roles: ["customer"], status: "active", is_provider: false, provider_tier: null, city: "Quetta", jobs_completed: 0, rating_avg: 0, created_at: "2026-11-10T08:15:00+05:00" },
  { id: "a1b2c3d4-1111-4000-8000-000000000105", phone: "+92 312 7778899", full_name: "Usman Tariq", roles: ["customer", "provider"], status: "suspended", is_provider: true, provider_tier: 1, city: "Quetta", jobs_completed: 21, rating_avg: 3.9, created_at: "2026-10-20T12:00:00+05:00" },
  { id: "a1b2c3d4-1111-4000-8000-000000000106", phone: "+92 301 4445566", full_name: "Hassan Raza", roles: ["provider"], status: "active", is_provider: true, provider_tier: 2, city: "Quetta", jobs_completed: 96, rating_avg: 4.9, created_at: "2026-10-15T16:45:00+05:00" },
];

export const DEMO_CATEGORIES: CategoryNode[] = [
  { id: "c1d2e3f4-1111-4000-8000-000000000001", parent_id: null, level: 1, slug: "book-binding", name_en: "Book Binding", name_ur: "کتاب کی جلد بندی", name_roman: "jild saazi", icon_key: "book", is_active: true, sort_order: 1, keywords: [{ keyword: "jild saazi", locale: "roman", kind: "synonym" }, { keyword: "book banding", locale: "en", kind: "misspelling" }, { keyword: "کتاب کی جلد بندی", locale: "ur", kind: "alias" }] },
  { id: "c1d2e3f4-1111-4000-8000-000000000002", parent_id: null, level: 1, slug: "ac-repair", name_en: "AC Repair", name_ur: "اے سی مرمت", name_roman: "AC repair", icon_key: "snowflake", is_active: true, sort_order: 2, keywords: [{ keyword: "AC gas refill", locale: "en", kind: "synonym" }, { keyword: "air conditioner repair", locale: "en", kind: "alias" }] },
  { id: "c1d2e3f4-1111-4000-8000-000000000003", parent_id: null, level: 1, slug: "electrician", name_en: "Electrician", name_ur: "بجلی کا کام", name_roman: "bijli wala", icon_key: "zap", is_active: true, sort_order: 3, keywords: [{ keyword: "bijli wala", locale: "roman", kind: "synonym" }] },
  { id: "c1d2e3f4-1111-4000-8000-000000000004", parent_id: null, level: 1, slug: "plumber", name_en: "Plumber", name_ur: "پلمبر", name_roman: "nalka wala", icon_key: "wrench", is_active: true, sort_order: 4, keywords: [{ keyword: "nalka wala", locale: "roman", kind: "synonym" }] },
  { id: "c1d2e3f4-1111-4000-8000-000000000005", parent_id: null, level: 1, slug: "mobile-repair", name_en: "Mobile Repair", name_ur: "موبائل مرمت", name_roman: "mobile repair", icon_key: "smartphone", is_active: true, sort_order: 5, keywords: [{ keyword: "mobile screen replacement", locale: "en", kind: "synonym" }] },
];

export const DEMO_REQUESTS: ServiceRequestRow[] = [
  { id: "req-001", customer_name: "Fatima Noor", customer_phone: "+92 345 2223344", category_name: "Book Binding", description: "20 school books, hard binding, pickup & delivery", customer_offer_pkr: 2400, fair_min_pkr: 2200, fair_typical_pkr: 2600, fair_max_pkr: 3000, fulfillment: "PICKUP_DELIVERY", status: "OFFERS_RECEIVED", offers_count: 3, city: "Quetta", created_at: "2026-11-17T01:20:00+05:00" },
  { id: "req-002", customer_name: "Hassan Raza", customer_phone: "+92 301 4445566", category_name: "AC Repair", description: "Split AC 1.5 ton not cooling, gas check needed", customer_offer_pkr: 1800, fair_min_pkr: 1500, fair_typical_pkr: 2000, fair_max_pkr: 2800, fulfillment: "PROVIDER_COMES", status: "BROADCASTING", offers_count: 1, city: "Quetta", created_at: "2026-11-17T01:05:00+05:00" },
  { id: "req-003", customer_name: "Ayesha Siddiqui", customer_phone: "+92 333 1112233", category_name: "Mobile Repair", description: "Screen cracked, Samsung A54", customer_offer_pkr: null, fair_min_pkr: 3500, fair_typical_pkr: 4500, fair_max_pkr: 6000, fulfillment: "VISIT_SHOP", status: "ACCEPTED", offers_count: 4, city: "Quetta", created_at: "2026-11-16T20:40:00+05:00" },
  { id: "req-004", customer_name: "Imran Baloch", customer_phone: "+92 300 9988776", category_name: "Plumber", description: "Kitchen tap leaking, replace washer", customer_offer_pkr: 800, fair_min_pkr: 600, fair_typical_pkr: 900, fair_max_pkr: 1500, fulfillment: "PROVIDER_COMES", status: "EXPIRED", offers_count: 0, city: "Quetta", created_at: "2026-11-16T15:10:00+05:00" },
];

export const DEMO_JOBS: JobRow[] = [
  {
    id: "job-001", request_id: "req-003", customer_name: "Ayesha Siddiqui", provider_name: "Sana Mobile Repair",
    category_name: "Mobile Repair", agreed_price_pkr: 4200, final_price_pkr: 4200, commission_rate: 0.1,
    commission_amount_pkr: 420, state: "IN_PROGRESS", payment_method: "cash", payment_status: "unpaid",
    city: "Quetta", created_at: "2026-11-16T21:00:00+05:00", completed_at: null,
    events: [
      { id: 1, from_state: null, to_state: "ACCEPTED", actor_role: "customer", actor_name: "Ayesha Siddiqui", created_at: "2026-11-16T21:00:00+05:00", note: "Offer accepted at PKR 4,200" },
      { id: 2, from_state: "ACCEPTED", to_state: "ITEM_PICKED_UP", actor_role: "provider", actor_name: "Sana Mobile Repair", created_at: "2026-11-16T21:25:00+05:00", note: "Phone picked up from customer" },
      { id: 3, from_state: "ITEM_PICKED_UP", to_state: "IN_PROGRESS", actor_role: "provider", actor_name: "Sana Mobile Repair", created_at: "2026-11-16T21:40:00+05:00", note: "Screen replacement started" },
    ],
  },
  {
    id: "job-002", request_id: "req-000", customer_name: "Fatima Noor", provider_name: "Ahmed Binding House",
    category_name: "Book Binding", agreed_price_pkr: 2550, final_price_pkr: 2550, commission_rate: 0.1,
    commission_amount_pkr: 255, state: "PAYMENT_SETTLED", payment_method: "cash", payment_status: "paid",
    city: "Quetta", created_at: "2026-11-15T10:00:00+05:00", completed_at: "2026-11-15T18:30:00+05:00",
    events: [
      { id: 1, from_state: null, to_state: "ACCEPTED", actor_role: "customer", actor_name: "Fatima Noor", created_at: "2026-11-15T10:00:00+05:00", note: "Offer accepted at PKR 2,550" },
      { id: 2, from_state: "ACCEPTED", to_state: "ITEM_PICKED_UP", actor_role: "provider", actor_name: "Ahmed Binding House", created_at: "2026-11-15T11:15:00+05:00", note: "20 books picked up" },
      { id: 3, from_state: "ITEM_PICKED_UP", to_state: "IN_PROGRESS", actor_role: "provider", actor_name: "Ahmed Binding House", created_at: "2026-11-15T12:00:00+05:00", note: "Hard binding in progress" },
      { id: 4, from_state: "IN_PROGRESS", to_state: "COMPLETED", actor_role: "provider", actor_name: "Ahmed Binding House", created_at: "2026-11-15T17:45:00+05:00", note: "Books bound, ready for delivery" },
      { id: 5, from_state: "COMPLETED", to_state: "PAYMENT_SETTLED", actor_role: "system", actor_name: "System", created_at: "2026-11-15T18:30:00+05:00", note: "Cash confirmed by both sides; commission PKR 255 accrued" },
    ],
  },
  {
    id: "job-003", request_id: "req-000", customer_name: "Imran Baloch", provider_name: "Bilal AC Services",
    category_name: "AC Repair", agreed_price_pkr: 2000, final_price_pkr: 2000, commission_rate: 0.1,
    commission_amount_pkr: 200, state: "DISPUTED", payment_method: "cash", payment_status: "unpaid",
    city: "Quetta", created_at: "2026-11-14T09:00:00+05:00", completed_at: null,
    events: [
      { id: 1, from_state: null, to_state: "ACCEPTED", actor_role: "customer", actor_name: "Imran Baloch", created_at: "2026-11-14T09:00:00+05:00", note: "Offer accepted at PKR 2,000" },
      { id: 2, from_state: "ACCEPTED", to_state: "PROVIDER_EN_ROUTE", actor_role: "provider", actor_name: "Bilal AC Services", created_at: "2026-11-14T09:30:00+05:00", note: "Provider en route" },
      { id: 3, from_state: "PROVIDER_EN_ROUTE", to_state: "COMPLETED", actor_role: "provider", actor_name: "Bilal AC Services", created_at: "2026-11-14T12:00:00+05:00", note: "Marked complete by provider" },
      { id: 4, from_state: "COMPLETED", to_state: "DISPUTED", actor_role: "customer", actor_name: "Imran Baloch", created_at: "2026-11-14T13:10:00+05:00", note: "Customer disputes: AC still not cooling" },
    ],
  },
];

export const DEMO_DISPUTES: DisputeRow[] = [
  {
    id: "dsp-001", job_id: "job-003", opened_by: "Imran Baloch", opened_by_role: "customer",
    reason: "Work not done properly", reason_code: "work_not_done",
    description: "AC still not cooling after the repair visit. Provider left without testing.",
    status: "open", outcome: null,
    sla_first_response_due: "2026-11-17T13:10:00+05:00", sla_resolution_due: "2026-11-19T13:10:00+05:00",
    sla_first_response_at: "2026-11-17T13:10:00+05:00", sla_resolve_at: "2026-11-19T13:10:00+05:00",
    breached: true, assigned_to: null, amount_pkr: 2000, created_at: "2026-11-14T13:10:00+05:00",
    evidence_count: 3,
    evidence: [
      { id: "ev-001", kind: "photo", storage_key: "disputes/dsp-001/ac-thermometer.jpg", note: "Thermometer shows 29°C after repair", created_at: "2026-11-14T13:15:00+05:00" },
      { id: "ev-002", kind: "chat", storage_key: "disputes/dsp-001/chat-transcript.json", note: "Customer told provider AC still warm; no reply", created_at: "2026-11-14T13:20:00+05:00" },
      { id: "ev-003", kind: "gps", storage_key: "disputes/dsp-001/visit-trail.json", note: "Provider on site 09:30–09:52, 22 min visit", created_at: "2026-11-14T13:22:00+05:00" },
    ],
  },
  {
    id: "dsp-002", job_id: "job-002", opened_by: "Ahmed Binding House", opened_by_role: "provider",
    reason: "Payment not received", reason_code: "payment_short",
    description: "Customer says cash was paid but provider reports short payment of PKR 300.",
    status: "in_review", outcome: null,
    sla_first_response_due: "2026-11-16T10:00:00+05:00", sla_resolution_due: "2026-11-18T10:00:00+05:00",
    sla_first_response_at: "2026-11-16T10:00:00+05:00", sla_resolve_at: "2026-11-18T10:00:00+05:00",
    breached: false, assigned_to: "Support Agent", amount_pkr: 300, created_at: "2026-11-15T19:00:00+05:00",
    evidence_count: 2,
    evidence: [
      { id: "ev-004", kind: "chat", storage_key: "disputes/dsp-002/chat-transcript.json", note: "Customer confirms PKR 2,250 handed over", created_at: "2026-11-15T19:05:00+05:00" },
      { id: "ev-005", kind: "photo", storage_key: "disputes/dsp-002/receipt.jpg", note: "Hand-written receipt for PKR 2,250", created_at: "2026-11-15T19:10:00+05:00" },
    ],
  },
];

export const DEMO_COMMISSION_RULES: CommissionRule[] = [
  { id: "cr-001", category_id: null, city_id: null, tier: null, rate: 10, valid_from: "2026-11-01", valid_to: null, is_promo: false },
  { id: "cr-002", category_id: "c1d2e3f4-1111-4000-8000-000000000002", city_id: null, tier: 2, rate: 8, valid_from: "2026-11-10", valid_to: "2026-12-31", is_promo: false },
  { id: "cr-003", category_id: null, city_id: null, tier: null, rate: 5, valid_from: "2026-11-15", valid_to: "2026-11-30", is_promo: true },
];

export const DEMO_PROMOS: Promo[] = [
  { id: "pr-001", code: "WELCOME100", kind: "fixed", value: 100, max_uses: 500, per_user_limit: 1, valid_from: "2026-11-01", valid_to: "2026-12-31", category_id: null, city_id: null, first_job_only: true, is_active: true, uses_count: 87 },
  { id: "pr-002", code: "AC20", kind: "percent", value: 20, max_uses: 200, per_user_limit: 1, valid_from: "2026-11-10", valid_to: "2026-11-30", category_id: "c1d2e3f4-1111-4000-8000-000000000002", city_id: null, first_job_only: false, is_active: true, uses_count: 34 },
  { id: "pr-003", code: "QUETTA50", kind: "fixed", value: 50, max_uses: null, per_user_limit: 2, valid_from: "2026-11-01", valid_to: "2026-11-15", category_id: null, city_id: null, first_job_only: false, is_active: false, uses_count: 210 },
];

// ---------------------------------------------------------------------------
// Phase 3 (v1.5) — risk, subscriptions, escrow/finance, verification evidence
// ---------------------------------------------------------------------------

export const getRiskReviewQueue = () =>
  getListWithDemo<RiskScoreRow>("/admin/risk/review-queue", DEMO_RISK_QUEUE);

export const getRiskSettings = () =>
  getWithDemo<RiskSettings>("/admin/risk/settings", DEMO_RISK_SETTINGS);

export async function updateRiskSettings(patch: Partial<RiskSettings>): Promise<RiskSettings> {
  return request<RiskSettings>("/admin/risk/settings", { method: "PATCH", body: JSON.stringify(patch) });
}

export const getSubscriptionPlans = () =>
  getListWithDemo<SubscriptionPlanRow>("/subscription-plans", DEMO_SUBSCRIPTION_PLANS);

export async function createSubscriptionPlan(payload: {
  code: string; name: string; price_pkr: number; commission_multiplier: number;
  max_staff_accounts: number; featured: boolean; analytics_enabled: boolean;
}): Promise<SubscriptionPlanRow> {
  return request<SubscriptionPlanRow>("/admin/subscription-plans", { method: "POST", body: JSON.stringify(payload) });
}

export async function updateSubscriptionPlan(
  id: string,
  payload: Partial<SubscriptionPlanRow>,
): Promise<SubscriptionPlanRow> {
  return request<SubscriptionPlanRow>(`/admin/subscription-plans/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
}

export const getAdminSubscriptions = () =>
  getListWithDemo<SubscriptionRow>("/admin/subscriptions", DEMO_SUBSCRIPTIONS);

export async function expireSubscriptions(): Promise<{ processed: number }> {
  return request<{ processed: number }>("/admin/subscriptions/expire", { method: "POST", body: JSON.stringify({}) });
}

export const getEscrowConfig = () =>
  getWithDemo<EscrowConfigRow>("/admin/escrow/config", DEMO_ESCROW_CONFIG);

export async function updateEscrowConfig(patch: {
  auto_release_hours?: number; min_amount_pkr?: number; payout_fee_flat_pkr?: number;
  payout_fee_rate?: number; payout_tax_rate?: number;
}): Promise<EscrowConfigRow> {
  return request<EscrowConfigRow>("/admin/escrow/config", { method: "PATCH", body: JSON.stringify(patch) });
}

export const getAdminEscrowHolds = () =>
  getListWithDemo<EscrowHoldRow>("/admin/escrow/holds", DEMO_ESCROW_HOLDS);

export const getAdminPayouts = () =>
  getListWithDemo<PayoutRow>("/admin/payouts", DEMO_PAYOUTS);

export async function approvePayout(id: string): Promise<PayoutRow> {
  return request<PayoutRow>(`/admin/payouts/${id}/approve`, { method: "POST", body: JSON.stringify({}) });
}

export async function rejectPayout(id: string, reason?: string): Promise<PayoutRow> {
  return request<PayoutRow>(`/admin/payouts/${id}/reject`, { method: "POST", body: JSON.stringify({ reason: reason ?? null }) });
}

export async function releaseEscrowHoldAdmin(id: string): Promise<EscrowHoldRow> {
  return request<EscrowHoldRow>(`/admin/escrow/holds/${id}/release`, { method: "POST", body: JSON.stringify({}) });
}

export async function autoReleaseEscrow(): Promise<{ released: string[]; skipped_dispute: string[]; checked_at: string }> {
  return request("/admin/escrow/auto-release", { method: "POST", body: JSON.stringify({}) });
}

export async function runDuePayouts(): Promise<{ executed: string[]; failed: string[]; checked_at: string }> {
  return request("/admin/payouts/run-due", { method: "POST", body: JSON.stringify({}) });
}

/** Tender deadline expiry sweep (hourly operator schedule; idempotent). */
export async function expireDueTenders(): Promise<{ expired_count: number; expired_tender_ids: string[]; checked_count: number }> {
  return request("/admin/tenders/expire-due", { method: "POST", body: JSON.stringify({}) });
}

/** Advisory verification evidence for one provider (face-match + liveness + OCR). */
export const getProviderEvidence = (providerId: string) =>
  getWithDemo<ProviderEvidence>(`/verification/providers/${providerId}/evidence`, DEMO_PROVIDER_EVIDENCE);

// ---------------------------------------------------------------------------
// Phase 4 (v1.6) — search metrics, analytics warehouse, multi-city ops,
// warranty, partners. Plain request() helpers (no demo fallback): these
// pages show the real error state when the API is unreachable, never demo
// data. They mirror the local helpers in the new Phase 4 admin pages
// (admin/src/app/search-metrics, analytics, cities, partners, warranty);
// the pages were not refactored onto them in this pass — this is the
// shared typed surface for future pages.
// ---------------------------------------------------------------------------

// ---- Search scale-out (item 1) ----
export async function getSearchMetrics(windowHours = 24, days = 14): Promise<SearchMetricsView> {
  return request<SearchMetricsView>(`/admin/search/metrics?window_hours=${windowHours}&days=${days}`);
}

export async function getSearchGate(): Promise<SearchGateEvaluation> {
  return request<SearchGateEvaluation>("/admin/search/gate");
}

export async function updateSearchGateThresholds(
  patch: Partial<SearchGateThresholds>,
): Promise<SearchGateThresholds> {
  return request<SearchGateThresholds>("/admin/search/gate/thresholds", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

// ---- Analytics warehouse (item 2) ----
function analyticsRangeParams(from?: string, to?: string): string {
  const p = new URLSearchParams();
  if (from) p.set("from", from);
  if (to) p.set("to", to);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export async function getAnalyticsFunnel(from?: string, to?: string): Promise<AnalyticsFunnel> {
  return request<AnalyticsFunnel>(`/admin/analytics/funnel${analyticsRangeParams(from, to)}`);
}

export async function getAnalyticsRevenue(
  groupBy: "city" | "category",
  from?: string,
  to?: string,
): Promise<AnalyticsRevenueRow[]> {
  const rest = analyticsRangeParams(from, to).replace("?", "&");
  return request<AnalyticsRevenueRow[]>(`/admin/analytics/revenue?group_by=${groupBy}${rest}`);
}

export async function getAnalyticsSupplyDemand(from?: string, to?: string): Promise<AnalyticsSupplyDemand> {
  return request<AnalyticsSupplyDemand>(`/admin/analytics/supply-demand${analyticsRangeParams(from, to)}`);
}

export async function getAnalyticsEtlStatus(): Promise<EtlRun | null> {
  return request<EtlRun | null>("/admin/analytics/etl/status");
}

export async function runAnalyticsEtl(): Promise<EtlRun> {
  return request<EtlRun>("/admin/analytics/etl/run", { method: "POST" });
}

export const ANALYTICS_EXPORT_TABLES = [
  "fact_requests",
  "fact_jobs",
  "fact_payments",
  "fact_providers",
  "revenue_by_city",
  "revenue_by_category",
] as const;

/** Download a warehouse CSV export as a file. Returns the filename.
 *  Every export is labelled subject to legal review (server header + file
 *  comment) — Finance / legal counsel must verify before any submission. */
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

// ---- Multi-city ops (item 3) ----
export async function getCities(): Promise<City[]> {
  return request<City[]>("/admin/cities");
}

export async function getCity(id: string): Promise<City> {
  return request<City>(`/admin/cities/${id}`);
}

export async function createCity(payload: {
  name: string;
  slug: string;
  lat: number;
  lng: number;
  default_radius_km?: number;
  population_estimate?: number;
  supply_target_providers?: number;
}): Promise<City> {
  return request<City>("/admin/cities", { method: "POST", body: JSON.stringify(payload) });
}

export async function updateCityTargets(
  id: string,
  patch: { supply_target_providers?: number; default_radius_km?: number; population_estimate?: number },
): Promise<City> {
  return request<City>(`/admin/cities/${id}/targets`, { method: "PATCH", body: JSON.stringify(patch) });
}

export async function updateCityGateConfig(
  id: string,
  patch: Partial<CityGateConfig>,
): Promise<CityGateConfig> {
  return request<CityGateConfig>(`/admin/cities/${id}/gate-config`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function evaluateCityGate(id: string, notes?: string): Promise<CityGateEvaluation> {
  return request<CityGateEvaluation>(`/admin/cities/${id}/gate-evaluations`, {
    method: "POST",
    body: JSON.stringify({ notes }),
  });
}

export async function listCityGateEvaluations(id: string): Promise<CityGateEvaluation[]> {
  return request<CityGateEvaluation[]>(`/admin/cities/${id}/gate-evaluations`);
}

export async function transitionCityStatus(id: string, to: CityStatus, note?: string): Promise<City> {
  return request<City>(`/admin/cities/${id}/status`, {
    method: "POST",
    body: JSON.stringify({ to, note }),
  });
}

export async function assignCityManager(id: string, managerUserId: string): Promise<City> {
  return request<City>(`/admin/cities/${id}/assign-manager`, {
    method: "POST",
    body: JSON.stringify({ manager_user_id: managerUserId }),
  });
}

export async function getCityChecklist(id: string): Promise<CityChecklistItem[]> {
  return request<CityChecklistItem[]>(`/admin/cities/${id}/checklist`);
}

export async function updateCityChecklistItem(
  id: string,
  itemKey: string,
  done: boolean,
  notes?: string,
): Promise<CityChecklistItem> {
  return request<CityChecklistItem>(`/admin/cities/${id}/checklist/${itemKey}`, {
    method: "PATCH",
    body: JSON.stringify({ done, notes }),
  });
}

export async function listCityCategories(id: string): Promise<{ items: CityCategoryOverride[] }> {
  return request<{ items: CityCategoryOverride[] }>(`/admin/cities/${id}/categories`);
}

export async function updateCityCategoryOverride(
  id: string,
  categoryId: string,
  isEnabled: boolean,
  sortOrder?: number,
): Promise<CityCategoryOverride> {
  return request<CityCategoryOverride>(`/admin/cities/${id}/categories/${categoryId}`, {
    method: "PATCH",
    body: JSON.stringify({ is_enabled: isEnabled, sort_order: sortOrder }),
  });
}

export async function getCityEffectiveCommission(
  id: string,
  categoryId?: string,
  tier?: number,
): Promise<CityEffectiveCommission> {
  const p = new URLSearchParams();
  if (categoryId) p.set("category_id", categoryId);
  if (tier !== undefined) p.set("tier", String(tier));
  const q = p.toString();
  return request<CityEffectiveCommission>(`/admin/cities/${id}/effective-commission${q ? `?${q}` : ""}`);
}

export async function createCityCommissionRule(
  id: string,
  payload: { category_id?: string | null; tier?: number | null; rate: number; valid_from?: string; valid_to?: string | null },
): Promise<CommissionRule> {
  return request<CommissionRule>(`/admin/cities/${id}/commission-rules`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function getCityFairPrice(id: string, categoryId: string): Promise<CityFairPrice | null> {
  return request<CityFairPrice | null>(`/admin/cities/${id}/fair-price?category_id=${categoryId}`);
}

export async function upsertCityFairPrice(
  id: string,
  payload: { category_id: string; min_price: number; typical_price: number; max_price: number; sample_size?: number },
): Promise<CityFairPrice> {
  return request<CityFairPrice>(`/admin/cities/${id}/fair-price`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// ---- Warranty product (item 4) ----
export async function listWarrantyClaims(status?: string): Promise<WarrantyClaimRow[]> {
  const q = status ? `?status=${status}&limit=50` : "?limit=50";
  return request<WarrantyClaimRow[]>(`/admin/warranty/claims${q}`);
}

export async function reviewWarrantyClaim(id: string): Promise<WarrantyClaimRow> {
  return request<WarrantyClaimRow>(`/admin/warranty/claims/${id}/review`, { method: "POST" });
}

export async function offerWarrantyRework(id: string, reason: string, note?: string): Promise<WarrantyClaimRow> {
  return request<WarrantyClaimRow>(`/admin/warranty/claims/${id}/offer-rework`, {
    method: "POST",
    body: JSON.stringify({ reason, note }),
  });
}

export async function rejectWarrantyClaim(id: string, reason: string): Promise<WarrantyClaimRow> {
  return request<WarrantyClaimRow>(`/admin/warranty/claims/${id}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export async function approveWarrantyRefund(id: string, reason: string): Promise<WarrantyClaimRow> {
  return request<WarrantyClaimRow>(`/admin/warranty/claims/${id}/approve-refund`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export async function getWarrantyConfig(): Promise<WarrantyConfigRow> {
  return request<WarrantyConfigRow>("/admin/warranty/config");
}

export async function updateWarrantyConfig(patch: {
  fee_rate?: number;
  fee_flat_pkr?: number;
  fee_min_pkr?: number;
  fee_max_pkr?: number;
  claim_window_days?: number;
}): Promise<WarrantyConfigRow> {
  return request<WarrantyConfigRow>("/admin/warranty/config", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function getWarrantyRules(): Promise<WarrantyRulesRow> {
  return request<WarrantyRulesRow>("/admin/warranty/rules");
}

export async function updateWarrantyRules(title: string, bodyMd: string): Promise<WarrantyRulesRow> {
  return request<WarrantyRulesRow>("/admin/warranty/rules", {
    method: "PUT",
    body: JSON.stringify({ title, body_md: bodyMd }),
  });
}

export async function expireDueWarranties(): Promise<{ expired: string[]; checked_at: string }> {
  return request<{ expired: string[]; checked_at: string }>("/admin/warranty/expire-due", {
    method: "POST",
  });
}

// ---- Partner integrations (item 5) ----
export async function listPartners(): Promise<PartnerRow[]> {
  return request<PartnerRow[]>("/admin/partners");
}

export async function createPartner(payload: {
  name: string;
  slug?: string;
  kind?: string;
  city?: string | null;
  affiliate_fee_rate?: number;
}): Promise<PartnerRow> {
  return request<PartnerRow>("/admin/partners", { method: "POST", body: JSON.stringify(payload) });
}

export async function updatePartner(id: string, patch: Partial<PartnerRow>): Promise<PartnerRow> {
  return request<PartnerRow>(`/admin/partners/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export async function listAdminPartnerOrders(opts?: {
  status?: string;
  partner_id?: string;
  job_id?: string;
  limit?: number;
}): Promise<{ items: PartnerOrderRow[]; total: number }> {
  const p = new URLSearchParams({ limit: String(opts?.limit ?? 50) });
  if (opts?.status) p.set("status", opts.status);
  if (opts?.partner_id) p.set("partner_id", opts.partner_id);
  if (opts?.job_id) p.set("job_id", opts.job_id);
  return request<{ items: PartnerOrderRow[]; total: number }>(`/admin/partners/orders?${p.toString()}`);
}

export async function getAdminPartnerOrder(id: string): Promise<PartnerOrderRow> {
  return request<PartnerOrderRow>(`/admin/partners/orders/${id}`);
}

export async function transitionAdminPartnerOrder(
  id: string,
  action: "confirm" | "deliver" | "cancel",
  reason?: string,
): Promise<PartnerOrderRow> {
  return request<PartnerOrderRow>(`/admin/partners/orders/${id}/${action}`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export async function getAffiliateFeeReport(opts?: {
  from?: string;
  to?: string;
  partner_id?: string;
}): Promise<PartnerFeeReport> {
  const p = new URLSearchParams();
  if (opts?.from) p.set("from", opts.from);
  if (opts?.to) p.set("to", opts.to);
  if (opts?.partner_id) p.set("partner_id", opts.partner_id);
  const q = p.toString();
  return request<PartnerFeeReport>(`/admin/partners/affiliate-fees${q ? `?${q}` : ""}`);
}

// ---- Phase 3 demo data (labelled DEMO DATA in the UI, never live) ----
export const DEMO_RISK_QUEUE: RiskScoreRow[] = [
  { user_id: "11111111-1111-4000-8000-000000000001", score: 72, level: "high", breakdown: { cancellation: { count: 3, weight: 5, points: 15 }, no_show: { count: 2, weight: 12, points: 24 } }, hold_until: null, updated_at: "2026-11-16T10:00:00+05:00", phone: "+923001234567", full_name: "Demo Provider", status: "active" },
  { user_id: "11111111-1111-4000-8000-000000000002", score: 61, level: "high", breakdown: { upheld_dispute: { count: 1, weight: 20, points: 20 }, report: { count: 4, weight: 3, points: 12 } }, hold_until: null, updated_at: "2026-11-16T09:00:00+05:00", phone: "+923007654321", full_name: "Demo Shop", status: "active" },
];

export const DEMO_RISK_SETTINGS: RiskSettings = {
  weights: { cancellation: 5, no_show: 12, upheld_dispute: 20, device_change: 8, sim_change: 8, mock_location: 15, teleport: 15, duplicate_account: 18, payout_account_reuse: 15, velocity: 10, report: 3, ledger_anomaly: 10 },
  review_threshold: 60, block_threshold: 85, hold_hours: 24, window_days: 90, velocity_max_requests_per_hour: 10,
};

export const DEMO_SUBSCRIPTION_PLANS: SubscriptionPlanRow[] = [
  { id: "22222222-2222-4000-8000-000000000001", code: "free", name: "Free", price_pkr: 0, commission_multiplier: 1, max_staff_accounts: 0, featured: false, analytics_enabled: false, is_active: true },
  { id: "22222222-2222-4000-8000-000000000002", code: "pro", name: "Pro", price_pkr: 999, commission_multiplier: 0.8, max_staff_accounts: 3, featured: false, analytics_enabled: true, is_active: true },
  { id: "22222222-2222-4000-8000-000000000003", code: "business", name: "Business", price_pkr: 2499, commission_multiplier: 0.6, max_staff_accounts: 10, featured: true, analytics_enabled: true, is_active: true },
];

export const DEMO_SUBSCRIPTIONS: SubscriptionRow[] = [
  { id: "33333333-3333-4000-8000-000000000001", provider_id: "44444444-4444-4000-8000-000000000001", plan_code: "pro", status: "active", current_period_start: "2026-11-01T00:00:00+05:00", current_period_end: "2026-12-01T00:00:00+05:00", cancel_at_period_end: false, created_at: "2026-11-01T00:00:00+05:00" },
];

export const DEMO_ESCROW_CONFIG: EscrowConfigRow = {
  auto_release_hours: 48, min_amount_paisa: 500000, payout_fee_flat_paisa: 0, payout_fee_rate: 0, payout_tax_rate: 0,
};

export const DEMO_ESCROW_HOLDS: EscrowHoldRow[] = [
  { id: "55555555-5555-4000-8000-000000000001", job_id: "66666666-6666-4000-8000-000000000001", customer_id: "77777777-7777-4000-8000-000000000001", provider_id: "44444444-4444-4000-8000-000000000001", amount_pkr: 12000, commission_paisa: 120000, status: "held", held_at: "2026-11-16T12:00:00+05:00", auto_release_at: "2026-11-18T12:00:00+05:00", released_at: null },
];

export const DEMO_PAYOUTS: PayoutRow[] = [
  { id: "88888888-8888-4000-8000-000000000001", amount_pkr: 10500, fee_paisa: 0, tax_paisa: 0, net_pkr: 10500, destination: "JazzCash", destination_phone: "+923001234567", provider_method: "jazzcash", kind: "instant", status: "requested", scheduled_for: null, executed_at: null, sandbox: true, created_at: "2026-11-16T13:00:00+05:00" },
];

export const DEMO_PROVIDER_EVIDENCE: ProviderEvidence = {
  provider_id: "44444444-4444-4000-8000-000000000001",
  face_match: { face_match_score: 0.87, verdict: "match", engine: "local-heuristic" },
  liveness: { status: "passed", challenge_id: "99999999-9999-4000-8000-000000000001" },
  ocr_extractions: [],
  rule: "Advisory only. Tier changes happen ONLY via AdminService.decideVerification by a human officer.",
};
