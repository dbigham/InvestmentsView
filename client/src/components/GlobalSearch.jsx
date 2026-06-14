import { useEffect, useId, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { getQuote } from '../api/questrade';
import { formatMoney, formatSignedPercent } from '../utils/formatters';
import { buildSymbolViewUrl, buildAccountViewUrl } from '../utils/navigation';

function normalize(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeKey(value) {
  return normalize(value).toLowerCase();
}

function normalizeSymbolKey(value) {
  return normalize(value).toUpperCase();
}

function normalizeTypedSymbolCandidate(value) {
  const candidate = normalize(value).toUpperCase();
  if (!candidate || /\s/.test(candidate)) return null;
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(candidate)) return null;
  return candidate;
}

function coerceNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function toneForChange(value) {
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return 'neutral';
}

function resolveChangePercent(quote, price) {
  const previousClose = coerceNumber(quote?.previousClose);
  if (price !== null && previousClose !== null && previousClose > 0) {
    return ((price - previousClose) / previousClose) * 100;
  }
  const directChangePercent = coerceNumber(quote?.changePercent);
  if (directChangePercent !== null) {
    return directChangePercent;
  }
  return null;
}

function getQuoteSymbolForResult(item) {
  if (!item) return null;
  if (item.kind === 'symbol') {
    return normalizeSymbolKey(item.key);
  }
  if (item.kind === 'symbol-action') {
    return normalizeSymbolKey(item.symbol || item.key);
  }
  return null;
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
  currentSymbols,
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
  const [quoteRows, setQuoteRows] = useState({});
  const quoteRequestRef = useRef(0);
  const enterQuoteLookupRef = useRef(0);

  useOutsideDismiss(containerRef, () => setOpen(false));

  // (moved below results) Ensure we reset highlighted option when opening

  const symbolItems = useMemo(() => {
    const seen = new Set();
    const list = Array.isArray(symbols) ? symbols : [];
    const items = [];
    list.forEach((entry) => {
      if (!entry) return;
      const sym = normalize(entry.symbol).toUpperCase();
      if (!sym || seen.has(sym)) return;
      seen.add(sym);
      const displayLabel = normalize(entry.label) || sym;
      const desc = normalize(entry.description);
      items.push({
        kind: 'symbol',
        key: sym,
        label: displayLabel,
        sublabel: desc || null,
      });
    });
    // Stable alphabetical for deterministic behavior
    items.sort((a, b) => a.label.localeCompare(b.label));
    return items;
  }, [symbols]);

  const currentSymbolItems = useMemo(() => {
    const seen = new Set();
    const list = Array.isArray(currentSymbols) ? currentSymbols : [];
    const items = [];
    list.forEach((entry) => {
      if (!entry) return;
      const sym = normalize(entry.symbol).toUpperCase();
      if (!sym || seen.has(sym)) return;
      seen.add(sym);
      const desc = normalize(entry.description);
      items.push({
        key: sym,
        label: normalize(entry.label) || sym,
        sublabel: desc || null,
      });
    });
    return items;
  }, [currentSymbols]);

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
    return list.map((item) => ({
      kind: 'nav',
      key: String(item.key),
      label: normalize(item.label),
      targetKey: normalizeKey(item.target || item.key) || String(item.key),
    }));
  }, [navItems]);

  const results = useMemo(() => {
    const rawQuery = typeof query === 'string' ? query : '';
    const q = normalize(rawQuery);
    if (!q) {
      return [];
    }
    // Special intent: "retire at 55" / "retirement at 55"
    const lower = q.toLowerCase();
    const prefixCandidate = rawQuery.toLowerCase().trimStart();
    let retireAction = null;
    const templateActions = [];
    const symbolActions = [];
    try {
      // Match variations like: retire at 55, retirement at 60, retire 55, retirement age 65
      const m = lower.match(/\bretire(?:ment)?(?:\s+(?:at|age))?\s*(\d{2})\b/);
      if (m && m[1]) {
        const age = Number(m[1]);
        if (Number.isFinite(age) && age >= 40 && age <= 80) {
          retireAction = {
            kind: 'action',
            key: `retire-at:${age}`,
            label: `Retire at ${age}`,
            sublabel: 'Open Projections and prefill retirement age',
          };
        }
      }
      // Provide placeholder templates when typing retire/retirement terms without a number
      const looksLikeRetire = /\bretir/.test(lower) || /\bretirement?/.test(lower);
      if (looksLikeRetire) {
        templateActions.push({
          kind: 'template',
          key: 'retire-template',
          label: 'Retire at [age]',
          sublabel: 'Type an age and press Enter',
          templateText: 'retire at ',
        });
        templateActions.push({
          kind: 'template',
          key: 'retirement-template',
          label: 'Retirement at [age]',
          sublabel: 'Type an age and press Enter',
          templateText: 'retirement at ',
        });
      }
    } catch {
      // no-op
    }

    const symbolIndex = new Map();
    symbolItems.forEach((item) => {
      if (!item || !item.key) return;
      symbolIndex.set(String(item.key).toUpperCase(), item);
    });

    const symbolActionDeduper = new Set();
    const templateDeduper = new Set();

    const pushSymbolIntentTemplate = (intent) => {
      if (templateDeduper.has(intent)) return;
      if (intent === 'orders') {
        templateActions.push({
          kind: 'template',
          key: 'orders-template',
          label: 'Orders for [symbol]',
          sublabel: 'Type a symbol or choose one of your symbols',
          templateText: 'orders for ',
        });
      } else if (intent === 'dividends') {
        templateActions.push({
          kind: 'template',
          key: 'dividends-template',
          label: 'Dividends for [symbol]',
          sublabel: 'Type a symbol or choose one of your symbols',
          templateText: 'dividends for ',
        });
      } else if (intent === 'buy') {
        templateActions.push({
          kind: 'template',
          key: 'buy-template',
          label: 'Buy [symbol]',
          sublabel: 'Type a symbol or choose one of your symbols',
          templateText: 'buy ',
        });
      } else if (intent === 'sell') {
        templateActions.push({
          kind: 'template',
          key: 'sell-template',
          label: 'Sell [symbol]',
          sublabel: 'Type a symbol or choose one of your symbols',
          templateText: 'sell ',
        });
      }
      templateDeduper.add(intent);
    };

    const pushSymbolAction = (intent, symbolItem) => {
      if (!symbolItem || !symbolItem.key) return;
      const symbolKey = String(symbolItem.key).toUpperCase();
      if (!symbolKey) return;
      const dedupeKey = `${intent}:${symbolKey}`;
      if (symbolActionDeduper.has(dedupeKey)) return;
      symbolActionDeduper.add(dedupeKey);
      const description = symbolItem.sublabel || null;
      if (intent === 'orders') {
        symbolActions.push({
          kind: 'symbol-action',
          key: `symbol-orders:${symbolKey}`,
          label: `Orders for ${symbolKey}`,
          sublabel: 'View Orders tab for this symbol',
          symbol: symbolKey,
          symbolDescription: description,
          targetTab: 'orders',
          intent: 'orders',
        });
      } else if (intent === 'dividends') {
        symbolActions.push({
          kind: 'symbol-action',
          key: `symbol-dividends:${symbolKey}`,
          label: `Dividends for ${symbolKey}`,
          sublabel: 'View Dividends tab for this symbol',
          symbol: symbolKey,
          symbolDescription: description,
          targetTab: 'dividends',
          intent: 'dividends',
        });
      } else if (intent === 'buy' || intent === 'sell') {
        symbolActions.push({
          kind: 'symbol-action',
          key: `symbol-${intent}:${symbolKey}`,
          label: `${intent === 'buy' ? 'Buy' : 'Sell'} ${symbolKey}`,
          sublabel: 'Open buy/sell flow for this symbol',
          symbol: symbolKey,
          symbolDescription: description,
          targetTab: null,
          intent,
        });
      }
    };

    const findSymbolSuggestions = (fragment) => {
      const normalizedFragment = normalize(fragment);
      if (!normalizedFragment) return [];
      const compact = normalizedFragment.replace(/\s+/g, '');
      if (!compact) return [];
      const bare = compact.replace(/[^a-z0-9]/gi, '');
      const withScores = symbolItems
        .map((item) => {
          const label = String(item.label || '');
          const baseScore = scoreMatch(label, compact);
          const bareLabel = label.replace(/[^a-z0-9]/gi, '');
          const bareScore = bare ? scoreMatch(bareLabel, bare) : -1;
          const score = Math.max(baseScore, bareScore);
          return { item, score };
        })
        .filter((entry) => entry.score >= 45)
        .sort((a, b) => b.score - a.score);
      return withScores.slice(0, 5).map((entry) => entry.item);
    };

    const matchSymbolIntent = (intent, regex, fragmentIndex = 1) => {
      const match = lower.match(regex);
      if (!match) return;
      const fragment = match[fragmentIndex] || '';
      collectSymbolIntentMatches(intent, fragment);
    };

    const matchesIntentCue = (candidate, forms) => {
      if (!candidate) return false;
      return forms.some((form) => form.startsWith(candidate) || candidate.startsWith(form));
    };

    const collectSymbolIntentMatches = (intent, fragment) => {
      const normalizedFragment = normalize(fragment);
      if (!normalizedFragment) return;
      const compact = normalizedFragment.replace(/\s+/g, '');
      if (compact) {
        const up = compact.toUpperCase();
        if (symbolIndex.has(up)) {
          pushSymbolAction(intent, symbolIndex.get(up));
        }
      }
      findSymbolSuggestions(fragment).forEach((item) => pushSymbolAction(intent, item));
    };

    const matchSymbolLeadingIntent = (intent, forms) => {
      const trimmed = rawQuery.trimStart();
      if (!trimmed) return;
      const match = trimmed.match(/^([-a-z0-9.]+)(?:\s+(.*))?$/i);
      if (!match) return;
      const symbolFragment = match[1] || '';
      const remainderRaw = match[2];
      if (!remainderRaw) return;
      const candidate = normalize(remainderRaw).toLowerCase();
      if (!candidate) return;
      if (!matchesIntentCue(candidate, forms)) return;
      collectSymbolIntentMatches(intent, symbolFragment);
    };

    const intentPrefixes = [
      { intent: 'orders', forms: ['orders', 'order', 'orders for', 'order for'] },
      { intent: 'dividends', forms: ['dividends', 'dividend', 'dividends for', 'dividend for'] },
      { intent: 'buy', forms: ['buy'] },
      { intent: 'sell', forms: ['sell'] },
    ];

    intentPrefixes.forEach(({ intent, forms }) => {
      if (matchesIntentCue(prefixCandidate, forms)) {
        pushSymbolIntentTemplate(intent);
      }
    });

    matchSymbolIntent('orders', /^orders?\s+for(?:\s+([-a-z0-9.]*))?\s*$/);
    matchSymbolIntent('dividends', /^dividends?\s+for(?:\s+([-a-z0-9.]*))?\s*$/);
    matchSymbolIntent('buy', /^buy(?:\s+([-a-z0-9.]*))?\s*$/);
    matchSymbolIntent('sell', /^sell(?:\s+([-a-z0-9.]*))?\s*$/);

    matchSymbolLeadingIntent('orders', ['orders', 'order']);
    matchSymbolLeadingIntent('dividends', ['dividends', 'dividend']);

    const parseGrowthCurveSymbolList = (fragment) => {
      const normalizedFragment = normalize(fragment);
      if (!normalizedFragment) return [];
      const withCommaSeparators = normalizedFragment
        .replace(/\s+(?:and)\s+/gi, ',')
        .replace(/[+&]/g, ',');
      const parts = withCommaSeparators.includes(',')
        ? withCommaSeparators.split(',')
        : withCommaSeparators.split(/\s+/);
      const seen = new Set();
      const parsed = [];
      parts.forEach((part) => {
        const symbol = normalizeTypedSymbolCandidate(part);
        if (!symbol || seen.has(symbol)) return;
        seen.add(symbol);
        parsed.push(symbol);
      });
      return parsed;
    };

    const resolveContextualGrowthCurveSymbols = (fragment) => {
      const normalizedFragment = normalize(fragment).toLowerCase();
      if (!normalizedFragment) return null;
      const contextPattern =
        /^(?:(?:the|my)\s+)?(?:(?:this|current|selected)\s+)?(?:account|portfolio|holdings|positions|stocks|symbols|securities)$|^(?:these|those)\s+(?:stocks|symbols|holdings|positions|securities)$/i;
      if (!contextPattern.test(normalizedFragment)) {
        return null;
      }
      const seen = new Set();
      return currentSymbolItems.reduce((acc, item) => {
        const symbol = normalizeTypedSymbolCandidate(item?.key);
        if (!symbol || seen.has(symbol)) return acc;
        seen.add(symbol);
        acc.push(symbol);
        return acc;
      }, []);
    };

    const buildGrowthCurvesResult = () => {
      const match = rawQuery.match(/^\s*growth\s+curves?\s+for\s+(.+?)\s*$/i);
      if (!match) {
        return null;
      }
      const contextualSymbols = resolveContextualGrowthCurveSymbols(match[1]);
      const symbols = contextualSymbols || parseGrowthCurveSymbolList(match[1]);
      if (!symbols.length) {
        return null;
      }
      const descriptions = {};
      symbols.forEach((symbol) => {
        const contextual = currentSymbolItems.find((item) => item.key === symbol);
        const indexed = contextual || symbolIndex.get(symbol);
        if (indexed?.sublabel) {
          descriptions[symbol] = indexed.sublabel;
        }
      });
      const contextual = Array.isArray(contextualSymbols);
      return {
        kind: 'growth-curves',
        key: symbols.join('|'),
        label: contextual
          ? `Growth curve${symbols.length === 1 ? '' : 's'} for current account`
          : `Growth curve${symbols.length === 1 ? '' : 's'} for ${symbols.join(' + ')}`,
        sublabel: contextual
          ? `Compare price history fits for ${symbols.length} current holding${symbols.length === 1 ? '' : 's'}`
          : 'Compare price history fits by stock',
        symbols,
        descriptions,
      };
    };

    const buildMultiSymbolResult = () => {
      const separatorPattern = /(?:\s*\+\s*|\s*,\s*|\s+and\s+|\s*&\s*)/i;
      if (!separatorPattern.test(rawQuery)) {
        return null;
      }
      const tokens = rawQuery
        .split(separatorPattern)
        .map((part) => normalize(part).toUpperCase())
        .filter(Boolean);
      const uniqueTokens = Array.from(new Set(tokens));
      if (uniqueTokens.length < 2) {
        return null;
      }
      const resolved = [];
      uniqueTokens.forEach((token) => {
        if (symbolIndex.has(token)) {
          resolved.push(symbolIndex.get(token));
          return;
        }
        const suggestion = findSymbolSuggestions(token)[0];
        if (suggestion) {
          resolved.push(suggestion);
        }
      });
      const deduped = [];
      const seenSymbols = new Set();
      resolved.forEach((item) => {
        const key = normalize(item?.key).toUpperCase();
        if (!key || seenSymbols.has(key)) return;
        seenSymbols.add(key);
        deduped.push(item);
      });
      if (deduped.length < 2) {
        return null;
      }
      const symbols = deduped.map((item) => item.key);
      const labelCore = symbols.join(' + ');
      const sublabelParts = deduped
        .map((item) => item.sublabel || null)
        .filter(Boolean);
      const sublabel =
        sublabelParts.length > 0
          ? `Includes: ${sublabelParts.slice(0, 2).join(' | ')}${
              sublabelParts.length > 2 ? '...' : ''
            }`
          : 'View combined symbols';
      return {
        kind: 'symbol-list',
        key: symbols.join('|'),
        label: `Symbols: ${labelCore}`,
        displayLabel: labelCore,
        sublabel,
        symbols,
      };
    };

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
      } else if (item.kind === 'action') {
        // Intent actions should be quite prominent when query hints at them
        boost += 25;
      } else if (item.kind === 'symbol-action') {
        boost += 35;
      } else if (item.kind === 'symbol-list') {
        boost += 30;
      } else if (item.kind === 'growth-curves') {
        boost += 45;
      } else if (item.kind === 'template') {
        // Template suggestions also prominent while composing
        boost += 20;
      }
      return base + boost;
    };
    const growthCurvesResult = buildGrowthCurvesResult();
    const multiSymbolResult = buildMultiSymbolResult();
    const specialResults = [growthCurvesResult, multiSymbolResult].filter(Boolean);
    const poolBase = specialResults.length
      ? [...specialResults, ...symbolItems, ...accountItems, ...groupItems, ...navItemsNormalized]
      : [...symbolItems, ...accountItems, ...groupItems, ...navItemsNormalized];
    const pool = retireAction
      ? [retireAction, ...templateActions, ...symbolActions, ...poolBase]
      : [...templateActions, ...symbolActions, ...poolBase];
    const withScores = pool
      .map((item) => ({ item, score: rank(item) }))
      .filter((e) => e.score >= 0)
      .sort((a, b) => b.score - a.score);

    const resolveTargetKey = (item) => {
      if (!item) return null;
      const baseKey = String(item.key ?? '').trim();
      if (!baseKey) return null;
      if (item.kind === 'nav') {
        const target = typeof item.targetKey === 'string' ? item.targetKey : baseKey;
        return `nav:${target}`;
      }
      if (item.kind === 'symbol-action') {
        return `symbol-action:${baseKey}`;
      }
      if (item.kind === 'template') {
        return `template:${baseKey}`;
      }
      if (item.kind === 'symbol') {
        return `symbol:${baseKey.toUpperCase()}`;
      }
      if (item.kind === 'symbol-list') {
        return `symbol-list:${baseKey}`;
      }
      if (item.kind === 'growth-curves') {
        return `growth-curves:${baseKey}`;
      }
      if (item.kind === 'account' || item.kind === 'group') {
        return `${item.kind}:${baseKey}`;
      }
      if (item.kind === 'action') {
        return `action:${baseKey}`;
      }
      return `${item.kind || 'item'}:${baseKey}`;
    };

    const seenTargets = new Set();
    const deduped = [];
    for (const entry of withScores) {
      const targetKey = resolveTargetKey(entry.item);
      if (targetKey && seenTargets.has(targetKey)) {
        continue;
      }
      if (targetKey) {
        seenTargets.add(targetKey);
      }
      deduped.push(entry.item);
      if (deduped.length >= 10) {
        break;
      }
    }
    return deduped;
  }, [query, symbolItems, currentSymbolItems, accountItems, groupItems, navItemsNormalized]);

  const visibleQuoteSymbols = useMemo(() => {
    if (!open || !results.length) {
      return [];
    }
    const seen = new Set();
    const list = [];
    results.forEach((item) => {
      const symbol = getQuoteSymbolForResult(item);
      if (!symbol || seen.has(symbol)) return;
      seen.add(symbol);
      list.push(symbol);
    });
    return list;
  }, [open, results]);

  useEffect(() => {
    quoteRequestRef.current += 1;
    const requestId = quoteRequestRef.current;

    if (!visibleQuoteSymbols.length) {
      setQuoteRows({});
      return undefined;
    }

    setQuoteRows({});

    const timer = setTimeout(() => {
      setQuoteRows((prev) => {
        const next = {};
        visibleQuoteSymbols.forEach((symbol) => {
          next[symbol] = prev[symbol]?.status === 'success'
            ? { ...prev[symbol], status: 'loading' }
            : { status: 'loading', data: null, error: null };
        });
        return next;
      });

      visibleQuoteSymbols.forEach((symbol) => {
        getQuote(symbol, { force: true })
          .then((quote) => {
            if (quoteRequestRef.current !== requestId) return;
            const price = coerceNumber(quote?.price);
            const normalizedPrice = price !== null && price > 0 ? price : null;
            const changePercent = resolveChangePercent(quote, normalizedPrice);
            setQuoteRows((prev) => ({
              ...prev,
              [symbol]: {
                status: 'success',
                data: {
                  price: normalizedPrice,
                  currency:
                    typeof quote?.currency === 'string' && quote.currency.trim()
                      ? quote.currency.trim().toUpperCase()
                      : null,
                  changePercent,
                },
                error: null,
              },
            }));
          })
          .catch((error) => {
            if (quoteRequestRef.current !== requestId) return;
            setQuoteRows((prev) => ({
              ...prev,
              [symbol]: { status: 'error', data: null, error },
            }));
          });
      });
    }, 500);

    return () => {
      clearTimeout(timer);
    };
  }, [visibleQuoteSymbols]);

  // Ensure we reset the highlighted option to the first item whenever
  // the list opens (after having been closed), so pressing Enter
  // acts on the first visible result by default.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setHighlightedIndex(results.length ? 0 : -1);
    }
    wasOpenRef.current = open;
  }, [open, results]);

  useEffect(() => {
    if (!open) return;
    if (highlightedIndex >= 0 && highlightedIndex < results.length) return;
    // Highlight first result by default when opening
    setHighlightedIndex(results.length ? 0 : -1);
  }, [open, results, highlightedIndex]);

  const listboxId = `${baseId}-list`;

  const findExactQueryMatch = (rawValue) => {
    const exact = normalize(rawValue);
    if (!exact) return null;
    const exactLower = exact.toLowerCase();
    const exactSymbol = exact.toUpperCase();
    return results.find((item) => {
      if (!item) return false;
      if (item.kind === 'symbol') {
        return normalizeSymbolKey(item.key) === exactSymbol;
      }
      if (item.kind === 'account' || item.kind === 'group' || item.kind === 'nav') {
        return (
          normalizeKey(item.label) === exactLower ||
          normalizeKey(item.key) === exactLower ||
          normalizeKey(item.targetKey) === exactLower
        );
      }
      return false;
    }) || null;
  };

  const handleSelect = (item) => {
    if (!item) return;
    // Handle templates by inserting placeholder text and keeping focus
    if (item.kind === 'template' && item.templateText) {
      const next = String(item.templateText);
      setQuery(next);
      setOpen(true);
      try {
        if (inputRef.current && typeof inputRef.current.focus === 'function') {
          inputRef.current.focus();
          // Move caret to end on next tick
          const len = next.length;
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
              try { inputRef.current.setSelectionRange(len, len); } catch { /* ignore */ }
            });
          } else {
            setTimeout(() => {
              try { inputRef.current.setSelectionRange(len, len); } catch { /* ignore */ }
            }, 0);
          }
        }
      } catch {
        // ignore caret errors
      }
      return;
    }
    setOpen(false);
    setQuery('');
    if (item.kind === 'symbol-action') {
      if (typeof onSelectSymbol === 'function' && item.symbol) {
        onSelectSymbol(item.symbol, {
          description: item.symbolDescription || item.sublabel || null,
          targetTab: item.targetTab || null,
          intent: item.intent || null,
        });
      }
      if (
        typeof onNavigate === 'function' &&
        (item.intent === 'orders' || item.intent === 'dividends')
      ) {
        onNavigate(item.intent);
      }
    } else if (item.kind === 'symbol-list' && typeof onSelectSymbol === 'function') {
      const symbols = Array.isArray(item.symbols) ? item.symbols : [];
      const primary = symbols[0] || item.key;
      onSelectSymbol(primary, {
        description: item.sublabel || null,
        symbols,
        label: item.displayLabel || item.label || null,
      });
    } else if (item.kind === 'growth-curves' && typeof onSelectSymbol === 'function') {
      const symbols = Array.isArray(item.symbols) ? item.symbols : [];
      const primary = symbols[0] || item.key;
      onSelectSymbol(primary, {
        symbols,
        descriptions: item.descriptions || {},
        label: item.label || null,
        growthCurves: true,
        intent: 'growth-curves',
      });
    } else if (item.kind === 'symbol' && typeof onSelectSymbol === 'function') {
      onSelectSymbol(item.key, { description: item.sublabel || null });
    } else if (item.kind === 'account' && typeof onSelectAccount === 'function') {
      onSelectAccount(item.key);
    } else if (item.kind === 'group' && typeof onSelectAccount === 'function') {
      onSelectAccount(item.key);
    } else if (item.kind === 'nav' && typeof onNavigate === 'function') {
      onNavigate(item.key);
    } else if (item.kind === 'action' && typeof onNavigate === 'function') {
      // Route intent-like actions through onNavigate with a distinct key
      onNavigate(item.key);
    }
  };

  const handleEnter = async () => {
    const exactMatch = findExactQueryMatch(query);
    if (exactMatch) {
      handleSelect(exactMatch);
      return;
    }

    const typedSymbol = normalizeTypedSymbolCandidate(query);
    if (typedSymbol && typeof onSelectSymbol === 'function') {
      const lookupId = enterQuoteLookupRef.current + 1;
      enterQuoteLookupRef.current = lookupId;
      try {
        const quote = await getQuote(typedSymbol, { force: true });
        if (enterQuoteLookupRef.current !== lookupId) {
          return;
        }
        const price = coerceNumber(quote?.price);
        const quoteSymbol =
          normalizeSymbolKey(quote?.symbol || quote?.requestedSymbol || typedSymbol) || typedSymbol;
        if (price !== null && price > 0 && quoteSymbol === typedSymbol) {
          setOpen(false);
          setQuery('');
          onSelectSymbol(typedSymbol, {
            description: normalize(quote?.name || quote?.shortName || quote?.longName) || null,
            externalSymbol: true,
            priceOnly: true,
          });
          return;
        }
      } catch {
        // Fall through to the best visible result below.
      }
    }

    const item = results[highlightedIndex] || results[0];
    handleSelect(item);
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
      handleEnter();
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
              const quoteSymbol = getQuoteSymbolForResult(item);
              const quoteRow = quoteSymbol ? quoteRows[quoteSymbol] : null;
              const quoteData = quoteRow?.data || null;
              const quoteChangeTone = quoteData ? toneForChange(quoteData.changePercent) : 'neutral';
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
                  <div className="global-search__row">
                    <div className="global-search__main">
                      <div className="global-search__label">
                        {item.label}
                        {item.kind === 'symbol' ? <span className="global-search__badge">SYM</span> : null}
                        {item.kind === 'nav' ? <span className="global-search__badge">NAV</span> : null}
                        {item.kind === 'account' ? <span className="global-search__badge">ACCT</span> : null}
                        {item.kind === 'group' ? <span className="global-search__badge">GROUP</span> : null}
                        {item.kind === 'action' ? <span className="global-search__badge">ACTION</span> : null}
                        {item.kind === 'symbol-action' ? (
                          <span className="global-search__badge">ACTION</span>
                        ) : null}
                        {item.kind === 'growth-curves' ? (
                          <span className="global-search__badge">CURVE</span>
                        ) : null}
                        {item.kind === 'template' ? <span className="global-search__badge">TPL</span> : null}
                      </div>
                      {item.sublabel ? (
                        <div className="global-search__sublabel">{item.sublabel}</div>
                      ) : null}
                    </div>
                    {quoteSymbol ? (
                      <div className="global-search__quote" aria-live="polite">
                        {quoteRow?.status === 'loading' ? (
                          <span className="global-search__quote-loading">Loading...</span>
                        ) : quoteRow?.status === 'success' && quoteData?.price ? (
                          <>
                            <span className="global-search__quote-price">
                              {formatMoney(quoteData.price)}
                              {quoteData.currency ? (
                                <span className="global-search__quote-currency"> {quoteData.currency}</span>
                              ) : null}
                            </span>
                            <span
                              className={`global-search__quote-change global-search__quote-change--${quoteChangeTone}`}
                            >
                              {formatSignedPercent(quoteData.changePercent)}
                            </span>
                          </>
                        ) : quoteRow?.status === 'error' ? (
                          <span className="global-search__quote-loading">Unavailable</span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
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
  currentSymbols: PropTypes.arrayOf(
    PropTypes.shape({
      symbol: PropTypes.string,
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
    PropTypes.shape({
      key: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      target: PropTypes.string,
    })
  ),
  placeholder: PropTypes.string,
  onSelectSymbol: PropTypes.func,
  onSelectAccount: PropTypes.func,
  onNavigate: PropTypes.func,
};

GlobalSearch.defaultProps = {
  symbols: [],
  currentSymbols: [],
  accounts: [],
  accountGroups: [],
  navItems: undefined,
  placeholder: 'Search symbols, accounts, or pages…',
  onSelectSymbol: undefined,
  onSelectAccount: undefined,
  onNavigate: undefined,
};
