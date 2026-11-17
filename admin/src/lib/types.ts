// Near Service Admin — shared types (aligned with PRD §15–17 and the API contract).
export type AdminRole =
  | "super_admin"
  | "verification_officer"
  | "support_agent"
  | "finance"
  | "marketing"
  | "city_manager";

export interface ApiErrorShape {
  error: { code: string; message: string };
}

export interface AuthUser {
  id: string;
  phone: string;
  full_name?: string;
  role: AdminRole;
  city_id?: string | null;
}

export interface Kpis {
  gmv_pkr: number;
  jobs_total: number;
  take_rate_pct: number;
  active_users: number;
  active_providers: number;
  acceptance_rate_pct: number;
  time_to_first_offer_seconds: number;
  cancellation_rate_pct: number;
  // Phase 2 contract aliases (GET /admin/kpis may return these names instead
  // of the *_pct ones). Dashboard normalises both; see lib/api.ts normalizeKpis.
  take_rate?: number | null;
  acceptance_rate?: number | null;
  cancellation_rate?: number | null;
  // Optional extras the backend may return; dashboard tolerates absence.
  nps?: number | null;
  disputes_open?: number;
  verifications_pending?: number;
}

export type VerificationStatus = "pending" | "approved" | "rejected" | "reupload_requested";
export type Tier = 0 | 1 | 2 | 3;

export interface VerificationItem {
  id: string; // document/group id (uuid) — path param {documentId} for the decide call
  provider_id: string;
  provider_name: string;
  provider_type: "SHOP" | "INDIVIDUAL" | "TEAM";
  phone: string;
  city: string;
  categories: string[];
  tier_requested: Tier;
  current_tier: Tier;
  // Phase 1 is MANUAL review only (PRD v1.1 / OpenAPI adminListVerifications):
  // no OCR data and no face-match scores. Those fields arrive in Phase 2/3.
  documents: { doc_type: string; review_status: VerificationStatus; url?: string | null }[];
  submitted_at: string;
  status: VerificationStatus;
  review_note?: string | null;
}

/** Append-only audit trail entry (GET /admin/audit-logs, cursor-paginated, read-only). */
export interface AuditLogEntry {
  id: string;
  actor_id?: string | null;
  actor_name?: string | null;
  actor_role?: string | null;
  action: string;
  entity_type?: string | null;
  entity_id?: string | null;
  detail?: string | null;
  created_at: string;
}

export type UserStatus = "active" | "suspended" | "banned";

export interface AdminUserRow {
  id: string;
  phone: string;
  full_name: string;
  roles: string[];
  status: UserStatus;
  is_provider: boolean;
  provider_tier?: Tier | null;
  city: string;
  jobs_completed: number;
  rating_avg: number;
  created_at: string;
}

export interface CategoryNode {
  id: string; // UUID (OpenAPI Category.id, format: uuid) — category_id end-to-end.
  parent_id: string | null; // UUID or null
  level: 1 | 2 | 3;
  slug: string; // separate resolver field — NEVER send the slug as category_id
  name_en: string;
  name_ur?: string | null;
  name_roman?: string | null;
  icon_key?: string | null;
  is_active: boolean;
  sort_order: number;
  keywords?: { keyword: string; locale: string; kind: string }[];
  children?: CategoryNode[];
}

export type RequestStatus =
  | "DRAFT"
  | "BROADCASTING"
  | "OFFERS_RECEIVED"
  | "ACCEPTED"
  | "EXPIRED"
  | "CANCELLED";

export interface ServiceRequestRow {
  id: string;
  customer_name: string;
  customer_phone: string;
  category_name: string;
  description: string;
  customer_offer_pkr: number | null;
  fair_min_pkr: number | null;
  fair_typical_pkr: number | null;
  fair_max_pkr: number | null;
  fulfillment: "VISIT_SHOP" | "PROVIDER_COMES" | "PICKUP_DELIVERY";
  status: RequestStatus;
  offers_count: number;
  city: string;
  created_at: string;
  expires_at?: string | null;
}

export type JobState =
  | "ACCEPTED"
  | "PROVIDER_EN_ROUTE"
  | "CUSTOMER_EN_ROUTE"
  | "ITEM_PICKED_UP"
  | "ARRIVED"
  | "IN_PROGRESS"
  | "PRICE_ADJUSTMENT_PENDING"
  | "COMPLETED"
  | "PAYMENT_SETTLED"
  | "RATED"
  | "CANCELLED_BY_CUSTOMER"
  | "CANCELLED_BY_PROVIDER"
  | "EXPIRED"
  | "DISPUTED"
  | "REFUNDED";

export interface JobEvent {
  id: number | string;
  from_state: string | null;
  to_state: string;
  actor_role?: string | null;
  actor_name?: string | null;
  created_at: string;
  note?: string | null;
}

export interface JobRow {
  id: string;
  request_id: string;
  customer_name: string;
  provider_name: string;
  category_name: string;
  agreed_price_pkr: number;
  final_price_pkr: number;
  commission_rate: number;
  commission_amount_pkr: number;
  state: JobState;
  payment_method: string;
  payment_status: string;
  city: string;
  created_at: string;
  completed_at?: string | null;
  events?: JobEvent[];
}

export type DisputeStatus = "open" | "in_review" | "resolved" | "escalated";
export type DisputeOutcome =
  | "refund"
  | "partial_refund"
  | "compensation"
  | "compensation_credit"
  | "no_action"
  | null;

/** One piece of evidence attached to a dispute (Phase 2). */
export interface DisputeEvidence {
  id: string;
  kind: "photo" | "chat" | "gps" | string;
  storage_key: string;
  note?: string | null;
  created_at: string;
}

export interface DisputeResolution {
  outcome: Exclude<DisputeOutcome, null>;
  amount_pkr?: number | null;
  note?: string | null;
  resolved_by?: string | null;
  resolved_at?: string | null;
}

export interface DisputeRow {
  id: string;
  job_id: string;
  opened_by: string;
  opened_by_role: "customer" | "provider";
  reason: string;
  reason_code?: string | null;
  description: string;
  status: DisputeStatus;
  outcome: DisputeOutcome;
  sla_first_response_due: string;
  sla_resolution_due: string;
  // Phase 2 contract aliases for the SLA deadlines.
  sla_first_response_at?: string | null;
  sla_resolve_at?: string | null;
  /** Server-computed breach flag (Phase 2). Client also derives it from the due dates. */
  breached?: boolean | null;
  assigned_to?: string | null;
  evidence?: DisputeEvidence[];
  resolution?: DisputeResolution | null;
  amount_pkr: number;
  created_at: string;
  evidence_count: number;
}

/** Commission rule (Phase 2, PRD §9). rate is a percent in the 5–15 band. */
export interface CommissionRule {
  id: string;
  category_id?: string | null;
  city_id?: string | null;
  tier?: number | null;
  rate: number;
  valid_from: string;
  valid_to?: string | null;
  is_promo: boolean;
}

/** Promo code (Phase 2). kind percent = % off, fixed = flat PKR off. */
export interface Promo {
  id: string;
  code: string;
  kind: "percent" | "fixed";
  value: number;
  max_uses?: number | null;
  per_user_limit?: number | null;
  valid_from?: string | null;
  valid_to?: string | null;
  category_id?: string | null;
  city_id?: string | null;
  first_job_only?: boolean | null;
  is_active: boolean;
  uses_count?: number | null;
}

/** Dynamic request-form schema for one category (Phase 2, PRD §5). */
export interface CategoryFormSchema {
  category_id: string;
  slug: string;
  name_en: string;
  form_schema: Record<string, unknown> | null;
}

/** ---- Phase 3 (v1.5) ---- */

/** One user's risk score (GET /risk/me, GET /admin/risk/review-queue). */
export interface RiskScoreRow {
  user_id: string;
  score: number;
  level: "low" | "medium" | "high" | "critical";
  breakdown: Record<string, { count: number; weight: number; points: number }>;
  hold_until?: string | null;
  updated_at?: string | null;
  phone?: string | null;
  full_name?: string | null;
  status?: string | null;
}

export interface RiskSettings {
  weights: Record<string, number>;
  review_threshold: number;
  block_threshold: number;
  hold_hours: number;
  window_days: number;
  velocity_max_requests_per_hour: number;
}

export interface SubscriptionPlanRow {
  id: string;
  code: "free" | "pro" | "business";
  name: string;
  price_pkr: number;
  commission_multiplier: number;
  max_staff_accounts: number;
  featured: boolean;
  analytics_enabled: boolean;
  is_active: boolean;
}

export interface SubscriptionRow {
  id: string;
  provider_id: string;
  plan_code: string;
  status: "active" | "cancelled" | "expired" | "none";
  current_period_start?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  created_at?: string;
}

export interface EscrowHoldRow {
  id: string;
  job_id: string;
  customer_id: string;
  provider_id: string;
  amount_pkr: number;
  commission_paisa: number;
  status: "held" | "released" | "refunded";
  held_at: string;
  auto_release_at: string;
  released_at?: string | null;
}

export interface PayoutRow {
  id: string;
  amount_pkr: number;
  fee_paisa: number;
  tax_paisa: number;
  net_pkr: number;
  destination: string;
  destination_phone?: string | null;
  provider_method?: string | null;
  kind: "instant" | "scheduled";
  status: "requested" | "approved" | "scheduled" | "executed" | "rejected" | "failed";
  scheduled_for?: string | null;
  executed_at?: string | null;
  sandbox: boolean;
  created_at: string;
}

export interface EscrowConfigRow {
  auto_release_hours: number;
  min_amount_paisa: number;
  payout_fee_flat_paisa: number;
  payout_fee_rate: number;
  payout_tax_rate: number;
}

/** Advisory verification assists for one provider (face-match + liveness + OCR).
 *  Never approves or rejects anything — the officer still decides. */
export interface ProviderEvidence {
  provider_id: string;
  face_match: { face_match_score?: number | null; verdict?: string | null; engine?: string | null } | null;
  liveness: { status?: string | null; challenge_id?: string | null } | null;
  ocr_extractions: unknown[];
  rule: string;
}

/** ---- Phase 4 (v1.6) ----
 *  Row types mirroring the local helpers in the new Phase 4 admin pages
 *  (admin/src/app/search-metrics, analytics, cities, partners, warranty).
 *  The pages still use their local copies; these are the shared surface
 *  for lib/api.ts and future pages. */

/** Search scale-out (item 1) — GET /admin/search/metrics + /gate. */
export interface SearchWindowStats {
  window_hours: number;
  queries: number;
  zero_result_queries: number;
  zero_result_rate: number;
  cache_hits: number;
  cache_hit_rate: number;
  clicks: number;
  click_through_rate: number | null; // null = no clicks recorded yet ("no data", never 0%)
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  queries_per_day: number;
}

export interface SearchGateThresholds {
  p95_latency_ms: number;
  zero_result_rate: number;
  ctr_floor: number;
  queries_per_day: number;
  min_queries_for_gate: number;
  window_hours: number;
}

export interface SearchGateEvaluation {
  decision: "stay_in_process" | "switch_on_dedicated_tier";
  reasons: string[];
  breached: string[];
  stats: SearchWindowStats;
  thresholds: SearchGateThresholds;
  evaluated_at: string;
}

export interface SearchDailyRow {
  day: string;
  provider: string;
  queries: number;
  zero_result_queries: number;
  cache_hits: number;
  clicks: number;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
}

export interface SearchMetricsView {
  window: SearchWindowStats;
  gate: SearchGateEvaluation;
  daily: SearchDailyRow[];
}

/** Analytics warehouse (item 2) — GET /admin/analytics/*. */
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

export interface AnalyticsFunnel {
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

export interface AnalyticsRevenueRow {
  key: string;
  label: string;
  jobs: number;
  completedJobs: number;
  revenuePkr: number;
  commissionPkr: number;
}

export interface AnalyticsSupplyDemand {
  demandByHour: { city: string; hour: number; requests: number; withOffers: number }[];
  supplyByCity: { city: string; providersTotal: number; providersOnline: number }[];
}

/** Multi-city ops (item 3) — /admin/cities/*. */
export type CityStatus = "planned" | "in_preparation" | "gate_review" | "live" | "paused";

export interface City {
  id: string;
  name: string;
  slug: string;
  status: CityStatus;
  is_launched: boolean;
  launched_at: string | null;
  default_radius_km: number;
  supply_target_providers: number;
  population_estimate: number | null;
  manager_id: string | null;
}

export interface CityGateConfig {
  min_providers: number;
  min_supply_density_per_100k: number;
  min_fill_rate: number;
  max_time_to_first_offer_seconds: number;
}

export interface CityGateEvaluation {
  id: string;
  evaluated_at: string;
  passed: boolean;
  metrics: {
    providerCount: number;
    supplyDensityPer100k: number | null;
    fillRate: number | null;
    timeToFirstOfferSeconds: number | null;
  };
  results: Record<string, { value: number | null; threshold: number; passed: boolean; reason: string | null }>;
}

export interface CityChecklistItem {
  id: string;
  item_key: string;
  label: string;
  done: boolean;
}

export interface CityCategoryOverride {
  city_id: string;
  category_id: string;
  is_enabled: boolean;
  sort_order: number;
  slug: string;
  name_en: string;
}

export interface CityEffectiveCommission {
  rate: number;
  ruleId: string | null;
  source: string;
}

export interface CityFairPrice {
  minPrice: number;
  typicalPrice: number;
  maxPrice: number;
  sampleSize: number;
  source: "city" | "global";
}

/** Warranty product (item 4) — /admin/warranty/*. */
export type WarrantyClaimStatus =
  | "filed"
  | "under_review"
  | "rework_offered"
  | "rework_done"
  | "rework_failed"
  | "refunded"
  | "rejected"
  | "closed";

export interface WarrantyClaimRow {
  id: string;
  job_id: string;
  customer_id: string;
  provider_id: string;
  status: WarrantyClaimStatus | string;
  reason: string;
  description: string;
  rework_note: string | null;
  refund_amount_pkr: number | null;
  decision_reason: string | null;
  filed_at: string;
}

export interface WarrantyConfigRow {
  fee_rate: number;
  fee_flat_paisa: number;
  fee_min_paisa: number;
  fee_max_paisa: number;
  claim_window_days: number;
}

export interface WarrantyRulesRow {
  version: number;
  title: string;
  body_md: string;
  is_current?: boolean;
  created_at?: string;
}

/** Partner integrations (item 5) — /admin/partners*. */
export interface PartnerRow {
  id: string;
  name: string;
  slug: string;
  kind: string;
  city: string | null;
  affiliate_fee_rate: number;
  is_active: boolean;
}

export interface PartnerOrderRow {
  id: string;
  job_id: string;
  partner_name: string;
  status: string;
  total_pkr: number;
  affiliate_fee_pkr: number;
  placed_at: string;
  partner_disclosure: { text: string };
}

export interface PartnerFeeReportRow {
  partner_id: string;
  partner_name: string;
  orders_placed: number;
  orders_confirmed: number;
  orders_delivered: number;
  orders_cancelled: number;
  gross_parts_pkr: number;
  affiliate_fee_earned_pkr: number;
}

export interface PartnerFeeReport {
  partners: PartnerFeeReportRow[];
  totals: { gross_parts_paisa: number; affiliate_fee_earned_paisa: number; orders: number };
  ledger_check: { txns_checked: number; mismatches: { txn_id: string; diff_paisa: number }[] };
}
