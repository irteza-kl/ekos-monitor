'use strict';
const crypto = require('crypto');
const config = require('../config');

/**
 * HTTP Basic: the browser's own password prompt, no login page.
 *
 * Credentials travel on every request, base64-encoded rather than encrypted, and
 * browsers hold them until the window closes - so there is no sign-out, and
 * plain http on a shared network exposes them. Changing APP_PASSWORD is what
 * revokes access.
 */

const REALM = 'Phantom Monitor';

/** Constant-time, and over digests so the stored length does not leak either. */
function matches(expected, candidate) {
  const a = crypto.createHash('sha256').update(String(expected)).digest();
  const b = crypto.createHash('sha256').update(String(candidate)).digest();
  return crypto.timingSafeEqual(a, b);
}

function parseHeader(req) {
  const header = req.headers.authorization || '';
  if (!/^basic /i.test(header)) return null;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  } catch (err) {
    return null;
  }
  // The password may contain colons; the username may not.
  const at = decoded.indexOf(':');
  if (at === -1) return null;
  return { username: decoded.slice(0, at), password: decoded.slice(at + 1) };
}

/** @returns {{username: string}|null} */
function session(req) {
  if (!config.authRequired) return { username: '' };
  const given = parseHeader(req);
  if (!given) return null;
  // Both halves are always compared, so a wrong username costs what a wrong
  // password does and the prompt cannot be used to guess the username.
  const userOk = matches(config.username, given.username);
  const passOk = matches(config.password, given.password);
  return userOk && passOk ? { username: given.username } : null;
}

/**
 * Guards pages as well as the API: a 401 on a top-level navigation is what
 * raises the browser dialog, and browsers do not reliably raise it for a
 * fetch(). So this must run ahead of the static files, not only before /api.
 */
function requireAuth(req, res, next) {
  if (session(req)) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="' + REALM + '", charset="UTF-8"');
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not signed in', code: 'UNAUTHORIZED' });
  }
  return res
    .status(401)
    .type('html')
    .send(
      '<!doctype html><meta charset="utf-8"><title>Phantom Monitor</title>' +
        '<body style="font:14px system-ui;padding:40px;color:#333">' +
        '<h1 style="font-size:17px">Phantom Monitor</h1>' +
        '<p>This console needs a username and password. Reload the page to be asked again.</p>'
    );
}

module.exports = { session, requireAuth };
