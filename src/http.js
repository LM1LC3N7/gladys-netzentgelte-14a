// -----------------------------------------------------------------------------
// The only place that talks to the network: `fetch` with a timeout, the
// module's User-Agent, a conditional request (ETag) and a body read up to a
// bound, never whole. Only the Par14a-Database web page is ever asked; no
// redirect is followed. Taken from gladys-entsoe (approved).
// -----------------------------------------------------------------------------

import { HTTP_TIMEOUT, USER_AGENT } from './constants.js';

export class SourceError extends Error {
  /** `code`: 'rate_limited', 'server', 'not_found', 'http', 'network', 'timeout', 'too_large', 'invalid'. */
  constructor(code, message, { status, retryAfter } = {}) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Retry-After (seconds or an HTTP date) -> milliseconds, undefined when absent or invalid. */
export function retryAfterMs(value, now) {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  // An HTTP date names its day and month: a bare number or sign is not one.
  if (!/^[A-Za-z]{3}, /.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** The body as text, refused past `limit` bytes (read in chunks, never whole). */
export async function readBounded(response, limit) {
  const tooLarge = () => new SourceError('too_large', `The answer is larger than ${limit} bytes`);
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel?.().catch(() => {});
    throw tooLarge();
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) throw tooLarge();
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function networkError(err) {
  const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  return timedOut
    ? new SourceError('timeout', 'The Par14a-Database page did not answer in time')
    : new SourceError('network', 'The Par14a-Database page is unreachable (network error)');
}

/**
 * GET a JSON file. Resolves `{ status: 304 }` when unchanged since `etag`, or
 * `{ status: 200, json, etag, lastModified }`; throws a SourceError otherwise.
 */
export async function getJson(
  url,
  { etag, limit, fetchImpl = globalThis.fetch, now = Date.now, timeout = HTTP_TIMEOUT } = {},
) {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
  if (typeof etag === 'string' && etag && !/[\r\n]/.test(etag)) headers['If-None-Match'] = etag;
  let response;
  try {
    response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(Math.max(1, timeout)),
      redirect: 'error',
    });
  } catch (err) {
    throw networkError(err);
  }
  const { status } = response;
  if (status === 304) {
    await response.body?.cancel?.().catch(() => {});
    return { status };
  }
  if (status === 200) {
    let body;
    try {
      body = await readBounded(response, limit);
    } catch (err) {
      throw err instanceof SourceError ? err : networkError(err);
    }
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      throw new SourceError(
        'invalid',
        'The Par14a-Database page answered something else than JSON',
      );
    }
    const header = (name) => {
      const value = response.headers?.get?.(name);
      return typeof value === 'string' && value.length <= 200 && !/[\r\n]/.test(value)
        ? value
        : undefined;
    };
    return { status, json, etag: header('etag'), lastModified: header('last-modified') };
  }
  await response.body?.cancel?.().catch(() => {});
  if (status === 429) {
    throw new SourceError('rate_limited', 'The Par14a-Database page asked to slow down (429)', {
      status,
      retryAfter: retryAfterMs(response.headers?.get?.('retry-after'), now()),
    });
  }
  if (status === 404) {
    throw new SourceError('not_found', 'The Par14a-Database file is missing (404)', { status });
  }
  if (status >= 500) {
    throw new SourceError('server', `The Par14a-Database page answered ${status}`, { status });
  }
  throw new SourceError('http', `The Par14a-Database page answered ${status}`, { status });
}
