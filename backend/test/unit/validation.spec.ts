// FIX 6 (Stage 2) — request validation.
// Boots the real app (global ValidationPipe + AllExceptionsFilter, exactly
// like main.ts) and posts invalid values to every endpoint that takes a
// body or a query. Every case must be 422 VALIDATION_FAILED in the shared
// error shape, naming the failing field in details.fields. A valid request
// must still succeed (OTP request needs no DB; the POST /requests happy
// path runs only when DATABASE_URL is set, against the seeded test DB).
//
// Rate limits are flushed before each case (rl:* keys in real Redis, the
// in-memory map otherwise) so FIX 9 counting can never turn a 422 into a
// 429 here. Run the suite with --runInBand when REDIS_URL is set, so two
// spec files cannot share one IP bucket in the same window.
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import Redis from 'ioredis';
import { Client } from 'pg';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/http-exception.filter';
import { createValidationPipe } from '../../src/common/validation/validation-pipe';
import { RedisService } from '../../src/database/redis.service';
import { env } from '../../src/config/env';

jest.setTimeout(30000);

const CUSTOMER_ID = 'c0000001-4000-4000-8000-000000000001';
// Per-run unique phone for the valid-OTP test: the service limits OTP
// requests to 5/hour per phone (FIX 3) and the counter lives in real Redis
// across runs — a fixed phone would 429 after a few full-suite runs.
const RUN_PHONE = `+92300${crypto.randomInt(100000, 999999)}1`;
const PROVIDER_ID = 'c0000002-4000-4000-8000-000000000002';
const ADMIN_ID = 'c0000003-4000-4000-8000-000000000003';
const REQ_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const CHAT_ID = '33333333-3333-4333-8333-333333333333';
const DISPUTE_ID = '44444444-4444-4444-8444-444444444444';

function token(sub: string, roles: string[]) {
  return jwt.sign({ sub, phone: '+923001234567', roles }, env.jwtAccessSecret, { expiresIn: 600 });
}
const CUSTOMER = token(CUSTOMER_ID, ['customer']);
const PROVIDER = token(PROVIDER_ID, ['provider']);
const ADMIN = token(ADMIN_ID, ['super_admin']);

const VALID_REQUEST = { category_slug: 'ac-repair', fulfillment: 'PROVIDER_COMES', lat: 30.18, lng: 66.99, description: 'Fix my AC' };
const VALID_OFFER = { price: 2500, eta_minutes: 60 };

interface Case {
  name: string;
  method: 'post' | 'get' | 'patch' | 'put';
  url: string;
  token?: string;
  body?: Record<string, unknown>;
  field: string;
}

const CASES: Case[] = [
  // ---- auth (public) ----
  { name: 'otp/request: bad phone', method: 'post', url: '/api/v1/auth/otp/request', body: { phone: '12345' }, field: 'phone' },
  { name: 'otp/verify: short code', method: 'post', url: '/api/v1/auth/otp/verify', body: { phone: '+923001234567', code: '12', device_fingerprint: 'fp' }, field: 'code' },
  { name: 'otp/verify: bad phone', method: 'post', url: '/api/v1/auth/otp/verify', body: { phone: '03001234567', code: '123456', device_fingerprint: 'fp' }, field: 'phone' },
  { name: 'otp/verify: bad language', method: 'post', url: '/api/v1/auth/otp/verify', body: { phone: '+923001234567', code: '123456', device_fingerprint: 'fp', language: 'xx' }, field: 'language' },
  { name: 'refresh: empty token', method: 'post', url: '/api/v1/auth/refresh', body: { refresh_token: '' }, field: 'refresh_token' },
  { name: 'refresh: missing token', method: 'post', url: '/api/v1/auth/refresh', body: {}, field: 'refresh_token' },
  // ---- POST /requests ----
  { name: 'request: lat 999', method: 'post', url: '/api/v1/requests', token: CUSTOMER, body: { ...VALID_REQUEST, lat: 999 }, field: 'lat' },
  { name: 'request: lng -181', method: 'post', url: '/api/v1/requests', token: CUSTOMER, body: { ...VALID_REQUEST, lng: -181 }, field: 'lng' },
  { name: 'request: offer -5', method: 'post', url: '/api/v1/requests', token: CUSTOMER, body: { ...VALID_REQUEST, customer_offer: -5 }, field: 'customer_offer' },
  { name: 'request: offer 0', method: 'post', url: '/api/v1/requests', token: CUSTOMER, body: { ...VALID_REQUEST, customer_offer: 0 }, field: 'customer_offer' },
  { name: 'request: offer 3 decimals', method: 'post', url: '/api/v1/requests', token: CUSTOMER, body: { ...VALID_REQUEST, customer_offer: 10.555 }, field: 'customer_offer' },
  { name: 'request: offer over max', method: 'post', url: '/api/v1/requests', token: CUSTOMER, body: { ...VALID_REQUEST, customer_offer: 10000001 }, field: 'customer_offer' },
  { name: 'request: 5000-char description', method: 'post', url: '/api/v1/requests', token: CUSTOMER, body: { ...VALID_REQUEST, description: 'x'.repeat(5000) }, field: 'description' },
  { name: 'request: bad category_id UUID', method: 'post', url: '/api/v1/requests', token: CUSTOMER, body: { ...VALID_REQUEST, category_id: 'not-a-uuid' }, field: 'category_id' },
  { name: 'request: wrong fulfillment enum', method: 'post', url: '/api/v1/requests', token: CUSTOMER, body: { ...VALID_REQUEST, fulfillment: 'WRONG' }, field: 'fulfillment' },
  { name: 'request: neither category', method: 'post', url: '/api/v1/requests', token: CUSTOMER, body: { fulfillment: 'PROVIDER_COMES', lat: 30.18, lng: 66.99 }, field: 'category_id' },
  { name: 'request: unknown field rejected', method: 'post', url: '/api/v1/requests', token: CUSTOMER, body: { ...VALID_REQUEST, hacker: 1 }, field: 'hacker' },
  { name: 'request: bad address_id UUID', method: 'post', url: '/api/v1/requests', token: CUSTOMER, body: { ...VALID_REQUEST, address_id: 'bad' }, field: 'address_id' },
  { name: 'request: bad scheduled_at', method: 'post', url: '/api/v1/requests', token: CUSTOMER, body: { ...VALID_REQUEST, scheduled_at: 'not-a-date' }, field: 'scheduled_at' },
  // ---- offers ----
  { name: 'offer: price -5', method: 'post', url: `/api/v1/requests/${REQ_ID}/offers`, token: PROVIDER, body: { price: -5 }, field: 'price' },
  { name: 'offer: price 0', method: 'post', url: `/api/v1/requests/${REQ_ID}/offers`, token: PROVIDER, body: { price: 0 }, field: 'price' },
  { name: 'offer: price 3 decimals', method: 'post', url: `/api/v1/requests/${REQ_ID}/offers`, token: PROVIDER, body: { price: 10.555 }, field: 'price' },
  { name: 'offer: 600-char note', method: 'post', url: `/api/v1/requests/${REQ_ID}/offers`, token: PROVIDER, body: { ...VALID_OFFER, note: 'x'.repeat(600) }, field: 'note' },
  { name: 'offer: eta 0', method: 'post', url: `/api/v1/requests/${REQ_ID}/offers`, token: PROVIDER, body: { ...VALID_OFFER, eta_minutes: 0 }, field: 'eta_minutes' },
  { name: 'counter: price -1', method: 'post', url: `/api/v1/offers/${REQ_ID}/counter`, token: CUSTOMER, body: { price: -1 }, field: 'price' },
  { name: 'decline: 150-char reason', method: 'post', url: `/api/v1/offers/${REQ_ID}/decline`, token: PROVIDER, body: { reason_code: 'x'.repeat(150) }, field: 'reason_code' },
  // ---- waitlist ----
  { name: 'waitlist: lat 999', method: 'post', url: '/api/v1/waitlist', token: CUSTOMER, body: { category_slug: 'ac-repair', lat: 999, lng: 66.99 }, field: 'lat' },
  { name: 'waitlist: neither category', method: 'post', url: '/api/v1/waitlist', token: CUSTOMER, body: { lat: 30.18, lng: 66.99 }, field: 'category_id' },
  // ---- jobs ----
  { name: 'transition: bad state', method: 'post', url: `/api/v1/jobs/${JOB_ID}/transition`, token: CUSTOMER, body: { to_state: 'WRONG' }, field: 'to_state' },
  { name: 'transition: lat 999', method: 'post', url: `/api/v1/jobs/${JOB_ID}/transition`, token: CUSTOMER, body: { to_state: 'ACCEPTED', lat: 999 }, field: 'lat' },
  { name: 'adjustment: negative amount', method: 'post', url: `/api/v1/jobs/${JOB_ID}/adjustments`, token: CUSTOMER, body: { items: [{ label: 'part', amount: -5 }], reason: 'extra part' }, field: 'items[0].amount' },
  { name: 'adjustment: 3000-char reason', method: 'post', url: `/api/v1/jobs/${JOB_ID}/adjustments`, token: CUSTOMER, body: { items: [{ label: 'part', amount: 100 }], reason: 'x'.repeat(3000) }, field: 'reason' },
  { name: 'review: stars 6', method: 'post', url: `/api/v1/jobs/${JOB_ID}/reviews`, token: CUSTOMER, body: { stars: 6 }, field: 'stars' },
  { name: 'review: stars 0', method: 'post', url: `/api/v1/jobs/${JOB_ID}/reviews`, token: CUSTOMER, body: { stars: 0 }, field: 'stars' },
  { name: 'review: 1500-char comment', method: 'post', url: `/api/v1/jobs/${JOB_ID}/reviews`, token: CUSTOMER, body: { stars: 5, comment: 'x'.repeat(1500) }, field: 'comment' },
  { name: 'review: 11 tags', method: 'post', url: `/api/v1/jobs/${JOB_ID}/reviews`, token: CUSTOMER, body: { stars: 5, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, field: 'tags' },
  { name: 'reschedule: bad date', method: 'post', url: `/api/v1/jobs/${JOB_ID}/reschedule`, token: CUSTOMER, body: { scheduled_at: 'tomorrow-ish' }, field: 'scheduled_at' },
  { name: 'recurring: bad frequency', method: 'post', url: '/api/v1/recurring-jobs', token: CUSTOMER, body: { ...VALID_REQUEST, frequency: 'daily', starts_at: '2026-12-01T00:00:00Z' }, field: 'frequency' },
  { name: 'recurring: lat 999', method: 'post', url: '/api/v1/recurring-jobs', token: CUSTOMER, body: { ...VALID_REQUEST, frequency: 'weekly', day_of_week: 1, starts_at: '2026-12-01T00:00:00Z', lat: 999 }, field: 'lat' },
  { name: 'recurring: day_of_week 7', method: 'post', url: '/api/v1/recurring-jobs', token: CUSTOMER, body: { ...VALID_REQUEST, frequency: 'weekly', day_of_week: 7, starts_at: '2026-12-01T00:00:00Z' }, field: 'day_of_week' },
  { name: 'recurring: bad starts_at', method: 'post', url: '/api/v1/recurring-jobs', token: CUSTOMER, body: { ...VALID_REQUEST, frequency: 'weekly', day_of_week: 1, starts_at: 'not-a-date' }, field: 'starts_at' },
  { name: 'recurring: neither category', method: 'post', url: '/api/v1/recurring-jobs', token: CUSTOMER, body: { fulfillment: 'PROVIDER_COMES', lat: 30.18, lng: 66.99, frequency: 'weekly', day_of_week: 1, starts_at: '2026-12-01T00:00:00Z' }, field: 'category_id' },
  { name: 'recurring patch: bad status', method: 'patch', url: `/api/v1/recurring-jobs/${REQ_ID}`, token: CUSTOMER, body: { status: 'WRONG' }, field: 'status' },
  { name: 'jobs list: bad role', method: 'get', url: '/api/v1/jobs?role=WRONG', token: CUSTOMER, field: 'role' },
  { name: 'jobs list: bad state', method: 'get', url: '/api/v1/jobs?state=WRONG', token: CUSTOMER, field: 'state' },
  { name: 'jobs list: limit 101', method: 'get', url: '/api/v1/jobs?limit=101', token: CUSTOMER, field: 'limit' },
  { name: 'chats list: bad job_id', method: 'get', url: '/api/v1/chats?job_id=bad', token: CUSTOMER, field: 'job_id' },
  // ---- messaging ----
  { name: 'message: 3000-char body', method: 'post', url: `/api/v1/chats/${CHAT_ID}/messages`, token: CUSTOMER, body: { body: 'x'.repeat(3000) }, field: 'body' },
  { name: 'message: bad kind', method: 'post', url: `/api/v1/chats/${CHAT_ID}/messages`, token: CUSTOMER, body: { body: 'hi', kind: 'WRONG' }, field: 'kind' },
  { name: 'messages list: limit 0', method: 'get', url: `/api/v1/chats/${CHAT_ID}/messages?limit=0`, token: CUSTOMER, field: 'limit' },
  { name: 'messages list: limit abc', method: 'get', url: `/api/v1/chats/${CHAT_ID}/messages?limit=abc`, token: CUSTOMER, field: 'limit' },
  // ---- trust ----
  { name: 'dispute: 3000-char description', method: 'post', url: `/api/v1/jobs/${JOB_ID}/disputes`, token: CUSTOMER, body: { description: 'x'.repeat(3000) }, field: 'description' },
  { name: 'evidence: bad kind', method: 'post', url: `/api/v1/disputes/${DISPUTE_ID}/evidence`, token: CUSTOMER, body: { kind: 'WRONG' }, field: 'kind' },
  { name: 'report: bad reported_id', method: 'post', url: '/api/v1/reports', token: CUSTOMER, body: { reported_id: 'bad' }, field: 'reported_id' },
  { name: 'block: bad blocked_id', method: 'post', url: '/api/v1/blocks', token: CUSTOMER, body: { blocked_id: 'bad' }, field: 'blocked_id' },
  { name: 'sos: lat 999', method: 'post', url: '/api/v1/sos', token: CUSTOMER, body: { lat: 999, lng: 66.99 }, field: 'lat' },
  { name: 'sos: bad job_id', method: 'post', url: '/api/v1/sos', token: CUSTOMER, body: { job_id: 'bad' }, field: 'job_id' },
  { name: 'disputes list: bad role', method: 'get', url: '/api/v1/disputes?role=WRONG', token: CUSTOMER, field: 'role' },
  // ---- wallet / promos / commission ----
  { name: 'topup: amount -5', method: 'post', url: '/api/v1/wallet/topup', token: CUSTOMER, body: { method: 'jazzcash', amount_pkr: -5, phone: '+923001234567' }, field: 'amount_pkr' },
  { name: 'topup: amount 3 decimals', method: 'post', url: '/api/v1/wallet/topup', token: CUSTOMER, body: { method: 'jazzcash', amount_pkr: 10.555, phone: '+923001234567' }, field: 'amount_pkr' },
  { name: 'topup: bad phone', method: 'post', url: '/api/v1/wallet/topup', token: CUSTOMER, body: { method: 'jazzcash', amount_pkr: 100, phone: '123' }, field: 'phone' },
  { name: 'topup: bad method', method: 'post', url: '/api/v1/wallet/topup', token: CUSTOMER, body: { method: 'cash', amount_pkr: 100, phone: '+923001234567' }, field: 'method' },
  { name: 'topup confirm: empty payment_id', method: 'post', url: '/api/v1/wallet/topup/confirm', token: CUSTOMER, body: { payment_id: '' }, field: 'payment_id' },
  { name: 'pay-wallet: 50-char promo', method: 'post', url: `/api/v1/jobs/${JOB_ID}/pay-wallet`, token: CUSTOMER, body: { promo_code: 'x'.repeat(50) }, field: 'promo_code' },
  { name: 'promo validate: amount -1', method: 'post', url: '/api/v1/promos/validate', token: CUSTOMER, body: { code: 'FIRSTJOB10', amount_pkr: -1 }, field: 'amount_pkr' },
  { name: 'promo validate: bad category_id', method: 'post', url: '/api/v1/promos/validate', token: CUSTOMER, body: { code: 'FIRSTJOB10', category_id: 'bad' }, field: 'category_id' },
  { name: 'referral claim: 50-char code', method: 'post', url: '/api/v1/referrals/claim', token: CUSTOMER, body: { code: 'x'.repeat(50) }, field: 'code' },
  { name: 'promo create: value -5', method: 'post', url: '/api/v1/admin/promos', token: ADMIN, body: { code: 'X1', kind: 'fixed', value: -5 }, field: 'value' },
  { name: 'promo create: bad kind', method: 'post', url: '/api/v1/admin/promos', token: ADMIN, body: { code: 'X1', kind: 'WRONG', value: 10 }, field: 'kind' },
  { name: 'promo create: max_uses 0', method: 'post', url: '/api/v1/admin/promos', token: ADMIN, body: { code: 'X1', kind: 'fixed', value: 10, max_uses: 0 }, field: 'max_uses' },
  { name: 'commission rule: rate 0.5', method: 'post', url: '/api/v1/admin/commission-rules', token: ADMIN, body: { rate: 0.5, valid_from: '2026-01-01T00:00:00Z' }, field: 'rate' },
  { name: 'commission rule: rate 0.01', method: 'post', url: '/api/v1/admin/commission-rules', token: ADMIN, body: { rate: 0.01, valid_from: '2026-01-01T00:00:00Z' }, field: 'rate' },
  { name: 'commission rule: bad valid_from', method: 'post', url: '/api/v1/admin/commission-rules', token: ADMIN, body: { rate: 0.1, valid_from: 'bad' }, field: 'valid_from' },
  // ---- providers ----
  { name: 'onboarding: bad step', method: 'post', url: '/api/v1/providers/onboarding', token: PROVIDER, body: { step: 'WRONG', data: {} }, field: 'step' },
  { name: 'online: lat 999', method: 'patch', url: '/api/v1/providers/me/online', token: PROVIDER, body: { is_online: true, lat: 999, lng: 66.99 }, field: 'lat' },
  { name: 'services: negative price', method: 'put', url: '/api/v1/providers/me/services', token: PROVIDER, body: { services: [{ category_slug: 'ac-repair', starting_price: -5 }] }, field: 'services[0].starting_price' },
  { name: 'services: neither category', method: 'put', url: '/api/v1/providers/me/services', token: PROVIDER, body: { services: [{ starting_price: 100 }] }, field: 'services[0].category_id' },
  { name: 'service-area: radius 0', method: 'put', url: '/api/v1/providers/me/service-area', token: PROVIDER, body: { center: { lat: 30.18, lng: 66.99 }, radius_km: 0 }, field: 'radius_km' },
  { name: 'service-area: both shapes', method: 'put', url: '/api/v1/providers/me/service-area', token: PROVIDER, body: { center: { lat: 30.18, lng: 66.99 }, radius_km: 5, polygon: { type: 'Polygon', coordinates: [] } }, field: 'service_area' },
  { name: 'service-area: neither shape', method: 'put', url: '/api/v1/providers/me/service-area', token: PROVIDER, body: {}, field: 'service_area' },
  { name: 'availability: weekday 7', method: 'put', url: '/api/v1/providers/me/availability', token: PROVIDER, body: { slots: [{ weekday: 7, opens: '09:00', closes: '17:00' }] }, field: 'slots[0].weekday' },
  { name: 'availability: bad opens', method: 'put', url: '/api/v1/providers/me/availability', token: PROVIDER, body: { slots: [{ weekday: 1, opens: '25:00', closes: '17:00' }] }, field: 'slots[0].opens' },
  { name: 'documents: bad doc_type', method: 'post', url: '/api/v1/providers/me/documents', token: PROVIDER, body: { doc_type: 'WRONG' }, field: 'doc_type' },
  { name: 'nearby: lat 999', method: 'get', url: '/api/v1/providers/nearby?lat=999&lng=66.99', field: 'lat' },
  { name: 'nearby: lat abc', method: 'get', url: '/api/v1/providers/nearby?lat=abc&lng=66.99', field: 'lat' },
  { name: 'nearby: radius 0', method: 'get', url: '/api/v1/providers/nearby?lat=30.18&lng=66.99&radius_km=0', field: 'radius_km' },
  { name: 'provider reviews: limit 0', method: 'get', url: `/api/v1/providers/${REQ_ID}/reviews?limit=0`, field: 'limit' },
  // ---- me / addresses / devices / contacts ----
  { name: 'address: lat 999', method: 'post', url: '/api/v1/me/addresses', token: CUSTOMER, body: { label: 'home', lat: 999, lng: 66.99 }, field: 'lat' },
  { name: 'address patch: lng -181', method: 'patch', url: `/api/v1/me/addresses/${REQ_ID}`, token: CUSTOMER, body: { lng: -181 }, field: 'lng' },
  { name: 'patch me: 150-char name', method: 'patch', url: '/api/v1/me', token: CUSTOMER, body: { full_name: 'x'.repeat(150) }, field: 'full_name' },
  { name: 'patch me: bad language', method: 'patch', url: '/api/v1/me', token: CUSTOMER, body: { language: 'xx' }, field: 'language' },
  { name: 'device: bad platform', method: 'post', url: '/api/v1/me/devices', token: CUSTOMER, body: { device_fingerprint: 'fp1', platform: 'windows' }, field: 'platform' },
  { name: 'trusted contact: bad phone', method: 'post', url: '/api/v1/me/trusted-contacts', token: CUSTOMER, body: { name: 'Fatima', phone: '123' }, field: 'phone' },
  { name: 'trusted contact: 150-char name', method: 'post', url: '/api/v1/me/trusted-contacts', token: CUSTOMER, body: { name: 'x'.repeat(150), phone: '+923001234567' }, field: 'name' },
  // ---- catalog (public) ----
  { name: 'search: empty q', method: 'get', url: '/api/v1/search?q=', field: 'q' },
  { name: 'search: lat 999', method: 'get', url: '/api/v1/search?q=ac&lat=999', field: 'lat' },
  { name: 'fair-range: neither category', method: 'get', url: '/api/v1/pricing/fair-range', field: 'category_id' },
  { name: 'fair-range: bad category_id', method: 'get', url: '/api/v1/pricing/fair-range?category_id=bad', field: 'category_id' },
  { name: 'form-schema: missing schema', method: 'put', url: `/api/v1/admin/categories/${REQ_ID}/form-schema`, token: ADMIN, body: {}, field: 'schema' },
  // ---- admin ----
  { name: 'decide: bad decision', method: 'post', url: `/api/v1/admin/verifications/${REQ_ID}/decide`, token: ADMIN, body: { decision: 'WRONG' }, field: 'decision' },
  { name: 'category: bad slug', method: 'post', url: '/api/v1/admin/categories', token: ADMIN, body: { slug: 'Bad Slug!', name_en: 'Test', level: 1 }, field: 'slug' },
  { name: 'category: level 0', method: 'post', url: '/api/v1/admin/categories', token: ADMIN, body: { slug: 'test-cat', name_en: 'Test', level: 0 }, field: 'level' },
  { name: 'category: bad parent_id', method: 'post', url: '/api/v1/admin/categories', token: ADMIN, body: { slug: 'test-cat', name_en: 'Test', level: 1, parent_id: 'bad' }, field: 'parent_id' },
  { name: 'suspend: non-boolean', method: 'patch', url: `/api/v1/admin/users/${REQ_ID}/suspend`, token: ADMIN, body: { suspended: 'yes' }, field: 'suspended' },
  { name: 'resolve dispute: amount -5', method: 'post', url: `/api/v1/admin/disputes/${DISPUTE_ID}/resolve`, token: ADMIN, body: { outcome: 'refund', amount_pkr: -5 }, field: 'amount_pkr' },
  { name: 'assign dispute: bad assigned_to', method: 'post', url: `/api/v1/admin/disputes/${DISPUTE_ID}/assign`, token: ADMIN, body: { assigned_to: 'bad' }, field: 'assigned_to' },
  { name: 'admin users: limit 0', method: 'get', url: '/api/v1/admin/users?limit=0', token: ADMIN, field: 'limit' },
  { name: 'admin users: limit 101', method: 'get', url: '/api/v1/admin/users?limit=101', token: ADMIN, field: 'limit' },
  { name: 'admin requests: 50-char status', method: 'get', url: `/api/v1/admin/requests?status=${'x'.repeat(50)}`, token: ADMIN, field: 'status' },
  // ---- bad UUID path params ----
  { name: 'param: bad request id', method: 'get', url: '/api/v1/requests/not-a-uuid', token: CUSTOMER, field: 'id' },
  { name: 'param: bad provider id', method: 'get', url: '/api/v1/providers/not-a-uuid', field: 'id' },
  { name: 'param: bad job id', method: 'get', url: '/api/v1/jobs/not-a-uuid', token: CUSTOMER, field: 'id' },
];

describe('request validation (FIX 6)', () => {
  let app: INestApplication;
  let pg: Client | null = null;

  async function flushRateLimits() {
    if (process.env.REDIS_URL) {
      const raw = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
      // Guard buckets (rl:*) AND the service-level per-phone OTP counters
      // (otp:rl:*) — both are per-IP/per-phone windows that would otherwise
      // leak across suites and runs sharing one Redis.
      const keys = [...(await raw.keys('rl:*')), ...(await raw.keys('otp:rl:*'))];
      if (keys.length) await raw.del(...keys);
      raw.disconnect();
    } else {
      const redis = app.get(RedisService);
      (redis as unknown as { mem?: Map<string, unknown> }).mem?.clear();
    }
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createValidationPipe());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    if (process.env.DATABASE_URL) {
      pg = new Client({ connectionString: process.env.DATABASE_URL });
      await pg.connect();
      await pg.query(
        `INSERT INTO users (id, phone, full_name, language, status) VALUES ($1, '+923009998877', 'Validation Test', 'ur', 'active') ON CONFLICT (id) DO NOTHING`,
        [CUSTOMER_ID],
      );
    }
  });

  afterAll(async () => {
    if (pg) {
      await pg.query('DELETE FROM service_requests WHERE customer_id=$1', [CUSTOMER_ID]).catch(() => undefined);
      await pg.query('DELETE FROM users WHERE id=$1', [CUSTOMER_ID]).catch(() => undefined);
      await pg.end().catch(() => undefined);
    }
    await app.close();
  });

  beforeEach(async () => { await flushRateLimits(); });

  for (const c of CASES) {
    it(`${c.name} -> 422 VALIDATION_FAILED (field: ${c.field})`, async () => {
      let req = request(app.getHttpServer())[c.method](c.url);
      if (c.token) req = req.set('Authorization', `Bearer ${c.token}`);
      if (c.body !== undefined) req = req.send(c.body);
      const res = await req;
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      // Direct key lookup (not toHaveProperty): field names contain brackets
      // for nested items, e.g. 'items[0].amount', which Jest would parse as
      // a path instead of a literal key.
      expect(res.body.error.details.fields[c.field]).toBeDefined();
      expect(res.body).toHaveProperty('request_id');
    });
  }

  it('valid OTP request still succeeds (202)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .send({ phone: RUN_PHONE, device_fingerprint: 'validation-test' });
    expect(res.status).toBe(202);
  });

  it('valid nearby query still succeeds (200)', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/providers/nearby?lat=30.18&lng=66.99');
    // 200 with the seeded test DB; without DATABASE_URL the service has no
    // database and fails — but the query itself must NOT be a 422.
    expect(res.status).not.toBe(422);
    if (process.env.DATABASE_URL) expect(res.status).toBe(200);
  });

  const maybeDb = process.env.DATABASE_URL ? it : it.skip;
  maybeDb('valid POST /requests still succeeds (201, real DB)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/requests')
      .set('Authorization', `Bearer ${CUSTOMER}`)
      .send(VALID_REQUEST);
    expect(res.status).toBe(201);
    expect(res.body.category_id).toBeTruthy();
  });
});
