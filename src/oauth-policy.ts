// Only legacy grants have a time/rotation limit. New consent remains valid until
// revoked; short access tokens and authenticated refresh generations stay bounded.
export const OAUTH_LEGACY_GRANT_MS = 8 * 60 * 60_000;
export const OAUTH_LEGACY_MAX_ROTATIONS = 64;
export const OAUTH_ACCESS_MS = 10 * 60_000;
export const OAUTH_MAX_ACCESS_TOKENS = 4096;
