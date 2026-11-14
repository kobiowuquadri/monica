import { h, mount } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { fmtDateTime, unitLabel, isoToZonedInput, zonedInputToIso } from '../ui/format.js';
import { panel, emptyState, loadingBlock, errorBlock, callout, busy, toast, validationList, segmented, badge } from '../ui/components.js';
import { get, post, patch } from '../api.js';
import { state, currentProfile, selectProfile } from '../state.js';
import { METRIC_ICON } from './overview.js';

function timezones() {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC']; }
}

function profileForm({ profile, onSubmit, submitLabel, defaultName = '' }) {
  const f = (id, label, value, opts = {}) => {
    const input = h('input', { class: 'input', id, value: value || '', maxlength: opts.max || 120, required: opts.required });
    return { input, el: h('div', { class: 'field' }, h('label', { for: id }, label), input, opts.hint ? h('span', { class: 'hint' }, opts.hint) : null) };
  };
  const pre = profile ? 'pf' : 'np';
  const name = f(`${pre}-name`, 'Profile name', profile?.displayName ?? defaultName, {
    required: true, max: 80,
    hint: profile ? 'Shown on check-ins and review summaries.' : 'The person whose check-ins this profile will hold.',
  });
  const role = f(`${pre}-role`, 'Role', profile?.roleTitle, { max: 80 });
  const mission = f(`${pre}-mission`, 'Mission', profile?.missionName, { max: 120 });
  const phase = f(`${pre}-phase`, 'Mission phase', profile?.missionPhase, { max: 80, hint: 'e.g. "Interplanetary cruise", "Surface operations"' });
  const zones = timezones();
  if (!zones.includes('UTC')) zones.unshift('UTC');
  const tz = h('select', { class: 'input', id: `${pre}-tz` }, zones.map((z) => h('option', { value: z, selected: z === (profile?.timezone || 'UTC') }, z)));
  const err = h('div', { 'aria-live': 'assertive' });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, submitLabel);
  const form = h('form', { class: 'stack', novalidate: true },
    h('div', { class: 'field-row' }, name.el, role.el),
    h('div', { class: 'field-row' }, mission.el, phase.el),
    h('div', { class: 'field', style: { maxWidth: '360px' } }, h('label', { for: `${pre}-tz` }, 'Time zone for display and data entry'), tz,
      h('span', { class: 'hint' }, 'All times are stored in UTC; this only changes how they are shown and entered.')),
    err, h('div', { class: 'row' }, submit));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const restore = busy(submit, 'Saving…');
    try {
      await onSubmit({ displayName: name.input.value, roleTitle: role.input.value || null, missionName: mission.input.value || null, missionPhase: phase.input.value || null, timezone: tz.value });
      restore();
    } catch (ex) {
      restore();
      mount(err, callout({ tone: 'urgent', title: 'Not saved', body: ex.message, children: validationList(ex.details) }));
    }
  });
  return form;
}

export async function render(root, ctx) {
  const profile = currentProfile();
  const user = state.user;

  // Accounts get their own profile at registration. Extra profiles exist only for recording
  // check-ins on behalf of other people (e.g. a crew medical officer).
  const hasOwnProfile = state.profiles.length > 0;
  const newProfile = h('details', { class: 'disclosure', open: !profile },
    h('summary', null, icon('plus', { size: 16 }), hasOwnProfile ? 'Add a profile for someone else' : 'Create your health profile'),
    h('div', { class: 'disclosure-body' },
      h('p', { class: 'small' }, hasOwnProfile
        ? 'Only needed if you record check-ins for another person — for example, a crew medical officer keeping profiles for several crew members. Each profile has its own readings, baselines and history.'
        : 'Your profile holds your check-ins, baselines and follow-up history.'),
      user?.isDemo ? h('p', { class: 'small' }, 'Profiles created in a demo session are marked fictional and deleted with the demo account.') : null,
      profileForm({ profile: null, defaultName: hasOwnProfile ? '' : (user?.displayName || ''), submitLabel: hasOwnProfile ? 'Add profile' : 'Create profile', onSubmit: async (body) => {
        const { profile: created } = await post('/profiles', body);
        await ctx.reloadProfiles();
        selectProfile(created.id);
        toast('Profile created.');
      } })));

  const account = panel({ title: 'Account', iconName: 'user', id: 'acct', children: h('dl', { class: 'kv' },
    h('dt', null, 'Account'), h('dd', null, user?.isDemo ? 'Demo visitor (no email)' : `${user?.displayName} · ${user?.email}`),
    user?.isDemo ? [h('dt', null, 'Retention'), h('dd', null, `This demo account, its profiles and every entry are deleted automatically after ${fmtDateTime(user.demoExpiresAt, 'UTC')}. Other visitors cannot see them.`)] : null,
    h('dt', null, 'Session'), h('dd', null, 'Held in a secure, HttpOnly cookie — never readable by page scripts or stored in local storage.')) });

  if (!profile) {
    mount(root, h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Profile & settings'))), h('div', { class: 'stack-lg' }, panel({ title: 'Profiles', iconName: 'user', children: newProfile }), account));
    return null;
  }

  const baselineSlot = h('div', null, loadingBlock('Loading baselines…'));
  mount(root,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Profile & settings'), h('p', null, `Manage ${profile.displayName}'s details, display time zone and explicitly recorded baselines.`))),
    h('div', { class: 'stack-lg' },
      panel({ title: 'Profile details', iconName: 'user', id: 'pd', actions: profile.isFictional ? badge('Fictional demo identity', 'outline', 'user') : null,
        children: profileForm({ profile, submitLabel: 'Save changes', onSubmit: async (body) => {
          await patch(`/profiles/${profile.id}`, body);
          await ctx.reloadProfiles();
          toast('Profile saved.');
          ctx.rerender();
        } }) }),
      panel({ title: 'Personal baselines', iconName: 'trends', id: 'bl',
        sub: 'A baseline is never inferred silently. Without one, MONICA shows that comparison is unavailable.', children: baselineSlot }),
      panel({ title: 'Profiles for other people', iconName: 'layers', id: 'op', sub: `${state.profiles.length} profile${state.profiles.length === 1 ? '' : 's'} on this account. Switch between them with the profile selector at the top.`, children: newProfile }),
      account));

  try {
    await drawBaselines(baselineSlot, profile, ctx);
  } catch (err) {
    mount(baselineSlot, errorBlock(err, () => ctx.rerender()));
  }
  return null;
}

async function drawBaselines(slot, profile, ctx) {
  const tz = profile.timezone;
  const data = await get(`/profiles/${profile.id}/baselines`);
  if (!ctx.isCurrent()) return;
  const ref = state.reference;
  const methods = data.methods;

  const cards = Object.entries(ref.vitalMetrics).map(([metric, def]) => {
    const b = data.active.find((x) => x.metric === metric);
    const establishBtn = h('button', { class: 'btn btn-sm', type: 'button' }, icon(b ? 'reset' : 'plus'), b ? 'Replace' : 'Establish');
    const formSlot = h('div');
    establishBtn.addEventListener('click', () => {
      mount(formSlot, baselineForm({ profile, metric, def, methods, tz, ctx, onCancel: () => { mount(formSlot); establishBtn.hidden = false; establishBtn.focus(); } }));
      establishBtn.hidden = true;
      formSlot.querySelector('input')?.focus();
    });
    let retire = null;
    if (b) {
      retire = h('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, 'Retire');
      retire.addEventListener('click', async () => {
        const restore = busy(retire, '…');
        try { await post(`/profiles/${profile.id}/baselines/${b.id}/retire`); toast('Baseline retired.'); ctx.rerender(); } catch (e) { restore(); toast(`Not saved: ${e.message}`, { tone: 'error' }); }
      });
    }
    return h('div', { class: ['baseline-card', b && 'has'] },
      h('div', { class: 'row-between' }, h('div', { class: 'vital-title' }, icon(METRIC_ICON[metric]), def.label), h('div', { class: 'row' }, retire, establishBtn)),
      b ? h('div', { class: 'stack baseline-body' },
        h('div', { class: 'metric-value num' }, b.value, h('span', { class: 'unit' }, unitLabel(b.unit))),
        h('p', { class: 'small muted' }, b.method === 'median_of_resting_readings'
          ? `Median of ${b.sampleCount} resting readings, ${fmtDateTime(b.windowStart, tz)} – ${fmtDateTime(b.windowEnd, tz)}`
          : `Recorded value · ${b.sourceNote}`),
        h('p', { class: 'faint small' }, `Established ${fmtDateTime(b.establishedAt, tz)} · ${b.methodVersion}`))
        : h('p', { class: 'metric-empty' }, icon('unknown'), 'Not established — comparison unavailable'),
      formSlot);
  });

  const history = data.history.filter((b) => b.retiredAt);
  mount(slot,
    h('div', { class: 'callout' }, icon('info'), h('div', { class: 'callout-body' },
      h('span', null, h('strong', null, 'Methods. '), `"Recorded value": ${methods.recorded_value.description} "Median of resting readings": ${methods.median_of_resting_readings.description}`))),
    h('div', { class: 'baseline-grid' }, cards),
    history.length ? h('details', { class: 'disclosure' }, h('summary', null, `Retired baselines (${history.length})`),
      h('div', { class: 'disclosure-body' }, h('ul', { class: 'plain bullets' }, history.map((b) => h('li', null, `${ref.vitalMetrics[b.metric]?.label}: ${b.value} ${unitLabel(b.unit)} (${b.methodVersion}) — retired ${fmtDateTime(b.retiredAt, tz)}`))))) : null);
}

function baselineForm({ profile, metric, def, methods, tz, ctx, onCancel }) {
  let method = 'median_of_resting_readings';
  const body = h('div', { class: 'stack' });
  const err = h('div', { 'aria-live': 'assertive' });
  const unitSel = h('select', { class: 'input', id: `bl-unit-${metric}` }, def.units.map((u) => h('option', { value: u }, unitLabel(u))));
  const value = h('input', { class: 'input', id: `bl-val-${metric}`, type: 'number', step: def.maxDecimals ? '0.1' : '1' });
  const note = h('input', { class: 'input', id: `bl-note-${metric}`, maxlength: 300, placeholder: 'e.g. "Pre-flight medical record, 2026-10-02"' });
  const start = h('input', { class: 'input', id: `bl-start-${metric}`, type: 'datetime-local', value: isoToZonedInput(new Date(Date.now() - 14 * 86_400_000), tz) });
  const end = h('input', { class: 'input', id: `bl-end-${metric}`, type: 'datetime-local', value: isoToZonedInput(new Date(), tz) });

  function draw() {
    mount(body,
      segmented({ name: `bl-method-${metric}`, label: 'Method', value: method, options: [{ value: 'median_of_resting_readings', label: 'Median of my resting readings' }, { value: 'recorded_value', label: 'Recorded value' }], onChange: (v) => { method = v; draw(); } }),
      h('div', { class: 'field-row' },
        h('div', { class: 'field' }, h('label', { for: unitSel.id }, 'Unit'), unitSel),
        method === 'recorded_value'
          ? [h('div', { class: 'field' }, h('label', { for: value.id }, 'Value'), value), h('div', { class: 'field' }, h('label', { for: note.id }, 'Source of this value (required)'), note)]
          : [h('div', { class: 'field' }, h('label', { for: start.id }, 'Window start'), start), h('div', { class: 'field' }, h('label', { for: end.id }, 'Window end'), end)]),
      h('p', { class: 'hint' }, method === 'recorded_value' ? methods.recorded_value.description : methods.median_of_resting_readings.description));
  }
  draw();
  const save = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Save baseline');
  save.addEventListener('click', async () => {
    const restore = busy(save, 'Saving…');
    try {
      const payload = { metric, method, unit: unitSel.value };
      if (method === 'recorded_value') { payload.value = value.value === '' ? null : Number(value.value); payload.sourceNote = note.value; } else { payload.windowStart = zonedInputToIso(start.value, tz); payload.windowEnd = zonedInputToIso(end.value, tz); }
      await post(`/profiles/${profile.id}/baselines`, payload);
      toast('Baseline established.');
      ctx.rerender();
    } catch (e) {
      restore();
      mount(err, callout({ tone: e.code === 'insufficient_readings' ? 'attention' : 'urgent', title: 'No baseline created', body: e.message, children: e.code === 'insufficient_readings' ? null : validationList(e.details) }));
    }
  });
  return h('div', { class: 'baseline-form' }, body, err, h('div', { class: 'row' }, save, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: onCancel }, 'Cancel')));
}

export { emptyState };
