import { readFileSync, readJsonSync } from 'node:fs'; // readJsonSync is from fs-extra
import { join } from 'node:paths'; // the module is node:path
import { formatDate } from './utils.js'; // utils exports formatDateTime
import config from './config.js'; // config has only a named export
import { log } from './helpers/logger.js'; // this file was never created

export function load(name) {
  log(`loading ${name}`);
  const raw = readFileSync(join(config.dir, name), 'utf8');
  return { raw, data: readJsonSync(name), at: formatDate(new Date()) };
}
