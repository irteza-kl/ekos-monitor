'use strict';
// Vercel serverless entrypoint. vercel.json rewrites every /api/* request here
// and Express does the routing, so one function serves the whole API.
module.exports = require('../server/app');
