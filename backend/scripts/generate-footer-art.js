#!/usr/bin/env node
// Generates frontend/assets/footer-landscape.svg: an etched-style Martian landscape (crater rim,
// a Mount Sharp-like mesa, mounds, boulders and textured ground) in two colours for the landing
// footer. Original artwork; deterministic (seeded) so the file can be regenerated exactly.
//   node scripts/generate-footer-art.js [output.svg]
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/assets/footer-landscape.svg');
const INK = '#0f7166';   // footer background colour, used for the engraving lines
const PALE = '#e3faf5';  // landscape fill
const W = 1920;
const H = 440;
const HORIZON = 300;

let seed = 7041969;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const f = (n) => Math.round(n * 10) / 10;
let defs = '';
let body = '';

/** Wobbly horizontal line from x0 to x1 at y (hand-engraved feel). */
function wobble(x0, x1, y, amp = 0.8, step = 26) {
  let d = `M${f(x0)} ${f(y)}`;
  for (let x = x0 + step; x <= x1 + step; x += step) d += ` L${f(Math.min(x, x1))} ${f(y + (rnd() - 0.5) * 2 * amp)}`;
  return d;
}

/**
 * A filled shape engraved with hatching. Horizontal lines run across the whole shape and thicken
 * toward the shaded side; optional vertical striations (clipped to the shape, so they follow its
 * curved outline) build up the shadowed flank like weathered rock.
 */
function hatchedShape(id, d, bbox, { spacing = 3.4, shadeSide = 'right', vertical = false, striations = 110 } = {}) {
  defs += `<clipPath id="${id}"><path d="${d}"/></clipPath>`;
  let lines = '';
  const [x0, y0, x1, y1] = bbox;
  const shadeAt = (x) => {
    const u = (x - x0) / (x1 - x0);
    if (shadeSide === 'none') return 0;
    return Math.max(0, shadeSide === 'right' ? (u - 0.45) / 0.55 : (0.55 - u) / 0.55);
  };
  for (let y = y0; y <= y1; y += spacing) {
    const t = (y - y0) / (y1 - y0);
    lines += `<path d="${wobble(x0, x1, y, 0.6)}" stroke-width="${f(0.55 + t * 0.4)}" opacity="${(0.3 + t * 0.35).toFixed(2)}"/>`;
    // heavier strokes over the shaded part of each line
    const segs = 10;
    for (let s = 0; s < segs; s += 1) {
      const xa = x0 + ((x1 - x0) * s) / segs;
      const xb = x0 + ((x1 - x0) * (s + 1)) / segs;
      const sh = shadeAt((xa + xb) / 2);
      if (sh <= 0.05) continue;
      lines += `<path d="M${f(xa)} ${f(y + (rnd() - 0.5))} L${f(xb)} ${f(y + (rnd() - 0.5))}" stroke-width="${f(0.6 + sh * sh * 2.2)}" opacity="${(0.35 + sh * 0.55).toFixed(2)}"/>`;
    }
  }
  if (vertical) {
    for (let i = 0; i < striations; i += 1) {
      // bias positions toward the shaded edge
      const u = Math.pow(rnd(), 0.55);
      const x = shadeSide === 'right' ? x1 - u * (x1 - x0) * 0.62 : x0 + u * (x1 - x0) * 0.62;
      const sh = shadeAt(x);
      const bow = (shadeSide === 'right' ? 1 : -1) * (4 + rnd() * 10);
      const start = y0 - 4;
      const end = y0 + (y1 - y0) * (0.55 + rnd() * 0.45);
      lines += `<path d="M${f(x)} ${f(start)} Q ${f(x + bow)} ${f((start + end) / 2)} ${f(x + bow * 0.3)} ${f(end)}" stroke-width="${f(0.5 + sh * (0.8 + rnd() * 1.8))}" opacity="${(0.2 + sh * 0.65 * (0.5 + rnd() * 0.5)).toFixed(2)}"/>`;
    }
  }
  body += `<path d="${d}" fill="${PALE}"/><g clip-path="url(#${id})" stroke="${INK}" fill="none" stroke-linecap="round">${lines}</g>`;
  body += `<path d="${d}" fill="none" stroke="${INK}" stroke-width="1.2" opacity=".55"/>`;
}

// 1) Distant crater rim: a long low ridge across the whole width.
let rim = `M0 ${HORIZON - 26}`;
for (let x = 0; x <= W; x += 60) rim += ` L${x} ${f(HORIZON - 26 - 10 * Math.sin(x / 210) - 6 * Math.sin(x / 73) - rnd() * 4)}`;
rim += ` L${W} ${HORIZON + 10} L0 ${HORIZON + 10}Z`;
hatchedShape('rim', rim, [0, HORIZON - 52, W, HORIZON + 10], { spacing: 3.6, shadeSide: 'none' });

// 2) Mesa (Mount Sharp-like) on the right with striated flanks.
const mesa = `M1270 ${HORIZON + 6} C1278 230 1300 170 1360 140 C1420 108 1470 96 1520 92 C1572 88 1600 98 1640 120 C1690 150 1712 220 1726 ${HORIZON + 6} Z`;
hatchedShape('mesa', mesa, [1270, 88, 1726, HORIZON + 6], { spacing: 3.2, vertical: true, shadeSide: 'right' });
const mesa2 = `M1556 ${HORIZON + 6} C1566 210 1590 150 1626 132 C1660 116 1690 136 1708 176 C1722 210 1730 260 1734 ${HORIZON + 6} Z`;
hatchedShape('mesa2', mesa2, [1556, 116, 1734, HORIZON + 6], { spacing: 3, vertical: true, shadeSide: 'right' });

// 3) Rounded mounds on the left.
hatchedShape('mound1', `M118 ${HORIZON + 4} C124 250 150 222 196 216 C238 212 262 236 270 ${HORIZON + 4} Z`, [118, 210, 270, HORIZON + 4], { vertical: true, shadeSide: 'left' });
hatchedShape('mound2', `M196 ${HORIZON + 4} C204 232 238 186 300 180 C356 176 390 214 404 ${HORIZON + 4} Z`, [196, 174, 404, HORIZON + 4], { vertical: true, shadeSide: 'right' });
hatchedShape('mound3', `M372 ${HORIZON + 4} C384 254 410 236 444 234 C476 234 494 252 500 ${HORIZON + 4} Z`, [372, 230, 500, HORIZON + 4], { spacing: 3 });

// 4) Ground plane with a slightly wavy horizon.
let ground = `M0 ${HORIZON}`;
for (let x = 0; x <= W; x += 40) ground += ` L${x} ${f(HORIZON + 3 * Math.sin(x / 90) + rnd() * 2)}`;
ground += ` L${W} ${H} L0 ${H}Z`;
body += `<path d="${ground}" fill="${PALE}"/>`;

// Ground texture: short engraved dashes, longer and darker toward the viewer.
let tex = '';
for (let i = 0; i < 1100; i += 1) {
  const depth = Math.sqrt(rnd());
  const y = HORIZON + 4 + depth * (H - HORIZON - 4);
  const x = rnd() * W;
  const len = 3 + depth * depth * 34 * (0.4 + rnd());
  tex += `<path d="M${f(x)} ${f(y)} h${f(len)}" stroke-width="${f(0.6 + depth * 1.3)}" opacity="${(0.25 + depth * 0.6 * rnd()).toFixed(2)}"/>`;
}
body += `<g stroke="${INK}" stroke-linecap="round" fill="none">${tex}</g>`;

// Faint dune lines give the plain some depth.
let dunes = '';
for (let i = 0; i < 9; i += 1) {
  const y = HORIZON + 12 + i * i * 1.6 + rnd() * 6;
  let d = `M0 ${f(y)}`;
  for (let x = 0; x <= W; x += 80) d += ` L${x} ${f(y + 4 * Math.sin(x / (160 + i * 30) + i) + rnd())}`;
  dunes += `<path d="${d}" stroke-width="${f(0.6 + i * 0.08)}" opacity="${(0.18 + i * 0.03).toFixed(2)}"/>`;
}
body += `<g stroke="${INK}" fill="none">${dunes}</g>`;

// Engraved rocks: a pale body with an ink outline, hatched shadow side and a cast shadow.
let rocks = '';
for (let i = 0; i < 80; i += 1) {
  const depth = Math.sqrt(rnd());
  const y = HORIZON + 10 + depth * (H - HORIZON - 16);
  const x = rnd() * W;
  const r = 1 + depth * depth * 8 * (0.3 + rnd());
  if (r < 2.5) {
    rocks += `<ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(r * 1.3)}" ry="${f(r * 0.6)}" fill="${INK}" opacity="${(0.5 + rnd() * 0.4).toFixed(2)}"/>`;
    continue;
  }
  const w = r * 1.7;
  const hgt = r * (0.9 + rnd() * 0.5);
  rocks += `<ellipse cx="${f(x + r * 0.5)}" cy="${f(y + 1)}" rx="${f(w * 1.15)}" ry="${f(r * 0.32)}" fill="${INK}" opacity=".55"/>`;
  rocks += `<path d="M${f(x - w)} ${f(y)} C${f(x - w * 0.9)} ${f(y - hgt)} ${f(x + w * 0.7)} ${f(y - hgt * 1.1)} ${f(x + w)} ${f(y)} Z" fill="${PALE}" stroke="${INK}" stroke-width="${f(0.8 + depth * 0.6)}"/>`;
  for (let k = 0; k < Math.min(6, Math.round(r)); k += 1) {
    const xx = x + w * (0.1 + k * 0.14);
    rocks += `<path d="M${f(xx)} ${f(y - hgt * 0.75 + k * 0.6)} L${f(xx + w * 0.08)} ${f(y - 0.6)}" stroke="${INK}" stroke-width=".8" opacity=".7"/>`;
  }
}
body += rocks;

// A few shallow craters.
for (const [cx, cy, rx] of [[620, 362, 46], [980, 330, 22], [1480, 402, 60], [260, 410, 34]]) {
  body += `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${f(rx * 0.22)}" fill="none" stroke="${INK}" stroke-width="1.4" opacity=".6"/>`;
  body += `<path d="M${cx - rx * 0.9} ${f(cy + 1)} q ${f(rx * 0.9)} ${f(rx * 0.28)} ${f(rx * 1.8)} 0" fill="none" stroke="${INK}" stroke-width="2.2" opacity=".45"/>`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice">
<defs>${defs}</defs>
${body}
</svg>`;
writeFileSync(out, svg);
console.log(`wrote ${out} (${(svg.length / 1024).toFixed(0)} KB)`);
