import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { classifyPnL, formatMoney, formatNumber, formatSignedMoney, formatSignedPercent } from '../utils/formatters';
import { buildQuoteUrl, openQuote } from '../utils/quotes';
import { copyTextToClipboard } from '../utils/clipboard';
import { openChatGpt } from '../utils/chat';
import { normalizeSymbolKey as normalizeSymbolGroupKey } from '../../../shared/symbolGroups.js';
import { resolveSymbolAnnualizedEntry } from '../utils/annualized.js';
import {
  buildExplainMovementPrompt,
  derivePercentages,
  formatQuantity,
  formatShare,
  resolveAccountForPosition,
  resolveTotalCost,
} from '../utils/positions';
// Logo column uses Logo.dev ticker endpoint when a publishable key is present

const TABLE_HEADERS = [
  {
    key: 'logo',
    label: '',
    className: 'positions-table__head--logo',
    sortType: 'text',
    accessor: (row) => row.symbol || '',
  },
  {
    key: 'symbol',
    label: 'Symbol',
    className: 'positions-table__head--symbol',
    sortType: 'text',
    accessor: (row) => row.symbol || '',
  },
  {
    key: 'dayPnl',
    label: "Today's P&L",
    className: 'positions-table__head--numeric',
    sortType: 'number',
    accessor: (row) => row.dayPnl ?? 0,
  },
  {
    key: 'openPnl',
    label: 'Open P&L',
    className: 'positions-table__head--numeric',
    sortType: 'number',
    accessor: (row) => row.openPnl ?? 0,
  },
  {
    key: 'openQuantity',
    label: 'Open qty',
    className: 'positions-table__head--numeric',
    sortType: 'number',
    accessor: (row) => row.openQuantity ?? 0,
  },
  {
    key: 'averageEntryPrice',
    label: 'Avg price',
    className: 'positions-table__head--numeric',
    sortType: 'number',
    accessor: (row) => row.averageEntryPrice ?? 0,
  },
  {
    key: 'currentPrice',
    label: 'Symbol price',
    className: 'positions-table__head--numeric',
    sortType: 'number',
    accessor: (row) => row.currentPrice ?? 0,
  },
  {
    key: 'currentMarketValue',
    label: 'Market value',
    className: 'positions-table__head--numeric',
    sortType: 'number',
    accessor: (row) => row.currentMarketValue ?? 0,
  },
  {
    key: 'currency',
    label: 'Currency',
    className: 'positions-table__head--currency',
    sortType: 'text',
    accessor: (row) => row.currency || '',
  },
  {
    key: 'portfolioShare',
    label: '% of portfolio',
    className: 'positions-table__head--numeric',
    sortType: 'number',
    accessor: (row) => row.portfolioShare ?? 0,
  },
  {
    key: 'targetProportion',
    label: 'Target %',
    className: 'positions-table__head--numeric',
    sortType: 'number',
    accessor: (row) => (Number.isFinite(row.targetProportion) ? row.targetProportion : -Infinity),
  },
];

const TABLE_HEADERS_WITHOUT_TARGET = TABLE_HEADERS.filter((column) => column.key !== 'targetProportion');

function hasTargetProportionValue(position) {
  if (!position || position.targetProportion === null || position.targetProportion === undefined) {
    return false;
  }
  const numeric = Number(position.targetProportion);
  return Number.isFinite(numeric);
}

function sanitizeDisplayValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed === '\u2014') {
      return '';
    }
  }
  return value;
}

function truncateDescription(value) {
  if (!value) {
    return '';
  }
  const normalized = String(value);
  if (normalized.length <= 21) {
    return normalized;
  }
  return `${normalized.slice(0, 21).trimEnd()}...`;
}

function normalizeSymbolKey(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim().toUpperCase();
  return trimmed || '';
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeCurrencyAmount(value, currency, currencyRates, baseCurrency = 'CAD') {
  if (!isFiniteNumber(value)) {
    return null;
  }
  const normalizedBase = (baseCurrency || 'CAD').toUpperCase();
  const normalizedCurrency = (currency || normalizedBase).toUpperCase();
  const rate = currencyRates?.get(normalizedCurrency);
  if (isFiniteNumber(rate) && rate > 0) {
    return value * rate;
  }
  if (normalizedCurrency === normalizedBase) {
    return value;
  }
  return value;
}

function convertBaseAmountToTarget(value, targetCurrency, currencyRates, baseCurrency = 'CAD') {
  if (!isFiniteNumber(value)) {
    return null;
  }
  const normalizedBase = (baseCurrency || 'CAD').toUpperCase();
  const normalizedTarget = (targetCurrency || normalizedBase).toUpperCase();
  if (normalizedTarget === normalizedBase) {
    return value;
  }
  const targetRate = currencyRates?.get(normalizedTarget);
  if (isFiniteNumber(targetRate) && targetRate > 0) {
    return value / targetRate;
  }
  return value;
}

function resolveMarketValueDisplay(position, mode, currencyRates, baseCurrency = 'CAD') {
  if (!position) {
    return { value: null, currency: '' };
  }
  if (mode === 'default') {
    const rawValue = isFiniteNumber(position.currentMarketValue) ? position.currentMarketValue : null;
    const rawCurrency = position.currency || '';
    return { value: rawValue, currency: rawCurrency };
  }

  const targetCurrency = mode === 'usd' ? 'USD' : 'CAD';
  const baseValue = isFiniteNumber(position.normalizedMarketValue)
    ? position.normalizedMarketValue
    : (() => {
        const rawValue = isFiniteNumber(position.currentMarketValue) ? position.currentMarketValue : null;
        if (rawValue === null) {
          return null;
        }
        return normalizeCurrencyAmount(rawValue, position.currency, currencyRates, baseCurrency);
      })();
  const convertedValue =
    baseValue === null ? null : convertBaseAmountToTarget(baseValue, targetCurrency, currencyRates, baseCurrency);
  return { value: convertedValue, currency: targetCurrency };
}

function resolveSymbolTotalPnlValue(symbolKey, accountId, symbolTotalPnlByAccountMap) {
  if (!symbolKey || !(symbolTotalPnlByAccountMap instanceof Map)) {
    return null;
  }
  const accountKey =
    accountId !== null && accountId !== undefined && accountId !== '' ? String(accountId) : '';
  if (accountKey && symbolTotalPnlByAccountMap.has(accountKey)) {
    const accountMap = symbolTotalPnlByAccountMap.get(accountKey);
    return accountMap?.get(symbolKey) ?? null;
  }
  if (symbolTotalPnlByAccountMap.has('all')) {
    const aggregateMap = symbolTotalPnlByAccountMap.get('all');
    return aggregateMap?.get(symbolKey) ?? null;
  }
  return null;
}

function compareRows(header, direction, accessorOverride) {
  const multiplier = direction === 'asc' ? 1 : -1;
  const accessor = typeof accessorOverride === 'function' ? accessorOverride : header.accessor;
  return (a, b) => {
    const valueA = accessor(a);
    const valueB = accessor(b);

    if (header.sortType === 'text') {
      const textA = (valueA ?? '').toString().toUpperCase();
      const textB = (valueB ?? '').toString().toUpperCase();
      const comparison = textA.localeCompare(textB);
      if (comparison !== 0) {
        return comparison * multiplier;
      }
    } else {
      const numberA = Number(valueA ?? 0);
      const numberB = Number(valueB ?? 0);
      if (!Number.isNaN(numberA) || !Number.isNaN(numberB)) {
        if (numberA !== numberB) {
          return numberA > numberB ? multiplier : -multiplier;
        }
      }
    }

    const fallback = (a.symbol || '').localeCompare(b.symbol || '', undefined, { sensitivity: 'base' });
    return fallback * multiplier;
  };
}

function PnlBadge({ value, percent, mode, onToggle, extraTooltipLines }) {
  const tone = classifyPnL(value);
  const isPercentMode = mode === 'percent';
  const hasPercent = percent !== null && Number.isFinite(percent);
  const formattedPercent = hasPercent
    ? formatSignedPercent(percent, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '';
  const formattedCurrency = sanitizeDisplayValue(formatSignedMoney(value));
  const sanitizedPercent = sanitizeDisplayValue(formattedPercent);
  const formatted = isPercentMode ? sanitizedPercent : formattedCurrency;
  const tooltipLines = [];
  const baseTooltip = isPercentMode ? formattedCurrency : sanitizedPercent;
  if (baseTooltip) {
    tooltipLines.push(baseTooltip);
  }
  if (Array.isArray(extraTooltipLines) && extraTooltipLines.length) {
    extraTooltipLines.forEach((line) => {
      const sanitizedLine = sanitizeDisplayValue(line);
      if (sanitizedLine) {
        tooltipLines.push(sanitizedLine);
      }
    });
  }
  const tooltip = tooltipLines.length ? tooltipLines.join('\n') : undefined;

  return (
    <button
      type="button"
      className={`positions-table__pnl ${tone}`}
      onClick={onToggle}
      aria-pressed={isPercentMode}
      title={tooltip}
    >
      {formatted}
    </button>
  );
}

PnlBadge.propTypes = {
  value: PropTypes.number,
  percent: PropTypes.number,
  mode: PropTypes.oneOf(['currency', 'percent']).isRequired,
  onToggle: PropTypes.func.isRequired,
  extraTooltipLines: PropTypes.arrayOf(PropTypes.string),
};

PnlBadge.defaultProps = {
  value: 0,
  percent: null,
  extraTooltipLines: undefined,
};

function isPnlColumn(columnKey, pnlColumnMode = 'open') {
  if (columnKey === 'dayPnl') {
    return true;
  }
  if (columnKey !== 'openPnl') {
    return false;
  }
  return pnlColumnMode === 'open';
}

function PositionsTable({
  positions,
  totalMarketValue,
  sortColumn,
  sortDirection,
  onSortChange,
  pnlMode: externalPnlMode,
  onPnlModeChange,
  embedded = false,
  investmentModelSymbolMap = null,
  onShowInvestmentModel = null,
  onShowNotes = null,
  onShowOrders = null,
  onBuySell = null,
  onFocusSymbol = null,
  onGoToAccount = null,
  forceShowTargetColumn = false,
  showPortfolioShare = true,
  showAccountColumn = false,
  hideTargetColumn = false,
  hideDetailsOption = false,
  accountsById = null,
  symbolAnnualizedMap = null,
  symbolAnnualizedByAccountMap = null,
  symbolTotalPnlByAccountMap = null,
  focusedSymbolTotalPnlOverride = null,
  focusedSymbolKey = null,
  currencyRates = null,
  baseCurrency = 'CAD',
}) {
  // No local mapping required when using Logo.dev ticker endpoint
  const resolvedDirection = sortDirection === 'asc' ? 'asc' : 'desc';
  const initialExternalMode = externalPnlMode === 'percent' || externalPnlMode === 'currency'
    ? externalPnlMode
    : 'currency';

  const [pnlColumnMode, setPnlColumnMode] = useState('open');
  const [sortState, setSortState] = useState(() => ({
    column: sortColumn,
    direction: resolvedDirection,
    valueMode: isPnlColumn(sortColumn, pnlColumnMode) ? initialExternalMode : null,
  }));
  const [internalPnlMode, setInternalPnlMode] = useState('currency');
  const menuRef = useRef(null);
  const [contextMenuState, setContextMenuState] = useState({ open: false, x: 0, y: 0, position: null });
  const pnlMenuRef = useRef(null);
  const [pnlMenuState, setPnlMenuState] = useState({ open: false, x: 0, y: 0 });
  const marketValueMenuRef = useRef(null);
  const [marketValueMenuState, setMarketValueMenuState] = useState({ open: false, x: 0, y: 0 });
  const [marketValueMode, setMarketValueMode] = useState('default');

  const closeContextMenu = useCallback(() => {
    setContextMenuState((state) => {
      if (!state.open) {
        return state;
      }
      return { open: false, x: 0, y: 0, position: null };
    });
  }, []);

  const closePnlMenu = useCallback(() => {
    setPnlMenuState((state) => {
      if (!state.open) {
        return state;
      }
      return { open: false, x: 0, y: 0 };
    });
  }, []);

  const closeMarketValueMenu = useCallback(() => {
    setMarketValueMenuState((state) => {
      if (!state.open) {
        return state;
      }
      return { open: false, x: 0, y: 0 };
    });
  }, []);

  const pnlMode = externalPnlMode === 'percent' || externalPnlMode === 'currency'
    ? externalPnlMode
    : internalPnlMode;

  const resolveMarketValueDisplayForRow = useCallback(
    (position) => resolveMarketValueDisplay(position, marketValueMode, currencyRates, baseCurrency),
    [marketValueMode, currencyRates, baseCurrency]
  );

  useEffect(() => {
    setSortState((current) => {
      if (current.column === sortColumn && current.direction === resolvedDirection) {
        return current;
      }
      return {
        column: sortColumn,
        direction: resolvedDirection,
        valueMode: isPnlColumn(sortColumn, pnlColumnMode) ? pnlMode : null,
      };
    });
  }, [sortColumn, resolvedDirection, pnlMode, pnlColumnMode]);

  useEffect(() => {
    setSortState((current) => {
      if (current.column !== 'openPnl') {
        return current;
      }
      const nextValueMode = isPnlColumn('openPnl', pnlColumnMode) ? pnlMode : null;
      if (current.valueMode === nextValueMode) {
        return current;
      }
      return { ...current, valueMode: nextValueMode };
    });
  }, [pnlColumnMode, pnlMode]);

  const aggregateMarketValue = useMemo(() => {
    if (typeof totalMarketValue === 'number' && totalMarketValue > 0) {
      return totalMarketValue;
    }
    return positions.reduce((acc, position) => acc + (position.currentMarketValue || 0), 0);
  }, [positions, totalMarketValue]);

  const decoratedPositions = useMemo(() => {
    if (!positions.length) {
      return [];
    }
    return positions.map((position) => {
      const normalizedTotalsKey = normalizeSymbolGroupKey(position?.symbol || '');
      const { dayPnlPercent, openPnlPercent } = derivePercentages(position);
      const normalizedSymbol = normalizeSymbolKey(position.symbol);
      const mappedTotalPnl = resolveSymbolTotalPnlValue(
        normalizedTotalsKey,
        position?.accountId,
        symbolTotalPnlByAccountMap
      );
      const annualizedEntry = resolveSymbolAnnualizedEntry(
        normalizedTotalsKey,
        position?.accountId,
        symbolAnnualizedByAccountMap,
        symbolAnnualizedMap
      );
      const focusedOverride =
        focusedSymbolKey &&
        normalizedTotalsKey &&
        focusedSymbolKey === normalizedTotalsKey &&
        Number.isFinite(focusedSymbolTotalPnlOverride)
          ? focusedSymbolTotalPnlOverride
          : null;
      const totalPnlResolved = Number.isFinite(focusedOverride)
        ? focusedOverride
        : Number.isFinite(mappedTotalPnl)
          ? mappedTotalPnl
          : Number.isFinite(position?.totalPnl)
            ? position.totalPnl
            : null;
      const totalCost = resolveTotalCost(position);
      const dayPnlForTotal = Number.isFinite(position?.normalizedDayPnl)
        ? position.normalizedDayPnl
        : Number.isFinite(position?.dayPnl)
          ? position.dayPnl
          : 0;
      const includeDayInTotal = !Number.isFinite(focusedOverride);
      const totalPnlDisplayValue =
        Number.isFinite(totalPnlResolved) && Number.isFinite(dayPnlForTotal)
          ? totalPnlResolved + (includeDayInTotal ? dayPnlForTotal : 0)
          : Number.isFinite(totalPnlResolved)
            ? totalPnlResolved
            : null;
      const totalPnlPercent =
        Number.isFinite(totalPnlDisplayValue) && totalCost !== null && Math.abs(totalCost) > 1e-6
          ? (totalPnlDisplayValue / totalCost) * 100
          : null;
      const annualizedRate =
        annualizedEntry && Number.isFinite(annualizedEntry.rate) ? annualizedEntry.rate : null;
      let share = position.portfolioShare;
      if (typeof share !== 'number') {
        share = aggregateMarketValue > 0 ? ((position.currentMarketValue || 0) / aggregateMarketValue) * 100 : null;
      }
      return {
        ...position,
        portfolioShare: share,
        dayPnlPercent,
        openPnlPercent,
        totalPnlResolved,
        totalPnlDisplayValue,
        totalPnlPercent,
        annualizedRate,
        annualizedEntry,
      };
    });
  }, [
    positions,
    aggregateMarketValue,
    symbolAnnualizedMap,
    symbolAnnualizedByAccountMap,
    symbolTotalPnlByAccountMap,
    focusedSymbolKey,
    focusedSymbolTotalPnlOverride,
  ]);

  const showTargetColumn = useMemo(() => {
    if (hideTargetColumn) return false;
    return (
      forceShowTargetColumn ||
      decoratedPositions.some((position) => hasTargetProportionValue(position))
    );
  }, [decoratedPositions, forceShowTargetColumn, hideTargetColumn]);

  let activeHeaders = showTargetColumn ? TABLE_HEADERS : TABLE_HEADERS_WITHOUT_TARGET;
  if (!showPortfolioShare) {
    activeHeaders = activeHeaders.filter((c) => c.key !== 'portfolioShare');
  }
  if (showAccountColumn) {
    const accountHeader = { key: 'account', label: 'Account', className: 'positions-table__head--account', sortType: 'text', accessor: (row) => row.accountDisplayName || row.accountNumber || row.accountId || '' };
    const symbolIndex = activeHeaders.findIndex((c) => c.key === 'symbol');
    const insertAt = symbolIndex >= 0 ? symbolIndex + 1 : 1;
    activeHeaders = activeHeaders.slice();
    activeHeaders.splice(insertAt, 0, accountHeader);
  }

  const sortedPositions = useMemo(() => {
    const header = activeHeaders.find((column) => column.key === sortState.column);
    if (!header) {
      return decoratedPositions.slice();
    }
    let accessorOverride = null;
    const effectiveMode = sortState.valueMode === 'percent' ? 'percent' : 'currency';

    if (header.key === 'dayPnl') {
      if (effectiveMode === 'percent') {
        accessorOverride = (row) => row.dayPnlPercent ?? 0;
      }
    } else if (header.key === 'openPnl') {
      if (pnlColumnMode === 'annualized') {
        accessorOverride = (row) => row.annualizedRate ?? 0;
      } else if (pnlColumnMode === 'total') {
        accessorOverride =
          effectiveMode === 'percent'
            ? (row) => row.totalPnlPercent ?? 0
            : (row) => row.totalPnlDisplayValue ?? row.totalPnlResolved ?? 0;
      } else if (effectiveMode === 'percent') {
        accessorOverride = (row) => row.openPnlPercent ?? 0;
      }
    } else if (header.key === 'currentMarketValue' && marketValueMode !== 'default') {
      accessorOverride = (row) => {
        const resolved = resolveMarketValueDisplayForRow(row);
        return isFiniteNumber(resolved.value) ? resolved.value : 0;
      };
    } else if (header.key === 'currency' && marketValueMode !== 'default') {
      accessorOverride = () => (marketValueMode === 'usd' ? 'USD' : 'CAD');
    }
    const sorter = compareRows(header, sortState.direction, accessorOverride);
    return decoratedPositions.slice().sort((a, b) => sorter(a, b));
  }, [activeHeaders, decoratedPositions, sortState, pnlColumnMode, marketValueMode, resolveMarketValueDisplayForRow]);

  const handleSort = useCallback((columnKey) => {
    const header = activeHeaders.find((column) => column.key === columnKey);
    if (!header) {
      return;
    }
    const current = sortState;
    let nextState;
    if (current.column === columnKey) {
      let nextDirection = current.direction === 'asc' ? 'desc' : 'asc';
      let nextValueMode = current.valueMode;

      if (isPnlColumn(columnKey, pnlColumnMode)) {
        if (current.valueMode !== pnlMode) {
          nextDirection = current.direction;
          nextValueMode = pnlMode;
        }
      } else {
        nextValueMode = null;
      }

      nextState = { column: columnKey, direction: nextDirection, valueMode: nextValueMode };
    } else {
      const defaultDirection = header.sortType === 'text' ? 'asc' : 'desc';
      nextState = {
        column: columnKey,
        direction: defaultDirection,
        valueMode: isPnlColumn(columnKey, pnlColumnMode) ? pnlMode : null,
      };
    }
    setSortState(nextState);
    if (typeof onSortChange === 'function') {
      onSortChange({ column: nextState.column, direction: nextState.direction });
    }
  }, [activeHeaders, onSortChange, pnlMode, pnlColumnMode, sortState]);

  useEffect(() => {
    if (showTargetColumn || sortState.column !== 'targetProportion') {
      return;
    }
    const fallbackState = { column: 'symbol', direction: 'asc', valueMode: null };
    setSortState(fallbackState);
    if (typeof onSortChange === 'function') {
      onSortChange({ column: fallbackState.column, direction: fallbackState.direction });
    }
  }, [onSortChange, showTargetColumn, sortState.column]);

  const handleTogglePnlMode = useCallback(() => {
    const nextMode = pnlMode === 'currency' ? 'percent' : 'currency';
    if (typeof onPnlModeChange === 'function') {
      onPnlModeChange(nextMode);
    }
    if (externalPnlMode !== 'currency' && externalPnlMode !== 'percent') {
      setInternalPnlMode(nextMode);
    }
  }, [externalPnlMode, onPnlModeChange, pnlMode]);

  const handlePnlHeaderContextMenu = useCallback(
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeContextMenu();
      closeMarketValueMenu();
      setPnlMenuState({
        open: true,
        x: event.clientX,
        y: event.clientY,
      });
    },
    [closeContextMenu, closeMarketValueMenu]
  );

  const handleMarketValueHeaderContextMenu = useCallback(
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeContextMenu();
      closePnlMenu();
      setMarketValueMenuState({
        open: true,
        x: event.clientX,
        y: event.clientY,
      });
    },
    [closeContextMenu, closePnlMenu]
  );

  const handlePnlColumnSelect = useCallback(
    (nextMode) => {
      setPnlColumnMode(nextMode);
      closePnlMenu();
    },
    [closePnlMenu]
  );

  const handleMarketValueColumnSelect = useCallback(
    (nextMode) => {
      setMarketValueMode(nextMode);
      closeMarketValueMenu();
    },
    [closeMarketValueMenu]
  );

  const handleRowContextMenu = useCallback(
    (event, position) => {
      if (!position) {
        return;
      }
      const element = event.target;
      if (element && typeof element.closest === 'function' && element.closest('button, a')) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      closePnlMenu();
      closeMarketValueMenu();
      setContextMenuState({
        open: true,
        x: event.clientX,
        y: event.clientY,
        position,
      });
    },
    [closePnlMenu, closeMarketValueMenu]
  );

  const handleExplainMovement = useCallback(async () => {
    const targetPosition = contextMenuState.position;
    closeContextMenu();
    if (!targetPosition) {
      return;
    }

    openChatGpt();

    const prompt = buildExplainMovementPrompt(targetPosition);
    if (!prompt) {
      return;
    }

    try {
      await copyTextToClipboard(prompt);
    } catch (error) {
      console.error('Failed to copy explain movement prompt', error);
    }
  }, [closeContextMenu, contextMenuState.position]);

  const handleOpenNotesFromMenu = useCallback(() => {
    const targetPosition = contextMenuState.position;
    closeContextMenu();
    if (!targetPosition || typeof onShowNotes !== 'function') {
      return;
    }
    onShowNotes(targetPosition);
  }, [closeContextMenu, contextMenuState.position, onShowNotes]);

  const handleOpenOrdersFromMenu = useCallback(() => {
    const targetPosition = contextMenuState.position;
    closeContextMenu();
    if (!targetPosition || typeof onShowOrders !== 'function') {
      return;
    }
    onShowOrders(targetPosition);
  }, [closeContextMenu, contextMenuState.position, onShowOrders]);

  const handleOpenBuySell = useCallback(() => {
    const targetPosition = contextMenuState.position;
    closeContextMenu();
    if (!targetPosition || typeof onBuySell !== 'function') {
      return;
    }
    onBuySell(targetPosition);
  }, [closeContextMenu, contextMenuState.position, onBuySell]);

  const handleOpenDetails = useCallback(() => {
    const targetPosition = contextMenuState.position;
    closeContextMenu();
    if (!targetPosition || typeof onFocusSymbol !== 'function') {
      return;
    }

    const rawSymbol = (targetPosition.symbol || '').toString().trim();
    if (!rawSymbol) {
      return;
    }

    const description =
      typeof targetPosition.description === 'string' && targetPosition.description.trim()
        ? targetPosition.description.trim()
        : null;

    onFocusSymbol(rawSymbol, { description });
  }, [closeContextMenu, contextMenuState.position, onFocusSymbol]);

  const handleGoToAccountFromMenu = useCallback(() => {
    const targetPosition = contextMenuState.position;
    closeContextMenu();
    if (!targetPosition || typeof onGoToAccount !== 'function') {
      return;
    }

    const account = resolveAccountForPosition(targetPosition, accountsById);
    onGoToAccount(targetPosition, account);
  }, [closeContextMenu, contextMenuState.position, onGoToAccount, accountsById]);

  const handleNotesIndicatorClick = useCallback(
    (event, targetPosition) => {
      event.stopPropagation();
      event.preventDefault();
      closeContextMenu();
      if (typeof onShowNotes === 'function') {
        onShowNotes(targetPosition);
      }
    },
    [closeContextMenu, onShowNotes]
  );

  const handleRowNavigation = useCallback(
    (event, symbol) => {
      closeContextMenu();
      if (!symbol) {
        return;
      }
      const element = event.target;
      if (element && typeof element.closest === 'function' && element.closest('button, a')) {
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        const questradeUrl = buildQuoteUrl(symbol, 'questrade');
        if (!questradeUrl) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        openQuote(symbol, 'questrade');
        return;
      }
      const provider = event.altKey ? 'yahoo' : 'perplexity';
      const url = buildQuoteUrl(symbol, provider);
      if (!url) {
        return;
      }
      event.stopPropagation();
      openQuote(symbol, provider);
    },
    [closeContextMenu]
  );

  useEffect(() => {
    if (!contextMenuState.open) {
      return undefined;
    }

    const handlePointer = (event) => {
      if (!menuRef.current) {
        closeContextMenu();
        return;
      }
      if (menuRef.current.contains(event.target)) {
        return;
      }
      closeContextMenu();
    };

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        closeContextMenu();
      }
    };

    const handleViewportChange = () => {
      closeContextMenu();
    };

    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('touchstart', handlePointer);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('touchstart', handlePointer);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [closeContextMenu, contextMenuState.open]);

  useEffect(() => {
    if (!contextMenuState.open || !menuRef.current) {
      return;
    }

    const { innerWidth, innerHeight } = window;
    const rect = menuRef.current.getBoundingClientRect();
    const padding = 12;
    let nextX = contextMenuState.x;
    let nextY = contextMenuState.y;

    if (nextX + rect.width > innerWidth - padding) {
      nextX = Math.max(padding, innerWidth - rect.width - padding);
    }
    if (nextY + rect.height > innerHeight - padding) {
      nextY = Math.max(padding, innerHeight - rect.height - padding);
    }

    if (nextX !== contextMenuState.x || nextY !== contextMenuState.y) {
      setContextMenuState((state) => {
        if (!state.open) {
          return state;
        }
        return { ...state, x: nextX, y: nextY };
      });
    }
  }, [contextMenuState.open, contextMenuState.x, contextMenuState.y]);

  useEffect(() => {
    if (!contextMenuState.open || !menuRef.current) {
      return;
    }
    const firstButton = menuRef.current.querySelector('button');
    if (firstButton && typeof firstButton.focus === 'function') {
      firstButton.focus({ preventScroll: true });
    }
  }, [contextMenuState.open]);

  useEffect(() => {
    if (!pnlMenuState.open) {
      return undefined;
    }

    const handlePointer = (event) => {
      if (!pnlMenuRef.current) {
        closePnlMenu();
        return;
      }
      if (pnlMenuRef.current.contains(event.target)) {
        return;
      }
      closePnlMenu();
    };

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        closePnlMenu();
      }
    };

    const handleViewportChange = () => {
      closePnlMenu();
    };

    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('touchstart', handlePointer);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('touchstart', handlePointer);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [closePnlMenu, pnlMenuState.open]);

  useEffect(() => {
    if (!pnlMenuState.open || !pnlMenuRef.current) {
      return;
    }

    const { innerWidth, innerHeight } = window;
    const rect = pnlMenuRef.current.getBoundingClientRect();
    const padding = 12;
    let nextX = pnlMenuState.x;
    let nextY = pnlMenuState.y;

    if (nextX + rect.width > innerWidth - padding) {
      nextX = Math.max(padding, innerWidth - rect.width - padding);
    }
    if (nextY + rect.height > innerHeight - padding) {
      nextY = Math.max(padding, innerHeight - rect.height - padding);
    }

    if (nextX !== pnlMenuState.x || nextY !== pnlMenuState.y) {
      setPnlMenuState((state) => {
        if (!state.open) {
          return state;
        }
        return { ...state, x: nextX, y: nextY };
      });
    }
  }, [pnlMenuState.open, pnlMenuState.x, pnlMenuState.y]);

  useEffect(() => {
    if (!pnlMenuState.open || !pnlMenuRef.current) {
      return;
    }
    const firstButton = pnlMenuRef.current.querySelector('button');
    if (firstButton && typeof firstButton.focus === 'function') {
      firstButton.focus({ preventScroll: true });
    }
  }, [pnlMenuState.open]);

  useEffect(() => {
    if (!marketValueMenuState.open) {
      return undefined;
    }

    const handlePointer = (event) => {
      if (!marketValueMenuRef.current) {
        closeMarketValueMenu();
        return;
      }
      if (marketValueMenuRef.current.contains(event.target)) {
        return;
      }
      closeMarketValueMenu();
    };

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        closeMarketValueMenu();
      }
    };

    const handleViewportChange = () => {
      closeMarketValueMenu();
    };

    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('touchstart', handlePointer);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('touchstart', handlePointer);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [closeMarketValueMenu, marketValueMenuState.open]);

  useEffect(() => {
    if (!marketValueMenuState.open || !marketValueMenuRef.current) {
      return;
    }

    const { innerWidth, innerHeight } = window;
    const rect = marketValueMenuRef.current.getBoundingClientRect();
    const padding = 12;
    let nextX = marketValueMenuState.x;
    let nextY = marketValueMenuState.y;

    if (nextX + rect.width > innerWidth - padding) {
      nextX = Math.max(padding, innerWidth - rect.width - padding);
    }
    if (nextY + rect.height > innerHeight - padding) {
      nextY = Math.max(padding, innerHeight - rect.height - padding);
    }

    if (nextX !== marketValueMenuState.x || nextY !== marketValueMenuState.y) {
      setMarketValueMenuState((state) => {
        if (!state.open) {
          return state;
        }
        return { ...state, x: nextX, y: nextY };
      });
    }
  }, [marketValueMenuState.open, marketValueMenuState.x, marketValueMenuState.y]);

  useEffect(() => {
    if (!marketValueMenuState.open || !marketValueMenuRef.current) {
      return;
    }
    const firstButton = marketValueMenuRef.current.querySelector('button');
    if (firstButton && typeof firstButton.focus === 'function') {
      firstButton.focus({ preventScroll: true });
    }
  }, [marketValueMenuState.open]);

  if (!positions.length) {
    if (embedded) {
      return <div className="empty-state">No positions to display.</div>;
    }

    return (
      <section className="positions-card">
        <header className="positions-card__header">
          <div className="positions-card__tabs" role="tablist" aria-label="Positions data views">
            <button type="button" role="tab" aria-selected="true" className="active">
              Positions
            </button>
          </div>
        </header>
        <div className="empty-state">No positions to display.</div>
      </section>
    );
  }

  const tableClassName = (() => {
    const classes = ['positions-table'];
    if (!showTargetColumn) {
      classes.push('positions-table--no-target');
    }
    if (showAccountColumn) {
      classes.push('positions-table--with-account');
    }
    return classes.join(' ');
  })();

  const pnlColumnLabel =
    pnlColumnMode === 'open'
      ? 'Open P&L'
      : pnlColumnMode === 'total'
        ? 'Total P&L'
        : 'Total P&L Annualized';
  const pnlColumnOptions = [
    { value: 'open', label: 'Open P&L' },
    { value: 'total', label: 'Total P&L' },
    { value: 'annualized', label: 'Total P&L Annualized (XIRR)' },
  ];
  const marketValueSuffix =
    marketValueMode === 'usd' ? 'USD' : marketValueMode === 'cad' ? 'CAD' : null;
  const marketValueColumnLabel = marketValueSuffix ? `Market value (${marketValueSuffix})` : 'Market value';
  const marketValueColumnOptions = [
    { value: 'default', label: 'Default' },
    { value: 'usd', label: 'USD' },
    { value: 'cad', label: 'CAD' },
  ];

  const renderTable = () => (
    <div className={tableClassName} role="table">
      <div className="positions-table__row positions-table__row--head" role="row">
        {activeHeaders.map((column) => {
          const isSorted = column.key === sortState.column;
          const sortDirectionValue = isSorted ? (sortState.direction === 'asc' ? 'ascending' : 'descending') : 'none';
          const isPnlHeader = column.key === 'openPnl';
          const isMarketValueHeader = column.key === 'currentMarketValue';
          const headerLabel = isPnlHeader
            ? pnlColumnLabel
            : isMarketValueHeader
              ? marketValueColumnLabel
              : column.label;
          return (
              <div
                key={column.key}
                role="columnheader"
                aria-sort={sortDirectionValue}
                className={`positions-table__head ${column.className}${isSorted ? ' sorted' : ''}`}
              >
                <button
                  type="button"
                  className="positions-table__head-button"
                  onClick={() => handleSort(column.key)}
                  onContextMenu={
                    isPnlHeader
                      ? handlePnlHeaderContextMenu
                      : isMarketValueHeader
                        ? handleMarketValueHeaderContextMenu
                        : undefined
                  }
                  aria-haspopup={isPnlHeader || isMarketValueHeader ? 'menu' : undefined}
                  aria-expanded={
                    isPnlHeader
                      ? (pnlMenuState.open ? true : undefined)
                      : isMarketValueHeader
                        ? (marketValueMenuState.open ? true : undefined)
                        : undefined
                  }
                >
                  <span>{headerLabel}</span>
                  {isSorted && (
                    <span className={`positions-table__sort-indicator ${sortState.direction}`} aria-hidden="true" />
                  )}
                </button>
              </div>
            );
          })}
      </div>

      <div className="positions-table__body">
        {sortedPositions.map((position, index) => {
          const displayShare = sanitizeDisplayValue(formatShare(position.portfolioShare));
          const displayTargetShare = showTargetColumn
            ? sanitizeDisplayValue(formatShare(position.targetProportion))
            : '';
          const displayDescription = truncateDescription(position.description);
          const dividendYieldPercent = Number(position.dividendYieldPercent);
          const hasDividendYield = Number.isFinite(dividendYieldPercent) && dividendYieldPercent > 0;
          const dividendTooltipLabel = hasDividendYield
            ? `Dividend: ${formatNumber(dividendYieldPercent, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}%`
            : null;
          const tooltipLines = [];
          if (typeof position.description === 'string') {
            const trimmedDescription = position.description.trim();
            if (trimmedDescription) {
              tooltipLines.push(trimmedDescription);
            }
          }
          if (dividendTooltipLabel) {
            tooltipLines.push(dividendTooltipLabel);
          }
          const symbolTooltip = tooltipLines.join('\n');
          const averageEntryPrice = sanitizeDisplayValue(
            formatMoney(position.averageEntryPrice, { minimumFractionDigits: 4, maximumFractionDigits: 4 })
          );
          const currentPrice = sanitizeDisplayValue(
            formatMoney(position.currentPrice, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          );
          const marketValueDisplay = resolveMarketValueDisplayForRow(position);
          const currentMarketValue = sanitizeDisplayValue(
            formatMoney(marketValueDisplay.value, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          );
          const marketValueCurrency = marketValueDisplay.currency || '';
          const fallbackKey = `${position.accountNumber || position.accountId || 'row'}:${
            position.symbolId ?? position.symbol ?? index
          }`;
          const rowKey = position.rowId || fallbackKey;
          const normalizedSymbol = normalizeSymbolKey(position.symbol);
          const normalizedTotalsKey = normalizeSymbolGroupKey(position?.symbol || '');
          const symbolLabel =
            typeof position.symbol === 'string' && position.symbol.trim()
              ? position.symbol.trim()
              : position.symbol || 'this symbol';
          const logoUrl = (() => {
            const symbol = normalizedSymbol;
            const pk = (import.meta && import.meta.env && import.meta.env.VITE_LOGO_DEV_PUBLISHABLE_KEY)
              ? import.meta.env.VITE_LOGO_DEV_PUBLISHABLE_KEY
              : null;
            if (!symbol || !pk) return null;
            const base = 'https://img.logo.dev/ticker';
            return `${base}/${encodeURIComponent(symbol)}?token=${encodeURIComponent(pk)}&size=64&format=png`;
          })();
          const hasNotes = (() => {
            if (typeof position.notes === 'string' && position.notes.trim()) {
              return true;
            }
            if (Array.isArray(position.accountNotes)) {
              return position.accountNotes.some(
                (entry) => entry && typeof entry.notes === 'string' && entry.notes.trim()
              );
            }
            return false;
          })();
          const showNotesIndicator = hasNotes && typeof onShowNotes === 'function';
          let modelSection = null;
          if (normalizedSymbol && investmentModelSymbolMap) {
            if (investmentModelSymbolMap instanceof Map) {
              modelSection = investmentModelSymbolMap.get(normalizedSymbol) || null;
            } else if (typeof investmentModelSymbolMap === 'object') {
              modelSection = investmentModelSymbolMap[normalizedSymbol] || null;
            }
          }
          const modelButtonLabel = modelSection?.displayTitle || modelSection?.title || modelSection?.model || 'Investment model';
          const isUsdPosition =
            typeof position.currency === 'string' && position.currency.trim().toUpperCase() === 'USD';
          const openPnlTooltipExtras = [];
          if (isUsdPosition && Number.isFinite(position.normalizedOpenPnl)) {
            const cadFormatted = formatSignedMoney(position.normalizedOpenPnl);
            if (cadFormatted && cadFormatted !== '-') {
              openPnlTooltipExtras.push(`${cadFormatted} CAD`);
            }
          }
          const annualizedEntry = position.annualizedEntry || null;
          const annualizedTooltip = (() => {
            if (!annualizedEntry) {
              return null;
            }
            if (Number.isFinite(annualizedEntry.rate)) {
              const formattedRate = formatSignedPercent(annualizedEntry.rate * 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              const formattedNoFx = Number.isFinite(annualizedEntry.rateNoFx)
                ? formatSignedPercent(annualizedEntry.rateNoFx * 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : null;
              const startSuffix = annualizedEntry.startDate ? ` (since ${annualizedEntry.startDate})` : '';
              const lines = [`XIRR w/ FX: ${formattedRate}${startSuffix}`];
              if (formattedNoFx) {
                lines.push(`XIRR w/o FX: ${formattedNoFx}${startSuffix}`);
              }
              return lines.join('\n');
            }
            if (annualizedEntry.incomplete) {
              return 'XIRR: unavailable (insufficient cash flows)';
            }
            return null;
          })();
          if (annualizedTooltip) {
            openPnlTooltipExtras.push(annualizedTooltip);
          }
          const totalPnlValue = Number.isFinite(position.totalPnlDisplayValue)
            ? position.totalPnlDisplayValue
            : Number.isFinite(position.totalPnlResolved)
              ? position.totalPnlResolved
              : null;
          const totalPnlDisplay = sanitizeDisplayValue(formatSignedMoney(totalPnlValue));
          const totalPnlTone = classifyPnL(Number.isFinite(totalPnlValue) ? totalPnlValue : 0);
          const annualizedRate = annualizedEntry && Number.isFinite(annualizedEntry.rate) ? annualizedEntry.rate : null;
          const annualizedDisplay = sanitizeDisplayValue(
            formatSignedPercent(
              Number.isFinite(annualizedRate) ? annualizedRate * 100 : null,
              { minimumFractionDigits: 2, maximumFractionDigits: 2 }
            )
          );
          const annualizedTone = classifyPnL(Number.isFinite(annualizedRate) ? annualizedRate : 0);

          return (
            <div
              key={rowKey}
              className="positions-table__row positions-table__row--clickable"
              role="row"
              onClick={(event) => handleRowNavigation(event, position.symbol)}
              onContextMenu={(event) => handleRowContextMenu(event, position)}
            >
              <div className="positions-table__cell positions-table__cell--logo" role="cell">
                {logoUrl ? (
                  <img
                    className="positions-table__logo"
                    src={logoUrl}
                    alt={displayDescription ? `${displayDescription} logo` : `${normalizedSymbol} logo`}
                    width={32}
                    height={32}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <span className="positions-table__logo--placeholder" aria-hidden="true">—</span>
                )}
              </div>
              <div
                className="positions-table__cell positions-table__cell--symbol"
                role="cell"
                title={symbolTooltip || undefined}
              >
                <div className="positions-table__symbol-header">
                  <div className="positions-table__symbol-ticker">{position.symbol}</div>
                  {showNotesIndicator ? (
                    <button
                      type="button"
                      className="positions-table__notes-indicator"
                      onClick={(event) => handleNotesIndicatorClick(event, position)}
                      title={`View notes for ${symbolLabel}`}
                      aria-label={`View notes for ${symbolLabel}`}
                    >
                      <span className="positions-table__notes-indicator-icon" aria-hidden="true">
                        📝
                      </span>
                    </button>
                  ) : null}
                  {modelSection && typeof onShowInvestmentModel === 'function' ? (
                    <button
                      type="button"
                      className="positions-table__model-link"
                      onClick={(event) => {
                        event.stopPropagation();
                        onShowInvestmentModel(modelSection);
                      }}
                      title={`View investment model guidance for ${modelButtonLabel}`}
                      aria-label={`View investment model guidance for ${modelButtonLabel}`}
                    >
                      Model
                    </button>
                  ) : null}
                </div>
                <div className="positions-table__symbol-name">
                  {displayDescription}
                </div>
              </div>
              {showAccountColumn ? (
                <div className="positions-table__cell positions-table__cell--account" role="cell">
                  {position.accountDisplayName || position.accountNumber || position.accountId || ''}
                </div>
              ) : null}
              <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                <PnlBadge
                  value={position.dayPnl}
                  percent={position.dayPnlPercent}
                  mode={pnlMode}
                  onToggle={handleTogglePnlMode}
                />
              </div>
              <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                {pnlColumnMode === 'open' ? (
                  <PnlBadge
                    value={position.openPnl}
                    percent={position.openPnlPercent}
                    mode={pnlMode}
                    onToggle={handleTogglePnlMode}
                    extraTooltipLines={openPnlTooltipExtras}
                  />
                ) : pnlColumnMode === 'total' ? (
                  <div className={`positions-table__pnl positions-table__pnl--static ${totalPnlTone}`}>
                    {totalPnlDisplay}
                  </div>
                ) : (
                  <div
                    className={`positions-table__pnl positions-table__pnl--static ${annualizedTone}`}
                    title={annualizedTooltip || undefined}
                  >
                    {annualizedDisplay}
                  </div>
                )}
              </div>
              <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                {formatQuantity(position.openQuantity)}
              </div>
              <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                {averageEntryPrice}
              </div>
              <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                {currentPrice}
              </div>
              <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                {currentMarketValue}
              </div>
              <div className="positions-table__cell positions-table__cell--currency" role="cell">
                <span>{marketValueCurrency}</span>
              </div>
              {showPortfolioShare ? (
                <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                  {displayShare}
                </div>
              ) : null}
              {showTargetColumn ? (
                <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                  {displayTargetShare}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );

  const contextMenuElement = contextMenuState.open ? (
    <div
      className="positions-table__context-menu"
      ref={menuRef}
      style={{ top: `${contextMenuState.y}px`, left: `${contextMenuState.x}px` }}
    >
      <ul className="positions-table__context-menu-list" role="menu">
        {!hideDetailsOption ? (
          <li role="none">
            <button
              type="button"
              className="positions-table__context-menu-item"
              role="menuitem"
              onClick={handleOpenDetails}
            >
              Details
            </button>
          </li>
        ) : null}
        <li role="none">
          <button
            type="button"
            className="positions-table__context-menu-item"
            role="menuitem"
            onClick={handleOpenBuySell}
            disabled={typeof onBuySell !== 'function'}
          >
            Buy/sell
          </button>
        </li>
        {typeof onGoToAccount === 'function' ? (
          <li role="none">
            <button
              type="button"
              className="positions-table__context-menu-item"
              role="menuitem"
              onClick={handleGoToAccountFromMenu}
            >
              Go to account
            </button>
          </li>
        ) : null}
        {typeof onShowOrders === 'function' ? (
          <li role="none">
            <button
              type="button"
              className="positions-table__context-menu-item"
              role="menuitem"
              onClick={handleOpenOrdersFromMenu}
            >
              Orders
            </button>
          </li>
        ) : null}
        {typeof onShowNotes === 'function' ? (
          <li role="none">
            <button
              type="button"
              className="positions-table__context-menu-item"
              role="menuitem"
              onClick={handleOpenNotesFromMenu}
            >
              Notes
            </button>
          </li>
        ) : null}
        <li role="none">
          <button
            type="button"
            className="positions-table__context-menu-item"
            role="menuitem"
            onClick={handleExplainMovement}
          >
            Explain movement
          </button>
        </li>
      </ul>
    </div>
  ) : null;

  const pnlMenuElement = pnlMenuState.open ? (
    <div
      className="positions-table__context-menu"
      ref={pnlMenuRef}
      style={{ top: `${pnlMenuState.y}px`, left: `${pnlMenuState.x}px` }}
    >
      <ul className="positions-table__context-menu-list" role="menu">
        {pnlColumnOptions.map((option) => {
          const isSelected = option.value === pnlColumnMode;
          return (
            <li key={option.value} role="none">
              <button
                type="button"
                className="positions-table__context-menu-item positions-table__context-menu-item--choice"
                role="menuitemradio"
                aria-checked={isSelected}
                onClick={() => handlePnlColumnSelect(option.value)}
              >
                <span
                  className={`positions-table__context-menu-check${isSelected ? ' positions-table__context-menu-check--active' : ''}`}
                  aria-hidden="true"
                />
                <span>{option.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  ) : null;

  const marketValueMenuElement = marketValueMenuState.open ? (
    <div
      className="positions-table__context-menu"
      ref={marketValueMenuRef}
      style={{ top: `${marketValueMenuState.y}px`, left: `${marketValueMenuState.x}px` }}
    >
      <ul className="positions-table__context-menu-list" role="menu">
        {marketValueColumnOptions.map((option) => {
          const isSelected = option.value === marketValueMode;
          return (
            <li key={option.value} role="none">
              <button
                type="button"
                className="positions-table__context-menu-item positions-table__context-menu-item--choice"
                role="menuitemradio"
                aria-checked={isSelected}
                onClick={() => handleMarketValueColumnSelect(option.value)}
              >
                <span
                  className={`positions-table__context-menu-check${isSelected ? ' positions-table__context-menu-check--active' : ''}`}
                  aria-hidden="true"
                />
                <span>{option.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  ) : null;

  if (embedded) {
    return (
      <>
        {renderTable()}
        {pnlMenuElement}
        {marketValueMenuElement}
        {contextMenuElement}
      </>
    );
  }

  return (
    <>
      <section className="positions-card">
        <header className="positions-card__header">
          <div className="positions-card__tabs" role="tablist" aria-label="Positions data views">
            <button type="button" role="tab" aria-selected="true" className="active">
              Positions
            </button>
          </div>
          {(import.meta && import.meta.env && import.meta.env.VITE_LOGO_DEV_PUBLISHABLE_KEY) ? (
            <div className="positions-card__attribution">
              Logos by{' '}
              <a
                href="https://logo.dev/?utm_source=investments-view&utm_medium=app&utm_campaign=attribution"
                target="_blank"
                rel="noopener noreferrer"
              >
                Logo.dev
              </a>
            </div>
          ) : null}
        </header>

        {renderTable()}
      </section>
      {pnlMenuElement}
      {marketValueMenuElement}
      {contextMenuElement}
    </>
  );
}

PositionsTable.propTypes = {
  positions: PropTypes.arrayOf(
    PropTypes.shape({
      accountId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
      accountNumber: PropTypes.string,
      symbol: PropTypes.string.isRequired,
      symbolId: PropTypes.oneOfType([PropTypes.number, PropTypes.string]).isRequired,
      description: PropTypes.string,
      dayPnl: PropTypes.number,
      openPnl: PropTypes.number,
      openQuantity: PropTypes.number,
      averageEntryPrice: PropTypes.number,
      currentPrice: PropTypes.number,
      currentMarketValue: PropTypes.number,
      currency: PropTypes.string,
      portfolioShare: PropTypes.number,
      totalCost: PropTypes.number,
      rowId: PropTypes.string,
      normalizedMarketValue: PropTypes.number,
      targetProportion: PropTypes.number,
      notes: PropTypes.string,
      dividendYieldPercent: PropTypes.number,
      accountDisplayName: PropTypes.string,
      accountOwnerLabel: PropTypes.string,
      accountNotes: PropTypes.arrayOf(
        PropTypes.shape({
          accountId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
          accountNumber: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
          accountDisplayName: PropTypes.string,
          accountOwnerLabel: PropTypes.string,
          notes: PropTypes.string,
          targetProportion: PropTypes.number,
        })
      ),
    })
  ).isRequired,
  totalMarketValue: PropTypes.number,
  sortColumn: PropTypes.string,
  sortDirection: PropTypes.oneOf(['asc', 'desc']),
  onSortChange: PropTypes.func,
  pnlMode: PropTypes.oneOf(['currency', 'percent']),
  onPnlModeChange: PropTypes.func,
  embedded: PropTypes.bool,
  investmentModelSymbolMap: PropTypes.instanceOf(Map),
  onShowInvestmentModel: PropTypes.func,
  onShowNotes: PropTypes.func,
  onShowOrders: PropTypes.func,
  onBuySell: PropTypes.func,
  onFocusSymbol: PropTypes.func,
  onGoToAccount: PropTypes.func,
  forceShowTargetColumn: PropTypes.bool,
  showPortfolioShare: PropTypes.bool,
  showAccountColumn: PropTypes.bool,
  hideTargetColumn: PropTypes.bool,
  hideDetailsOption: PropTypes.bool,
  accountsById: PropTypes.instanceOf(Map),
  symbolAnnualizedMap: PropTypes.instanceOf(Map),
  symbolAnnualizedByAccountMap: PropTypes.instanceOf(Map),
  symbolTotalPnlByAccountMap: PropTypes.instanceOf(Map),
  focusedSymbolTotalPnlOverride: PropTypes.number,
  focusedSymbolKey: PropTypes.string,
  currencyRates: PropTypes.instanceOf(Map),
  baseCurrency: PropTypes.string,
};

PositionsTable.defaultProps = {
  totalMarketValue: null,
  sortColumn: 'portfolioShare',
  sortDirection: 'desc',
  onSortChange: null,
  pnlMode: null,
  onPnlModeChange: null,
  embedded: false,
  investmentModelSymbolMap: null,
  onShowInvestmentModel: null,
  onShowNotes: null,
  onShowOrders: null,
  onBuySell: null,
  onFocusSymbol: null,
  onGoToAccount: null,
  forceShowTargetColumn: false,
  showPortfolioShare: true,
  showAccountColumn: false,
  hideTargetColumn: false,
  hideDetailsOption: false,
  accountsById: null,
  symbolAnnualizedMap: null,
  symbolAnnualizedByAccountMap: null,
  symbolTotalPnlByAccountMap: null,
  focusedSymbolTotalPnlOverride: null,
  focusedSymbolKey: null,
  currencyRates: null,
  baseCurrency: 'CAD',
};

export default PositionsTable;
