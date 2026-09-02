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
