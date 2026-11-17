-- 0007 — Revoke all pre-existing refresh-token families (Stage 1, FIX 2).
-- Before FIX 2, refresh_token_families.token_hash stored bcrypt hashes of the
-- full JWT. bcrypt reads only the first 72 bytes of a JWT, which are
-- identical for all tokens of one user, so reuse detection never fired.
-- Those hashes cannot be migrated to the new scheme (SHA-256 of the full
-- token): the plaintext tokens are gone. Revoking every family is safe
-- because this is pre-launch — all users simply log in again (OTP) and get
-- fresh families under the new scheme. New rows are written with the SHA-256
-- hex hash by AuthService.issueTokens/refresh.
UPDATE refresh_token_families SET revoked_at = now() WHERE revoked_at IS NULL;
