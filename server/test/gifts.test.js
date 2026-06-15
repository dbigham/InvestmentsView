'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createGift,
  deleteGift,
  listGifts,
  normalizeAmountCad,
  updateGift,
} = require('../src/gifts');

function withTempGiftFile(fn) {
  const filePath = path.join(
    os.tmpdir(),
    `investments-view-gifts-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  try {
    return fn({ filePath });
  } finally {
    try {
      fs.unlinkSync(filePath);
    } catch {}
  }
}

test('normalizeAmountCad supports money strings and compact thousands', () => {
  assert.equal(normalizeAmountCad('$1,234.56'), 1234.56);
  assert.equal(normalizeAmountCad('2.5k'), 2500);
  assert.equal(normalizeAmountCad(100), 100);
  assert.equal(normalizeAmountCad(0), null);
});

test('createGift and listGifts summarize current-year giving by organization', () => {
  withTempGiftFile((options) => {
    createGift(
      {
        date: '2026-01-05',
        organization: 'MCC',
        amountCad: '1,200',
        taxClaimable: true,
      },
      options
    );
    createGift(
      {
        date: '2026-02-10',
        organization: 'One4Another',
        amountCad: 800,
        taxClaimable: false,
      },
      options
    );
    createGift(
      {
        date: '2025-12-10',
        organization: 'MCC',
        amountCad: 500,
        taxClaimable: true,
      },
      options
    );

    const result = listGifts({ year: 2026 }, options);
    assert.equal(result.gifts.length, 2);
    assert.equal(result.summary.year, 2026);
    assert.equal(result.summary.totalCad, 2000);
    assert.equal(result.summary.taxClaimableCad, 1200);
    assert.equal(result.summary.nonTaxClaimableCad, 800);
    assert.equal(result.summary.organizationCount, 2);
    assert.deepEqual(
      result.summary.organizations.map((entry) => [entry.organization, entry.totalCad]),
      [
        ['MCC', 1200],
        ['One4Another', 800],
      ]
    );
  });
});

test('updateGift and deleteGift rewrite the gift list', () => {
  withTempGiftFile((options) => {
    const created = createGift(
      {
        date: '2026-03-01',
        organization: 'MCC',
        amountCad: 100,
        taxClaimable: true,
      },
      options
    );

    const updated = updateGift(
      created.gift.id,
      {
        amountCad: 150,
        organization: 'One4Another',
        taxClaimable: false,
      },
      options
    );
    assert.equal(updated.gift.amountCad, 150);
    assert.equal(updated.gift.organization, 'One4Another');
    assert.equal(updated.gift.taxClaimable, false);

    const afterUpdate = listGifts({ year: 2026 }, options);
    assert.equal(afterUpdate.summary.totalCad, 150);
    assert.equal(afterUpdate.summary.taxClaimableCad, 0);

    const deleted = deleteGift(created.gift.id, options);
    assert.equal(deleted.gift.id, created.gift.id);

    const afterDelete = listGifts({ year: 2026 }, options);
    assert.equal(afterDelete.gifts.length, 0);
    assert.equal(afterDelete.summary.totalCad, 0);
  });
});
