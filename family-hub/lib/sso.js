// family-hub/lib/sso.js — the family SSO cookie: sign it here, verify it here
// and (independently) inside each trip instance's server.js.
//
// The cookie is SELF-CONTAINED and stateless by design: there is no sessions
// table anywhere. A trip instance can therefore trust a portal login without
// ever talking to the portal — it only needs the shared secret, which
// deploy/sync-sso-secret.sh writes into every instance's .env.
//
//   value = base64url(JSON{n:<name>, exp:<unix-ms>}) "." base64url(HMAC-SHA256(secret, part1))
//
// DELIBERATE DUPLICATION: the trip app's server.js carries its own ~20-line
// copy of verify() rather than requiring this file — a deployed instance in
// /var/www/trips/<name> has no access to the portal's tree. If you change the
// format here, change it there too (search server.js for "FAMILY SSO"), and
// bump both apps: an instance verifying an older format simply rejects the
// cookie and falls back to the PIN screen, so a mismatch degrades rather than
// breaks, but nobody gets signed in.
'use strict';
const crypto = require('crypto');

const COOKIE_NAME = 'fam_sso';
const MAX_AGE_S = 90 * 24 * 60 * 60; // 90 days — matches the Max-Age we set

const b64u = buf => Buffer.from(buf).toString('base64url');

function hmac(secret, part1) {
  return b64u(crypto.createHmac('sha256', String(secret)).update(part1).digest());
}

// Signs {name, exp}. ttlMs defaults to the cookie's own 90-day life so the
// payload never outlives the cookie that carries it.
function sign(secret, name, nowMs, ttlMs) {
  if (!secret) throw new Error('sso.sign: no secret');
  const exp = nowMs + (ttlMs == null ? MAX_AGE_S * 1000 : ttlMs);
  const part1 = b64u(JSON.stringify({ n: String(name), exp }));
  return part1 + '.' + hmac(secret, part1);
}

// Returns { name, exp } or null. Never throws on malformed input — every
// failure path (bad shape, bad signature, expired, junk JSON) is one null, so
// callers can treat "no cookie" and "bad cookie" identically.
function verify(secret, value) {
  if (!secret || typeof value !== 'string') return null;
  const dot = value.indexOf('.');
  if (dot < 1 || dot === value.length - 1) return null;
  const part1 = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const want = hmac(secret, part1);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (sig.length !== want.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(part1, 'base64url').toString('utf8')); }
  catch (e) { return null; }
  if (!payload || typeof payload.n !== 'string' || !payload.n) return null;
  if (typeof payload.exp !== 'number' || !(payload.exp > Date.now())) return null;
  return { name: payload.n, exp: payload.exp };
}

// Hand-rolled Cookie header parse — the portal takes no dependencies it can
// avoid, and one header is not worth cookie-parser.
function readCookie(header, name) {
  if (!header) return '';
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    if (part.slice(0, i).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(i + 1).trim()); }
    catch (e) { return part.slice(i + 1).trim(); }
  }
  return '';
}

// Secure only when the request really arrived over https. nginx terminates TLS
// and proxies over http, so X-Forwarded-Proto is the authority in production;
// without it (plain localhost dev) the cookie stays non-Secure and still works.
function isHttps(req) {
  const xf = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return (xf || req.protocol) === 'https';
}

// domain '' => omit the Domain attribute entirely: a host-only cookie, which is
// what localhost dev wants. In production COOKIE_DOMAIN is the dot-prefixed
// parent (e.g. .example.com) so every <trip>.example.com sees it.
function cookieHeader(req, value, domain, maxAgeS) {
  const parts = [COOKIE_NAME + '=' + value];
  if (domain) parts.push('Domain=' + domain);
  parts.push('Path=/', 'Max-Age=' + maxAgeS, 'HttpOnly', 'SameSite=Lax');
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

module.exports = { COOKIE_NAME, MAX_AGE_S, sign, verify, readCookie, isHttps, cookieHeader };
