// Builds src/data/export-index.json: which popular package exports which value name.
// Used for hints like `"formatRelative" is exported by date-fns` when date-fns isn't installed.
// Packages are downloaded for inspection only (never executed). Run: node scripts/build-index.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchForInspection } from '../src/inspect.js';
import { namesInRoot } from '../src/tsutil.js';
import { pool } from '../src/analyze.js';

// Popular libraries AIs mix up. Order = preference when a name lives in several.
const PACKAGES = [
  // dates
  'date-fns', 'dayjs', 'moment', 'luxon',
  // utilities
  'lodash', 'ramda', 'underscore', 'radash', 'es-toolkit',
  // http
  'axios', 'ky', 'node-fetch', 'got', 'undici', 'ofetch',
  // validation
  'zod', 'yup', 'joi', 'valibot', 'ajv', 'class-validator', 'superstruct',
  // servers
  'express', 'koa', 'fastify', 'hono', 'cors', 'helmet', 'cookie', 'cookie-parser', 'multer', 'body-parser',
  // react & friends
  'react', 'react-dom', 'react-router-dom', 'react-router', '@tanstack/react-query', 'swr', '@reduxjs/toolkit', 'redux',
  'react-redux', 'zustand', 'jotai', 'mobx', 'react-hook-form', 'formik', 'framer-motion', 'clsx', 'classnames', 'tailwind-merge',
  '@testing-library/react',
  // vue & svelte
  'vue', 'vue-router', 'pinia', 'svelte',
  // node tooling
  'fs-extra', 'glob', 'fast-glob', 'globby', 'rimraf', 'dotenv', 'chalk', 'picocolors', 'kleur', 'commander', 'yargs',
  '@inquirer/prompts', 'ora', 'execa', 'chokidar', 'p-limit', 'p-retry', 'semver', 'minimatch', 'mime-types',
  // ids & crypto & data
  'uuid', 'nanoid', 'jsonwebtoken', 'jose', 'bcryptjs', 'immer', 'rxjs', 'eventemitter3', 'yaml', 'js-yaml', 'papaparse',
  // data & services
  'mongoose', 'pg', 'mysql2', 'ioredis', 'redis', 'knex', 'drizzle-orm', 'sequelize', 'ws', 'socket.io', 'socket.io-client',
  '@supabase/supabase-js', 'openai', '@anthropic-ai/sdk', 'stripe',
  // testing
  'vitest', 'chai', 'sinon', 'supertest',
];

const MIN_NAME = 4; // "get", "map", "set" are everywhere and say nothing
const MAX_OWNERS = 4; // a name exported by many packages is not a useful hint

const byName = new Map();
const ok = [];
await pool(PACKAGES, 6, async (name) => {
  try {
    const got = await fetchForInspection(name);
    const n = got && namesInRoot(got.root, name);
    if (!n || n.any || !n.values.size) {
      console.log(`- ${name}: no declarations`);
      return;
    }
    ok.push(name);
    for (const v of n.values) {
      if (v.length < MIN_NAME || v === 'default' || v.startsWith('_') || /^[A-Z_]+$/.test(v)) continue;
      if (!byName.has(v)) byName.set(v, new Set());
      byName.get(v).add(name);
    }
    console.log(`✔ ${name}@${got.version}: ${n.values.size} values`);
  } catch (e) {
    console.log(`- ${name}: ${e.message}`);
  }
});

const order = (p) => PACKAGES.indexOf(p);
const packages = ok.sort((a, b) => order(a) - order(b));
const index = {};
for (const [v, owners] of [...byName].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (owners.size > MAX_OWNERS) continue;
  index[v] = [...owners].sort((a, b) => order(a) - order(b)).map((p) => packages.indexOf(p));
}
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'export-index.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), packages, names: index }) + '\n');
console.log(`\n${Object.keys(index).length} names from ${packages.length} packages → ${out}`);
