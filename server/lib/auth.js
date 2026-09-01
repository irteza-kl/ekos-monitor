'use strict';
const crypto = require('crypto');
const config = require('../config');

const COOKIE = 'pm_session';
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h

function sign(payload) {
  return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('hex');
}

function issue() {
  const expires = Date.now() + MAX_AGE_MS;
  const payload = 'v1.' + expires;
  return payload + '.' + sign(payload);
}

function verify(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [v, expires, mac] = parts;
  const payload = v + '.' + expires;
  const expected = sign(payload);
  if (mac.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  return Number(expires) > Date.now();
}

/** Constant-time password check. Always true when no password is configured. */
function passwordMatches(candidate) {
  if (!config.authRequired) return true;
  const a = Buffer.from(String(candidate ?? ''));
  const b = Buffer.from(config.password);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function setCookie(res) {
  res.cookie(COOKIE, issue(), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: MAX_AGE_MS,
  });
}

function clearCookie(res) {
  res.clearCookie(COOKIE);
}

function isAuthed(req) {
  if (!config.authRequired) return true;
  return verify(req.cookies && req.cookies[COOKIE]);
}

/** Guards the API: JSON 401 instead of a redirect. */
function requireApiAuth(req, res, next) {
  if (isAuthed(req)) return next();
  return res.status(401).json({ error: 'Not signed in', code: 'UNAUTHORIZED' });
}

/** Guards pages: bounce to the login screen. */
function requirePageAuth(req, res, next) {
  if (isAuthed(req)) return next();
  const target = encodeURIComponent(req.originalUrl || '/');
  return res.redirect('/login.html?next=' + target);
}

module.exports = { COOKIE, setCookie, clearCookie, isAuthed, requireApiAuth, requirePageAuth, passwordMatches };
