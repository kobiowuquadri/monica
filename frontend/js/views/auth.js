import { h, mount } from '../ui/dom.js';
import { icon, brandMark } from '../ui/icons.js';
import { callout, busy, validationList } from '../ui/components.js';
import { post } from '../api.js';

function orbitArt() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 400 400');
  svg.setAttribute('class', 'orbit-art');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `
    <circle cx="200" cy="200" r="96" fill="none" stroke="#4fd1bd" stroke-opacity=".28"/>
    <circle cx="200" cy="200" r="140" fill="none" stroke="#b8c0ce" stroke-opacity=".10"/>
    <circle cx="200" cy="200" r="186" fill="none" stroke="#b8c0ce" stroke-opacity=".07" stroke-dasharray="2 6"/>
    <ellipse cx="200" cy="200" rx="190" ry="62" fill="none" stroke="#4fd1bd" stroke-opacity=".22" transform="rotate(-22 200 200)"/>
    <circle cx="200" cy="200" r="58" fill="#0f2238" stroke="#4fd1bd" stroke-opacity=".5"/>
    <path d="M158 204h22l10-22 16 42 12-28 8 8h30" fill="none" stroke="#f2ede4" stroke-opacity=".8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="372" cy="128" r="6" fill="#f2b84b"/>`;
  return svg;
}

export function renderAuth(root, { onSignedIn, startupError } = {}) {
  let mode = 'signin';
  const errorSlot = h('div', { 'aria-live': 'assertive' });
  const formSlot = h('div');

  function showError(err) {
    mount(errorSlot, callout({ tone: 'urgent', title: err.network ? 'Cannot reach the MONICA server' : 'Not signed in', body: err.message, children: validationList(err.details) }));
  }

  function renderForm() {
    mount(errorSlot);
    const isRegister = mode === 'register';
    const email = h('input', { class: 'input', id: 'auth-email', type: 'email', name: 'email', autocomplete: 'email', required: true });
    const password = h('input', { class: 'input', id: 'auth-password', type: 'password', name: 'password', autocomplete: isRegister ? 'new-password' : 'current-password', required: true, minlength: isRegister ? 10 : undefined });
    const name = isRegister ? h('input', { class: 'input', id: 'auth-name', name: 'displayName', autocomplete: 'name', required: true, maxlength: 80 }) : null;
    const submit = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, isRegister ? 'Create account' : 'Sign in');
    const form = h('form', { class: 'stack', novalidate: true },
      isRegister ? h('div', { class: 'field' }, h('label', { for: 'auth-name' }, 'Display name'), name) : null,
      h('div', { class: 'field' }, h('label', { for: 'auth-email' }, 'Email'), email),
      h('div', { class: 'field' }, h('label', { for: 'auth-password' }, 'Password'), password,
        isRegister ? h('span', { class: 'hint' }, 'At least 10 characters. Stored only as a salted scrypt hash.') : null),
      submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const restore = busy(submit, isRegister ? 'Creating account…' : 'Signing in…');
      try {
        const body = isRegister ? { displayName: name.value, email: email.value, password: password.value } : { email: email.value, password: password.value };
        const res = await post(isRegister ? '/auth/register' : '/auth/login', body);
        await onSignedIn(res.user);
      } catch (err) {
        restore();
        showError(err);
      }
    });
    mount(formSlot, form);
  }

  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Account' });
  const tabSignIn = h('button', { type: 'button', role: 'tab', 'aria-selected': 'true' }, 'Sign in');
  const tabRegister = h('button', { type: 'button', role: 'tab', 'aria-selected': 'false' }, 'Create account');
  for (const [btn, m] of [[tabSignIn, 'signin'], [tabRegister, 'register']]) {
    btn.addEventListener('click', () => {
      mode = m;
      tabSignIn.setAttribute('aria-selected', String(m === 'signin'));
      tabRegister.setAttribute('aria-selected', String(m === 'register'));
      renderForm();
    });
  }
  tabs.append(tabSignIn, tabRegister);

  const demoBtn = h('button', { class: 'btn btn-lg btn-block', type: 'button' }, icon('user'), 'Explore with fictional demo profiles');
  demoBtn.addEventListener('click', async () => {
    const restore = busy(demoBtn, 'Preparing demo…');
    try {
      const res = await post('/auth/demo');
      await onSignedIn(res.user);
    } catch (err) {
      restore();
      showError(err);
    }
  });

  mount(root,
    h('section', { class: 'auth-hero' },
      orbitArt(),
      h('div', { class: 'brand' }, brandMark(34), h('span', null, h('span', { class: 'brand-word' }, 'MONICA'), h('span', { class: 'brand-sub' }, 'Mission health console'))),
      h('div', { class: 'auth-hero-copy' },
        h('h1', null, 'Health monitoring for long-duration missions.'),
        h('p', { class: 'lede' }, 'Guided check-ins, personal trends against an explicit baseline, transparent observations and follow-up — alongside historical NASA radiation-environment data, clearly kept separate.'),
        h('div', { class: 'acronym', 'aria-label': 'MONICA stands for Monitor, Observe, Navigate, Intervene, Check, Adapt' },
          ['Monitor', 'Observe', 'Navigate', 'Intervene', 'Check', 'Adapt'].map((w) => h('span', null, h('b', null, w[0]), w.slice(1))))),
      h('p', { class: 'auth-disclaimer' }, 'NASA Space Apps Challenge 2026 research prototype. Not a validated diagnostic or treatment system, and not affiliated with or endorsed by NASA.')),
    h('section', { class: 'auth-panel' },
      h('div', { class: 'auth-card' },
        h('h2', { class: 'auth-title' }, 'Welcome'),
        h('p', { class: 'muted auth-intro' }, 'Sign in to your account, or explore with fictional demo profiles.'),
        startupError ? callout({ tone: 'attention', title: 'Connection problem', body: startupError.message }) : null,
        errorSlot,
        tabs,
        formSlot,
        h('div', { class: 'divider-label', role: 'separator' }, 'or'),
        demoBtn,
        h('p', { class: 'faint demo-note' }, 'The demo creates two clearly fictional profiles with no health readings. Anything you enter is visible only in your demo session and is deleted automatically after 24 hours.'))));
  renderForm();
}
