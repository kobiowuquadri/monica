// Minimal, explicit request validation. These checks concern data-entry structure
// (types, units, formats, plausible input ranges to catch typing errors) and are
// deliberately separate from any health interpretation.
import { HttpError } from '../middleware/errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// ISO 8601 with an explicit offset or Z, so the instant is unambiguous.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

export class Validator {
  constructor() { this.errors = []; }

  add(field, message) { this.errors.push({ field, message }); }

  ok() { return this.errors.length === 0; }

  throwIfInvalid() {
    if (!this.ok()) {
      throw new HttpError(400, 'validation_failed', 'Some fields need attention before this can be saved.', this.errors);
    }
  }

  string(field, value, { required = false, min = 0, max = 500, trim = true } = {}) {
    if (value === undefined || value === null || value === '') {
      if (required) this.add(field, 'Required.');
      return null;
    }
    if (typeof value !== 'string') { this.add(field, 'Must be text.'); return null; }
    const v = trim ? value.trim() : value;
    if (required && v.length === 0) { this.add(field, 'Required.'); return null; }
    if (v.length < min) this.add(field, `Must be at least ${min} characters.`);
    if (v.length > max) this.add(field, `Must be at most ${max} characters.`);
    // Reject control characters other than tab/newline.
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v)) this.add(field, 'Contains unsupported control characters.');
    return v.length ? v : null;
  }

  enumValue(field, value, allowed, { required = false } = {}) {
    if (value === undefined || value === null || value === '') {
      if (required) this.add(field, 'Required.');
      return null;
    }
    if (!allowed.includes(value)) { this.add(field, `Must be one of: ${allowed.join(', ')}.`); return null; }
    return value;
  }

  number(field, value, { required = false, min, max, integer = false, maxDecimals } = {}) {
    if (value === undefined || value === null || value === '') {
      if (required) this.add(field, 'Required.');
      return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) { this.add(field, 'Must be a number.'); return null; }
    if (integer && !Number.isInteger(value)) { this.add(field, 'Must be a whole number.'); return null; }
    if (maxDecimals !== undefined) {
      const decimals = (String(value).split('.')[1] || '').length;
      if (decimals > maxDecimals) this.add(field, `Use at most ${maxDecimals} decimal place(s).`);
    }
    if (min !== undefined && value < min) this.add(field, `Outside the accepted input range (${min}–${max}). Check for a typing error.`);
    else if (max !== undefined && value > max) this.add(field, `Outside the accepted input range (${min}–${max}). Check for a typing error.`);
    return value;
  }

  boolean(field, value, { defaultValue = false } = {}) {
    if (value === undefined || value === null) return defaultValue;
    if (typeof value !== 'boolean') { this.add(field, 'Must be true or false.'); return defaultValue; }
    return value;
  }

  timestamp(field, value, { required = false, notFutureMinutes, notOlderThanDays } = {}) {
    if (value === undefined || value === null || value === '') {
      if (required) this.add(field, 'Required.');
      return null;
    }
    if (typeof value !== 'string' || !ISO_RE.test(value)) {
      this.add(field, 'Must be an ISO 8601 timestamp with a time-zone offset (e.g. 2026-11-14T08:30:00Z).');
      return null;
    }
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) { this.add(field, 'Not a valid date/time.'); return null; }
    if (notFutureMinutes !== undefined && d.getTime() > Date.now() + notFutureMinutes * 60_000) {
      this.add(field, 'Cannot be in the future.');
    }
    if (notOlderThanDays !== undefined && d.getTime() < Date.now() - notOlderThanDays * 86_400_000) {
      this.add(field, `Must be within the last ${notOlderThanDays} days.`);
    }
    return d;
  }

  array(field, value, { max = 50 } = {}) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) { this.add(field, 'Must be a list.'); return []; }
    if (value.length > max) { this.add(field, `At most ${max} entries.`); return []; }
    return value;
  }

  object(field, value) {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) { this.add(field, 'Must be an object.'); return {}; }
    return value;
  }
}

export function rejectUnknownKeys(v, field, obj, allowed) {
  for (const key of Object.keys(obj || {})) {
    if (!allowed.includes(key)) v.add(field ? `${field}.${key}` : key, 'Unknown field.');
  }
}

/** Parses an optional ISO date (YYYY-MM-DD or full ISO) query parameter. */
export function parseQueryDate(value, field) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/.test(value)) {
    throw new HttpError(400, 'validation_failed', `Query parameter "${field}" must be a date (YYYY-MM-DD) or ISO timestamp.`);
  }
  const d = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'validation_failed', `Query parameter "${field}" is not a valid date.`);
  return d;
}
