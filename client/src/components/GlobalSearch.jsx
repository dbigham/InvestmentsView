import { useEffect, useId, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { buildSymbolViewUrl, buildAccountViewUrl } from '../utils/navigation';

function normalize(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeKey(value) {
  return normalize(value).toLowerCase();
}

function useOutsideDismiss(ref, onDismiss) {
  useEffect(() => {
    if (!ref.current) return undefined;
    const handlePointer = (event) => {
      if (!ref.current) return;
      if (ref.current.contains(event.target)) return;
      onDismiss?.();
    };
    const handleKey = (event) => {
      if (event.key === 'Escape') {
        onDismiss?.();
      }
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('touchstart', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('touchstart', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [ref, onDismiss]);
}

function scoreMatch(haystack, needle) {
  // Higher is better
  const h = normalizeKey(haystack);
  const n = normalizeKey(needle);
  if (!n) return 0;
  if (!h) return -1;
  if (h === n) return 100;
  if (h.startsWith(n)) return 80;
  if (h.includes(n)) return 60;
  // Split into words for partials
  const words = h.split(/[^a-z0-9]+/g).filter(Boolean);
  if (words.some((w) => w.startsWith(n))) return 55;
  if (words.some((w) => w.includes(n))) return 45;
  return -1;
}

export default function GlobalSearch({
  symbols,
  accounts,
  accountGroups,
  navItems,
  placeholder = 'Search symbols, accounts, or pages…',
  onSelectSymbol,
  onSelectAccount,
  onNavigate,
}) {
  const baseId = useId() || `global-search-${Math.random().toString(36).slice(2)}`;
  const containerRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  useOutsideDismiss(containerRef, () => setOpen(false));

  const symbolItems = useMemo(() => {
    const seen = new Set();
    const list = Array.isArray(symbols) ? symbols : [];
    const items = [];
    list.forEach((entry) => {
      if (!entry) return;
      const sym = normalize(entry.symbol).toUpperCase();
      if (!sym || seen.has(sym)) return;
      seen.add(sym);
      const desc = normalize(entry.description);
      items.push({
        kind: 'symbol',
        key: sym,
        label: sym,
        sublabel: desc || null,
      });
    });
    // Stable alphabetical for deterministic behavior
    items.sort((a, b) => a.label.localeCompare(b.label));
    return items;
  }, [symbols]);

  const accountItems = useMemo(() => {
    const list = Array.isArray(accounts) ? accounts : [];
    return list
      .map((acct) => {
        if (!acct || !acct.id) return null;
        const primary = normalize(
          acct.displayName || acct.name || acct.number || acct.id
        );
        const owner = normalize(acct.ownerLabel || acct.loginLabel);
        const number = normalize(acct.number);
        const type = normalize(acct.clientAccountType || acct.type);
        const label = primary || number || acct.id;
        const sub = [number && number !== label ? number : null, owner || null, type || null]
          .filter(Boolean)
          .join(' • ');
        return { kind: 'account', key: String(acct.id), label, sublabel: sub || null };
      })
      .filter(Boolean);
  }, [accounts]);

  const groupItems = useMemo(() => {
    const list = Array.isArray(accountGroups) ? accountGroups : [];
    return list
      .map((group) => {
        if (!group || !group.id || !group.name) return null;
        const label = normalize(group.name);
        const count = Number.isFinite(group.memberCount) ? group.memberCount : null;
        const sub = count !== null ? `${count} account${count === 1 ? '' : 's'}` : null;
        return { kind: 'group', key: String(group.id), label, sublabel: sub };
      })
      .filter(Boolean)
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [accountGroups]);

  const navItemsNormalized = useMemo(() => {
    const defaults = [
      { key: 'positions', label: 'Positions' },
      { key: 'orders', label: 'Orders' },
      { key: 'dividends', label: 'Dividends' },
      { key: 'total-pnl', label: 'Total P&L' },
      { key: 'projections', label: 'Projections' },
      { key: 'retirement-projections', label: 'Retirement Projections' },
      { key: 'deployment', label: 'Deployment' },
    ];
    const custom = Array.isArray(navItems) ? navItems : [];
    const list = custom.length ? custom : defaults;
    return list.map((item) => ({ kind: 'nav', key: String(item.key), label: normalize(item.label) }));
  }, [navItems]);

  const results = useMemo(() => {
    const q = normalize(query);
    if (!q) {
      return [];
    }
    const rank = (item) => {
      if (!item) return -1;
      const base = scoreMatch(item.label, q);
      let boost = 0;
      if (item.kind === 'symbol') {
        boost += item.label.toLowerCase() === q.toLowerCase() ? 20 : 0;
        if (item.sublabel) boost = Math.max(boost, scoreMatch(item.sublabel, q) - 5);
      } else if (item.kind === 'account') {
        boost += 5;
        if (item.sublabel) boost = Math.max(boost, scoreMatch(item.sublabel, q) - 5);
      } else if (item.kind === 'group') {
        boost += 5;
        if (item.sublabel) boost = Math.max(boost, scoreMatch(item.sublabel, q) - 5);
      } else if (item.kind === 'nav') {
        boost += 10; // nav is short keyword-like terms
      }
      return base + boost;
    };
    const pool = [...symbolItems, ...accountItems, ...groupItems, ...navItemsNormalized];
    const withScores = pool
      .map((item) => ({ item, score: rank(item) }))
      .filter((e) => e.score >= 0)
      .sort((a, b) => b.score - a.score);
    const top = withScores.slice(0, 10).map((e) => e.item);
    return top;
  }, [query, symbolItems, accountItems, groupItems, navItemsNormalized]);

  useEffect(() => {
    if (!open) return;
    if (highlightedIndex >= 0 && highlightedIndex < results.length) return;
    // Highlight first result by default when opening
    setHighlightedIndex(results.length ? 0 : -1);
  }, [open, results, highlightedIndex]);

  const listboxId = `${baseId}-list`;

  const handleSelect = (item) => {
    if (!item) return;
    setOpen(false);
    setQuery('');
    if (item.kind === 'symbol' && typeof onSelectSymbol === 'function') {
      onSelectSymbol(item.key, { description: item.sublabel || null });
    } else if (item.kind === 'account' && typeof onSelectAccount === 'function') {
      onSelectAccount(item.key);
    } else if (item.kind === 'group' && typeof onSelectAccount === 'function') {
      onSelectAccount(item.key);
    } else if (item.kind === 'nav' && typeof onNavigate === 'function') {
      onNavigate(item.key);
    }
  };

  const handleOptionMouseDown = (event, item) => {
    // Prevent input losing focus when clicking options
    // Also handle middle-click new tab behavior for symbols
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    if (!item) return;
    if (event && event.button === 1) {
      // Middle-click behavior: open appropriate target in new tab
      let targetUrl = null;
      if (item.kind === 'symbol') {
        targetUrl = buildSymbolViewUrl(item.key);
      } else if (item.kind === 'account' || item.kind === 'group') {
        targetUrl = buildAccountViewUrl(item.key);
      }
      if (targetUrl && typeof window !== 'undefined' && typeof window.open === 'function') {
        if (typeof event.stopPropagation === 'function') event.stopPropagation();
        window.open(targetUrl, '_blank', 'noopener,noreferrer');
      }
    }
  };

  const handleOptionClick = (event, item) => {
    if (!item) return;
    if (event && (event.ctrlKey || event.metaKey)) {
      // Ctrl/Cmd click -> open in new tab for symbols, accounts, and groups
      let targetUrl = null;
      if (item.kind === 'symbol') {
        targetUrl = buildSymbolViewUrl(item.key);
      } else if (item.kind === 'account' || item.kind === 'group') {
        targetUrl = buildAccountViewUrl(item.key);
      }
      if (targetUrl && typeof window !== 'undefined' && typeof window.open === 'function') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (typeof event.stopPropagation === 'function') event.stopPropagation();
        window.open(targetUrl, '_blank', 'noopener,noreferrer');
      }
      return;
    }
    handleSelect(item);
  };

  const handleKeyDown = (event) => {
    if (!open && (event.key === 'ArrowDown' || event.key === 'Enter')) {
      if (normalize(query)) {
        setOpen(true);
      }
      return;
    }
    if (!open) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightedIndex((i) => (results.length ? Math.min(results.length - 1, i + 1) : -1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedIndex((i) => (results.length ? Math.max(0, i - 1) : -1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = results[highlightedIndex] || results[0];
      handleSelect(item);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  const classes = ['global-search'];
  if (open) classes.push('global-search--open');

  return (
    <div className={classes.join(' ')} ref={containerRef}>
      <div className="global-search__input-wrap">
        <span className="global-search__icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.6" />
            <path d="M20 20L16.65 16.65" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
        <input
          ref={inputRef}
          type="search"
          className="global-search__input"
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            const v = e.target.value;
            setQuery(v);
            setOpen(Boolean(normalize(v)));
          }}
          onFocus={() => { /* require typing to open */ }}
          onKeyDown={handleKeyDown}
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-autocomplete="list"
          role="combobox"
        />
      </div>
      {open && results.length > 0 && (
        <ul className="global-search__list" role="listbox" id={listboxId} ref={listRef}>
          {results.length ? (
            results.map((item, index) => {
              const id = `${baseId}-opt-${index}`;
              const classes = ['global-search__option'];
              if (index === highlightedIndex) classes.push('global-search__option--active');
              return (
                <li
                  key={`${item.kind}:${item.key}:${index}`}
                  id={id}
                  className={classes.join(' ')}
                  role="option"
                  aria-selected={index === highlightedIndex}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  onMouseDown={(e) => handleOptionMouseDown(e, item)}
                  onClick={(e) => handleOptionClick(e, item)}
                >
                  <div className="global-search__label">
                    {item.label}
                    {item.kind === 'symbol' ? <span className="global-search__badge">SYM</span> : null}
                    {item.kind === 'nav' ? <span className="global-search__badge">NAV</span> : null}
                    {item.kind === 'account' ? <span className="global-search__badge">ACCT</span> : null}
                    {item.kind === 'group' ? <span className="global-search__badge">GROUP</span> : null}
                  </div>
                  {item.sublabel ? (
                    <div className="global-search__sublabel">{item.sublabel}</div>
                  ) : null}
                </li>
              );
            })
          ) : (
            <li className="global-search__empty">No matches</li>
          )}
        </ul>
      )}
    </div>
  );
}

GlobalSearch.propTypes = {
  symbols: PropTypes.arrayOf(
    PropTypes.shape({
      symbol: PropTypes.string.isRequired,
      description: PropTypes.string,
    })
  ),
  accounts: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      number: PropTypes.string,
      displayName: PropTypes.string,
      name: PropTypes.string,
      clientAccountType: PropTypes.string,
      type: PropTypes.string,
      ownerLabel: PropTypes.string,
      loginLabel: PropTypes.string,
    })
  ),
  accountGroups: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string.isRequired,
      memberCount: PropTypes.number,
    })
  ),
  navItems: PropTypes.arrayOf(
    PropTypes.shape({ key: PropTypes.string.isRequired, label: PropTypes.string.isRequired })
  ),
  placeholder: PropTypes.string,
  onSelectSymbol: PropTypes.func,
  onSelectAccount: PropTypes.func,
  onNavigate: PropTypes.func,
};

GlobalSearch.defaultProps = {
  symbols: [],
  accounts: [],
  accountGroups: [],
  navItems: undefined,
  placeholder: 'Search symbols, accounts, or pages…',
  onSelectSymbol: undefined,
  onSelectAccount: undefined,
  onNavigate: undefined,
};
