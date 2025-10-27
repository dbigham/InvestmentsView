const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { assignAccountGroups } = require(path.join(__dirname, '../src/grouping.js'));

test('synthesizes parent groups using relations and aggregates descendants', () => {
  const accounts = [
    { id: 'a:1', number: '1', accountGroup: 'Aggressive RRSP', ownerLabel: 'a' },
    { id: 'a:2', number: '2', accountGroup: 'Aggressive RRSP', ownerLabel: 'a' },
    { id: 'a:3', number: '3', accountGroup: 'Aggressive RRSP', ownerLabel: 'a' },
    { id: 'm:1', number: '4', accountGroup: 'Main RRSP', ownerLabel: 'm' },
    { id: 'm:2', number: '5', accountGroup: 'Main RRSP', ownerLabel: 'm' },
  ];

  const relations = {
    'Aggressive RRSP': ['RRSP'],
    'Main RRSP': ['RRSP'],
  };

  const { accountGroups, accountGroupsById } = assignAccountGroups(accounts, { groupRelations: relations });

  assert.ok(Array.isArray(accountGroups) && accountGroups.length >= 3);

  const byName = new Map(accountGroups.map((g) => [g.name, g]));

  // Child groups exist with direct members
  assert.equal(byName.get('Aggressive RRSP').memberCount, 3);
  assert.equal(byName.get('Main RRSP').memberCount, 2);

  // Synthesized parent RRSP aggregates both children
  const rrsp = byName.get('RRSP');
  assert.ok(rrsp, 'RRSP group should be present');
  assert.equal(rrsp.memberCount, 5, 'RRSP should aggregate all descendant accounts');

  // The id should be a stable slug form
  assert.ok(rrsp.id && rrsp.id.startsWith('group:rrsp'));

  // accountGroupsById should allow lookup by id
  const lookup = accountGroupsById.get(rrsp.id);
  assert.ok(lookup);
  assert.equal(lookup.accounts.length, 5);
});

