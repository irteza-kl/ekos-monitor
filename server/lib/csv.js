'use strict';

function cell(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return '"' + value.join(' | ').replace(/"/g, '""') + '"';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return '"' + JSON.stringify(value).replace(/"/g, '""') + '"';
  const s = String(value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** columns: [{ key, label, get? }] */
function toCsv(rows, columns) {
  const head = columns.map((c) => cell(c.label || c.key)).join(',');
  const body = rows.map((row) =>
    columns.map((c) => cell(c.get ? c.get(row) : dig(row, c.key))).join(',')
  );
  return [head, ...body].join('\r\n');
}

function dig(obj, path) {
  return String(path)
    .split('.')
    .reduce((acc, part) => (acc === null || acc === undefined ? acc : acc[part]), obj);
}

function send(res, filename, csvText) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.send('﻿' + csvText);
}

module.exports = { toCsv, send, dig };
