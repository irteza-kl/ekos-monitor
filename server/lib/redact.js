'use strict';

/**
 * Strips personal data that this console has no business showing.
 *
 * The heartbeat documents embed the whole employee record, which in this store
 * includes SSN, bank account and routing numbers, home address and emergency
 * contacts. None of it is needed to answer a question about geofences or device
 * health, and any raw-document view - the Query Explorer, the "Raw document"
 * drawer tabs - would otherwise put it on screen.
 *
 * Matched by field name at every depth, so it keeps working when the writers
 * add a field or move one, and a redacted value becomes the marker rather than
 * disappearing, so nobody mistakes redaction for missing data.
 */

const REDACTED = '[redacted]';

/** Sensitive wherever they appear. */
const ALWAYS = [
  /^ssn$/i,
  /social.?security/i,
  /^bank/i,
  /routing/i,
  /iban/i,
  /emergency/i,
  /^hourlyRate$/i,
  /salary|wage/i,
  /passport|nationalId|cnic/i,
  /licenseNumber/i,
  /dateOfBirth|^dob$/i,
  /^taxId/i,
];

/**
 * Sensitive only inside a person's record. `address` is the case that matters:
 * an employee's home address is personal, and a job site's address is the whole
 * point of the Sites page - redacting both would break the product to protect
 * one of them.
 */
const PERSONAL_CONTEXT = /^(tenantAccount|accountDetails|currentUser|user|employee|account|data)$/i;
const IN_PERSON = [/^address$/i, /^addressLine/i, /^postCode$|^postalCode$|^zip$/i];

function redactValue(value, parents, depth) {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, parents, depth + 1));
  if (value instanceof Date) return value;

  const inPerson = parents.some((p) => PERSONAL_CONTEXT.test(p));
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    const sensitive = ALWAYS.some((rx) => rx.test(key)) || (inPerson && IN_PERSON.some((rx) => rx.test(key)));
    if (sensitive) {
      // Only mark it when there was something there, so an empty record does not
      // look like it is hiding something.
      out[key] = v === null || v === undefined || v === '' ? v : REDACTED;
      continue;
    }
    out[key] = redactValue(v, [...parents, key], depth + 1);
  }
  return out;
}

/**
 * @param {*} value any JSON-shaped value
 * @returns a copy with sensitive fields replaced
 */
function redact(value) {
  return redactValue(value, [], 0);
}

module.exports = { redact, REDACTED };
