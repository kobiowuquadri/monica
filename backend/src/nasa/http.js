import dns from 'node:dns';

// Some NASA hosts publish AAAA records that are unreachable from some networks; prefer IPv4.
dns.setDefaultResultOrder('ipv4first');

export class UpstreamError extends Error {
  constructor(code, message, { status, url } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.url = url;
  }
}

const USER_AGENT = 'MONICA-prototype/0.1 (NASA Space Apps 2026 research prototype)';

/**
 * fetch() with a hard timeout and normalised upstream errors. Never retries silently on
 * 4xx; retries network errors/5xx a limited number of times with backoff.
 */
export async function fetchWithTimeout(url, { timeoutMs = 20_000, headers = {}, retries = 1, fetchImpl = globalThis.fetch, signal } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal: controller.signal });
      if (res.status >= 500 && attempt < retries) {
        lastErr = new UpstreamError('upstream_error', `Upstream returned HTTP ${res.status}`, { status: res.status, url });
        await res.body?.cancel?.();
      } else {
        return { res, controller };
      }
    } catch (err) {
      const timedOut = controller.signal.aborted && String(controller.signal.reason?.message) === 'timeout';
      lastErr = new UpstreamError(timedOut ? 'upstream_timeout' : 'upstream_unreachable',
        timedOut ? `No response within ${timeoutMs} ms` : `Could not reach upstream (${err.cause?.code || err.code || err.name})`, { url });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 750 * (attempt + 1)));
  }
  throw lastErr;
}

export async function fetchText(url, opts = {}) {
  const { res } = await fetchWithTimeout(url, opts);
  if (!res.ok) {
    await res.body?.cancel?.();
    throw new UpstreamError('upstream_http_error', `Upstream returned HTTP ${res.status}`, { status: res.status, url });
  }
  return res.text();
}
