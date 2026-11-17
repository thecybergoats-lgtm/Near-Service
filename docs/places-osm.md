# Places — real-world shop discovery via OpenStreetMap

Free, no key, no account. `GET /api/v1/places/nearby` proxies the
Overpass API (OpenStreetMap's read-only query endpoint) and returns real
shops near the user that match the selected service category. These are
public map data, NOT registered Near Service providers — the app shows
them as amber store pins (teal = registered providers) with a Directions
button (Google Maps intent URL, also free, no key).

## Endpoint

`GET /api/v1/places/nearby?lat&lng&category_slug&radius_km`

- Public, rate-limited on the `nearby` bucket (same as providers/nearby).
- `category_slug` (required): one of the 5 launch categories only;
  anything else is 422 `VALIDATION_FAILED`.
- `radius_km` (optional): default 20, min 0.5, max 50.
- Response: `{items: PlaceShop[], source: 'openstreetmap', degraded: bool}`.
  A shop is `{name, lat, lng, distance_km, tags: {shop?, craft?},
  source: 'openstreetmap'}`. `name` is the OSM name tag, or
  `'Unnamed shop'` when the node has none. Items are sorted by distance,
  capped at 50.

## Failure policy — never 500

An Overpass error, timeout or empty result answers HTTP 200 with
`{items: [], source: 'openstreetmap', degraded: true}`. The app shows
"No real shops found nearby" and keeps showing registered providers.

## Category → OSM tag mapping

| category_slug | OSM selectors |
|---|---|
| book-binding | shop=stationery, shop=books, craft=bookbinder |
| ac-repair | shop=appliances, shop=electronics, craft=electronics_repair |
| electrician | shop=electrical, craft=electrician |
| plumber | shop=plumbing, craft=plumber |
| mobile-repair | shop=mobile_phone, craft=electronics_repair |

A shop matches when ANY selector matches; a node matching several
selectors is returned once (dedup by node id).

## Cache

Results are cached in Redis for 15 minutes per
`(category, ~100 m cell, radius)` — coordinates are rounded to 3 decimals
for the key. A Redis failure never fails the request: cache errors are
logged and the live fetch runs (see `RedisService` in-memory fallback).

## Overpass quirks (verified live 2026-11-18)

- The server returns HTTP 406 unless the request carries a `User-Agent`
  AND an `Accept: application/json` header. Both are set on every call.
- The query is POSTed as form data (`data=<Overpass QL>`).
- Query timeout is 50 s server-side and 50 s client-side (AbortController).
  Raised from 25 s in Batch 3: Overpass was taking ~28–37 s (or 502) at
  peak, so the endpoint almost always degraded with no shops even though
  the 5 Quetta shops exist. Degraded fallback is unchanged (HTTP 200
  `{items: [], degraded: true}`, never 500; degraded results are not cached).
- Coverage is whatever volunteers mapped. Quetta centre (30.18, 66.975),
  20 km, stationery/books/bookbinder returned 5 real shops
  (Honar stationary, Azhari stationary, N.B.D Book Shop, Nashaqbandia
  Stationery + 1 unnamed books shop). Sparse areas may return none.

## Upgrade path

If OSM coverage proves too thin, add a Google Places provider behind the
same `GET /places/nearby` contract (new service, same response shape).
That needs a Google Cloud account + billing + API key and is NOT wired
here — the user chose the free route first.
