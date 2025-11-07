function normalizeAccountGroupName(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const stringValue = typeof value === 'string' ? value : String(value);
  const normalized = stringValue.replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function normalizeDateOnly(value) {
  if (value == null) {
    return null;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    if (Number.isNaN(time)) {
      return null;
    }
    return new Date(time).toISOString().slice(0, 10);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const derived = new Date(value);
    if (Number.isNaN(derived.getTime())) {
      return null;
    }
    return derived.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = new Date(`${trimmed}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

function slugifyAccountGroupKey(name) {
  if (!name) {
    return null;
  }
  const base = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'group';
}

/**
 * Builds account groups from a flat list of accounts and optional group relations.
 *
 * options.groupRelations: { [childGroupName: string]: string[] parentGroupNames }
 */
function assignAccountGroups(accounts, options) {
  const opts = options || {};
  const groupRelationsRaw = opts.groupRelations || null; // { childName: [parentName, ...] }
  const metadataByKey = new Map();
  if (opts.groupMetadata && typeof opts.groupMetadata === 'object') {
    Object.entries(opts.groupMetadata).forEach(([rawKey, value]) => {
      if (!rawKey || !value || typeof value !== 'object') {
        return;
      }
      const normalized = normalizeAccountGroupName(rawKey);
      if (!normalized) {
        return;
      }
      const key = normalized.toLowerCase();
      if (!key) {
        return;
      }
      metadataByKey.set(key, value);
    });
  }

  const decorateGroupWithMetadata = (group) => {
    if (!group || typeof group !== 'object') {
      return;
    }
    const normalizedName = normalizeAccountGroupName(group.name);
    if (!normalizedName) {
      return;
    }
    const key = normalizedName.toLowerCase();
    const meta = metadataByKey.get(key);
    if (!meta || typeof meta !== 'object') {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(meta, 'mainRetirementAccount')) {
      group.mainRetirementAccount = meta.mainRetirementAccount === true;
    }
    if (Object.prototype.hasOwnProperty.call(meta, 'retirementAge')) {
      const age = Number(meta.retirementAge);
      if (Number.isFinite(age) && age > 0) {
        group.retirementAge = Math.round(age);
      }
    }
    if (Object.prototype.hasOwnProperty.call(meta, 'retirementIncome')) {
      const income = Number(meta.retirementIncome);
      if (Number.isFinite(income) && income >= 0) {
        group.retirementIncome = Math.round(income * 100) / 100;
      }
    }
    if (Object.prototype.hasOwnProperty.call(meta, 'retirementLivingExpenses')) {
      const expenses = Number(meta.retirementLivingExpenses);
      if (Number.isFinite(expenses) && expenses >= 0) {
        group.retirementLivingExpenses = Math.round(expenses * 100) / 100;
      }
    }
    if (Object.prototype.hasOwnProperty.call(meta, 'retirementBirthDate')) {
      const normalized = normalizeDateOnly(meta.retirementBirthDate);
      if (normalized) {
        group.retirementBirthDate = normalized;
      }
    }
  };

  const groupsByKey = new Map();
  const groupsById = new Map();
  const usedSlugs = new Set();
  const displayNameByKey = new Map(); // lowercased key -> display name

  (accounts || []).forEach((account) => {
    if (!account) {
      return;
    }
    const groupName = normalizeAccountGroupName(account.accountGroup);
    if (!groupName) {
      account.accountGroup = null;
      account.accountGroupId = null;
      return;
    }

    const key = groupName.toLowerCase();
    let group = groupsByKey.get(key);
    if (!group) {
      const baseSlug = slugifyAccountGroupKey(groupName);
      let slug = baseSlug;
      let suffix = 2;
      while (usedSlugs.has(slug)) {
        slug = `${baseSlug}-${suffix}`;
        suffix += 1;
      }
      usedSlugs.add(slug);
      const id = `group:${slug}`;
      group = { id, name: groupName, accounts: [] };
      groupsByKey.set(key, group);
      groupsById.set(id, group);
      displayNameByKey.set(key, groupName);
      decorateGroupWithMetadata(group);
    }

    group.accounts.push(account);
    account.accountGroup = groupName;
    account.accountGroupId = group.id;
  });

  // If group relations are provided (child -> [parent,...]), synthesize parent groups by aggregating
  // accounts from descendant groups.
  if (groupRelationsRaw && typeof groupRelationsRaw === 'object') {
    // Normalize relations: childKey (lowercased) -> Set(parentKey)
    const childToParents = new Map();
    Object.entries(groupRelationsRaw).forEach(([rawChild, rawParents]) => {
      const childName = normalizeAccountGroupName(rawChild);
      const childKey = childName ? childName.toLowerCase() : null;
      const parentList = Array.isArray(rawParents) ? rawParents : [];
      if (!childKey) {
        return;
      }
      let set = childToParents.get(childKey);
      if (!set) {
        set = new Set();
        childToParents.set(childKey, set);
      }
      displayNameByKey.set(childKey, displayNameByKey.get(childKey) || childName);
      parentList.forEach((rawParent) => {
        const parentName = normalizeAccountGroupName(rawParent);
        const parentKey = parentName ? parentName.toLowerCase() : null;
        if (!parentKey) {
          return;
        }
        set.add(parentKey);
        displayNameByKey.set(parentKey, displayNameByKey.get(parentKey) || parentName);
      });
    });

    // Build reverse mapping: parentKey -> Set(childKey)
    const parentToChildren = new Map();
    childToParents.forEach((parents, childKey) => {
      parents.forEach((parentKey) => {
        let children = parentToChildren.get(parentKey);
        if (!children) {
          children = new Set();
          parentToChildren.set(parentKey, children);
        }
        children.add(childKey);
      });
    });

    // Helper to get transitive descendants of a parent
    const getDescendants = (parentKey) => {
      const result = new Set();
      const queue = [];
      const seen = new Set();
      const direct = parentToChildren.get(parentKey);
      if (direct) {
        direct.forEach((c) => queue.push(c));
      }
      while (queue.length) {
        const child = queue.shift();
        if (seen.has(child)) {
          continue;
        }
        seen.add(child);
        result.add(child);
        const next = parentToChildren.get(child);
        if (next) {
          next.forEach((n) => queue.push(n));
        }
      }
      return result;
    };

    // For each parent, aggregate accounts from all descendant groups (and include direct members if any)
    parentToChildren.forEach((childrenSet, parentKey) => {
      const parentName = displayNameByKey.get(parentKey) || parentKey;
      // Ensure parent group exists with stable id
      let parentGroup = groupsByKey.get(parentKey);
      if (!parentGroup) {
        const baseSlug = slugifyAccountGroupKey(parentName);
        let slug = baseSlug;
        let suffix = 2;
        while (usedSlugs.has(slug)) {
          slug = `${baseSlug}-${suffix}`;
          suffix += 1;
        }
        usedSlugs.add(slug);
        const id = `group:${slug}`;
        parentGroup = { id, name: parentName, accounts: [] };
        groupsByKey.set(parentKey, parentGroup);
        groupsById.set(id, parentGroup);
        displayNameByKey.set(parentKey, parentName);
        decorateGroupWithMetadata(parentGroup);
      }

      const accountsSet = new Map(); // id -> account

      // Include any direct members of the parent (if a base group already existed)
      const maybeExisting = groupsByKey.get(parentKey);
      if (maybeExisting && Array.isArray(maybeExisting.accounts)) {
        maybeExisting.accounts.forEach((acc) => {
          if (acc && acc.id) {
            accountsSet.set(acc.id, acc);
          }
        });
      }

      const allDescendants = getDescendants(parentKey);
      allDescendants.forEach((childKey) => {
        const childGroup = groupsByKey.get(childKey);
        if (!childGroup || !Array.isArray(childGroup.accounts)) {
          return;
        }
        childGroup.accounts.forEach((acc) => {
          if (acc && acc.id) {
            accountsSet.set(acc.id, acc);
          }
        });
      });

      const aggregated = Array.from(accountsSet.values());
      if (aggregated.length) {
        parentGroup.accounts = aggregated;
      }
    });
  }

  const accountGroups = Array.from(groupsById.values()).map((group) => {
    decorateGroupWithMetadata(group);
    const ownerLabels = new Set();
    const accountNumbers = new Set();
    group.accounts.forEach((account) => {
      if (!account) {
        return;
      }
      if (typeof account.ownerLabel === 'string') {
        const label = account.ownerLabel.trim();
        if (label) {
          ownerLabels.add(label);
        }
      }
      if (account.number !== undefined && account.number !== null) {
        const number = String(account.number).trim();
        if (number) {
          accountNumbers.add(number);
        }
      }
    });
    return {
      id: group.id,
      name: group.name,
      accounts: group.accounts,
      memberCount: group.accounts.length,
      accountIds: group.accounts.map((account) => account.id),
      accountNumbers: Array.from(accountNumbers),
      ownerLabels: Array.from(ownerLabels),
      mainRetirementAccount: group.mainRetirementAccount === true,
      retirementAge:
        Number.isFinite(group.retirementAge) && group.retirementAge > 0
          ? Math.round(group.retirementAge)
          : null,
      retirementIncome:
        Number.isFinite(group.retirementIncome) && group.retirementIncome >= 0
          ? Math.round(group.retirementIncome * 100) / 100
          : null,
      retirementLivingExpenses:
        Number.isFinite(group.retirementLivingExpenses) && group.retirementLivingExpenses >= 0
          ? Math.round(group.retirementLivingExpenses * 100) / 100
          : null,
      retirementBirthDate:
        typeof group.retirementBirthDate === 'string' && group.retirementBirthDate
          ? group.retirementBirthDate
          : null,
    };
  });

  accountGroups.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return { accountGroups, accountGroupsById: groupsById };
}

module.exports = {
  assignAccountGroups,
  normalizeAccountGroupName,
  slugifyAccountGroupKey,
};
