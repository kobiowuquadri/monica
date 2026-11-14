import { h, mount } from './dom.js';
import { icon } from './icons.js';
import { LABELS } from './format.js';

export const LEVEL_ICON = { info: 'info', attention: 'attention', urgent_review: 'urgent' };
export const LEVEL_CLASS = { info: 'info', attention: 'attention', urgent_review: 'urgent' };

export function levelBadge(level) {
  return h('span', { class: ['badge', LEVEL_CLASS[level]] }, icon(LEVEL_ICON[level] || 'info'), LABELS.level[level] || level);
}

export function categoryBadge(category) {
  const ic = { data_quality: 'database', personal_trend: 'trends', health_concern: 'heart' }[category] || 'info';
  return h('span', { class: 'badge outline' }, icon(ic), LABELS.category[category] || category);
}

export function badge(text, cls = '', ic) {
  return h('span', { class: ['badge', cls] }, ic ? icon(ic) : null, text);
}

export function historicalBadge(text = 'Historical NASA data') {
  return h('span', { class: 'badge historical' }, icon('clock'), text);
}

export function panel({ title, iconName, sub, actions, children, className, headingLevel = 'h2', id }) {
  return h('section', { class: ['panel', className], id, 'aria-labelledby': id ? `${id}-title` : undefined },
    title ? h('div', { class: 'panel-head' },
      h('div', null,
        h(headingLevel, { id: id ? `${id}-title` : undefined }, iconName ? icon(iconName) : null, title),
        sub ? h('div', { class: 'sub' }, sub) : null),
      actions ? h('div', { class: 'row' }, actions) : null) : null,
    children);
}

export function emptyState({ iconName = 'info', title, body, action, center = false }) {
  return h('div', { class: ['empty', center && 'center'] },
    h('div', { class: 'empty-icon' }, icon(iconName)),
    h('h3', null, title),
    body ? h('p', null, body) : null,
    action || null);
}

export function callout({ tone = 'info', iconName, title, body, children }) {
  const ic = iconName || { info: 'info', attention: 'attention', urgent: 'urgent', teal: 'shield' }[tone];
  return h('div', { class: ['callout', tone !== 'info' && tone], role: tone === 'urgent' ? 'alert' : undefined },
    icon(ic),
    h('div', { class: 'callout-body' }, title ? h('strong', null, title) : null, body ? h('span', null, body) : null, children));
}

export function loadingBlock(text = 'Loading…') {
  return h('div', { class: 'loading-block', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text);
}

export function errorBlock(err, retry) {
  const offline = err?.network;
  return h('div', { class: 'empty', role: 'alert' },
    h('div', { class: 'empty-icon' }, icon(offline ? 'wifiOff' : 'attention')),
    h('h3', null, offline ? 'Connection problem' : 'Could not load this section'),
    h('p', null, err?.message || 'Something went wrong.'),
    retry ? h('button', { class: 'btn btn-sm', type: 'button', onclick: retry }, icon('reset'), 'Try again') : null);
}

export function provenance(text, ic = 'database') {
  return h('span', { class: 'provenance' }, icon(ic), text);
}

export function button(label, { variant = '', iconName, onClick, type = 'button', size = '', disabled = false, attrs = {} } = {}) {
  return h('button', { class: ['btn', variant && `btn-${variant}`, size && `btn-${size}`], type, onclick: onClick, disabled, ...attrs },
    iconName ? icon(iconName) : null, label);
}

export function linkButton(label, href, { variant = '', iconName, size = '' } = {}) {
  return h('a', { class: ['btn', variant && `btn-${variant}`, size && `btn-${size}`], href }, iconName ? icon(iconName) : null, label);
}

/** Sets a button into a busy state and returns a restore function. */
export function busy(btn, text) {
  const original = Array.from(btn.childNodes).map((n) => n.cloneNode(true));
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  mount(btn, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text);
  return () => {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    mount(btn, original);
  };
}

// ---------- Toasts ----------
export function toast(message, { tone = 'success', timeout = 5000 } = {}) {
  const region = document.getElementById('toasts');
  if (!region) return;
  const el = h('div', { class: ['toast', tone] }, icon(tone === 'error' ? 'attention' : 'checkCircle'), h('div', null, message));
  region.append(el);
  setTimeout(() => el.remove(), timeout);
}

// ---------- Modal dialog ----------
export function openModal({ title, body, footer, onClose, labelledBy }) {
  const id = labelledBy || `modal-${Math.random().toString(36).slice(2, 8)}`;
  const dlg = h('dialog', { class: 'modal', 'aria-labelledby': id },
    h('div', { class: 'modal-head' }, h('h2', { id, class: 'h3' }, title),
      h('button', { class: 'btn btn-ghost btn-icon', type: 'button', 'aria-label': 'Close dialog', onclick: () => close() }, icon('x'))),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null);
  function close() {
    if (dlg.open) dlg.close();
  }
  dlg.addEventListener('close', () => { dlg.remove(); onClose?.(); });
  document.body.append(dlg);
  dlg.showModal();
  return { close, dialog: dlg };
}

/** Renders validation details returned by the API next to matching fields, or as a list. */
export function validationList(details) {
  if (!Array.isArray(details) || details.length === 0) return null;
  return h('ul', { class: 'stack', style: { gap: '4px', paddingLeft: '1.1em', margin: '6px 0 0' } },
    details.slice(0, 8).map((d) => h('li', null, h('code', null, d.field), ' — ', d.message)));
}

export function segmented({ name, options, value, onChange, label, fill = false }) {
  const group = h('div', { class: ['segmented', fill && 'fill'], role: 'radiogroup', 'aria-label': label });
  for (const opt of options) {
    const input = h('input', { type: 'radio', name, value: String(opt.value), checked: String(opt.value) === String(value) });
    input.addEventListener('change', () => onChange?.(opt.value));
    group.append(h('label', { title: opt.title || undefined }, input, h('span', null, opt.label)));
  }
  return group;
}
