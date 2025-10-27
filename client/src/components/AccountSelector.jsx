import { useEffect, useId, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { openAccountSummary } from '../utils/questrade';
import { buildAccountViewUrl } from '../utils/navigation';

function normalizeLabel(value) {
  if (!value) {
    return '';
  }
  return String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toFriendlyLabel(value) {
  const normalized = normalizeLabel(value);
  if (!normalized) {
    return '';
  }
  return normalized
    .split(' ')
    .map((word) => {
      if (!word) {
        return '';
      }
      const isShort = word.length <= 3;
      const isAllCaps = word === word.toUpperCase();
      if (isShort || isAllCaps) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .filter(Boolean)
    .join(' ');
}

function formatAccountType(account) {
  if (!account) {
    return null;
  }
  const rawType = account.clientAccountType || account.type;
  if (!rawType) {
    return null;
  }
  const friendly = toFriendlyLabel(rawType);
  if (!friendly) {
    return null;
  }
  if (/self[-\s]?directed/i.test(rawType)) {
    return friendly;
  }
  return `Self-directed ${friendly}`;
}

function buildPrimaryLabel(account) {
  if (!account) {
    return 'Account';
  }
  const displayName = normalizeLabel(account.displayName);
  if (displayName) {
    return displayName;
  }
  const ownerLabel = normalizeLabel(account.ownerLabel);
  if (ownerLabel) {
    return ownerLabel;
  }
  const typeLabel = toFriendlyLabel(account.clientAccountType || account.type);
  if (account.isPrimary && typeLabel) {
    return `Main ${typeLabel}`;
  }
  if (typeLabel) {
    return typeLabel;
  }
  const number = account.number ? String(account.number).trim() : '';
  if (number) {
    return `Account ${number}`;
  }
  return 'Account';
}

function labelsEqual(a, b) {
  if (!a || !b) {
    return false;
  }
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function resolveMetaLabel(account, multipleOwners, primaryLabel) {
  const ownerLabel = normalizeLabel(account && account.ownerLabel);
  if (!ownerLabel) {
    return null;
  }
  if (!primaryLabel) {
    return ownerLabel;
  }
  if (labelsEqual(ownerLabel, primaryLabel)) {
    return multipleOwners ? ownerLabel : null;
  }
  return ownerLabel;
}

function buildSecondaryLabel(account, totalAccounts) {
  if (!account) {
    if (totalAccounts > 1) {
      return `Combined across ${totalAccounts} accounts`;
    }
    return null;
  }
  const parts = [];
  const typeLabel = formatAccountType(account);
  if (typeLabel) {
    parts.push(typeLabel);
  }
  const number = account.number ? String(account.number).trim() : '';
  if (number) {
    parts.push(number);
  }
  return parts.join(' - ') || null;
}

const HIDDEN_ACCOUNT_PATTERN = /(?:not\s*used|unused)/i;

function containsHiddenKeyword(value) {
  if (value == null) {
    return false;
  }
  const stringValue = typeof value === 'string' ? value : String(value);
  return HIDDEN_ACCOUNT_PATTERN.test(stringValue);
}

function shouldHideAccountOption(option) {
  if (!option) {
    return false;
  }
  const fieldsToCheck = [
    option.primary,
    option.meta,
    option.secondary,
    option.account?.displayName,
    option.account?.ownerLabel,
    option.account?.clientAccountType,
    option.account?.type,
    option.account?.number,
    option.account?.name,
  ];
  return fieldsToCheck.some(containsHiddenKeyword);
}

function buildAccountOption(account, context) {
  if (!account) {
    return null;
  }
  const primary = buildPrimaryLabel(account);
  const meta = resolveMetaLabel(account, context.multipleOwners, primary);
  const secondary = buildSecondaryLabel(account, context.totalAccounts);
  return {
    value: account.id,
    primary,
    meta,
    secondary,
    account,
  };
}

function buildAllOption(totalAccounts, accountOptions, multipleOwners) {
  if (!totalAccounts) {
    return null;
  }
  if (totalAccounts === 1 && accountOptions.length) {
    const single = accountOptions[0];
    return {
      value: 'all',
      primary: single.primary,
      meta: single.meta,
      secondary: single.secondary,
    };
  }
  return {
    value: 'all',
    primary: 'All accounts',
    meta: multipleOwners ? 'All owners' : null,
    secondary: `Combined across ${totalAccounts} accounts`,
  };
}

function buildAccountGroupOption(group) {
  if (!group || typeof group !== 'object') {
    return null;
  }
  const id = typeof group.id === 'string' ? group.id.trim() : '';
  const name = typeof group.name === 'string' ? group.name.trim() : '';
  if (!id || !name) {
    return null;
  }
  const memberCount = Number.isFinite(group.memberCount)
    ? Math.max(0, Math.round(group.memberCount))
    : Array.isArray(group.accountIds)
      ? group.accountIds.length
      : 0;
  const normalizedOwnerLabels = Array.isArray(group.ownerLabels)
    ? Array.from(
        new Set(
          group.ownerLabels
            .map((value) => (typeof value === 'string' ? value.trim() : ''))
            .filter(Boolean)
        )
      )
    : [];
  let meta = null;
  if (normalizedOwnerLabels.length === 1) {
    meta = normalizedOwnerLabels[0];
  } else if (normalizedOwnerLabels.length > 1) {
    meta = `${normalizedOwnerLabels.length} owners`;
  }
  const secondaryParts = [];
  if (memberCount > 0) {
    secondaryParts.push(`Combined across ${memberCount} accounts`);
  }
  return {
    value: id,
    primary: name,
    meta,
    secondary: secondaryParts.join(' • ') || null,
    group,
  };
}

export default function AccountSelector({ accounts, accountGroups, groupRelations, selected, onChange, disabled }) {
  const baseReactId = useId();
  const fallbackId = useMemo(() => `account-selector-${Math.random().toString(36).slice(2)}`, []);
  const baseId = baseReactId || fallbackId;

  const containerRef = useRef(null);
  const listRef = useRef(null);

  const totalAccounts = accounts.length;
  const multipleOwners = useMemo(() => {
    const labels = new Set();
    accounts.forEach((account) => {
      if (account && account.ownerLabel) {
        labels.add(account.ownerLabel.trim().toLowerCase());
      }
    });
    return labels.size > 1;
  }, [accounts]);

  const optionsState = useMemo(() => {
    const normalize = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
    const relationsMap = new Map();
    if (groupRelations && typeof groupRelations === 'object') {
      Object.entries(groupRelations).forEach(([child, parents]) => {
        const c = normalize(child);
        const parentList = Array.isArray(parents) ? parents : [parents];
        let set = relationsMap.get(c);
        if (!set) {
          set = new Set();
          relationsMap.set(c, set);
        }
        parentList.forEach((p) => {
          const pn = normalize(p);
          if (pn) set.add(pn);
        });
      });
    }

    const isAncestor = (maybeParentName, childName) => {
      const parentKey = normalize(maybeParentName);
      const childKey = normalize(childName);
      if (!parentKey || !childKey || parentKey === childKey) {
        return false;
      }
      const seen = new Set();
      const queue = [childKey];
      while (queue.length) {
        const current = queue.shift();
        if (seen.has(current)) continue;
        seen.add(current);
        const parents = relationsMap.get(current);
        if (!parents) continue;
        if (parents.has(parentKey)) {
          return true;
        }
        parents.forEach((p) => queue.push(p));
      }
      return false;
    };

    const accountOptions = accounts
      .map((account) => buildAccountOption(account, { multipleOwners, totalAccounts }))
      .filter((option) => option && !shouldHideAccountOption(option));
    const groupOptionsRaw = Array.isArray(accountGroups)
      ? accountGroups
          .map((group) => buildAccountGroupOption(group))
          .filter((option) => option && !shouldHideAccountOption(option))
      : [];
    const groupOptions = groupOptionsRaw
      .slice()
      .sort((a, b) => {
        // Parents first: if a is ancestor of b, a comes first; if b is ancestor of a, b first.
        if (isAncestor(a.primary, b.primary)) return -1;
        if (isAncestor(b.primary, a.primary)) return 1;
        // Fallback to alphabetical
        return a.primary.localeCompare(b.primary, undefined, { sensitivity: 'base' });
      });
    const allOption = buildAllOption(totalAccounts, accountOptions, multipleOwners);
    const optionsList = [];
    if (allOption) {
      optionsList.push(allOption);
    }
    if (groupOptions.length) {
      groupOptions.forEach((option) => {
        optionsList.push(option);
      });
    }
    optionsList.push(...accountOptions);
    return {
      options: optionsList,
      accountOptions,
      groupOptions,
      allOption,
    };
  }, [accounts, accountGroups, groupRelations, multipleOwners, totalAccounts]);

  const options = optionsState.options;
  const accountOptions = optionsState.accountOptions;
  const groupOptions = optionsState.groupOptions;
  const allOption = optionsState.allOption;

  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const selectedIndex = useMemo(
    () => options.findIndex((option) => option.value === selected),
    [options, selected]
  );

  const selectedOption = useMemo(() => {
    if (!options.length) {
      return null;
    }
    const direct = options.find((option) => option.value === selected);
    if (direct) {
      return direct;
    }
    if (selected === 'all' && accountOptions.length === 1) {
      const single = accountOptions[0];
      return {
        value: 'all',
        primary: single.primary,
        meta: single.meta,
        secondary: single.secondary,
      };
    }
    return options[0];
  }, [options, selected, accountOptions]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const indexToHighlight = selectedIndex >= 0 ? selectedIndex : 0;
    setHighlightedIndex(indexToHighlight);
  }, [isOpen, selectedIndex]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    function handleClickOutside(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const listElement = listRef.current;
    if (!listElement) {
      return;
    }
    if (highlightedIndex < 0 || highlightedIndex >= listElement.children.length) {
      return;
    }
    const optionNode = listElement.children[highlightedIndex];
    if (optionNode && optionNode.scrollIntoView) {
      optionNode.scrollIntoView({ block: 'nearest' });
    }
  }, [isOpen, highlightedIndex]);

  useEffect(() => {
    if (disabled && isOpen) {
      setIsOpen(false);
    }
  }, [disabled, isOpen]);

  const handleSelect = (option, event) => {
    if (!option) {
      return;
    }

    const shouldOpenInNewTab = Boolean(
      event && (event.ctrlKey || event.metaKey || event.button === 1)
    );
    if (shouldOpenInNewTab) {
      event.preventDefault();
      event.stopPropagation();

      const targetUrl = buildAccountViewUrl(option.value);
      if (targetUrl && typeof window !== 'undefined' && typeof window.open === 'function') {
        window.open(targetUrl, '_blank', 'noopener,noreferrer');
      }
      setIsOpen(false);
      return;
    }

    if (option.value !== selected) {
      onChange(option.value);
    }
    setIsOpen(false);
  };

  const handleKeyDown = (event) => {
    if (disabled) {
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!options.length) {
        return;
      }
      if (!isOpen) {
        setIsOpen(true);
        return;
      }
      setHighlightedIndex((current) => {
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        if (current < 0) {
          return direction === 1 ? 0 : options.length - 1;
        }
        return (current + direction + options.length) % options.length;
      });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (isOpen && highlightedIndex >= 0 && highlightedIndex < options.length) {
        handleSelect(options[highlightedIndex]);
      } else {
        setIsOpen(true);
      }
      return;
    }
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
      } else if (highlightedIndex >= 0 && highlightedIndex < options.length) {
        handleSelect(options[highlightedIndex]);
      }
      return;
    }
    if (event.key === 'Escape') {
      if (isOpen) {
        event.preventDefault();
        setIsOpen(false);
      }
      return;
    }
    if (event.key === 'Home') {
      if (isOpen && options.length) {
        event.preventDefault();
        setHighlightedIndex(0);
      }
      return;
    }
    if (event.key === 'End') {
      if (isOpen && options.length) {
        event.preventDefault();
        setHighlightedIndex(options.length - 1);
      }
      return;
    }
    if (event.key === 'Tab') {
      setIsOpen(false);
    }
  };

  const displayOption =
    selectedOption ||
    allOption || {
      value: 'all',
      primary: 'All accounts',
      meta: null,
      secondary: totalAccounts > 1 ? `Combined across ${totalAccounts} accounts` : null,
    };

  const isTriggerDisabled = disabled || !options.length;

  const handleToggle = (event) => {
    if (isTriggerDisabled) {
      return;
    }
    if (event && (event.ctrlKey || event.metaKey)) {
      const account = displayOption.account;
      if (account) {
        const opened = openAccountSummary(account);
        if (opened) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
    }
    setIsOpen((value) => !value);
  };

  const listId = `${baseId}-list`;
  const activeOptionId = isOpen && highlightedIndex >= 0 ? `${baseId}-option-${highlightedIndex}` : undefined;
  const classes = ['account-selector'];
  if (isOpen) {
    classes.push('account-selector--open');
  }
  if (isTriggerDisabled) {
    classes.push('account-selector--disabled');
  }

  return (
    <div className={classes.join(' ')} ref={containerRef}>
      <button
        type="button"
        className="account-selector__trigger"
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
        disabled={isTriggerDisabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listId}
        aria-activedescendant={activeOptionId}
      >
        <div className="account-selector__value">
          {displayOption.meta && <span className="account-selector__meta">{displayOption.meta}</span>}
          <span className="account-selector__primary">{displayOption.primary}</span>
          {displayOption.secondary && (
            <span className="account-selector__secondary">{displayOption.secondary}</span>
          )}
        </div>
        <span className="account-selector__chevron" aria-hidden="true" />
      </button>

      {isOpen && (
        <div className="account-selector__dropdown">
          {options.length ? (
            <ul className="account-selector__list" role="listbox" id={listId} ref={listRef}>
              {options.map((option, index) => {
                const optionClasses = ['account-selector__option'];
                if (option.value === selected) {
                  optionClasses.push('account-selector__option--selected');
                }
                if (index === highlightedIndex) {
                  optionClasses.push('account-selector__option--highlighted');
                }
                const optionId = `${baseId}-option-${index}`;
                return (
                  <li
                    key={option.value}
                    id={optionId}
                    role="option"
                    aria-selected={option.value === selected}
                    className={optionClasses.join(' ')}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={(event) => handleSelect(option, event)}
                  >
                    <div className="account-selector__option-content">
                      {option.meta && <span className="account-selector__meta">{option.meta}</span>}
                      <span className="account-selector__primary">{option.primary}</span>
                      {option.secondary && (
                        <span className="account-selector__secondary">{option.secondary}</span>
                      )}
                    </div>
                    {option.value === selected && <span className="account-selector__check" aria-hidden="true" />}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="account-selector__empty">No accounts available</div>
          )}
        </div>
      )}
    </div>
  );
}

AccountSelector.propTypes = {
  accounts: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      number: PropTypes.string.isRequired,
      clientAccountType: PropTypes.string,
      type: PropTypes.string,
      isPrimary: PropTypes.bool,
      ownerLabel: PropTypes.string,
      ownerEmail: PropTypes.string,
      loginId: PropTypes.string,
      displayName: PropTypes.string,
      beneficiary: PropTypes.string,
      portalAccountId: PropTypes.string,
      showQQQDetails: PropTypes.bool,
    })
  ).isRequired,
  accountGroups: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string.isRequired,
      memberCount: PropTypes.number,
      accountIds: PropTypes.arrayOf(PropTypes.string),
      accountNumbers: PropTypes.arrayOf(PropTypes.string),
      ownerLabels: PropTypes.arrayOf(PropTypes.string),
    })
  ),
  groupRelations: PropTypes.object,
  selected: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  disabled: PropTypes.bool,
};

AccountSelector.defaultProps = {
  accountGroups: [],
  groupRelations: {},
  disabled: false,
};
