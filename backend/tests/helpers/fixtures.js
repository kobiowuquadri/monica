// Test helpers for NASA archive parsing. Fixtures are verbatim excerpts of real files from
// the NASA PDS PPI archive MSL-M-RAD-3-RDR-V1.0 (sol 1812 product), not synthetic data.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');

export const RAD_LABEL = readFileSync(path.join(dir, 'RAD_RDR_2017_253_04_24_1812_V00.excerpt.LBL'), 'latin1');
export const RAD_DATA = readFileSync(path.join(dir, 'RAD_RDR_2017_253_04_24_1812_V00.excerpt.TXT'));
export const RAD_INDEX = readFileSync(path.join(dir, 'INDEX.excerpt.TAB'), 'latin1');

export const SOL_1812_PRODUCT = {
  sol: 1812, version: 0, productId: 'RAD_RDR_2017_253_04_24_1812_V00',
  labelPath: '/DATA/SOL_01773_01869/RAD_RDR_2017_253_04_24_1812_V00.LBL',
  productCreationTime: '2018-01-25T18:51:57', startTime: '2017-253T04:24:11',
};

/** A fetch() stand-in that serves the fixture label and answers byte-range requests like nginx. */
export function archiveFetch({ label = RAD_LABEL, data = RAD_DATA, calls = [] } = {}) {
  return async (url, opts = {}) => {
    calls.push({ url, range: opts.headers?.Range });
    if (url.endsWith('.LBL')) return new Response(label, { status: 200, headers: { 'content-type': 'text/plain' } });
    if (url.endsWith('.TXT')) {
      const header = opts.headers?.Range;
      if (!header) return new Response(data, { status: 200 });
      const ranges = header.replace(/^bytes=/, '').split(',').map((r) => r.split('-').map(Number))
        .map(([s, e]) => [s, Math.min(e, data.length - 1)]);
      if (ranges.length === 1) {
        const [s, e] = ranges[0];
        return new Response(data.subarray(s, e + 1), { status: 206, headers: { 'content-range': `bytes ${s}-${e}/${data.length}`, 'content-type': 'text/plain' } });
      }
      const boundary = 'fixtureboundary0001';
      const parts = [];
      for (const [s, e] of ranges) {
        parts.push(Buffer.from(`\r\n--${boundary}\r\nContent-type: text/plain\r\nContent-range: bytes ${s}-${e}/${data.length}\r\n\r\n`, 'latin1'));
        parts.push(data.subarray(s, e + 1));
      }
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1'));
      return new Response(Buffer.concat(parts), { status: 206, headers: { 'content-type': `multipart/byteranges; boundary=${boundary}` } });
    }
    return new Response('not found', { status: 404 });
  };
}

/** fetch() stand-in returning a fixed response or throwing. */
export function stubFetch(handler) {
  return async (url, opts) => handler(url, opts);
}
