import test from 'node:test';
import assert from 'node:assert/strict';
import { processBirthMatches } from '../src/secure-process.js';

test('PID reuse proves prior process absent; malformed timestamps never prove absence', () => {
  assert.equal(processBirthMatches('2026-09-06T03:58:23.2353230Z', '2026-09-06T03:58:23.2353230Z'), true);
  assert.equal(processBirthMatches('2026-09-06T03:58:23.2353230Z', '2026-09-06T04:00:36.9115630Z'), false);
  assert.throws(() => processBirthMatches('invalid', '2026-09-06T04:00:36.9115630Z'));
});
