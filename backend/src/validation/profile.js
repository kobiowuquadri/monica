import { Validator, rejectUnknownKeys } from './validate.js';

export function isValidTimezone(tz) {
  if (typeof tz !== 'string' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateProfile(body, { partial = false } = {}) {
  const v = new Validator();
  const b = v.object('body', body);
  rejectUnknownKeys(v, '', b, ['displayName', 'roleTitle', 'missionName', 'missionPhase', 'timezone', 'notes']);
  const out = {};
  if (!partial || 'displayName' in b) out.displayName = v.string('displayName', b.displayName, { required: true, max: 80 });
  for (const [key, max] of [['roleTitle', 80], ['missionName', 120], ['missionPhase', 80], ['notes', 500]]) {
    if (!partial || key in b) out[key] = v.string(key, b[key], { max });
  }
  if (!partial || 'timezone' in b) {
    const tz = v.string('timezone', b.timezone, { required: !partial, max: 64 }) || (partial ? null : 'UTC');
    if (tz && !isValidTimezone(tz)) v.add('timezone', 'Unknown time zone. Use an IANA name such as "UTC" or "America/Chicago".');
    out.timezone = tz;
  }
  v.throwIfInvalid();
  return out;
}
