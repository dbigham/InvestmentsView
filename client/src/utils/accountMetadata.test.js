import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAccountMetadataKey } from './accountMetadata.js';

test('resolveAccountMetadataKey prefers the configured account id over a provider account number', () => {
  const account = {
    id: 'investments-view-daniel-bigham:6e0e277d-6528-41a6-86b2-74403c2c77fa',
    number: 'spousal-rrsp-RPA0CP-v8A',
  };

  assert.equal(
    resolveAccountMetadataKey(account),
    'investments-view-daniel-bigham:6e0e277d-6528-41a6-86b2-74403c2c77fa'
  );
});

test('resolveAccountMetadataKey falls back to the account number when no id is available', () => {
  assert.equal(resolveAccountMetadataKey({ number: '53547066' }), '53547066');
});

test('resolveAccountMetadataKey rejects missing account identifiers', () => {
  assert.equal(resolveAccountMetadataKey(null), null);
  assert.equal(resolveAccountMetadataKey({ id: ' ', number: '' }), null);
});
