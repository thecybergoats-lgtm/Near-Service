# Provider QR code — payload format

Batch 3. A provider's QR code encodes a stable deep-link-style string —
not a screenshot-only image, so the same code works printed on a flyer,
shared in a chat message, or typed by hand.

## Payload format

```
near-service://provider/<provider-profile-uuid>
```

Example:

```
near-service://provider/00000000-0000-4000-8000-0000b0000001
```

- `<provider-profile-uuid>` is `provider_profiles.id` — the same id
  returned by `GET /providers/me` and `GET /providers/:id`.
- The payload is built by `buildProviderQrPayload()` in
  `mobile/lib/core/qr_code.dart` and parsed by
  `parseProviderIdFromQr()` in the same file.

## Scanning

Customer side (`mobile/lib/features/customer/qr_scan_screen.dart`,
route `/customer/scan-qr`):

- The camera scanner (`mobile_scanner`) reads the code and opens
  `/customer/provider/<id>` — the normal provider profile screen.
- A manual code field sits below the camera as the fallback (camera
  permission denied, scanner failing, or a printed code typed by hand).
  It accepts the full `near-service://provider/<uuid>` string **or** a
  bare UUID.
- Anything else is rejected with "This is not a Near Service provider
  code." — a random QR code never opens a profile.

## Provider side

`mobile/lib/features/provider/qr_code_screen.dart` (route
`/provider/qr-code`, reached from the provider dashboard's "My QR code"
button):

- Loads the provider's own profile via `GET /providers/me` and renders
  the QR with `qr_flutter`.
- **Share** sends the payload text (plus the provider name) through the
  platform share sheet (`share_plus`).
- **Copy code** copies the payload text to the clipboard.

## What it is not

- There is no web landing page behind the link: the `near-service://`
  scheme is an in-app deep link only. If a web profile page is ever
  built, the payload format must be versioned first (e.g. a `v2` prefix)
  — do not silently change what existing printed codes mean.
- The QR code carries no auth, no phone number and no payout data — only
  the public provider id.
