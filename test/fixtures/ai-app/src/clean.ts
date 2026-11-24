// Correct code: importprobe must report nothing here.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import axios, { isAxiosError } from 'axios';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { z } from 'zod';
import { slugify, formatDateTime } from './utils.js';
import { config } from './config.js';

dayjs.extend(relativeTime);

export async function fetchReport(name: string) {
  try {
    const res = await axios.get(`/reports/${slugify(name)}`);
    const file = await readFile(path.join(config.dir, `${name}.json`), 'utf8');
    return { res, file, schema: z.object({ name: z.string() }), at: formatDateTime(new Date()), ago: dayjs().fromNow() };
  } catch (e) {
    if (isAxiosError(e)) return null;
    throw e;
  }
}
