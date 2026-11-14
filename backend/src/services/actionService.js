import { withTransaction } from '../db/pool.js';
import { HttpError } from '../middleware/errors.js';
import { Validator, rejectUnknownKeys, isUuid } from '../validation/validate.js';
import { insertAction, getAction, updateAction } from '../repositories/actions.js';
import { getObservation, acknowledgeObservation, resolveObservation } from '../repositories/observations.js';
import { getCheckIn } from '../repositories/checkIns.js';
import { recordAudit } from '../repositories/audit.js';

export async function acknowledge({ profile, user, observationId }) {
  if (!isUuid(observationId)) throw new HttpError(404, 'observation_not_found', 'Observation not found.');
  return withTransaction(async (client) => {
    const existing = await getObservation(profile.id, observationId);
    if (!existing) throw new HttpError(404, 'observation_not_found', 'Observation not found.');
    if (existing.status !== 'open') return existing;
    const o = await acknowledgeObservation(client, profile.id, observationId, user.id);
    await recordAudit(client, { userId: user.id, profileId: profile.id, entityType: 'observation', entityId: observationId, action: 'observation.acknowledged', metadata: { ruleId: existing.ruleId } });
    return o || existing;
  });
}

export async function resolve({ profile, user, observationId }) {
  if (!isUuid(observationId)) throw new HttpError(404, 'observation_not_found', 'Observation not found.');
  return withTransaction(async (client) => {
    const existing = await getObservation(profile.id, observationId);
    if (!existing) throw new HttpError(404, 'observation_not_found', 'Observation not found.');
    const o = await resolveObservation(client, profile.id, observationId);
    await recordAudit(client, { userId: user.id, profileId: profile.id, entityType: 'observation', entityId: observationId, action: 'observation.closed', metadata: { ruleId: existing.ruleId } });
    return o || existing;
  });
}

export async function createAction({ profile, user, body }) {
  const v = new Validator();
  const b = v.object('body', body);
  rejectUnknownKeys(v, '', b, ['kind', 'description', 'scheduledFor', 'observationId']);
  const kind = v.enumValue('kind', b.kind, ['action_taken', 'follow_up'], { required: true });
  const description = v.string('description', b.description, { required: true, max: 1000 });
  const scheduledFor = v.timestamp('scheduledFor', b.scheduledFor, { required: kind === 'follow_up' });
  if (kind === 'follow_up' && scheduledFor && scheduledFor.getTime() < Date.now() - 24 * 3600_000) {
    v.add('scheduledFor', 'A follow-up should be scheduled for now or later.');
  }
  if (kind === 'action_taken' && scheduledFor) v.add('scheduledFor', 'Only follow-ups are scheduled.');
  let observationId = null;
  if (b.observationId !== undefined && b.observationId !== null) {
    if (!isUuid(b.observationId)) v.add('observationId', 'Invalid observation.');
    else observationId = b.observationId;
  }
  v.throwIfInvalid();

  return withTransaction(async (client) => {
    if (observationId) {
      const o = await getObservation(profile.id, observationId);
      if (!o) throw new HttpError(404, 'observation_not_found', 'Observation not found.');
    }
    const action = await insertAction(client, profile.id, user.id, { kind, description, scheduledFor, observationId });
    await recordAudit(client, {
      userId: user.id, profileId: profile.id, entityType: 'action', entityId: action.id,
      action: kind === 'follow_up' ? 'follow_up.scheduled' : 'action.recorded', metadata: { observationId },
    });
    if (observationId) {
      await recordAudit(client, {
        userId: user.id, profileId: profile.id, entityType: 'observation', entityId: observationId,
        action: kind === 'follow_up' ? 'observation.follow_up_scheduled' : 'observation.action_recorded', metadata: { actionId: action.id },
      });
    }
    return action;
  });
}

export async function patchAction({ profile, user, actionId, body }) {
  if (!isUuid(actionId)) throw new HttpError(404, 'action_not_found', 'Action not found.');
  const v = new Validator();
  const b = v.object('body', body);
  rejectUnknownKeys(v, '', b, ['status', 'scheduledFor', 'completionCheckInId', 'completionNote']);
  const status = v.enumValue('status', b.status, ['completed', 'cancelled']);
  const scheduledFor = v.timestamp('scheduledFor', b.scheduledFor);
  const completionNote = v.string('completionNote', b.completionNote, { max: 1000 });
  let completionCheckInId = null;
  if (b.completionCheckInId !== undefined && b.completionCheckInId !== null) {
    if (!isUuid(b.completionCheckInId)) v.add('completionCheckInId', 'Invalid check-in.');
    else completionCheckInId = b.completionCheckInId;
  }
  if (!status && !scheduledFor) v.add('body', 'Nothing to update.');
  v.throwIfInvalid();

  return withTransaction(async (client) => {
    const current = await getAction(client, profile.id, actionId);
    if (!current) throw new HttpError(404, 'action_not_found', 'Action not found.');
    if (current.status === 'completed' || current.status === 'cancelled') {
      throw new HttpError(409, 'action_closed', 'This action is already closed.');
    }
    if (scheduledFor && current.kind !== 'follow_up') throw new HttpError(400, 'validation_failed', 'Only follow-ups can be rescheduled.');
    if (completionCheckInId) {
      // Must be one of this profile's check-ins — prevents linking to another user's records.
      const ci = await getCheckIn(profile.id, completionCheckInId);
      if (!ci) throw new HttpError(404, 'check_in_not_found', 'Check-in not found.');
    }
    const updated = await updateAction(client, profile.id, actionId, { status, scheduledFor, completionCheckInId, completionNote });
    await recordAudit(client, {
      userId: user.id, profileId: profile.id, entityType: 'action', entityId: actionId,
      action: status === 'completed' ? 'follow_up.completed' : status === 'cancelled' ? 'action.cancelled' : 'follow_up.rescheduled',
      metadata: { completionCheckInId },
    });
    if (current.observationId && status === 'completed') {
      await recordAudit(client, {
        userId: user.id, profileId: profile.id, entityType: 'observation', entityId: current.observationId,
        action: 'observation.follow_up_completed', metadata: { actionId, completionCheckInId },
      });
    }
    return updated;
  });
}
