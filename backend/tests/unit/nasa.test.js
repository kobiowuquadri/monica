import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePdsLabel, dosimetryElements, parseDayOfYearUtc } from '../../src/nasa/pdsLabel.js';
import {
  decodeQc, parseObservationHeader, parseDoseWindow, interpretDoseValue, parseMultipartByteranges, mergeRanges,
  selectProductsFromIndex, readSolDosimetry,
} from '../../src/nasa/radRdr.js';
import { normaliseDonkiRecord, fetchDonki } from '../../src/nasa/donki.js';
import { getRecentSpaceWeather, _resetSpaceWeatherCache } from '../../src/services/environmentService.js';
import { RAD_LABEL, RAD_DATA, RAD_INDEX, SOL_1812_PRODUCT, archiveFetch, stubFetch } from '../helpers/fixtures.js';

// ---------------- PDS label & RDR parsing (real archive excerpts) ----------------
test('label pointers are 1-based and units are read from the label', () => {
  const label = parsePdsLabel(RAD_LABEL);
  assert.equal(label.keywords.PRODUCT_ID, 'RAD_RDR_2017_253_04_24_1812_V00');
  const els = dosimetryElements(label);
  assert.deepEqual(els.map((e) => e.detector), ['B', 'E']);
  const b = els.find((e) => e.detector === 'B');
  assert.equal(b.offset0, 18696); // label says 18697 <BYTES>, counted from 1
  assert.equal(b.unit, 'microGray / Hour');
  assert.equal(b.bytes, 8);
  assert.equal(RAD_DATA.subarray(b.offset0, b.offset0 + 8).toString('latin1'), '10.79981');
});

test('RDR day-of-year timestamps are parsed as UTC', () => {
  assert.equal(parseDayOfYearUtc('2017-253 04:24:11').toISOString(), '2017-09-10T04:24:11.000Z');
  assert.equal(parseDayOfYearUtc('2017-253T04:24:11').toISOString(), '2017-09-10T04:24:11.000Z');
  assert.equal(parseDayOfYearUtc('2017-366 00:00:00'), null); // 2017 is not a leap year
  assert.equal(parseDayOfYearUtc('garbage'), null);
});

test('observation header and both detector channels are parsed separately', () => {
  const text = RAD_DATA.toString('latin1');
  const hdr = parseObservationHeader(text.slice(0, 735), 0);
  assert.equal(hdr.startObsUtc.toISOString(), '2017-09-10T04:24:11.000Z');
  assert.equal(hdr.qc, '00000000');
  assert.equal(hdr.startObsMars, '1812 01:02:41');
  const dose = parseDoseWindow(text.slice(18400, 18800), 0);
  assert.equal(dose.B, '10.79981');
  assert.equal(dose.E, '11.31774');
  assert.equal(dose.header.DETECTOR_B_THICKNESS, 300);
});

test('QC bits are interpreted per RAD_RDR_SIS §4.2.1.2', () => {
  assert.equal(decodeQc('00000000').qualityStatus, 'no_issues_identified');
  assert.equal(decodeQc('00000001').qualityStatus, 'issues_may_exist');
  assert.equal(decodeQc('00000100').qualityStatus, 'instrument_mode_flagged');
  assert.equal(decodeQc('00001000').flags[0].code, 'solar_event_mode');
  assert.equal(decodeQc('00000101').qualityStatus, 'issues_may_exist');
  assert.equal(decodeQc('00100000').flags[0].code, 'undocumented_bit_5');
  assert.equal(decodeQc('xyz').qualityStatus, 'issues_may_exist');
});

test('missing, non-numeric and negative values become gaps', () => {
  assert.deepEqual(interpretDoseValue(null), { value: null, status: 'missing' });
  assert.deepEqual(interpretDoseValue('N/A'), { value: null, status: 'invalid_value' });
  assert.deepEqual(interpretDoseValue('-1.0'), { value: null, status: 'invalid_value' });
  assert.deepEqual(interpretDoseValue('10.79981'), { value: 10.79981, status: 'ok' });
});

test('multipart byte-range responses are parsed by Content-Range', async () => {
  const res = await archiveFetch()('x.TXT', { headers: { Range: 'bytes=0-9,18696-18703' } });
  const parts = parseMultipartByteranges(Buffer.from(await res.arrayBuffer()), res.headers.get('content-type'));
  assert.equal(parts.length, 2);
  assert.equal(parts[1].buf.toString('latin1'), '10.79981');
  assert.deepEqual(mergeRanges([[10, 20], [0, 5], [6, 12], [30, 40]]), [[0, 20], [30, 40]]);
});

test('index selection keeps surface sols in range and the highest version', () => {
  const extra = `${RAD_INDEX}\n"MSL-M-RAD-3-RDR-V1.0","/DATA/SOL_01773_01869/RAD_RDR_2017_253_04_24_1812_V01.LBL","RAD_RDR_2017_253_04_24_1812_V01","MSLRAD_1002",2019-01-01T00:00:00  ,"MARS       ",2017-253T04:24:11,UNK`;
  const sel = selectProductsFromIndex(extra, 1812, 1813);
  assert.deepEqual(sel.map((p) => p.sol), [1812, 1813]);
  assert.equal(sel[0].productId, 'RAD_RDR_2017_253_04_24_1812_V01');
});

test('reading a sol keeps detectors separate with archived units and provenance', async () => {
  const calls = [];
  const { observations, messages } = await readSolDosimetry(SOL_1812_PRODUCT, { fetchImpl: archiveFetch({ calls }) });
  assert.deepEqual(messages, []);
  assert.equal(observations.length, 2);
  const [b, e] = observations;
  assert.equal(b.detector, 'B');
  assert.equal(e.detector, 'E');
  assert.equal(b.value, 10.79981);
  assert.equal(e.value, 11.31774);
  for (const o of observations) {
    assert.equal(o.unit, 'microGray / Hour');
    assert.equal(o.quantity, 'absorbed_dose_rate');
    assert.equal(o.observationStartUtc.toISOString(), '2017-09-10T04:24:11.000Z');
    assert.equal(o.qualityStatus, 'no_issues_identified');
    assert.match(o.labelFileUrl, /RAD_RDR_2017_253_04_24_1812_V00\.LBL$/);
    assert.match(o.dataFileUrl, /RAD_RDR_2017_253_04_24_1812_V00\.TXT$/);
  }
  // No combined/summed channel is ever produced.
  assert.ok(!observations.some((o) => !['B', 'E'].includes(o.detector)));
  // Only byte ranges were requested from the ~86 MB data file.
  assert.ok(calls.filter((c) => c.url.endsWith('.TXT')).every((c) => /^bytes=/.test(c.range)));
});

test('a server that ignores Range is refused instead of downloading the full file', async () => {
  const fetchImpl = async (url) => (url.endsWith('.LBL') ? new Response(RAD_LABEL, { status: 200 }) : new Response(RAD_DATA, { status: 200 }));
  await assert.rejects(readSolDosimetry(SOL_1812_PRODUCT, { fetchImpl }), (err) => err.code === 'range_not_supported');
});

// ---------------- DONKI ----------------
test('DONKI records are normalised without inventing fields', () => {
  const sep = normaliseDonkiRecord('SEP', {
    sepID: '2017-09-04T22:56:00-SEP-001', eventTime: '2017-09-04T22:56Z',
    instruments: [{ displayName: 'MODEL: REleASE:SOHO/EPHIN 15.8-39.8 MeV' }], linkedEvents: [{ activityID: '2017-09-04T20:15:00-FLR-001' }],
    link: 'https://ccmc.gsfc.nasa.gov/DONKI/view/SEP/13004/-1',
  });
  assert.equal(sep.eventTime.toISOString(), '2017-09-04T22:56:00.000Z');
  assert.deepEqual(sep.observedBy, ['MODEL: REleASE:SOHO/EPHIN 15.8-39.8 MeV']);
  assert.equal(sep.summary.observingLocation, null);
  assert.equal(normaliseDonkiRecord('SEP', { eventTime: '2017-09-04T22:56Z' }), null);
  assert.equal(normaliseDonkiRecord('CME', { activityID: 'x', startTime: 'not a date' }), null);
  const ips = normaliseDonkiRecord('IPS', { activityID: 'i1', eventTime: '2017-09-06T23:10Z', location: 'Earth', instruments: [] });
  assert.equal(ips.summary.observingLocation, 'Earth');
});

test('DONKI upstream failures are reported, never replaced with data', async () => {
  const s = new Date('2017-09-01T00:00:00Z');
  const e = new Date('2017-09-02T00:00:00Z');
  await assert.rejects(fetchDonki('SEP', s, e, { fetchImpl: stubFetch(() => new Response('', { status: 429 })) }), (err) => err.code === 'rate_limited');
  await assert.rejects(fetchDonki('SEP', s, e, { fetchImpl: stubFetch(() => new Response('oops', { status: 404 })) }), (err) => err.code === 'upstream_http_error');
  await assert.rejects(fetchDonki('SEP', s, e, { fetchImpl: stubFetch(() => new Response('<html>', { status: 200 })) }), (err) => err.code === 'malformed_response');
  await assert.rejects(fetchDonki('SEP', s, e, { fetchImpl: stubFetch(() => new Response('{"a":1}', { status: 200 })) }), (err) => err.code === 'malformed_response');
  await assert.rejects(fetchDonki('SEP', s, e, { fetchImpl: stubFetch(() => { throw new TypeError('fetch failed'); }) }), (err) => err.code === 'upstream_unreachable');
  const empty = await fetchDonki('SEP', s, e, { fetchImpl: stubFetch(() => new Response('', { status: 200 })) });
  assert.deepEqual(empty.records, []);
});

test('DONKI timeouts are surfaced as upstream_timeout', async () => {
  const hang = (_url, opts) => new Promise((_resolve, reject) => { opts.signal.addEventListener('abort', () => reject(new Error('aborted'))); });
  await assert.rejects(fetchDonki('FLR', new Date(), new Date(), { fetchImpl: hang, timeoutMs: 50 }), (err) => err.code === 'upstream_timeout');
});

test('recent space weather reports "unavailable" with no events when NASA cannot be reached', async () => {
  _resetSpaceWeatherCache();
  const res = await getRecentSpaceWeather({ fetchImpl: stubFetch(() => { throw new TypeError('fetch failed'); }) });
  assert.equal(res.status, 'unavailable');
  assert.deepEqual(res.events, []);
  assert.equal(res.errors.length, 3);
  _resetSpaceWeatherCache();
});
