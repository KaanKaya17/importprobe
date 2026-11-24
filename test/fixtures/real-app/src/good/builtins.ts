import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'events';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

test('builtins', async () => {
  await sleep(1);
  const e = new EventEmitter();
  setImmediate(() => e.emit('x'));
  await once(e, 'x');
  assert.ok(Buffer.from('a').length);
  assert.ok(fs.existsSync('.') && fs.promises);
  assert.ok(createHash('sha1').update(randomUUID()).digest('hex'));
  assert.ok(process.cwd());
});
