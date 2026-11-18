# Places — real-world shop discovery via OpenStreetMap

Free, no key, no account. `GET /api/v1/places/nearby` proxies the
Overpass API (OpenStreetMap's read-only query endpoint) and returns real
shops near the user that match the selected service category. These are
public map data, NOT registered Near Service providers — the app shows
them as amber store pins (teal = registered providers) with an in-app
route drawn on the app's own map (free OSRM demo server, no key) —
Directions never opens an external Maps app.

## Endpoint

`GET /api/v1/places/nearby?lat&lng&category_slug&radius_km`

- Public, rate-limited on the `nearby` bucket (same as providers/nearby).
- `category_slug` (required): any of the 13 level-1 categories;
  anything else is 422 `VALIDATION_FAILED`.
- `radius_km` (optional): default 20, min 0.5, max 50.
- Response: `{items: PlaceShop[], source: 'openstreetmap', degraded: bool,
  empty: bool}`. A shop is `{name, lat, lng, distance_km,
  tags: {shop?, craft?}, source: 'openstreetmap'}`. `name` is the OSM name
  tag, or `'Unnamed shop'` when the node has none. Items are sorted by
  distance, capped at 50.

## Failure policy — never 500, three states

The response always carries both flags so the app can tell the user the
truth instead of a bare "no nearby shops":

- **Shops found** — `degraded: false, empty: false`, items sorted by
  distance.
- **Empty** — Overpass answered fine but nothing is mapped for this
  category nearby: `{items: [], degraded: false, empty: true}`. The app
  says "OSM mein is category ki koi dukaan mapped nahi hai" and keeps
  showing registered providers.
- **Degraded** — Overpass errored, timed out or 502'd:
  `{items: [], degraded: true, empty: false}`. The app says the real-shop
  lookup is unavailable right now and keeps showing registered providers.

## Category → OSM tag mapping

| category_slug | OSM selectors |
|---|---|
| book-binding | shop=stationery, shop=books, craft=bookbinder |
| ac-repair | shop=appliances, shop=electronics, craft=electronics_repair |
| electrician | shop=electrical, craft=electrician |
| plumber | shop=plumbing, craft=plumber |
| mobile-repair | shop=mobile_phone, craft=electronics_repair |
| tailoring | shop=tailor, craft=tailor |
| carpentry | craft=carpenter |
| painting | craft=painter, shop=paint |
| cleaning | shop=cleaning, craft=cleaner |
| tutoring | office=educational_institution, amenity=school, amenity=language_school |
| printing | shop=copyshop, craft=printer |
| car-mechanic | shop=car_repair, craft=car_mechanic |
| appliance-repair | shop=appliances, craft=electronics_repair |

A shop matches when ANY selector matches; a node matching several
selectors is returned once (dedup by node id).

Tutoring has no dedicated OSM tag — schools / educational institutions
are the closest mappable equivalent. Do not expect tuition centres to
appear reliably; they are usually not mapped as such.

## Cache

Results are cached in Redis for 15 minutes per
`(category, ~100 m cell, radius)` — coordinates are rounded to 3 decimals
for the key. A Redis failure never fails the request: cache errors are
logged and the live fetch runs (see `RedisService` in-memory fallback).
Non-degraded results are cached, including empty answers (an empty answer
is a real answer). Degraded answers are never cached.

## Overpass quirks (verified live 2026-11-18)

- The server returns HTTP 406 unless the request carries a `User-Agent`
  AND an `Accept: application/json` header. Both are set on every call.
- The query is POSTed as form data (`data=<Overpass QL>`).
- Query timeout is 50 s server-side and 50 s client-side (AbortController).
  Raised from 25 s in Batch 3: Overpass was taking ~28–37 s (or 502) at
  peak, so the endpoint almost always degraded with no shops even though
  the 5 Quetta shops exist. Degraded fallback is unchanged (HTTP 200
  `{items: [], degraded: true, empty: false}`, never 500; degraded results
  are not cached).
- Coverage is whatever volunteers mapped. Quetta centre (30.18, 66.975),
  20 km, stationery/books/bookbinder returned 5 real shops
  (Honar stationary, Azhari stationary, N.B.D Book Shop, Nashaqbandia
  Stationery + 1 unnamed books shop). Batch 4 live checks (2026-11-18):
  tailoring returned 1 shop (QTH, Sirki Road) and car repair 3
  (Motorcycle repairer shop, Car Garages, Zarghoon Market) — most local
  tailors are simply not mapped on OpenStreetMap yet, which is why the
  app previously showed nothing for Tailoring (the category was not
  mapped at all). Sparse areas may return none.

## Upgrade path

If OSM coverage proves too thin, add a Google Places provider behind the
same `GET /places/nearby` contract (new service, same response shape).
That needs a Google Cloud account + billing + API key and is NOT wired
here — the user chose the free route first.
