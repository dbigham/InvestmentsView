import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';

function normalizeGroupKey(value) {
  if (!value) {
    return '';
  }
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function buildAccountOverrideMap(entries, accounts) {
  const byAccountId = new Map();
  if (!Array.isArray(entries)) {
    return byAccountId;
  }
  entries.forEach((entry) => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const key = entry.id !== undefined && entry.id !== null
      ? String(entry.id).trim()
      : entry.number !== undefined && entry.number !== null
        ? String(entry.number).trim()
        : '';
    if (!key) {
      return;
    }
    byAccountId.set(key, {
      name: typeof entry.name === 'string' ? entry.name.trim() : '',
      parentGroup: typeof entry.accountGroup === 'string' ? entry.accountGroup.trim() : '',
    });
  });

  if (!accounts || !Array.isArray(accounts)) {
    return byAccountId;
  }
  // Map number-based overrides to account ids for convenience.
  accounts.forEach((account) => {
    if (!account) {
      return;
    }
    const numberKey =
      account.number !== undefined && account.number !== null
        ? String(account.number).trim()
        : account.accountNumber !== undefined && account.accountNumber !== null
          ? String(account.accountNumber).trim()
          : '';
    if (numberKey && byAccountId.has(numberKey) && account.id) {
      const existing = byAccountId.get(numberKey);
      byAccountId.set(String(account.id).trim(), existing);
    }
  });
  return byAccountId;
}

function buildInitialGroups(accountGroups, groupRelations, entries, accounts) {
  const groupList = [];
  const groupKeyMap = new Map();
  const parentByKey = new Map();
  const ensureGroup = (name) => {
    const normalized = normalizeGroupKey(name);
    if (!normalized) {
      return null;
    }
    if (groupKeyMap.has(normalized)) {
      return groupKeyMap.get(normalized);
    }
    const group = {
      key: normalized,
      name: name.trim(),
      parentKey: '',
    };
    groupKeyMap.set(normalized, group);
    groupList.push(group);
    return group;
  };

  if (Array.isArray(accountGroups)) {
    accountGroups.forEach((group) => {
      if (!group || typeof group.name !== 'string') {
        return;
      }
      ensureGroup(group.name);
    });
  }

  if (groupRelations && typeof groupRelations === 'object') {
    Object.entries(groupRelations).forEach(([childName, parents]) => {
      const child = ensureGroup(childName || '');
      if (!child || !Array.isArray(parents) || !parents.length) {
        return;
      }
      const parent = ensureGroup(parents[0]);
      if (parent) {
        parentByKey.set(child.key, parent.key);
      }
    });
  }

  if (Array.isArray(entries)) {
    entries.forEach((entry) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }
      const hasKey = entry.id !== undefined || entry.number !== undefined;
      if (hasKey) {
        return;
      }
      if (typeof entry.name !== 'string' || !entry.name.trim()) {
        return;
      }
      const group = ensureGroup(entry.name);
      if (!group) {
        return;
      }
      if (typeof entry.accountGroup === 'string' && entry.accountGroup.trim()) {
        const parent = ensureGroup(entry.accountGroup);
        if (parent) {
          parentByKey.set(group.key, parent.key);
        }
      }
    });
  }

  if (Array.isArray(accounts)) {
    accounts.forEach((account) => {
      if (account && typeof account.accountGroup === 'string' && account.accountGroup.trim()) {
        ensureGroup(account.accountGroup);
      }
    });
  }

  groupList.forEach((group) => {
    group.parentKey = parentByKey.get(group.key) || '';
  });

  return groupList;
}

function buildGroupTree(groups) {
  const map = new Map(groups.map((group) => [group.key, { ...group, children: [] }]));
  const roots = [];
  map.forEach((group) => {
    if (group.parentKey && map.has(group.parentKey) && group.parentKey !== group.key) {
      map.get(group.parentKey).children.push(group);
    } else {
      roots.push(group);
    }
  });
  const sortGroups = (nodes) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    nodes.forEach((node) => {
      if (node.children && node.children.length) {
        sortGroups(node.children);
      }
    });
  };
  sortGroups(roots);
  return roots;
}

export default function AccountStructureDialog({
  accounts,
  accountGroups,
  groupRelations,
  initialEntries,
  onSave,
  onClose,
}) {
  const titleId = useId();
  const descriptionId = useId();
  const groupIdCounter = useRef(0);
  const [groupDrafts, setGroupDrafts] = useState([]);
  const [accountDrafts, setAccountDrafts] = useState([]);
  const [ordering, setOrdering] = useState([]);
  const [status, setStatus] = useState({ saving: false, error: null, success: null });
  const [newGroupName, setNewGroupName] = useState('');
  const [showGroupHelp, setShowGroupHelp] = useState(false);

  const createGroupId = useCallback(() => {
    groupIdCounter.current += 1;
    return `group-${groupIdCounter.current}`;
  }, []);

  useEffect(() => {
    const overrideMap = buildAccountOverrideMap(initialEntries, accounts);
    groupIdCounter.current = 0;
    const groups = buildInitialGroups(accountGroups, groupRelations, initialEntries, accounts)
      .map((group) => ({ ...group, id: createGroupId() }));

    const draftAccounts = Array.isArray(accounts)
      ? accounts.map((account) => {
          const id = account && account.id ? String(account.id).trim() : '';
          const override = overrideMap.get(id) || {};
          const displayName =
            override.name ||
            (typeof account.displayName === 'string' && account.displayName.trim()
              ? account.displayName.trim()
              : typeof account.name === 'string' && account.name.trim()
                ? account.name.trim()
                : '');
          const parentGroup = override.parentGroup ||
            (typeof account.accountGroup === 'string' ? account.accountGroup.trim() : '');
          return {
            id,
            number: account?.number != null ? String(account.number).trim() : '',
            ownerLabel: account?.ownerLabel || account?.loginLabel || '',
            name: displayName,
            parentKey: normalizeGroupKey(parentGroup),
          };
        })
      : [];

    setGroupDrafts(groups);
    setAccountDrafts(draftAccounts);
    setOrdering(draftAccounts.map((account) => account.id));
    setStatus({ saving: false, error: null, success: null });
    setNewGroupName('');
    setShowGroupHelp(false);
  }, [accounts, accountGroups, groupRelations, initialEntries, createGroupId]);

  const groupNameByKey = useMemo(() => {
    const map = new Map();
    groupDrafts.forEach((group) => {
      if (group.key && group.name) {
        map.set(group.key, group.name);
      }
    });
    return map;
  }, [groupDrafts]);

  const accountById = useMemo(() => {
    const map = new Map();
    accountDrafts.forEach((account) => {
      if (account.id) {
        map.set(account.id, account);
      }
    });
    return map;
  }, [accountDrafts]);

  const orderingIndex = useMemo(() => {
    const map = new Map();
    ordering.forEach((id, index) => {
      map.set(id, index);
    });
    return map;
  }, [ordering]);

  const groupOptions = useMemo(() => {
    return groupDrafts
      .filter((group) => group.name)
      .map((group) => ({ key: group.key, label: group.name }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  }, [groupDrafts]);

  const buildAccountEntriesForGroup = useCallback(
    (groupKey) => {
      return accountDrafts
        .filter((account) => account.parentKey === groupKey)
        .slice()
        .sort((a, b) => {
          const orderA = orderingIndex.has(a.id) ? orderingIndex.get(a.id) : Number.MAX_SAFE_INTEGER;
          const orderB = orderingIndex.has(b.id) ? orderingIndex.get(b.id) : Number.MAX_SAFE_INTEGER;
          if (orderA !== orderB) {
            return orderA - orderB;
          }
          return a.id.localeCompare(b.id);
        });
    },
    [accountDrafts, orderingIndex]
  );

  const buildRootAccounts = useCallback(() => {
    return accountDrafts
      .filter((account) => !account.parentKey)
      .slice()
      .sort((a, b) => {
        const orderA = orderingIndex.has(a.id) ? orderingIndex.get(a.id) : Number.MAX_SAFE_INTEGER;
        const orderB = orderingIndex.has(b.id) ? orderingIndex.get(b.id) : Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) {
          return orderA - orderB;
        }
        return a.id.localeCompare(b.id);
      });
  }, [accountDrafts, orderingIndex]);

  const handleAccountNameChange = useCallback((accountId, value) => {
    setAccountDrafts((prev) =>
      prev.map((account) => (account.id === accountId ? { ...account, name: value } : account))
    );
  }, []);

  const handleAccountParentChange = useCallback((accountId, value) => {
    const normalized = normalizeGroupKey(value);
    setAccountDrafts((prev) =>
      prev.map((account) => (account.id === accountId ? { ...account, parentKey: normalized } : account))
    );
  }, []);

  const handleGroupNameChange = useCallback((groupId, groupKey, value) => {
    const nextKey = normalizeGroupKey(value);
    let shouldRekey = false;
    setGroupDrafts((prev) => {
      const exists = nextKey ? prev.some((group) => group.key === nextKey && group.id !== groupId) : false;
      shouldRekey = Boolean(nextKey && nextKey !== groupKey && !exists);
      return prev.map((group) => {
        if (group.id !== groupId) {
          return group;
        }
        if (shouldRekey) {
          return { ...group, key: nextKey, name: value };
        }
        return { ...group, name: value };
      }).map((group) => {
        if (shouldRekey && group.parentKey === groupKey) {
          return { ...group, parentKey: nextKey };
        }
        return group;
      });
    });
    if (shouldRekey) {
      setAccountDrafts((prev) =>
        prev.map((account) => (account.parentKey === groupKey ? { ...account, parentKey: nextKey } : account))
      );
    }
  }, []);

  const handleGroupParentChange = useCallback((groupId, value) => {
    const normalized = normalizeGroupKey(value);
    setGroupDrafts((prev) =>
      prev.map((group) => (group.id === groupId ? { ...group, parentKey: normalized } : group))
    );
  }, []);

  const moveAccount = useCallback(
    (accountId, direction) => {
      const account = accountById.get(accountId);
      if (!account) {
        return;
      }
      const siblings = accountDrafts
        .filter((item) => item.parentKey === account.parentKey)
        .slice()
        .sort((a, b) => {
          const orderA = orderingIndex.has(a.id) ? orderingIndex.get(a.id) : Number.MAX_SAFE_INTEGER;
          const orderB = orderingIndex.has(b.id) ? orderingIndex.get(b.id) : Number.MAX_SAFE_INTEGER;
          if (orderA !== orderB) {
            return orderA - orderB;
          }
          return a.id.localeCompare(b.id);
        });
      const currentIndex = siblings.findIndex((item) => item.id === accountId);
      if (currentIndex === -1) {
        return;
      }
      const swapIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
      if (swapIndex < 0 || swapIndex >= siblings.length) {
        return;
      }
      const swapAccount = siblings[swapIndex];
      setOrdering((prev) => {
        const next = prev.slice();
        const idxA = next.indexOf(accountId);
        const idxB = next.indexOf(swapAccount.id);
        if (idxA === -1 || idxB === -1) {
          return prev;
        }
        next[idxA] = swapAccount.id;
        next[idxB] = accountId;
        return next;
      });
    },
    [accountById, accountDrafts, orderingIndex]
  );

  const handleAddGroup = useCallback(() => {
    const trimmed = newGroupName.trim();
    if (!trimmed) {
      return;
    }
    const normalized = normalizeGroupKey(trimmed);
    const exists = groupDrafts.some((group) => group.key === normalized);
    if (exists) {
      setStatus({ saving: false, error: 'Group name already exists.', success: null });
      return;
    }
    setGroupDrafts((prev) => prev.concat([{
      id: createGroupId(),
      key: normalized,
      name: trimmed,
      parentKey: '',
    }]));
    setNewGroupName('');
    setStatus({ saving: false, error: null, success: null });
  }, [newGroupName, groupDrafts, createGroupId]);

  const validateGroups = useCallback(() => {
    const seen = new Set();
    for (const group of groupDrafts) {
      const name = group.name ? group.name.trim() : '';
      if (!name) {
        return 'Group names cannot be empty.';
      }
      const normalized = normalizeGroupKey(name);
      if (seen.has(normalized)) {
        return 'Group names must be unique.';
      }
      seen.add(normalized);
    }
    return null;
  }, [groupDrafts]);

  const handleSave = useCallback(async () => {
    if (status.saving) {
      return;
    }
    const validationError = validateGroups();
    if (validationError) {
      setStatus({ saving: false, error: validationError, success: null });
      return;
    }
    const entries = [];
    groupDrafts.forEach((group) => {
      const name = group.name ? group.name.trim() : '';
      if (!name) {
        return;
      }
      const parentName = group.parentKey ? groupNameByKey.get(group.parentKey) || '' : '';
      const entry = { name };
      if (parentName) {
        entry.accountGroup = parentName;
      }
      entries.push(entry);
    });
    ordering.forEach((accountId) => {
      const account = accountById.get(accountId);
      if (!account) {
        return;
      }
      const entry = { id: account.id };
      if (account.name && account.name.trim()) {
        entry.name = account.name.trim();
      }
      if (account.parentKey) {
        const parentName = groupNameByKey.get(account.parentKey);
        if (parentName) {
          entry.accountGroup = parentName;
        }
      }
      entries.push(entry);
    });

    setStatus({ saving: true, error: null, success: null });
    try {
      await onSave(entries);
      setStatus({ saving: false, error: null, success: 'Account labels updated.' });
      onClose();
    } catch (error) {
      const message = error && error.message ? error.message : 'Failed to save changes.';
      setStatus({ saving: false, error: message, success: null });
    }
  }, [status.saving, validateGroups, groupDrafts, ordering, accountById, groupNameByKey, onSave]);

  const groupTree = useMemo(() => buildGroupTree(groupDrafts), [groupDrafts]);
  const rootAccounts = useMemo(() => buildRootAccounts(), [buildRootAccounts]);

  const renderAccountRow = (account, depth) => {
    const parentValue = account.parentKey ? groupNameByKey.get(account.parentKey) || '' : '';
    return (
      <div key={account.id} className="account-structure-dialog__row" style={{ marginLeft: depth * 24 }}>
        <div className="account-structure-dialog__cell account-structure-dialog__cell--label">
          <span className="account-structure-dialog__badge">Account</span>
          <span className="account-structure-dialog__meta">
            {account.name || 'Unnamed account'} {account.number ? `• ${account.number}` : ''}
          </span>
          {account.ownerLabel ? (
            <span className="account-structure-dialog__meta account-structure-dialog__meta--muted">
              {account.ownerLabel}
            </span>
          ) : null}
        </div>
        <div className="account-structure-dialog__cell">
          <input
            className="account-structure-dialog__input"
            value={account.name}
            onChange={(event) => handleAccountNameChange(account.id, event.target.value)}
            placeholder="Account name"
          />
        </div>
        <div className="account-structure-dialog__cell">
          <select
            className="account-structure-dialog__select"
            value={parentValue}
            onChange={(event) => handleAccountParentChange(account.id, event.target.value)}
          >
            <option value="">No parent</option>
            {groupOptions.map((group) => (
              <option key={group.key} value={group.label}>
                {group.label}
              </option>
            ))}
          </select>
        </div>
        <div className="account-structure-dialog__cell account-structure-dialog__cell--actions">
          <button
            type="button"
            className="account-structure-dialog__icon-button"
            onClick={() => moveAccount(account.id, 'up')}
            aria-label="Move account up"
          >
            ▲
          </button>
          <button
            type="button"
            className="account-structure-dialog__icon-button"
            onClick={() => moveAccount(account.id, 'down')}
            aria-label="Move account down"
          >
            ▼
          </button>
        </div>
      </div>
    );
  };

  const renderGroupNode = (group, depth = 0) => {
    const parentValue = group.parentKey ? groupNameByKey.get(group.parentKey) || '' : '';
    return (
      <div key={group.id || group.key} className="account-structure-dialog__group">
        <div className="account-structure-dialog__row" style={{ marginLeft: depth * 24 }}>
          <div className="account-structure-dialog__cell account-structure-dialog__cell--label">
            <span className="account-structure-dialog__badge account-structure-dialog__badge--group">Group</span>
            <span className="account-structure-dialog__meta">{group.name || 'Unnamed group'}</span>
          </div>
          <div className="account-structure-dialog__cell">
            <input
              className="account-structure-dialog__input"
              value={group.name}
              onChange={(event) => handleGroupNameChange(group.id, group.key, event.target.value)}
              placeholder="Group name"
            />
          </div>
          <div className="account-structure-dialog__cell">
            <select
              className="account-structure-dialog__select"
              value={parentValue}
              onChange={(event) => handleGroupParentChange(group.id, event.target.value)}
            >
              <option value="">No parent</option>
              {groupOptions
                .filter((option) => option.key !== group.key)
                .map((option) => (
                  <option key={option.key} value={option.label}>
                    {option.label}
                  </option>
                ))}
            </select>
          </div>
          <div className="account-structure-dialog__cell account-structure-dialog__cell--actions" />
        </div>
        {group.children && group.children.length
          ? group.children.map((child) => renderGroupNode(child, depth + 1))
          : null}
        {buildAccountEntriesForGroup(group.key).map((account) => renderAccountRow(account, depth + 1))}
      </div>
    );
  };

  return (
    <div className="account-structure-overlay" role="presentation">
      <div
        className="account-structure-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className="account-structure-dialog__header">
          <div>
            <h2 id={titleId} className="account-structure-dialog__title">Account labels & groups</h2>
            <p id={descriptionId} className="account-structure-dialog__subtitle">
              Name accounts, create groups, and organize the hierarchy.
            </p>
          </div>
          <div className="account-structure-dialog__header-spacer" />
        </header>
        <div className="account-structure-dialog__body">
          {status.error ? (
            <div className="account-structure-dialog__status account-structure-dialog__status--error">
              {status.error}
            </div>
          ) : null}
          {status.success ? (
            <div className="account-structure-dialog__status account-structure-dialog__status--success">
              {status.success}
            </div>
          ) : null}
          <div className="account-structure-dialog__toolbar">
            <div className="account-structure-dialog__add-group">
              <input
                className="account-structure-dialog__input"
                value={newGroupName}
                onChange={(event) => setNewGroupName(event.target.value)}
                placeholder="New group name"
              />
              <button
                type="button"
                className="account-structure-dialog__button"
                onClick={handleAddGroup}
                disabled={!newGroupName.trim()}
              >
                Add group
              </button>
              <button
                type="button"
                className="account-structure-dialog__help-button"
                onClick={() => setShowGroupHelp(true)}
                aria-label="Learn about account groups"
              >
                ?
              </button>
            </div>
          </div>
          <div className="account-structure-dialog__table">
            <div className="account-structure-dialog__row account-structure-dialog__row--header">
              <div className="account-structure-dialog__cell account-structure-dialog__cell--label">Type</div>
              <div className="account-structure-dialog__cell">Label</div>
              <div className="account-structure-dialog__cell">Parent group</div>
              <div className="account-structure-dialog__cell account-structure-dialog__cell--actions">Order</div>
            </div>
            {groupTree.map((group) => renderGroupNode(group, 0))}
            {rootAccounts.map((account) => renderAccountRow(account, 0))}
          </div>
        </div>
        <footer className="account-structure-dialog__footer">
          <button type="button" className="account-structure-dialog__button" onClick={onClose} disabled={status.saving}>
            Discard changes
          </button>
          <button
            type="button"
            className="account-structure-dialog__button account-structure-dialog__button--primary"
            onClick={handleSave}
            disabled={status.saving}
          >
            {status.saving ? 'Saving...' : 'Save changes'}
          </button>
        </footer>
      </div>
      {showGroupHelp ? (
        <div className="account-structure-help-overlay" role="presentation">
          <div
            className="account-structure-help-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="group-help-title"
          >
            <header className="account-structure-help-dialog__header">
              <h3 id="group-help-title" className="account-structure-help-dialog__title">Account groups</h3>
            </header>
            <div className="account-structure-help-dialog__body">
              <p>
                Create groups like "RRSP", "Kids", or anything else that helps you organize accounts.
                Groups can also contain other groups. For example, "RRSP" might contain "Aggressive RRSP".
              </p>
              <p>
                To put something inside a group, set its PARENT GROUP to that group.
              </p>
            </div>
            <footer className="account-structure-help-dialog__footer">
              <button
                type="button"
                className="account-structure-dialog__button account-structure-dialog__button--primary"
                onClick={() => setShowGroupHelp(false)}
              >
                Got it
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}

AccountStructureDialog.propTypes = {
  accounts: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    number: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    accountNumber: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    displayName: PropTypes.string,
    name: PropTypes.string,
    ownerLabel: PropTypes.string,
    loginLabel: PropTypes.string,
    accountGroup: PropTypes.string,
  })),
  accountGroups: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string,
      name: PropTypes.string,
    })
  ),
  groupRelations: PropTypes.object,
  initialEntries: PropTypes.arrayOf(PropTypes.object),
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};

AccountStructureDialog.defaultProps = {
  accounts: [],
  accountGroups: [],
  groupRelations: {},
  initialEntries: [],
};
