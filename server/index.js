'use strict';
const app = require('./app');
const config = require('./config');
const { resolveCollections, close } = require('./db');

const server = app.listen(config.port, async () => {
  console.log('phantom-monitor listening on http://localhost:' + config.port);
  try {
    const map = await resolveCollections();
    console.log('  database   :', map.database);
    console.log('  snapshots  :', map.snapshots, '(' + (map.counts.snapshots ?? '?') + ' docs)');
    console.log('  clockInLogs:', map.clockInLogs, '(' + (map.counts.clockInLogs ?? '?') + ' docs)');
    console.log('  exitWindows:', map.exitWindows || 'not present yet');
  } catch (err) {
    console.error('  mongo connection failed:', err.message);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(async () => {
      await close().catch(() => {});
      process.exit(0);
    });
  });
}
