'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
const auth = require('./lib/auth');
const { resolveCollections } = require('./db');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));

// ------------------------------------------------------------------ gzip
/**
 * Compress JSON responses. No dependency - node ships zlib, and `compression`
 * would be the first runtime package here that is not Express or the driver.
 *
 * This is not a nicety, it is a correctness fix. A Vercel serverless function
 * may return at most **4.5 MB**, and the user page's trail is one JSON array of
 * heartbeats: at 189 bytes a point, 25,000 heartbeats already breaches it and
 * the whole page fails with FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE. This payload
 * is thousands of objects with identical keys and near-identical values, which
 * is the best case there is for DEFLATE - measured at ~15x on a realistic
 * 50,000-point track (8.95 MB -> 0.57 MB).
 *
 * Only JSON is touched. HTML, CSS and JS are served by express.static (and on
 * Vercel by the CDN, which compresses them itself), and the vendored tiles and
 * images are already compressed formats that gzip would only make bigger.
 *
 * Small bodies are sent as-is: below about a packet's worth, the gzip header
 * and the CPU cost buy nothing.
 */
const zlib = require('zlib');
const GZIP_MIN_BYTES = 1024;

app.use((req, res, next) => {
  const accepts = String(req.headers['accept-encoding'] || '');
  if (!/\bgzip\b/.test(accepts)) return next();

  const json = res.json.bind(res);
  res.json = (body) => {
    let text;
    try {
      text = JSON.stringify(body);
    } catch (err) {
      return json(body);
    }
    if (text === undefined) return json(body);
    const raw = Buffer.from(text, 'utf8');
    if (raw.length < GZIP_MIN_BYTES) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.send(raw);
    }
    // Level 6 is zlib's default and the knee of the curve here: level 9 bought
    // under 2% on this payload for several times the CPU, which on a serverless
    // function is billed wall-clock against a 30 s ceiling.
    zlib.gzip(raw, { level: 6 }, (err, packed) => {
      if (err) {
        // Compression is an optimisation; never let it be the reason a
        // response fails. Fall back to the plain body.
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.send(raw);
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      // The body now varies with the request's Accept-Encoding, so any cache in
      // front of this must key on it or it will hand a gzipped body to a client
      // that did not ask for one.
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', String(packed.length));
      res.end(packed);
    });
    return res;
  };
  next();
});

// -------------------------------------------------------------------- logging
// One line per API call: what was asked, what came back, how long Mongo took.
// Static assets are skipped so the log stays readable. LOG_REQUESTS=0 silences it.
if (process.env.LOG_REQUESTS !== '0') {
  // Colour only when a real terminal is attached, so a log drain stays clean.
  const paint = process.stdout.isTTY;
  const sgr = (code) => (paint ? String.fromCharCode(27) + '[' + code + 'm' : '');
  const GREY = sgr(90);
  const RED = sgr(31);
  const YELLOW = sgr(33);
  const GREEN = sgr(32);
  const RESET = sgr(0);
  const colour = (code) => (code >= 500 ? RED : code >= 400 ? YELLOW : GREEN);

  app.use((req, res, next) => {
    if (!req.path.startsWith('/api')) return next();
    const started = Date.now();
    // Capture the URL now: Express rewrites req.url as the request descends
    // into mounted routers, so by 'finish' the path has lost its /api prefix.
    const url = req.originalUrl;
    const cut = url.indexOf('?');
    const routePath = cut === -1 ? url : url.slice(0, cut);
    const query = cut === -1 ? '' : url.slice(cut);
    res.on('finish', () => {
      const ms = Date.now() - started;
      const time = new Date().toISOString().slice(11, 19);
      const slow = ms > 2000 ? YELLOW + '  SLOW' + RESET : '';
      console.log(
        GREY + time + RESET + '  ' +
          colour(res.statusCode) + res.statusCode + RESET + '  ' +
          req.method.padEnd(4) + ' ' + routePath +
          (query ? GREY + query.slice(0, 140) + RESET : '') +
          '  ' + GREY + ms + 'ms' + RESET +
          slow
      );
    });
    next();
  });
}

// --------------------------------------------------------------------- auth
// HTTP Basic, in front of EVERYTHING - pages included. A 401 on a top-level
// navigation is what makes the browser show its own password box, so guarding
// only /api would leave the pages open and never raise a prompt (browsers do
// not reliably surface the dialog for a fetch()).
app.use(auth.requireAuth);

// The topbar asks who is signed in. Nothing is gated on the answer - the
// middleware above already decided - so this is only for display.
app.get('/api/auth/me', (req, res) => {
  const current = auth.session(req);
  res.json({
    authenticated: !!current,
    authRequired: config.authRequired,
    username: (current && current.username) || null,
  });
});
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use('/api', require('./routes/meta'));
app.use('/api', require('./routes/stats'));
app.use('/api', require('./routes/users'));
app.use('/api', require('./routes/logs'));
app.use('/api', require('./routes/exitWindows'));
app.use('/api', require('./routes/sites'));
app.use('/api', require('./routes/issues'));
app.use('/api', require('./routes/fence'));
app.use('/api', require('./routes/query'));

app.get('/api/refresh-schema', async (req, res, next) => {
  try {
    require('./lib/sites').invalidate();
    res.json(await resolveCollections({ force: true }));
  } catch (err) {
    next(err);
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint ' + req.path }));

// ------------------------------------------------------------------ statics
// On Vercel the public/ directory is served from the edge; this keeps local
// `npm run dev` (and any self-hosted run) serving the same files.
app.use(
  express.static(config.publicDir, {
    extensions: ['html'],
    setHeaders: (res, filePath) => {
      if (filePath.includes(path.sep + 'vendor' + path.sep)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (filePath.endsWith('.html')) {
        // These now come through the password gate, so no shared cache may hold
        // an authorised copy and hand it to the next visitor.
        res.setHeader('Cache-Control', 'private, no-store, must-revalidate');
      }
    },
  })
);

// ------------------------------------------------------------- error handler
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[phantom-monitor]', err);
  res.status(status).json({
    error: err.message || 'Unexpected error',
    code: err.code || undefined,
    ...(status >= 500 && process.env.NODE_ENV !== 'production' ? { stack: err.stack } : {}),
  });
});

module.exports = app;
