// -----------------------------------------------------------------------------
// The network and /data helpers: Retry-After, the bounded read, the headers
// kept from an answer, the file store (missing vs unreadable, atomic writes).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceError, getJson, readBounded, retryAfterMs } from '../src/http.js';
import { createFileStore } from '../src/store.js';

test('Retry-After: seconds or an HTTP date', () => {
  const now = Date.parse('2026-01-15T12:00:00Z');
  assert.equal(retryAfterMs('120', now), 120_000);
  assert.equal(retryAfterMs('Thu, 15 Jan 2026 12:05:00 GMT', now), 300_000);
  assert.equal(retryAfterMs('Thu, 15 Jan 2026 11:00:00 GMT', now), 0);
  for (const bad of [undefined, null, '', 'soon', '-5']) {
    assert.equal(retryAfterMs(bad, now), undefined, String(bad));
  }
});

test('the bounded read: the declared length, the streamed size, a body without stream', async () => {
  assert.equal(await readBounded(new Response('abc'), 3), 'abc');
  await assert.rejects(readBounded(new Response('abcd'), 3), (e) => e.code === 'too_large');
  await assert.rejects(
    readBounded(new Response('x', { headers: { 'content-length': '99' } }), 3),
    (e) => e.code === 'too_large',
  );
  const plain = { headers: { get: () => null }, text: async () => 'abcd' };
  await assert.rejects(readBounded(plain, 3), (e) => e.code === 'too_large');
  assert.equal(
    await readBounded({ headers: { get: () => null }, text: async () => 'ab' }, 3),
    'ab',
  );
});

test('getJson: 200, 304, the ETag sent only when clean, the answer headers bounded', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.headers);
    if (init.headers['If-None-Match'] === '"a"') return new Response(null, { status: 304 });
    return new Response('[1]', { headers: { etag: '"a"', 'last-modified': 'x'.repeat(300) } });
  };
  const first = await getJson('https://x/y', { fetchImpl, limit: 100 });
  assert.deepEqual(first.json, [1]);
  assert.equal(first.etag, '"a"');
  assert.equal(first.lastModified, undefined, 'a header over 200 characters is dropped');
  assert.equal((await getJson('https://x/y', { fetchImpl, limit: 100, etag: '"a"' })).status, 304);
  await getJson('https://x/y', { fetchImpl, limit: 100, etag: '"a"\r\nX: 1' });
  assert.equal(seen.at(-1)['If-None-Match'], undefined);
  // A 429 with an HTTP date: measured on the server's Date header, not the local clock.
  await assert.rejects(
    getJson('https://x/y', {
      limit: 100,
      now: () => Date.parse('2026-01-15T13:00:00Z'),
      fetchImpl: async () =>
        new Response('', {
          status: 429,
          headers: {
            date: 'Thu, 15 Jan 2026 12:00:00 GMT',
            'retry-after': 'Thu, 15 Jan 2026 12:30:00 GMT',
          },
        }),
    }),
    (e) => e.code === 'rate_limited' && e.retryAfter === 30 * 60_000,
  );
  const fail = (response) =>
    getJson('https://x/y', { fetchImpl: async () => response, limit: 100 });
  await assert.rejects(fail(new Response('', { status: 500 })), (e) => e.code === 'server');
  await assert.rejects(fail(new Response('', { status: 403 })), (e) => e.code === 'http');
  await assert.rejects(fail(new Response('{', { status: 200 })), (e) => e.code === 'invalid');
  await assert.rejects(
    getJson('https://x/y', {
      limit: 100,
      fetchImpl: async () => {
        throw new TypeError('fetch failed https://secret/url');
      },
    }),
    (e) => e instanceof SourceError && e.code === 'network' && !/secret/.test(e.message),
  );
});

test('the file store: missing, written atomically, read back, unreadable told apart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'netzentgelte-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  const store = createFileStore(file);
  assert.deepEqual(await store.load(), { status: 'missing' });
  await Promise.all([store.save({ a: 1 }), store.save({ a: 2 })]);
  assert.deepEqual(await store.load(), { status: 'ok', data: { a: 2 } });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { a: 2 });
  await writeFile(file, '{broken');
  assert.deepEqual(await store.load(), { status: 'unreadable' });
  await writeFile(file, '[1]');
  assert.deepEqual(await store.load(), { status: 'unreadable' });
  if (process.getuid?.() !== 0) {
    await writeFile(file, '{}');
    await chmod(file, 0o000);
    assert.deepEqual(await store.load(), { status: 'unreadable' });
    await chmod(file, 0o600);
  }
  const bad = createFileStore(join(dir, 'missing-dir', 'state.json'));
  await assert.rejects(bad.save({ a: 1 }));
  await bad.save({ a: 1 }).catch(() => {});
});
