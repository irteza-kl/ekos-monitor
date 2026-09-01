'use strict';
// Copies the map + chart libraries out of node_modules into public/vendor so the
// deployed app serves them itself. No CDN, no external requests for code.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'public', 'vendor');

const files = [
  ['node_modules/leaflet/dist/leaflet.js', 'leaflet.js'],
  ['node_modules/leaflet/dist/leaflet.css', 'leaflet.css'],
  ['node_modules/chart.js/dist/chart.umd.js', 'chart.umd.js'],
];

fs.mkdirSync(path.join(out, 'images'), { recursive: true });
for (const [from, to] of files) {
  fs.copyFileSync(path.join(root, from), path.join(out, to));
  console.log('vendored', to);
}
const imgDir = path.join(root, 'node_modules/leaflet/dist/images');
for (const img of fs.readdirSync(imgDir)) {
  fs.copyFileSync(path.join(imgDir, img), path.join(out, 'images', img));
}
console.log('vendored leaflet images');
