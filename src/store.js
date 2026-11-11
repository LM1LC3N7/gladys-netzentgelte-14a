// -----------------------------------------------------------------------------
// The state kept in /data (the only writable place of the container): the
// checked Par14a-Database years (compact), their ETag and date, the time of
// the last check and of the last attempt, and the pause after a 429. No
// secret, no personal data. One JSON file written through a temporary file
// and a rename, one save after the other. Taken from gladys-iskra (approved).
//
// A missing file is an empty state; an unreadable one (permissions, a broken
// volume, a file too large or not ours) is told apart: the app reads it again
// later and never overwrites it with an empty state.
// -----------------------------------------------------------------------------

import { readFile, rename, stat, writeFile } from 'node:fs/promises';

export const DEFAULT_STATE_FILE = '/data/netzentgelte-14a-state.json';
const MAX_STATE_BYTES = 16 * 1024 * 1024;

export function createFileStore(file = DEFAULT_STATE_FILE) {
  let queue = Promise.resolve();
  const write = async (data) => {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, file);
  };
  return {
    /** `{ status: 'ok', data }`, `{ status: 'missing' }` or `{ status: 'unreadable' }`. */
    async load() {
      try {
        if ((await stat(file)).size > MAX_STATE_BYTES) return { status: 'unreadable' };
        const data = JSON.parse(await readFile(file, 'utf8'));
        return data && typeof data === 'object' && !Array.isArray(data)
          ? { status: 'ok', data }
          : { status: 'unreadable' };
      } catch (err) {
        return err?.code === 'ENOENT' ? { status: 'missing' } : { status: 'unreadable' };
      }
    },
    save(data) {
      const job = queue.then(
        () => write(data),
        () => write(data),
      );
      queue = job.catch(() => {});
      return job;
    },
  };
}

/** The same in memory (tests): `unreadable` and `failSave` simulate a broken volume. */
export function createMemoryStore(initial) {
  let data = initial === undefined ? undefined : structuredClone(initial);
  const store = {
    unreadable: false,
    failSave: false,
    saves: 0,
    async load() {
      if (store.unreadable) return { status: 'unreadable' };
      return data === undefined
        ? { status: 'missing' }
        : { status: 'ok', data: structuredClone(data) };
    },
    async save(next) {
      if (store.failSave) throw new Error('EROFS');
      store.saves += 1;
      data = structuredClone(next);
    },
    get data() {
      return data;
    },
  };
  return store;
}
