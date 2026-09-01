import test from 'node:test';
import assert from 'node:assert/strict';

import { isCurrentProjectionAccount, isProjectableEquity } from './projectionAccounts.js';

test('excludes closed and archived predecessor accounts from current projections', () => {
  assert.equal(isCurrentProjectionAccount({ id: 'live' }), true);
  assert.equal(isCurrentProjectionAccount({ id: 'closed', closed: true }), false);
  assert.equal(isCurrentProjectionAccount({ id: 'archived', archived: true }), false);
  assert.equal(
    isCurrentProjectionAccount({ id: 'predecessor', closed: true, archived: true }),
    false
  );
});

test('keeps signed non-zero equity so the projection start reconciles to total equity', () => {
  assert.equal(isProjectableEquity(100), true);
  assert.equal(isProjectableEquity(-0.01), true);
  assert.equal(isProjectableEquity(0), false);
  assert.equal(isProjectableEquity(null), false);
  assert.equal(isProjectableEquity('not-a-number'), false);
});
