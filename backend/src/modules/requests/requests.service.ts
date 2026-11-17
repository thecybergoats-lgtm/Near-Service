import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../database/redis.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { CatalogService } from '../catalog/catalog.service';
import { Errors } from '../../common/errors/api-error';
import { offerWarning } from '../../common/utils/fair-range';
import { resolveCategoryId } from '../../common/utils/category-resolve';
import { withIdempotency } from '../../common/utils/idempotency';
import { toOffer } from '../offers/offers.service';
import { CreateRequestDto } from './dto';

const REQUEST_TTL_MINUTES = 10;
const WAVE1_SIZE = 10;

export function toServiceRequest(row: Record<string, unknown>) {
  const fair = row.fair_min != null ? { min: Number(row.fair_min), typical: Number(row.fair_typical), max: Number(row.fair_max), sample_size: 0 } : null;
  return { id: row.id, category_id: row.category_id, status: row.status, wave: row.wave, fair_range: fair, expires_at: row.expires_at };
}

@Injectable()
export class RequestsService {
  constructor(private db: DatabaseService, private redis: RedisService, private realtime: RealtimeService, private catalog: CatalogService) {}

  async create(customerId: string, dto: CreateRequestDto, idempotencyKey?: string) {
    return withIdempotency(this.redis, 'request', idempotencyKey, async () => {
      const categoryId = await resolveCategoryId(this.catalog.categoryLookup(), { category_id: dto.category_id, category_slug: dto.category_slug });
      const fair = await this.catalog.fairRange(categoryId, undefined);
      const expiresAt = new Date(Date.now() + REQUEST_TTL_MINUTES * 60 * 1000);
      const row = (await this.db.query(
        `INSERT INTO service_requests (customer_id, category_id, description, specs, fulfillment, location, address_id, scheduled_at, customer_offer, fair_min, fair_typical, fair_max, status, wave, radius_km, expires_at, idempotency_key)
         VALUES ($1,$2,$3,$4,$5, ST_SetSRID(ST_MakePoint($6,$7),4326)::geography,$8,$9,$10,$11,$12,$13,'BROADCASTING',1,3,$14,$15)
         RETURNING id, category_id, status, wave, fair_min, fair_typical, fair_max, expires_at`,
        [customerId, categoryId, dto.description ?? null, JSON.stringify(dto.specs ?? {}), dto.fulfillment, dto.lng, dto.lat,
         dto.address_id ?? null, dto.scheduled_at ?? null, dto.customer_offer ?? null,
         fair.sample_size < 5 ? null : fair.min, fair.sample_size < 5 ? null : fair.typical, fair.sample_size < 5 ? null : fair.max, expiresAt, idempotencyKey ?? null])).rows[0];
      const _sr = toServiceRequest(row); if (_sr.fair_range) _sr.fair_range.sample_size = fair.sample_size;
      const result = { ..._sr, offer_warning: offerWarning(dto.customer_offer ?? null, { min: fair.min, typical: fair.typical, max: fair.max, sampleSize: fair.sample_size, hidden: fair.sample_size < 5 }) };
      await this.broadcastWave(row.id as string, dto.lat, dto.lng, categoryId, 1);
      return result;
    });
  }

  async broadcastWave(requestId: string, lat: number, lng: number, categoryId: string, wave: number) {
    const providers = (await this.db.query<{ id: string; user_id: string }>(
      `SELECT p.id, p.user_id FROM provider_profiles p JOIN provider_services ps ON ps.provider_id=p.id
        WHERE ps.category_id=$1 AND ps.is_active AND p.is_online AND p.deleted_at IS NULL AND p.tier >= 0
          AND ST_DWithin(p.base_point, ST_SetSRID(ST_MakePoint($3,$2),4326)::geography, 3000)
        ORDER BY ST_Distance(p.base_point, ST_SetSRID(ST_MakePoint($3,$2),4326)::geography) ASC LIMIT $4`,
      [categoryId, lat, lng, WAVE1_SIZE])).rows;
    for (const p of providers) {
      this.realtime.emitToUser(p.user_id, 'request.new', { request_id: requestId, wave, distance_km: null, ttl_seconds: REQUEST_TTL_MINUTES * 60 });
      await this.db.query(`INSERT INTO notifications (user_id, channel, template_key, payload, status) VALUES ($1,'push','request.new',$2,'queued')`,
        [p.user_id, JSON.stringify({ request_id: requestId, wave })]).catch(() => undefined);
    }
    return { wave, notified_providers: providers.length };
  }

  async getById(id: string, userId: string) {
    const row = (await this.db.query(
      `SELECT id, category_id, status, wave, fair_min, fair_typical, fair_max, expires_at, customer_id FROM service_requests WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!row) throw Errors.notFound('Request');
    if (row.customer_id !== userId) {
      const isProvider = (await this.db.query(`SELECT 1 FROM provider_profiles WHERE user_id=$1`, [userId])).rows.length > 0;
      if (!isProvider) throw Errors.forbidden('Not your request');
    }
    const out = toServiceRequest(row);
    if (out.fair_range) {
      const n = (await this.db.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM jobs j JOIN service_requests r ON r.id=j.request_id WHERE r.category_id=$1 AND j.state IN ('COMPLETED','PAYMENT_SETTLED','RATED')`, [row.category_id])).rows[0];
      out.fair_range.sample_size = Number(n?.c ?? 0);
    }
    return out;
  }

  /** Offers on a request (OpenAPI listOffers). v1.2 OfferPage envelope;
   *  cursor is an offer id, ordered by (created_at, id). Rows go through
   *  toOffer so numeric price comes back as a JSON number, not pg's
   *  numeric-as-string (FIX 7: listOffers previously returned raw rows). */
  async listOffers(requestId: string, cursor?: string, limit = 20) {
    const lim = Math.min(Math.max(limit, 1), 100);
    const rows = (await this.db.query(
      `SELECT id, request_id, provider_id, offered_by, round, price, eta_minutes, status, expires_at FROM offers WHERE request_id=$1
         AND ($2::text IS NULL OR (created_at, id) < (SELECT created_at, id FROM offers WHERE id=$2::uuid))
       ORDER BY created_at DESC, id DESC LIMIT $3`, [requestId, cursor ?? null, lim + 1])).rows;
    const hasMore = rows.length > lim;
    const page = (hasMore ? rows.slice(0, lim) : rows).map((r) => toOffer(r as unknown as Record<string, unknown>));
    return { items: page, next_cursor: hasMore ? String(page[page.length - 1].id) : null };
  }

  async cancel(requestId: string, userId: string, idempotencyKey?: string) {
    return withIdempotency(this.redis, 'request-cancel', idempotencyKey, async () => {
      const row = (await this.db.query(
        `UPDATE service_requests SET status='CANCELLED', updated_at=now() WHERE id=$1 AND customer_id=$2 AND status IN ('DRAFT','BROADCASTING','OFFERS_RECEIVED') RETURNING id, status`,
        [requestId, userId])).rows[0];
      if (!row) throw Errors.conflict('CANNOT_CANCEL', 'Request cannot be cancelled in its current state');
      return { status: 'CANCELLED', fee_due: 0 }; // Phase 1: free cancellation before acceptance
    });
  }

  /** Join the area waitlist (OpenAPI joinWaitlist). Idempotent per user +
   *  category + geo cell: re-joining the same cell returns the existing
   *  entry. CELL SIZE, HONESTLY: lat/lng are rounded to 3 decimals, i.e.
   *  ~110 m cells (0.001 deg lat ~ 111 m; lng a little less at Quetta's
   *  latitude) — the contract text says "~500 m" but the implementation
   *  keys on ~110 m cells. No ON CONFLICT: SELECT-then-insert plus the
   *  unique index (user_id, category_id, cell_lat, cell_lng) in 0006. */
  async joinWaitlist(userId: string, dto: { category_id?: string; category_slug?: string; lat: number; lng: number }, idempotencyKey?: string) {
    return withIdempotency(this.redis, 'waitlist', idempotencyKey, async () => {
      const categoryId = await resolveCategoryId(this.catalog.categoryLookup(), { category_id: dto.category_id, category_slug: dto.category_slug });
      if (typeof dto.lat !== 'number' || dto.lat < -90 || dto.lat > 90 || typeof dto.lng !== 'number' || dto.lng < -180 || dto.lng > 180) {
        throw Errors.unprocessable('INVALID_LOCATION', 'lat must be -90..90 and lng -180..180');
      }
      const cellLat = Number(dto.lat.toFixed(3));
      const cellLng = Number(dto.lng.toFixed(3));
      const existing = (await this.db.query(
        `SELECT id, category_id, ST_Y(point::geometry) AS lat, ST_X(point::geometry) AS lng, status, created_at
         FROM waitlist WHERE user_id=$1 AND category_id=$2 AND cell_lat=$3 AND cell_lng=$4`,
        [userId, categoryId, cellLat, cellLng])).rows[0];
      if (existing) return this.toWaitlistEntry(existing);
      const row = (await this.db.query(
        `INSERT INTO waitlist (user_id, category_id, point, cell_lat, cell_lng, status)
         VALUES ($1,$2, ST_SetSRID(ST_MakePoint($4,$3),4326)::geography, $3, $4, 'waiting')
         RETURNING id, category_id, ST_Y(point::geometry) AS lat, ST_X(point::geometry) AS lng, status, created_at`,
        [userId, categoryId, cellLat, cellLng])).rows[0];
      return this.toWaitlistEntry(row);
    });
  }
  private toWaitlistEntry(row: Record<string, unknown>) {
    return { id: row.id, category_id: row.category_id, lat: Number(row.lat), lng: Number(row.lng), status: row.status ?? 'waiting', created_at: row.created_at };
  }

  /** Fetch the chat for a request (OpenAPI getRequestChat). One chat is
   *  created per request and stays attached to its job; 404 when no chat
   *  exists yet for the request. Customer or provider of the chat only. */
  async getRequestChat(requestId: string, userId: string) {
    const req = (await this.db.query(`SELECT customer_id FROM service_requests WHERE id=$1 AND deleted_at IS NULL`, [requestId])).rows[0];
    if (!req) throw Errors.notFound('Request');
    const chat = (await this.db.query(
      `SELECT c.*, p.user_id AS provider_user_id FROM chats c JOIN provider_profiles p ON p.id=c.provider_id WHERE c.request_id=$1`,
      [requestId])).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!chat) throw Errors.notFound('Chat');
    if (req.customer_id !== userId && chat.provider_user_id !== userId) throw Errors.forbidden('Not a participant');
    const { provider_user_id: _omit, ...out } = chat;
    return out;
  }
}
