import { h, mount, uid } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { LABELS, fmtDateTime, isoToZonedInput, zonedInputToIso, tzName, unitLabel, plural } from '../ui/format.js';
import { callout, levelBadge, linkButton, busy, segmented, emptyState, toast } from '../ui/components.js';
import { post, patch, get, newIdempotencyKey } from '../api.js';
import { state, currentProfile } from '../state.js';
import { noProfileState, METRIC_ICON } from './overview.js';

const STEPS = ['Measurement context', 'Vital signs', 'Symptoms', 'Sleep & wellbeing', 'Review & save'];

// Data-entry guidance written by MONICA. It is deliberately not a clinical measurement protocol.
const GUIDANCE = {
  heart_rate: 'Enter beats per minute as you counted them or as your device displays them.',
  spo2: 'Enter the percentage exactly as a pulse oximeter displays it. If the device shows a warning or an unstable signal, mark quality as uncertain.',
  temperature: 'Choose the measurement site and enter the value in the unit shown. MONICA stores the site so readings can be compared like-for-like.',
  bp: 'Enter both numbers from the same measurement: systolic first, diastolic second.',
  respiratory_rate: 'Enter breaths per minute as counted, or as reported by a device that measures breathing rate.',
};
const GUIDANCE_REF = 'Data-entry guidance by MONICA — not a clinical measurement protocol. Follow your mission\'s medical procedures and your device manufacturer\'s instructions.';

const CONTEXT_DESC = {
  resting: 'Seated or lying quietly before measuring. Used for baseline comparison.',
  after_waking: 'Shortly after waking, before activity.',
  post_exercise: 'Shortly after exercise or exertion.',
  during_activity: 'While working or moving.',
  other: 'Describe in the note below.',
  unknown: 'Context not known.',
};

function emptyDraft(profile) {
  const nowLocal = isoToZonedInput(new Date(), profile.timezone);
  const vitals = {};
  for (const m of ['heart_rate', 'spo2', 'temperature', 'respiratory_rate']) {
    vitals[m] = { enabled: false, value: '', unit: m === 'temperature' ? 'degC' : null, method: '', sourceType: 'manual', deviceLabel: '', quality: 'good' };
  }
  return {
    profileId: profile.id,
    idempotencyKey: newIdempotencyKey(),
    step: 0,
    measuredLocal: nowLocal,
    activityContext: 'resting',
    contextNote: '',
    vitals,
    bp: { enabled: false, sys: '', dia: '', sourceType: 'manual', deviceLabel: '', quality: 'good' },
    symptomStatus: null,
    symptoms: [],
    wellbeing: { sleepDurationHours: '', sleepQuality: null, fatigueRating: null, moodRating: null },
    exposure: { enabled: false, value: '', sourceType: 'device_reported', note: '' },
    lymph: { enabled: false, value: '' },
    medications: [],
    notes: '',
    followUpId: null,
    attempts: 0,
    result: null,
  };
}

function drafts() {
  state.checkInDraft ||= {};
  return state.checkInDraft;
}

const UNIT_FOR = { heart_rate: 'beats/min', spo2: '%', respiratory_rate: 'breaths/min' };

/** Builds the API payload from the draft. Client-side checks mirror, but never replace, the server's. */
function buildPayload(d, tz) {
  const errors = [];
  const measuredAt = zonedInputToIso(d.measuredLocal, tz);
  if (!measuredAt) errors.push({ step: 0, message: 'Enter the date and time of the measurements.' });
  else if (new Date(measuredAt) > new Date(Date.now() + 5 * 60_000)) errors.push({ step: 0, message: 'Measurement time cannot be in the future.' });
  const vitals = [];
  for (const [metric, v] of Object.entries(d.vitals)) {
    if (!v.enabled) continue;
    const value = Number(v.value);
    if (v.value === '' || !Number.isFinite(value)) { errors.push({ step: 1, message: `${state.reference.vitalMetrics[metric].label}: enter a number or switch it to "Not measured".` }); continue; }
    if (metric === 'temperature' && !v.method) errors.push({ step: 1, message: 'Body temperature: choose the measurement site.' });
    vitals.push({
      metric, value, unit: metric === 'temperature' ? v.unit : UNIT_FOR[metric],
      method: metric === 'temperature' ? (v.method || undefined) : undefined,
      sourceType: v.sourceType, deviceLabel: v.deviceLabel.trim() || undefined, quality: v.quality,
    });
  }
  if (d.bp.enabled) {
    const sys = Number(d.bp.sys);
    const dia = Number(d.bp.dia);
    if (d.bp.sys === '' || d.bp.dia === '' || !Number.isFinite(sys) || !Number.isFinite(dia)) errors.push({ step: 1, message: 'Blood pressure: enter both systolic and diastolic values.' });
    else {
      const common = { unit: 'mmHg', sourceType: d.bp.sourceType, deviceLabel: d.bp.deviceLabel.trim() || undefined, quality: d.bp.quality };
      vitals.push({ metric: 'bp_systolic', value: sys, ...common }, { metric: 'bp_diastolic', value: dia, ...common });
    }
  }
  let exposure;
  if (d.exposure?.enabled) {
    const value = Number(d.exposure.value);
    if (d.exposure.value === '' || !Number.isFinite(value) || value < 0) errors.push({ step: 1, message: 'Radiation dose rate: enter a number or switch it to "Not measured".' });
    else exposure = { doseRate: value, sourceType: d.exposure.sourceType, sourceNote: d.exposure.note.trim() || undefined };
  }
  let biomarkers;
  if (d.lymph?.enabled) {
    const value = Number(d.lymph.value);
    if (d.lymph.value === '' || !Number.isFinite(value) || value < 0) errors.push({ step: 1, message: 'Lymphocyte count: enter a number or switch it to "Not measured".' });
    else biomarkers = { lymphocyteCount: value };
  }
  const symptoms = d.symptoms.map((s) => ({
    code: s.code, severity: s.severity,
    onsetAt: s.onsetLocal ? zonedInputToIso(s.onsetLocal, tz) : undefined,
    onsetNote: s.onsetNote.trim() || undefined,
    markedUrgent: s.markedUrgent,
    notes: s.notes.trim() || undefined,
  }));
  for (const s of d.symptoms) if (!s.severity) errors.push({ step: 2, message: `${state.reference.symptoms[s.code]}: choose a severity.` });
  for (const s of d.symptoms) if (s.code === 'other' && !s.notes.trim()) errors.push({ step: 2, message: 'Other symptom: describe it in the notes.' });
  const w = d.wellbeing;
  const wellbeing = {};
  if (w.sleepDurationHours !== '') wellbeing.sleepDurationHours = Number(w.sleepDurationHours);
  if (w.sleepQuality !== null) wellbeing.sleepQuality = w.sleepQuality;
  if (w.fatigueRating !== null) wellbeing.fatigueRating = w.fatigueRating;
  if (w.moodRating !== null) wellbeing.moodRating = w.moodRating;
  const medications = d.medications.filter((m) => m.name.trim()).map((m) => ({ name: m.name.trim(), amount: m.amount.trim() || undefined }));
  const symptomStatus = symptoms.length ? 'reported' : (d.symptomStatus === 'none_reported' ? 'none_reported' : 'not_assessed');
  const payload = {
    measuredAt, activityContext: d.activityContext, contextNote: d.contextNote.trim() || undefined,
    vitals, symptoms, symptomStatus, wellbeing, medications, notes: d.notes.trim() || undefined,
  };
  if (exposure) payload.exposure = exposure;
  if (biomarkers) payload.biomarkers = biomarkers;
  if (!vitals.length && !symptoms.length && !Object.keys(wellbeing).length && !medications.length && !payload.notes && !exposure && !biomarkers) {
    errors.push({ step: 1, message: 'Add at least one entry — a measurement, symptom, wellbeing rating, medication or note.' });
  }
  return { payload, errors };
}

function stepForField(field) {
  if (/^(measuredAt|activityContext|contextNote)/.test(field)) return 0;
  if (/^(vitals|exposure|biomarkers)/.test(field)) return 1;
  if (/^(symptoms|symptomStatus)/.test(field)) return 2;
  return 3;
}

export async function render(root, ctx) {
  const profile = currentProfile();
  if (!profile) { mount(root, noProfileState()); return null; }
  const tz = profile.timezone;
  const ref = state.reference;
  const store = drafts();
  let d = store[profile.id];
  if (!d || d.result) { d = emptyDraft(profile); store[profile.id] = d; }
  d.exposure ||= { enabled: false, value: '', sourceType: 'device_reported', note: '' };
  d.lymph ||= { enabled: false, value: '' };

  let followUp = null;
  if (ctx.params.followUp) {
    d.followUpId = ctx.params.followUp;
    try {
      const { actions } = await get(`/profiles/${profile.id}/actions?status=planned`);
      followUp = actions.find((a) => a.id === ctx.params.followUp) || null;
      if (!followUp) d.followUpId = null;
    } catch { followUp = null; }
  } else if (d.followUpId) {
    followUp = { id: d.followUpId, description: 'Scheduled follow-up' };
  }

  const stepperEl = h('ol', { class: 'stepper', 'aria-label': 'Check-in steps' });
  const body = h('div', { class: 'checkin-body' });
  const nav = h('div', { class: 'checkin-nav' });
  const statusSlot = h('div', { 'aria-live': 'polite' });

  function go(step) {
    d.step = Math.max(0, Math.min(STEPS.length - 1, step));
    draw();
    body.querySelector('h2')?.focus();
  }

  function drawStepper() {
    mount(stepperEl, STEPS.map((name, i) => h('li', { class: [i < d.step && 'done', i === d.step && 'current'] },
      h('button', { type: 'button', onclick: () => go(i), 'aria-current': i === d.step ? 'step' : undefined },
        h('span', { class: 'step-num' }, `Step ${i + 1}`), h('span', { class: 'step-name' }, name)))));
  }

  function drawNav() {
    const back = d.step > 0 ? h('button', { class: 'btn', type: 'button', onclick: () => go(d.step - 1) }, icon('chevronLeft'), 'Back') : h('span');
    const next = d.step < STEPS.length - 1
      ? h('button', { class: 'btn btn-primary', type: 'button', onclick: () => go(d.step + 1) }, d.step === STEPS.length - 2 ? 'Review' : 'Continue', icon('chevronRight'))
      : null;
    mount(nav, back, h('span', { class: 'faint small' }, 'Entries stay in this browser tab until saved.'), next);
  }

  function draw() {
    drawStepper();
    drawNav();
    const renderers = [stepContext, stepVitals, stepSymptoms, stepWellbeing, stepReview];
    mount(body, renderers[d.step]());
  }

  // ---------------- Step 1 ----------------
  function stepContext() {
    const dt = h('input', { class: 'input', type: 'datetime-local', id: 'ci-time', value: d.measuredLocal, max: isoToZonedInput(new Date(Date.now() + 5 * 60_000), tz), required: true });
    dt.addEventListener('input', () => { d.measuredLocal = dt.value; });
    const note = h('input', { class: 'input', id: 'ci-ctx-note', value: d.contextNote, maxlength: 300, placeholder: 'Optional, e.g. "after 30 min treadmill session"' });
    note.addEventListener('input', () => { d.contextNote = note.value; });
    const options = h('div', { class: 'option-grid', role: 'radiogroup', 'aria-labelledby': 'ci-ctx-label' },
      ref.activityContexts.map((c) => {
        const input = h('input', { type: 'radio', name: 'ci-context', value: c, checked: d.activityContext === c });
        input.addEventListener('change', () => { d.activityContext = c; });
        return h('label', { class: 'option-card' }, input, h('span', { class: 'oc-body' }, h('span', { class: 'oc-title' }, LABELS.context[c]), h('span', { class: 'oc-desc' }, CONTEXT_DESC[c])));
      }));
    return h('div', { class: 'stack-lg' },
      h('div', null, h('h2', { tabindex: '-1' }, 'When and in what context?'), h('p', { class: 'muted' }, 'Context matters: MONICA keeps resting and post-exercise readings apart and only compares resting readings with a baseline.')),
      h('div', { class: 'field', style: { maxWidth: '320px' } }, h('label', { for: 'ci-time' }, 'Date and time of measurements'), dt, h('span', { class: 'hint' }, `Profile time zone: ${tz} (${tzName(tz)})`)),
      h('div', { class: 'field' }, h('span', { class: 'field-label', id: 'ci-ctx-label' }, 'Activity context'), options),
      h('div', { class: 'field' }, h('label', { for: 'ci-ctx-note' }, 'Context note'), note));
  }

  // ---------------- Step 2 ----------------
  function sourceFields(v, key) {
    const deviceId = uid('dev');
    const dev = h('input', { class: 'input', id: deviceId, value: v.deviceLabel, maxlength: 120, placeholder: 'e.g. "Fingertip pulse oximeter"' });
    dev.addEventListener('input', () => { v.deviceLabel = dev.value; });
    return h('div', { class: 'source-fields' },
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Source'),
        segmented({ name: `${key}-src`, label: 'Source', value: v.sourceType, fill: true, options: [{ value: 'manual', label: 'Manual' }, { value: 'device_reported', label: 'Device-reported' }], onChange: (val) => { v.sourceType = val; } })),
      h('div', { class: 'field' }, h('label', { for: deviceId }, 'Device (optional)'), dev),
      h('div', { class: 'field span-all' }, h('span', { class: 'field-label' }, 'Measurement quality'),
        segmented({ name: `${key}-q`, label: 'Quality', value: v.quality, fill: true, options: [
          { value: 'good', label: 'Good' }, { value: 'uncertain', label: 'Uncertain' }, { value: 'poor', label: 'Poor' }, { value: 'not_stated', label: 'Not stated' }], onChange: (val) => { v.quality = val; } })));
  }

  function vitalCard(metric) {
    const def = ref.vitalMetrics[metric];
    const v = d.vitals[metric];
    const fields = h('div', { class: 'vital-fields stack' });
    const toggle = h('input', { type: 'checkbox', checked: v.enabled, 'aria-describedby': `${metric}-status` });
    const status = h('span', { id: `${metric}-status`, class: 'vital-status' }, v.enabled ? 'Recording' : 'Not measured');
    function drawFields() {
      if (!v.enabled) { mount(fields); return; }
      const valId = uid('val');
      const val = h('input', { class: 'input', id: valId, type: 'number', inputmode: 'decimal', step: metric === 'temperature' ? '0.1' : '1', value: v.value, required: true });
      val.addEventListener('input', () => { v.value = val.value; });
      let unitEl;
      if (metric === 'temperature') {
        unitEl = segmented({ name: `${metric}-unit`, label: 'Unit', value: v.unit, options: [{ value: 'degC', label: '°C' }, { value: 'degF', label: '°F' }], onChange: (u) => { v.unit = u; } });
      }
      const range = metric === 'temperature' ? def.inputRange[v.unit] : def.inputRange;
      mount(fields,
        h('div', { class: 'field-row' },
          h('div', { class: 'field' }, h('label', { for: valId }, `Value`),
            metric === 'temperature' ? val : h('div', { class: 'input-unit' }, val, h('span', { class: 'unit' }, unitLabel(def.defaultUnit))),
            h('span', { class: 'hint' }, `Accepted input ${range.min}–${range.max} (typo check only)`)),
          metric === 'temperature' ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Unit'), unitEl) : null,
          metric === 'temperature' ? (() => {
            const mId = uid('m');
            const sel = h('select', { class: 'input', id: mId, required: true }, h('option', { value: '' }, 'Choose site…'),
              def.methods.map((m) => h('option', { value: m, selected: v.method === m }, LABELS.tempMethod[m])));
            sel.addEventListener('change', () => { v.method = sel.value; });
            return h('div', { class: 'field' }, h('label', { for: mId }, 'Measurement site'), sel);
          })() : null),
        sourceFields(v, metric));
    }
    toggle.addEventListener('change', () => { v.enabled = toggle.checked; status.textContent = v.enabled ? 'Recording' : 'Not measured'; card.classList.toggle('on', v.enabled); drawFields(); if (v.enabled) fields.querySelector('input')?.focus(); });
    drawFields();
    const card = h('div', { class: ['vital-card', v.enabled && 'on'] },
      h('div', { class: 'vital-card-head' },
        h('div', { class: 'vital-title' }, icon(METRIC_ICON[metric]), h('span', null, def.label)),
        h('label', { class: 'switch' }, toggle, status)),
      h('p', { class: 'guidance' }, GUIDANCE[metric]),
      fields);
    return card;
  }

  function bpCard() {
    const v = d.bp;
    const fields = h('div', { class: 'vital-fields stack' });
    const toggle = h('input', { type: 'checkbox', checked: v.enabled });
    const status = h('span', { class: 'vital-status' }, v.enabled ? 'Recording' : 'Not measured');
    function drawFields() {
      if (!v.enabled) { mount(fields); return; }
      const sys = h('input', { class: 'input', id: 'bp-sys', type: 'number', inputmode: 'numeric', value: v.sys });
      const dia = h('input', { class: 'input', id: 'bp-dia', type: 'number', inputmode: 'numeric', value: v.dia });
      sys.addEventListener('input', () => { v.sys = sys.value; });
      dia.addEventListener('input', () => { v.dia = dia.value; });
      mount(fields,
        h('div', { class: 'field-row' },
          h('div', { class: 'field' }, h('label', { for: 'bp-sys' }, 'Systolic'), h('div', { class: 'input-unit' }, sys, h('span', { class: 'unit' }, 'mmHg'))),
          h('div', { class: 'field' }, h('label', { for: 'bp-dia' }, 'Diastolic'), h('div', { class: 'input-unit' }, dia, h('span', { class: 'unit' }, 'mmHg')))),
        sourceFields(v, 'bp'));
    }
    toggle.addEventListener('change', () => { v.enabled = toggle.checked; status.textContent = v.enabled ? 'Recording' : 'Not measured'; card.classList.toggle('on', v.enabled); drawFields(); if (v.enabled) fields.querySelector('input')?.focus(); });
    drawFields();
    const card = h('div', { class: ['vital-card', v.enabled && 'on'] },
      h('div', { class: 'vital-card-head' }, h('div', { class: 'vital-title' }, icon('gauge'), h('span', null, 'Blood pressure')), h('label', { class: 'switch' }, toggle, status)),
      h('p', { class: 'guidance' }, GUIDANCE.bp),
      fields);
    return card;
  }

  /** Optional Health Brain inputs: a personal dose-rate reading and a lymphocyte count. */
  function inputCard({ v, key, title, iconName, guidance, unit, step, hint, extra }) {
    const fields = h('div', { class: 'vital-fields stack' });
    const toggle = h('input', { type: 'checkbox', checked: v.enabled, 'aria-describedby': `${key}-status` });
    const status = h('span', { id: `${key}-status`, class: 'vital-status' }, v.enabled ? 'Recording' : 'Not measured');
    function drawFields() {
      if (!v.enabled) { mount(fields); return; }
      const valId = uid('val');
      const val = h('input', { class: 'input', id: valId, type: 'number', inputmode: 'decimal', step, min: 0, value: v.value, required: true });
      val.addEventListener('input', () => { v.value = val.value; });
      mount(fields,
        h('div', { class: 'field' }, h('label', { for: valId }, 'Value'), h('div', { class: 'input-unit' }, val, h('span', { class: 'unit' }, unit)), h('span', { class: 'hint' }, hint)),
        extra ? extra() : null);
    }
    toggle.addEventListener('change', () => { v.enabled = toggle.checked; status.textContent = v.enabled ? 'Recording' : 'Not measured'; card.classList.toggle('on', v.enabled); drawFields(); if (v.enabled) fields.querySelector('input')?.focus(); });
    drawFields();
    const card = h('div', { class: ['vital-card', v.enabled && 'on'] },
      h('div', { class: 'vital-card-head' }, h('div', { class: 'vital-title' }, icon(iconName), h('span', null, title)), h('label', { class: 'switch' }, toggle, status)),
      h('p', { class: 'guidance' }, guidance),
      fields);
    return card;
  }

  function exposureCard() {
    const r = ref.exposureInput?.inputRange || { min: 0, max: 100000 };
    return inputCard({
      v: d.exposure, key: 'exposure', title: 'Radiation dose rate', iconName: 'radiation', unit: 'µGy/h', step: '0.01',
      guidance: 'Enter the absorbed dose rate exactly as your personal or area dosimeter displays it. The Health Brain compares it with your own earlier readings; it needs three earlier readings before Exposure can be assessed.',
      hint: `Accepted input ${r.min}–${r.max} (typo check only)`,
      extra: () => {
        const noteId = uid('exp-note');
        const note = h('input', { class: 'input', id: noteId, value: d.exposure.note, maxlength: 300, placeholder: 'e.g. "Habitat area monitor, sleeping quarters"' });
        note.addEventListener('input', () => { d.exposure.note = note.value; });
        return h('div', { class: 'source-fields' },
          h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Source'),
            segmented({ name: 'exposure-src', label: 'Source', value: d.exposure.sourceType, fill: true, options: [{ value: 'device_reported', label: 'Device-reported' }, { value: 'manual', label: 'Manual' }], onChange: (val) => { d.exposure.sourceType = val; } })),
          h('div', { class: 'field' }, h('label', { for: noteId }, 'Dosimeter / location (optional)'), note));
      },
    });
  }

  function lymphCard() {
    const r = ref.lymphocyteInput?.inputRange || { min: 0, max: 20 };
    return inputCard({
      v: d.lymph, key: 'lymph', title: 'Lymphocyte count', iconName: 'flask', unit: '×10⁹/L', step: '0.01',
      guidance: 'Enter the absolute lymphocyte count from a blood analyser result, if one was taken. The Health Brain compares it with the median of your earlier counts.',
      hint: `Accepted input ${r.min}–${r.max} (typo check only)`,
    });
  }

  function stepVitals() {
    return h('div', { class: 'stack-lg' },
      h('div', null, h('h2', { tabindex: '-1' }, 'Vital signs'), h('p', { class: 'muted' }, 'Switch on only what you actually measured. Anything left as "Not measured" is stored as not assessed — never as normal.')),
      callout({ tone: 'info', iconName: 'info', body: 'Only enter values a device actually displays for that measurement. Don\'t derive one measurement from another — for example, don\'t estimate oxygen saturation from heart rate.' }),
      h('div', { class: 'vital-grid' }, vitalCard('heart_rate'), vitalCard('spo2'), vitalCard('temperature'), bpCard(), vitalCard('respiratory_rate')),
      h('div', null, h('h3', { class: 'hb-inputs-title' }, icon('gauge'), 'Health Brain inputs (optional)'), h('p', { class: 'muted small' }, 'These feed the Exposure and Biomarkers components of the RHI index. Left as "Not measured", those components are shown as not assessed and add no points.')),
      h('div', { class: 'vital-grid' }, exposureCard(), lymphCard()),
      h('p', { class: 'faint small' }, icon('info', { size: 13 }), ' ', GUIDANCE_REF));
  }

  // ---------------- Step 3 ----------------
  function stepSymptoms() {
    const list = h('div', { class: 'stack' });
    const chips = h('div', { class: 'chip-grid', role: 'group', 'aria-label': 'Symptoms' });
    const statusWrap = h('div');
    function drawStatus() {
      if (d.symptoms.length) { mount(statusWrap); return; }
      mount(statusWrap, h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'If you have nothing to add'),
        segmented({ name: 'sym-status', label: 'Symptom status', value: d.symptomStatus || '', options: [
          { value: 'none_reported', label: 'No symptoms to report' }, { value: 'not_assessed', label: 'Skip — not assessed' }], onChange: (v) => { d.symptomStatus = v; } }),
        h('span', { class: 'hint' }, 'Skipping is recorded as "not assessed", which is different from "no symptoms".')));
    }
    function drawChips() {
      mount(chips, Object.entries(ref.symptoms).map(([code, label]) => {
        const on = d.symptoms.some((s) => s.code === code);
        return h('button', { type: 'button', class: 'chip', 'aria-pressed': String(on), onclick: () => toggleSymptom(code) }, on ? icon('check') : icon('plus'), label);
      }));
    }
    function toggleSymptom(code) {
      const i = d.symptoms.findIndex((s) => s.code === code);
      if (i >= 0) d.symptoms.splice(i, 1);
      else d.symptoms.push({ code, severity: null, onsetLocal: '', onsetNote: '', markedUrgent: false, notes: '' });
      drawChips(); drawList(); drawStatus();
    }
    function drawList() {
      mount(list, d.symptoms.map((s) => {
        const onsetId = uid('onset');
        const onset = h('input', { class: 'input', id: onsetId, type: 'datetime-local', value: s.onsetLocal });
        onset.addEventListener('input', () => { s.onsetLocal = onset.value; });
        const onsetNoteId = uid('on');
        const onsetNote = h('input', { class: 'input', id: onsetNoteId, value: s.onsetNote, maxlength: 200, placeholder: 'or describe, e.g. "since yesterday evening"' });
        onsetNote.addEventListener('input', () => { s.onsetNote = onsetNote.value; });
        const notesId = uid('sn');
        const notes = h('textarea', { class: 'input', id: notesId, rows: 2, maxlength: 1000 }, s.notes);
        notes.addEventListener('input', () => { s.notes = notes.value; });
        const urgent = h('input', { type: 'checkbox', checked: s.markedUrgent });
        urgent.addEventListener('change', () => { s.markedUrgent = urgent.checked; card.classList.toggle('urgent', urgent.checked); });
        const card = h('div', { class: ['symptom-card', s.markedUrgent && 'urgent'] },
          h('div', { class: 'row-between' }, h('h3', null, ref.symptoms[s.code]),
            h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => toggleSymptom(s.code), 'aria-label': `Remove ${ref.symptoms[s.code]}` }, icon('x'), 'Remove')),
          h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Severity (your rating)'),
            segmented({ name: `sev-${s.code}`, label: 'Severity', value: s.severity || '', options: ['mild', 'moderate', 'severe'].map((x) => ({ value: x, label: LABELS.severity[x] })), onChange: (val) => { s.severity = val; } })),
          h('div', { class: 'field-row' },
            h('div', { class: 'field' }, h('label', { for: onsetId }, 'Onset (optional)'), onset),
            h('div', { class: 'field' }, h('label', { for: onsetNoteId }, 'Onset description (optional)'), onsetNote)),
          h('div', { class: 'field' }, h('label', { for: notesId }, s.code === 'other' ? 'Describe the symptom (required)' : 'Notes (optional)'), notes),
          h('label', { class: 'check urgent-check' }, urgent, h('span', null, h('strong', null, 'This needs prompt medical attention.'), ' MONICA will show an urgent medical-review prompt. It does not contact anyone.')));
        return card;
      }));
    }
    drawChips(); drawList(); drawStatus();
    return h('div', { class: 'stack-lg' },
      h('div', null, h('h2', { tabindex: '-1' }, 'Symptoms'), h('p', { class: 'muted' }, 'Select anything you are experiencing. MONICA records symptoms as reported and does not infer causes from them.')),
      chips, list, statusWrap);
  }

  // ---------------- Step 4 ----------------
  function scale(name, label, key, min, max, anchors) {
    const opts = [];
    for (let i = min; i <= max; i += 1) opts.push({ value: i, label: String(i), title: anchors?.[i] });
    const clear = h('button', { class: 'link-btn small', type: 'button', onclick: () => { d.wellbeing[key] = null; draw(); } }, 'Clear');
    return h('div', { class: 'field' },
      h('div', { class: 'row-between' }, h('span', { class: 'field-label', id: `${name}-l` }, label), d.wellbeing[key] !== null ? clear : h('span', { class: 'faint small' }, 'Not assessed')),
      segmented({ name, label, value: d.wellbeing[key] ?? '', options: opts, onChange: (v) => { d.wellbeing[key] = Number(v); } }),
      anchors ? h('div', { class: 'scale-anchors' }, Object.entries(anchors).map(([k, v]) => h('span', null, `${k} = ${v}`))) : null);
  }

  function stepWellbeing() {
    const wb = ref.wellbeingMetrics;
    const sleep = h('input', { class: 'input', id: 'wb-sleep', type: 'number', inputmode: 'decimal', step: '0.25', min: 0, max: 24, value: d.wellbeing.sleepDurationHours });
    sleep.addEventListener('input', () => { d.wellbeing.sleepDurationHours = sleep.value; });
    const meds = h('div', { class: 'stack' });
    function drawMeds() {
      mount(meds, d.medications.map((m, i) => {
        const n = h('input', { class: 'input', value: m.name, maxlength: 120, 'aria-label': `Medication ${i + 1} name as reported` });
        const a = h('input', { class: 'input', value: m.amount, maxlength: 120, 'aria-label': `Medication ${i + 1} amount as reported`, placeholder: 'Amount, as you would describe it' });
        n.addEventListener('input', () => { m.name = n.value; });
        a.addEventListener('input', () => { m.amount = a.value; });
        return h('div', { class: 'med-row' }, n, a, h('button', { class: 'btn btn-ghost btn-icon', type: 'button', 'aria-label': `Remove medication ${i + 1}`, onclick: () => { d.medications.splice(i, 1); drawMeds(); } }, icon('x')));
      }), h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { d.medications.push({ name: '', amount: '' }); drawMeds(); meds.querySelector('.med-row:last-of-type input')?.focus(); } }, icon('plus'), 'Add medication or supplement taken'));
    }
    drawMeds();
    const notes = h('textarea', { class: 'input', id: 'wb-notes', rows: 4, maxlength: 2000 }, d.notes);
    notes.addEventListener('input', () => { d.notes = notes.value; });
    return h('div', { class: 'stack-lg' },
      h('div', null, h('h2', { tabindex: '-1' }, 'Sleep & wellbeing'), h('p', { class: 'muted' }, 'Self-ratings on MONICA prototype scales — useful for spotting your own patterns, not validated clinical instruments. Leave anything blank to record it as not assessed.')),
      h('div', { class: 'field', style: { maxWidth: '260px' } }, h('label', { for: 'wb-sleep' }, 'Sleep duration (last sleep period)'), h('div', { class: 'input-unit' }, sleep, h('span', { class: 'unit' }, 'hours'))),
      scale('wb-sq', 'Perceived sleep quality', 'sleepQuality', 1, 5, wb.sleep_quality.anchors),
      scale('wb-fat', 'Fatigue', 'fatigueRating', 0, 10, wb.fatigue_rating.anchors),
      scale('wb-mood', 'Mood', 'moodRating', 1, 5, wb.mood_rating.anchors),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Medication log (self-reported)'),
        h('span', { class: 'hint' }, 'Records what you report having taken. MONICA never recommends medication or doses.'), meds),
      h('div', { class: 'field' }, h('label', { for: 'wb-notes' }, 'Notes'), notes));
  }

  // ---------------- Step 5 ----------------
  function reviewRow(label, value, step) {
    return h('div', { class: 'review-row' }, h('div', { class: 'review-label' }, label), h('div', { class: 'review-value' }, value),
      h('button', { class: 'link-btn small', type: 'button', onclick: () => go(step) }, 'Edit'));
  }

  function stepReview() {
    const { payload, errors } = buildPayload(d, tz);
    const vitalsSummary = payload.vitals.length
      ? h('ul', { class: 'plain' }, payload.vitals.map((v) => h('li', null,
        `${ref.vitalMetrics[v.metric].label}: `, h('strong', { class: 'num' }, `${v.value} ${unitLabel(v.unit)}`),
        h('span', { class: 'faint' }, ` · ${LABELS.source[v.sourceType]}${v.deviceLabel ? ` (${v.deviceLabel})` : ''} · ${LABELS.quality[v.quality]}${v.method ? ` · ${LABELS.tempMethod[v.method]}` : ''}`))))
      : h('span', { class: 'faint' }, 'Not assessed — no vital signs recorded');
    const symSummary = payload.symptoms.length
      ? h('ul', { class: 'plain' }, payload.symptoms.map((s) => h('li', null, `${ref.symptoms[s.code]} — ${LABELS.severity[s.severity] || 'severity missing'}`, s.markedUrgent ? h('span', { class: 'badge urgent inline' }, icon('urgent'), 'Prompt attention') : null)))
      : h('span', { class: 'faint' }, LABELS.symptomStatus[payload.symptomStatus]);
    const w = payload.wellbeing;
    const wbSummary = Object.keys(w).length
      ? [w.sleepDurationHours !== undefined && `Sleep ${w.sleepDurationHours} h`, w.sleepQuality !== undefined && `Sleep quality ${w.sleepQuality}/5`, w.fatigueRating !== undefined && `Fatigue ${w.fatigueRating}/10`, w.moodRating !== undefined && `Mood ${w.moodRating}/5`].filter(Boolean).join(' · ')
      : h('span', { class: 'faint' }, 'Not assessed');

    const saveBtn = h('button', { class: 'btn btn-primary btn-lg', type: 'button', disabled: errors.length > 0 }, icon('check'), d.attempts ? 'Retry save' : 'Save check-in');
    saveBtn.addEventListener('click', () => save(saveBtn, payload));

    return h('div', { class: 'stack-lg' },
      h('div', null, h('h2', { tabindex: '-1' }, 'Review & save'), h('p', { class: 'muted' }, 'Check everything below. "Saved" is shown only after the server confirms the database write.')),
      followUp ? callout({ tone: 'teal', iconName: 'calendar', title: 'Completing a follow-up', body: followUp.description }) : null,
      errors.length ? callout({ tone: 'attention', title: 'A few things need attention before saving', children: h('ul', { class: 'plain' }, errors.map((e) => h('li', null, e.message, ' ', h('button', { class: 'link-btn', type: 'button', onclick: () => go(e.step) }, `Go to ${STEPS[e.step]}`)))) }) : null,
      h('div', { class: 'review panel tight' },
        reviewRow('Measured', `${fmtDateTime(payload.measuredAt, tz)} · ${LABELS.context[payload.activityContext]}${payload.contextNote ? ` — ${payload.contextNote}` : ''}`, 0),
        reviewRow('Vital signs', vitalsSummary, 1),
        reviewRow('Health Brain inputs', (payload.exposure || payload.biomarkers)
          ? [payload.exposure && `Dose rate ${payload.exposure.doseRate} µGy/h (${LABELS.source[payload.exposure.sourceType]})`, payload.biomarkers && `Lymphocytes ${payload.biomarkers.lymphocyteCount} ×10⁹/L`].filter(Boolean).join(' · ')
          : h('span', { class: 'faint' }, 'Not assessed — no dose rate or lymphocyte count'), 1),
        reviewRow('Symptoms', symSummary, 2),
        reviewRow('Sleep & wellbeing', wbSummary, 3),
        reviewRow('Medications (as reported)', payload.medications.length ? payload.medications.map((m) => `${m.name}${m.amount ? ` (${m.amount})` : ''}`).join(', ') : h('span', { class: 'faint' }, 'None recorded'), 3),
        reviewRow('Notes', payload.notes || h('span', { class: 'faint' }, 'None'), 3)),
      statusSlot,
      h('div', { class: 'row' }, saveBtn, h('span', { class: 'faint small' }, `Submission key ${d.idempotencyKey.slice(0, 11)}… — retries reuse it, so a retry cannot create a duplicate.`)));
  }

  async function save(btn, payload) {
    const restore = busy(btn, 'Saving…');
    mount(statusSlot, h('div', { class: 'callout' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('div', { class: 'callout-body' }, h('strong', null, 'Saving…'), h('span', null, 'Waiting for the server to confirm the database write.'))));
    d.attempts += 1;
    try {
      const res = await post(`/profiles/${profile.id}/check-ins`, payload, { idempotencyKey: d.idempotencyKey, timeoutMs: 25_000 });
      if (!res?.checkIn?.id) throw Object.assign(new Error('The server response did not include a saved record.'), { network: false });
      let followUpResult = null;
      if (d.followUpId) {
        try {
          await patch(`/profiles/${profile.id}/actions/${d.followUpId}`, { status: 'completed', completionCheckInId: res.checkIn.id });
          followUpResult = 'completed';
        } catch (err) {
          followUpResult = err.message;
        }
      }
      d.result = { ...res, followUpResult };
      delete drafts()[profile.id];
      ctx.refreshCounts();
      renderSuccess(d.result);
    } catch (err) {
      restore();
      btn.textContent = 'Retry save';
      btn.prepend(icon('reset'));
      renderFailure(err, payload);
    }
  }

  function renderFailure(err, payload) {
    if (err.code === 'validation_failed') {
      mount(statusSlot, callout({ tone: 'urgent', title: 'Not saved — the server found entries to fix', body: err.message,
        children: h('ul', { class: 'plain' }, (err.details || []).map((x) => h('li', null, h('code', null, x.field), ` — ${x.message} `, h('button', { class: 'link-btn', type: 'button', onclick: () => go(stepForField(x.field)) }, 'Fix'))))}));
      return;
    }
    if (err.code === 'idempotency_conflict') {
      const newBtn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Submit these values as a new check-in');
      newBtn.addEventListener('click', () => { d.idempotencyKey = newIdempotencyKey(); draw(); });
      mount(statusSlot, callout({ tone: 'attention', title: 'An earlier attempt was already saved with different values',
        body: 'A previous save of this check-in reached the server before you edited it. Check Recent check-ins on the Overview. To store the current values too, submit them as a new check-in.', children: newBtn }));
      return;
    }
    const ambiguous = err.timeout;
    mount(statusSlot, callout({ tone: 'urgent', title: 'Not saved',
      body: `${err.message} ${ambiguous ? 'The server may or may not have received it. ' : ''}Your entries are still here. Retrying is safe — it reuses the same submission key, so it cannot create a duplicate.` }));
    toast('Check-in not saved — your entries are kept.', { tone: 'error' });
    void payload;
  }

  function renderSuccess(result) {
    const obs = result.observations || [];
    mount(root,
      h('div', { class: 'stack-lg success-wrap' },
        h('div', { class: 'success-head' },
          h('div', { class: 'success-icon' }, icon('checkCircle')),
          h('div', null,
            h('h1', { tabindex: '-1', id: 'saved-title' }, result.replayed ? 'Already saved' : 'Saved'),
            h('p', { class: 'muted' }, `Confirmed by the server — check-in recorded ${fmtDateTime(result.checkIn.recordedAt, tz, { seconds: true })} for measurements at ${fmtDateTime(result.checkIn.measuredAt, tz)}.`),
            result.replayed ? h('p', { class: 'faint small' }, 'An earlier attempt had already been stored; no duplicate was created.') : null)),
        result.followUpResult === 'completed' ? callout({ tone: 'teal', iconName: 'calendar', body: 'The linked follow-up was marked complete with this check-in.' }) : null,
        result.followUpResult && result.followUpResult !== 'completed' ? callout({ tone: 'attention', title: 'Check-in saved, but the follow-up was not updated', body: `${result.followUpResult} You can complete it from Actions & follow-up.` }) : null,
        h('section', { class: 'panel' },
          h('div', { class: 'panel-head' }, h('h2', null, icon('actions'), `Observations from this check-in (${obs.length})`)),
          obs.length === 0
            ? emptyState({ iconName: 'info', title: 'No rule produced an observation', body: 'This only means none of MONICA\'s demonstration rules matched. It is not a statement that everything is normal.' })
            : h('ul', { class: 'list' }, obs.map((o) => h('li', null,
              levelBadge(o.level),
              h('div', { class: 'li-main' }, h('a', { class: 'li-title', href: `#/actions?obs=${o.id}` }, o.title), h('div', { class: 'li-meta' }, h('span', null, `${o.ruleId} · v${o.ruleVersion}`), h('span', null, o.suggestedNextStep))))))),
        h('div', { class: 'row' },
          linkButton('Back to overview', '#/overview', { variant: 'primary' }),
          linkButton('Open Health Brain', '#/health-brain', { iconName: 'gauge' }),
          obs.length ? linkButton('Review observations', '#/actions', { iconName: 'actions' }) : null,
          h('button', { class: 'btn', type: 'button', onclick: () => { ctx.navigate('/check-in'); } }, icon('plus'), 'New check-in'))));
    document.getElementById('saved-title')?.focus();
  }

  mount(root,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Health check-in'), h('p', null, `For ${profile.displayName}. Every measurement is optional — skip what you could not measure.`)),
      d.attempts ? h('span', { class: 'badge attention' }, icon('attention'), 'Unsaved check-in restored') : null),
    h('div', { class: 'panel checkin-panel' }, stepperEl, body, nav));
  draw();
  return null;
}

export { plural };
