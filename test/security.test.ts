import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRecord, constantTimeEqual, isLocalOrigin, safeToken } from '../desktop/security.js';

test('desktop boundary accepts only loopback origins', () => {
  assert.equal(isLocalOrigin('http://127.0.0.1:80'), true);
  assert.equal(isLocalOrigin('http://localhost:80'), false);
  assert.equal(isLocalOrigin('https://127.0.0.1'), false);
  assert.equal(isLocalOrigin('http://127.0.0.1.evil.test'), false);
});
test('tokens are constrained and compared without early exit', () => {
  const token = 'a'.repeat(32);
  assert.equal(safeToken(token), true);
  assert.equal(safeToken('short'), false);
  assert.equal(constantTimeEqual(token, token), true);
  assert.equal(constantTimeEqual(token, 'b'.repeat(32)), false);
});
test('record validation rejects null and arrays', () => {
  assert.throws(() => assertRecord(null, 'state'));
  assert.throws(() => assertRecord([], 'state'));
  assert.deepEqual(assertRecord({ ok: true }, 'state'), { ok: true });
});
