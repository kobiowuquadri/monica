// Public landing page. Everything stated here is either a description of what MONICA does or
// real data fetched from the API (NASA coverage counts, the historical RAD chart). No testimonials,
// usage figures or invented metrics.
import { h, mount } from '../ui/dom.js';
import { icon, brandMark } from '../ui/icons.js';
import { fmtDate, fmtNum } from '../ui/format.js';
import { busy, callout } from '../ui/components.js';
import { timeChart, destroyChart, SERIES, chartsAvailable } from '../ui/charts.js';
import { get, post } from '../api.js';

const PILLARS = [
  ['M', 'Monitor', 'Guided check-ins for vital signs, symptoms, sleep and wellbeing — every field optional.'],
  ['O', 'Observe', 'Personal trends against a baseline you explicitly establish, with resting and post-exercise readings kept apart.'],
  ['N', 'Navigate', 'Historical NASA radiation and space-weather context, clearly separated from personal health records.'],
  ['I', 'Intervene', 'Transparent observations with a suggested next step — never a diagnosis, never a hidden score.'],
  ['C', 'Check', 'Acknowledge observations, record what you did and schedule follow-up check-ins.'],
  ['A', 'Adapt', 'Organised review summaries to print, save as PDF or export as JSON for medical review.'],
];

const STEPS = [
  ['checkin', 'Check in', 'Record what you measured and how you feel. Skip anything you could not measure — it stays "not assessed".'],
  ['actions', 'Review observations', 'Versioned rules explain why something was raised, with the exact inputs and what is missing.'],
  ['calendar', 'Act and follow up', 'Acknowledge, note the action taken and schedule a follow-up check-in to close the loop.'],
  ['reports', 'Prepare a summary', 'Generate a review summary for your medical team — MONICA never sends anything on your behalf.'],
];

const PRINCIPLES = [
  ['shield', 'No health score', 'MONICA never collapses your health into a single number, a "fit for duty" verdict or an "all normal" banner.'],
  ['unknown', 'Unknown stays unknown', 'Missing readings are shown as "No reading recorded" or "Not assessed" — never as healthy.'],
  ['flask', 'Every rule is inspectable', 'Each observation carries its rule ID, version, inputs and missing information. No clinical thresholds are invented.'],
  ['database', 'Private by design', 'HttpOnly sessions, owner-only access to every record, and audit history that never stores health values.'],
];

// NASA photographs (NASA Image and Video Library). Used factually under NASA's media guidelines,
// credited, with no implied endorsement. See docs/DATA_SOURCES.md → Imagery.
export const IMAGES = {
  hero: {
    id: 'iss028e007274', credit: 'NASA', alt: '',
    caption: 'Sunrise over Earth\'s limb, photographed from the International Space Station (Expedition 28, 2011).',
  },
  ultrasound: {
    id: 'iss036e006639', credit: 'NASA', src: 'assets/images/crew-ultrasound-1200.jpg',
    alt: 'Aboard the International Space Station, one astronaut performs an eye ultrasound scan on another as part of NASA ocular health research.',
    caption: 'In-flight ocular health ultrasound on the ISS (Expedition 36, 2013). Crew shown are not associated with MONICA.',
  },
  curiosity: {
    id: 'PIA20602', credit: 'NASA/JPL-Caltech/MSSS', src: 'assets/images/curiosity-selfie-1200.jpg',
    alt: 'Self-portrait of NASA\'s Curiosity rover on the rocky Martian surface of lower Mount Sharp, with a dusty sky behind it.',
    caption: 'Curiosity self-portrait on lower Mount Sharp, Gale Crater (2016). Its Radiation Assessment Detector produced the data MONICA charts.',
  },
  eva: {
    id: 'iss061e003491', credit: 'NASA', src: 'assets/images/eva-earth-1200.jpg',
    alt: 'A spacewalking astronaut works on the exterior of the International Space Station with Earth\'s clouds below.',
    caption: 'Spacewalk on the International Space Station (Expedition 61, 2019).',
  },
  sunset: {
    id: 'PIA19400', credit: 'NASA/JPL-Caltech/MSSS/Texas A&M Univ.', src: 'assets/images/mars-sunset-1344.jpg',
    caption: 'Sunset in Gale Crater, recorded by Curiosity on sol 956 (April 2015).',
  },
};
const detailsUrl = (id) => `https://images.nasa.gov/details/${id}`;

const SOURCES = [
  ['NASA PDS — Curiosity RAD archive', 'https://pds-ppi.igpp.ucla.edu/bundle/MSL-M-RAD-3-RDR-V1.0'],
  ['RAD RDR interface specification', 'https://pds-ppi.igpp.ucla.edu/data/MSL-M-RAD-3-RDR-V1.0/DOCUMENT/RAD_RDR_SIS.HTM'],
  ['NASA DONKI space weather', 'https://ccmc.gsfc.nasa.gov/tools/DONKI/'],
  ['NASA HRP Space Radiation Element', 'https://www.nasa.gov/reference/about-the-space-radiation-element/'],
  ['NASA JSC Space Radiation Analysis Group', 'https://srag.jsc.nasa.gov/spaceradiation/how/how.cfm'],
  ['NASA-STD-3001 Human Performance', 'https://www.nasa.gov/reference/4-0-human-performance/'],
];

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The MONICA mark, animated: a satellite orbits the planet (passing behind it), a vital-sign trace
 * sweeps across like a monitor and the whole mark floats. Static when reduced motion is preferred.
 */
function animatedMark() {
  const still = prefersReducedMotion();
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 200 200');
  svg.setAttribute('class', 'lp-mark-svg');
  svg.setAttribute('aria-hidden', 'true');
  // Ellipse in the orbit's own (rotated) frame: centre (100,100), rx 92, ry 32.
  const orbitPath = 'M192 100 A92 32 0 1 1 8 100 A92 32 0 1 1 192 100';
  svg.innerHTML = `
    <defs>
      <radialGradient id="lpPlanet" cx="34%" cy="28%" r="78%"><stop offset="0" stop-color="#21436b"/><stop offset=".6" stop-color="#11243f"/><stop offset="1" stop-color="#0a1628"/></radialGradient>
      <linearGradient id="lpRim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8ef0e1"/><stop offset="1" stop-color="#2a9f8f"/></linearGradient>
      <radialGradient id="lpHalo" cx="50%" cy="50%" r="50%"><stop offset=".55" stop-color="#4fd1bd" stop-opacity=".22"/><stop offset="1" stop-color="#4fd1bd" stop-opacity="0"/></radialGradient>
      <mask id="lpBehind" maskUnits="userSpaceOnUse" x="-20" y="-20" width="240" height="240">
        <rect x="-20" y="-20" width="240" height="240" fill="#fff"/>
        <path d="M52 100 A48 48 0 0 1 148 100 Z" fill="#000"/>
      </mask>
      <filter id="lpGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <circle class="lp-mark-halo" cx="100" cy="100" r="86" fill="url(#lpHalo)"/>
    <g transform="rotate(-24 100 100)"><ellipse cx="100" cy="100" rx="92" ry="32" fill="none" stroke="#4fd1bd" stroke-opacity=".38" stroke-width="2"/></g>
    <circle cx="100" cy="100" r="48" fill="url(#lpPlanet)"/>
    <circle cx="100" cy="100" r="48" fill="none" stroke="url(#lpRim)" stroke-width="3.2"/>
    <path class="lp-mark-trace" d="M58 104 H76 L84 86 L96 120 L105 98 L111 105 H142" fill="none" stroke="#f2ede4" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round" filter="url(#lpGlow)"/>
    <g transform="rotate(-24 100 100)">
      <path d="M8 100 A92 32 0 0 0 192 100" fill="none" stroke="#4fd1bd" stroke-opacity=".75" stroke-width="2.2"/>
      <g mask="url(#lpBehind)">
        <circle class="lp-mark-sat" ${still ? 'cx="165" cy="122.6"' : 'cx="0" cy="0"'} r="6.5" fill="#f2b84b" filter="url(#lpGlow)">${still ? '' : `<animateMotion dur="9s" repeatCount="indefinite" path="${orbitPath}"/>`}</circle>
      </g>
    </g>`;
  return h('div', { class: ['lp-mark', still && 'still'] }, svg);
}

/** A small astronaut that walks across the footer landscape (two alternating poses). */
function walker() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 44 66');
  svg.setAttribute('class', 'lp-walker-svg');
  const INK = '#0f7166';
  const PALE = '#e3faf5';
  const limb = (d, w = 5.6) => `<path d="${d}" stroke="${INK}" stroke-width="${w}" stroke-linecap="round" fill="none"/>`;
  svg.innerHTML = `
    <ellipse cx="22" cy="63" rx="13" ry="2.4" fill="${INK}" opacity=".35"/>
    <g class="pose-a">${limb('M20 37 L14 50 L11 60')}${limb('M24 37 L28 49 L31 60')}<ellipse cx="10.5" cy="61" rx="4.6" ry="2.4" fill="${INK}"/><ellipse cx="32.5" cy="61" rx="4.6" ry="2.4" fill="${INK}"/>${limb('M25 23 L31 30 L33 36', 4.6)}</g>
    <g class="pose-b">${limb('M21 37 L19 49 L18 60')}${limb('M23 37 L25 49 L25 60')}<ellipse cx="18" cy="61" rx="4.6" ry="2.4" fill="${INK}"/><ellipse cx="26.5" cy="61" rx="4.6" ry="2.4" fill="${INK}"/>${limb('M25 23 L27 31 L25 37', 4.6)}</g>
    <rect x="7" y="17" width="10" height="19" rx="2.6" fill="${INK}"/>
    <rect x="13" y="19" width="16" height="20" rx="6" fill="${INK}"/>
    <rect x="16" y="26" width="7" height="4" rx="1.4" fill="${PALE}" opacity=".85"/>
    <circle cx="22" cy="11" r="9.2" fill="${INK}"/>
    <path d="M23 5.6 a6.6 6.6 0 0 1 6.4 7.6 l-7.6 -0.6 z" fill="${PALE}"/>
    <path d="M25.5 7.6 q2 1 2.2 3.4" stroke="${INK}" stroke-width="1.1" fill="none" stroke-linecap="round" opacity=".6"/>`;
  return h('div', { class: 'lp-walker' }, svg);
}

function scrollTo(id) {
  return (e) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    el.focus({ preventScroll: true });
  };
}

export function renderLanding(root, { onSignedIn }) {
  let chart = null;
  const errorSlot = h('div', { class: 'landing-error', 'aria-live': 'assertive' });

  function demoButton(label, variant = 'primary', size = 'lg') {
    const b = h('button', { class: ['btn', `btn-${variant}`, `btn-${size}`], type: 'button' }, label, icon('arrowRight'));
    b.addEventListener('click', async () => {
      const restore = busy(b, 'Preparing demo…');
      try {
        const res = await post('/auth/demo');
        await onSignedIn(res.user);
      } catch (err) {
        restore();
        mount(errorSlot, callout({ tone: 'urgent', title: err.network ? 'Cannot reach the MONICA server' : 'The demo could not start', body: err.message }));
        errorSlot.scrollIntoView({ block: 'center' });
      }
    });
    return b;
  }

  const navLinks = [['features', 'Features'], ['data', 'NASA data'], ['how', 'How it works'], ['principles', 'Principles']];
  const nav = h('header', { class: 'lp-nav' },
    h('div', { class: 'lp-wrap lp-nav-inner' },
      h('a', { class: 'brand', href: '#/', 'aria-label': 'MONICA home' }, brandMark(30), h('span', null, h('span', { class: 'brand-word' }, 'MONICA'))),
      h('nav', { class: 'lp-links', 'aria-label': 'Page sections' }, navLinks.map(([id, label]) => h('a', { href: `#${id}`, onclick: scrollTo(id) }, label))),
      h('div', { class: 'lp-nav-cta' },
        h('a', { class: 'btn btn-ghost btn-sm', href: '#/signin' }, 'Sign in'),
        demoButton('Try the demo', 'primary', 'sm'))));

  const strip = h('div', { class: 'lp-strip', hidden: true, 'aria-live': 'polite' });

  const hero = h('section', { class: 'lp-hero', 'aria-labelledby': 'lp-title' },
    h('img', {
      class: 'lp-hero-art', alt: '', 'aria-hidden': 'true', decoding: 'async', fetchpriority: 'high',
      src: 'assets/images/hero-earth-limb-1600.jpg',
      srcset: 'assets/images/hero-earth-limb-1600.jpg 1600w, assets/images/hero-earth-limb-3200.jpg 3200w',
      sizes: '100vw',
    }),
    h('div', { class: 'lp-hero-shade', 'aria-hidden': 'true' }),
    h('a', { class: 'lp-photo-credit lp-hero-credit', href: detailsUrl(IMAGES.hero.id), target: '_blank', rel: 'noopener noreferrer', title: IMAGES.hero.caption }, `Photo: ${IMAGES.hero.credit} · ${IMAGES.hero.id}`),
    h('div', { class: 'lp-wrap lp-hero-inner' },
      h('div', { class: 'lp-hero-center' },
        animatedMark(),
        h('h1', { id: 'lp-title' }, 'Health monitoring for the long road to Mars.'),
        h('p', { class: 'lp-lede' }, 'Check-ins, personal trends and transparent observations for long-duration crews.'),
        h('div', { class: 'lp-cta-row' },
          demoButton('Explore the demo'),
          h('a', { class: 'btn btn-lg lp-btn-glass', href: '#/register' }, 'Create an account')),
        errorSlot)));

  const pillars = h('section', { class: 'lp-section', id: 'features', tabindex: '-1', 'aria-labelledby': 'lp-features-title' },
    h('div', { class: 'lp-wrap' },
      h('div', { class: 'lp-section-head' },
        h('p', { class: 'lp-kicker' }, 'What MONICA does'),
        h('h2', { id: 'lp-features-title' }, 'Six steps of careful, transparent monitoring.'),
        h('p', null, 'Each letter of MONICA is a part of the workflow — from recording a reading to preparing a summary your medical team can review.')),
      h('div', { class: 'lp-pillars' }, PILLARS.map(([letter, word, text]) => h('article', { class: 'lp-pillar' },
        h('span', { class: 'lp-letter', 'aria-hidden': 'true' }, letter),
        h('h3', null, word),
        h('p', null, text))))));

  function featureRow({ image, kicker, title, text, bullets, reverse }) {
    return h('div', { class: ['lp-feature', reverse && 'reverse'] },
      h('figure', { class: 'lp-feature-art' },
        h('img', { src: image.src, alt: image.alt, loading: 'lazy', decoding: 'async', width: 1200, height: 943 }),
        h('figcaption', null,
          h('span', null, image.caption),
          h('a', { href: detailsUrl(image.id), target: '_blank', rel: 'noopener noreferrer' }, `Photo: ${image.credit}`))),
      h('div', { class: 'lp-feature-copy' },
        h('p', { class: 'lp-kicker' }, kicker),
        h('h3', null, title),
        h('p', null, text),
        h('ul', { class: 'lp-checks' }, bullets.map((b) => h('li', null, icon('check'), h('span', null, b))))));
  }

  const features = h('section', { class: 'lp-section lp-features', 'aria-label': 'Feature details' },
    h('div', { class: 'lp-wrap lp-feature-list' },
      featureRow({
        image: IMAGES.ultrasound,
        kicker: 'Guided check-ins', title: 'Check-ins that never guess.',
        text: 'A five-step check-in records measurement context, vital signs, symptoms, sleep and wellbeing. Every measurement is optional and nothing is filled in for you.',
        bullets: ['Skipped measurements are stored as "not assessed", never as normal', 'Manual entries, device-reported values and measurement quality are recorded with each reading', '"Saved" appears only after the server confirms the write — retries never create duplicates'],
      }),
      featureRow({
        image: IMAGES.curiosity,
        kicker: 'Radiation context', title: 'Environment is not the person.', reverse: true,
        text: 'MONICA shows historical measurements from the Radiation Assessment Detector on NASA\'s Curiosity rover — exactly as archived, with dates, detector channels and quality flags.',
        bullets: ['Absorbed dose rate in µGy/h, detectors B and E never added together', 'Clearly labelled as historical environmental data — not personal dosimetry', 'Space-weather events from NASA DONKI shown as context, never as a Mars alert'],
      }),
      featureRow({
        image: IMAGES.eva,
        kicker: 'Observations & follow-up', title: 'Observations you can inspect — and act on.',
        text: 'Deterministic, versioned rules turn check-ins into observations that explain themselves. You decide what happens next.',
        bullets: ['Urgent symptom reports are never averaged away by normal readings', 'Acknowledge, record actions and complete follow-ups with a new check-in', 'Full event history for every observation, ready for a review summary'],
      })));

  // ---- Real NASA data section ----
  const chartBox = h('div', { class: 'chart-box lp-chart-box' });
  const chartMeta = h('div', { class: 'lp-chart-meta' });
  const chartLegend = h('div', { class: 'chart-legend', 'aria-hidden': 'true' });
  const data = h('section', { class: 'lp-section lp-data', id: 'data', tabindex: '-1', 'aria-labelledby': 'lp-data-title' },
    h('div', { class: 'lp-wrap' },
      h('div', { class: 'lp-section-head' },
        h('p', { class: 'lp-kicker' }, 'From the NASA archive'),
        h('h2', { id: 'lp-data-title' }, 'Real measurements, honestly framed.'),
        h('p', null, 'This chart is loaded live from MONICA\'s database: Curiosity RAD observations imported from NASA\'s Planetary Data System. It is historical data from the Mars surface — not a simulation, and not anyone\'s personal dose.')),
      strip,
      h('div', { class: 'lp-chart-card' },
        h('div', { class: 'lp-chart-head' },
          h('div', null, h('h3', null, 'Curiosity RAD — total absorbed dose rate'), chartMeta),
          h('span', { class: 'badge historical' }, icon('clock'), 'Historical NASA data')),
        chartLegend, chartBox,
        h('p', { class: 'chart-caption' }, 'Values exactly as archived (µGy/h), plotted at each observation\'s start time (UTC). Lines break at missing or quality-flagged samples. Source: NASA PDS PPI, dataset MSL-M-RAD-3-RDR-V1.0.')),
      h('div', { class: 'lp-sources' },
        h('p', { class: 'lp-sources-label' }, 'Sources MONICA cites'),
        h('ul', { class: 'lp-source-list' }, SOURCES.map(([label, url]) => h('li', null, h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, label, icon('external', { size: 13 }))))),
        h('p', { class: 'lp-note' }, 'MONICA is an independent prototype. It is not affiliated with or endorsed by NASA.'))));

  const how = h('section', { class: 'lp-section', id: 'how', tabindex: '-1', 'aria-labelledby': 'lp-how-title' },
    h('div', { class: 'lp-wrap' },
      h('div', { class: 'lp-section-head' },
        h('p', { class: 'lp-kicker' }, 'How it works'),
        h('h2', { id: 'lp-how-title' }, 'From a reading to a review summary.')),
      h('ol', { class: 'lp-steps' }, STEPS.map(([ic, title, text], i) => h('li', { class: 'lp-step' },
        h('div', { class: 'lp-step-top' }, h('span', { class: 'lp-step-num' }, String(i + 1).padStart(2, '0')), h('span', { class: 'lp-step-icon' }, icon(ic))),
        h('h3', null, title),
        h('p', null, text))))));

  const principles = h('section', { class: 'lp-section', id: 'principles', tabindex: '-1', 'aria-labelledby': 'lp-principles-title' },
    h('div', { class: 'lp-wrap' },
      h('div', { class: 'lp-section-head' },
        h('p', { class: 'lp-kicker' }, 'Principles'),
        h('h2', { id: 'lp-principles-title' }, 'Built to be trusted, not to impress.')),
      h('div', { class: 'lp-principles' }, PRINCIPLES.map(([ic, title, text]) => h('article', { class: 'lp-principle' },
        h('span', { class: 'lp-principle-icon' }, icon(ic)),
        h('h3', null, title),
        h('p', null, text))))));

  const cta = h('section', { class: 'lp-section lp-final' },
    h('div', { class: 'lp-wrap' },
      h('div', { class: 'lp-final-card' },
        h('img', { class: 'lp-final-bg', src: IMAGES.sunset.src, alt: '', 'aria-hidden': 'true', loading: 'lazy', decoding: 'async' }),
        h('a', { class: 'lp-photo-credit lp-final-credit', href: detailsUrl(IMAGES.sunset.id), target: '_blank', rel: 'noopener noreferrer', title: IMAGES.sunset.caption }, `Photo: ${IMAGES.sunset.credit} · ${IMAGES.sunset.id}`),
        h('div', { class: 'lp-final-copy' },
          h('h2', null, 'See MONICA with a fictional crew member.'),
          h('p', null, 'Two clearly fictional demo profiles, no real health data, and a private session that is deleted after 24 hours.')),
        h('div', { class: 'lp-cta-row' }, demoButton('Explore the demo'), h('a', { class: 'btn btn-lg lp-btn-glass', href: '#/signin' }, 'Sign in')))));

  const footCol = (title, links) => h('div', { class: 'lp-fcol' },
    h('h2', { class: 'lp-fcol-title' }, title),
    h('ul', null, links.map((l) => h('li', null, l))));
  const ext = (label, url) => h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, label);
  const footDemo = h('button', { class: 'lp-flink-btn', type: 'button' }, 'Explore the demo');
  footDemo.addEventListener('click', async () => {
    footDemo.disabled = true;
    footDemo.textContent = 'Preparing demo…';
    try { const res = await post('/auth/demo'); await onSignedIn(res.user); } catch (err) {
      footDemo.disabled = false;
      footDemo.textContent = 'Explore the demo';
      mount(errorSlot, callout({ tone: 'urgent', title: 'The demo could not start', body: err.message }));
      errorSlot.scrollIntoView({ block: 'center' });
    }
  });

  const footer = h('footer', { class: 'lp-footer' },
    h('div', { class: 'lp-wrap lp-footer-top' },
      h('div', { class: 'lp-footer-brand' },
        h('div', { class: 'brand' }, brandMark(30), h('span', { class: 'brand-word' }, 'MONICA')),
        h('p', { class: 'lp-footer-tagline' }, 'Careful health monitoring for long-duration crews, with NASA radiation data kept honestly in context.')),
      footCol('Product', [
        h('a', { href: '#/check-in' }, 'Health check-ins'),
        h('a', { href: '#/trends' }, 'Trends & baselines'),
        h('a', { href: '#/environment' }, 'Radiation & space weather'),
        h('a', { href: '#/actions' }, 'Actions & follow-up'),
        h('a', { href: '#/reports' }, 'Review summaries'),
        h('a', { href: '#/sources' }, 'Sources & learning'),
      ]),
      footCol('NASA data', SOURCES.slice(0, 1).concat(SOURCES.slice(2)).map(([label, url]) => ext(label.replace(/^NASA (PDS — )?/, ''), url))),
      footCol('Get started', [
        footDemo,
        h('a', { href: '#/register' }, 'Create an account'),
        h('a', { href: '#/signin' }, 'Sign in'),
      ])),
    h('div', { class: 'lp-wrap lp-footer-legal' },
      h('p', { class: 'lp-footer-copy' }, '© 2026 MONICA. Built for the NASA Space Apps Challenge.'),
      h('p', { class: 'lp-footer-fine' }, 'Research prototype — not a validated diagnostic or treatment system, and not affiliated with or endorsed by NASA. Charted radiation values are real NASA archive data. Photographs: NASA Image and Video Library, used under ',
        ext('NASA\'s media guidelines', 'https://www.nasa.gov/nasa-brand-center/images-and-media/'),
        '; crew shown are not associated with MONICA (',
        Object.values(IMAGES).map((img, i) => [i ? ', ' : '', ext(img.id, detailsUrl(img.id))]),
        '). Landscape illustration: original artwork.')),
    h('div', { class: 'lp-footer-scene', 'aria-hidden': 'true' },
      h('img', { src: 'assets/footer-landscape.svg', alt: '', loading: 'lazy', decoding: 'async' }),
      walker()));

  mount(root, nav, h('main', { id: 'landing-main', tabindex: '-1' }, hero, pillars, features, data, how, principles, cta), footer);

  // ---- Live data: coverage strip (real counts) ----
  get('/catalog', { timeoutMs: 75_000 }).then((cat) => {
    if (!cat?.radiation) return;
    const r = cat.radiation;
    mount(strip,
      h('span', { class: 'lp-strip-label' }, icon('database', { size: 14 }), cat.label),
      h('span', { class: 'lp-strip-item' }, h('strong', { class: 'num' }, fmtNum(r.samples)), ` Curiosity RAD observations · ${fmtDate(r.firstObservation, 'UTC')} – ${fmtDate(r.lastObservation, 'UTC')}`),
      cat.spaceWeather ? h('span', { class: 'lp-strip-item' }, h('strong', { class: 'num' }, fmtNum(cat.spaceWeather.events)), ' NASA DONKI space-weather events') : null,
      h('span', { class: 'lp-strip-item' }, h('strong', { class: 'num' }, String(cat.sources)), ' cited NASA sources'));
    strip.hidden = false;
    mount(chartMeta, h('p', { class: 'faint small' }, `Sols ${r.firstSol}–${r.lastSol} · ${fmtDate(r.firstObservation, 'UTC')} – ${fmtDate(r.lastObservation, 'UTC')} · ${fmtNum(r.samples)} samples`));
  }).catch(() => { /* strip stays hidden: no numbers are shown unless they come from the API */ });

  // ---- Live data: RAD chart, loaded only when the section approaches the viewport ----
  function showChartFallback(message) {
    mount(chartBox, h('div', { class: 'lp-chart-fallback' }, h('img', { src: IMAGES.curiosity.src, alt: '', 'aria-hidden': 'true' }), h('p', null, message)));
  }
  async function loadChart() {
    mount(chartBox, h('div', { class: 'loading-block' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading NASA archive data…'));
    try {
      const rad = await get('/radiation', { timeoutMs: 75_000 });
      const c = SERIES();
      const colors = { B: c.s1, E: c.s2 };
      const datasets = [];
      let first = Infinity;
      let last = -Infinity;
      for (const det of ['B', 'E']) {
        const pts = [];
        let prev = null;
        for (const p of rad.series[det] || []) {
          const x = new Date(p.t).getTime();
          first = Math.min(first, x); last = Math.max(last, x);
          const ok = p.value !== null && (p.quality === 'no_issues_identified' || p.quality === 'instrument_mode_flagged');
          if (prev !== null && x - prev > 2 * 3600_000) pts.push({ x: (x + prev) / 2, y: null });
          pts.push(ok ? { x, y: p.value, raw: p } : { x, y: null });
          prev = x;
        }
        if (pts.length) datasets.push({ label: `Detector ${det}`, color: colors[det], points: pts, pointRadius: 0, borderWidth: 1.25 });
      }
      if (!datasets.length) { showChartFallback('No NASA RAD observations have been imported into this deployment yet.'); return; }
      if (!chartsAvailable()) { showChartFallback('The chart library did not load.'); return; }
      mount(chartLegend, datasets.map((d) => h('span', { class: 'key' }, h('span', { class: 'swatch line', style: { background: d.color } }), `${d.label} (µGy/h)`)));
      const canvas = h('canvas', { role: 'img', 'aria-label': `Historical Curiosity RAD absorbed dose rate for detectors B and E, ${fmtDate(first, 'UTC')} to ${fmtDate(last, 'UTC')}.` });
      mount(chartBox, canvas);
      chart = timeChart(canvas, {
        datasets, tz: 'UTC', yTitle: 'µGy/h', xMin: first, xMax: last,
        tooltipLines: (raw, label) => (raw.raw ? [`${label}: ${raw.raw.valueText} µGy/h`, `Sol ${raw.raw.sol} · QC ${raw.raw.qc ?? '—'}`] : `${label}: ${raw.y}`),
      });
    } catch (err) {
      showChartFallback(err.status === 503 ? 'NASA data are unavailable on this server right now.' : 'The NASA archive data could not be loaded right now.');
    }
  }
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); loadChart(); }
    }, { rootMargin: '400px 0px' });
    io.observe(data);
  } else {
    loadChart();
  }

  return () => destroyChart(chart);
}
