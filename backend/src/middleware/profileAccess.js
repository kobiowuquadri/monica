import { HttpError } from './errors.js';
import { findOwnedProfile } from '../repositories/profiles.js';
import { isUuid } from '../validation/validate.js';

/**
 * Loads :id as a profile owned by the signed-in user. A profile belonging to someone else
 * is reported as "not found" so that profile IDs cannot be probed.
 */
export async function loadOwnedProfile(req, _res, next) {
  try {
    const { id } = req.params;
    if (!isUuid(id)) throw new HttpError(404, 'profile_not_found', 'Profile not found.');
    const profile = await findOwnedProfile(id, req.user.id);
    if (!profile) throw new HttpError(404, 'profile_not_found', 'Profile not found.');
    req.profile = profile;
    return next();
  } catch (err) {
    return next(err);
  }
}
