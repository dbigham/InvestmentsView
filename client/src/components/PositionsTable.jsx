import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { classifyPnL, formatMoney, formatNumber, formatSignedMoney, formatSignedPercent } from '../utils/formatters';
import { buildQuoteUrl, openQuote } from '../utils/quotes';
import { copyTextToClipboard } from '../utils/clipboard';
import { openChatGpt } from '../utils/chat';

const TABLE_HEADERS = [
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

function resolveTotalCost(position) {
  if (position.totalCost !== undefined && position.totalCost !== null) {
    return position.totalCost;
  }
  if (typeof position.averageEntryPrice === 'number' && typeof position.openQuantity === 'number') {
    return position.averageEntryPrice * position.openQuantity;
  }
  return null;
}

function derivePercentages(position) {
  const currentMarketValue = position.currentMarketValue || 0;
  const dayPnl = position.dayPnl || 0;
  const openPnl = position.openPnl || 0;
  const totalCost = resolveTotalCost(position);

  const previousValue = currentMarketValue - dayPnl;
  const dayPnlPercent = Math.abs(previousValue) > 1e-6 ? (dayPnl / previousValue) * 100 : null;
  const openPnlPercent = totalCost && Math.abs(totalCost) > 1e-6 ? (openPnl / totalCost) * 100 : null;

  return { dayPnlPercent, openPnlPercent };
}

function formatQuantity(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '';
  }
  const numeric = Number(value);
  const hasFraction = Math.abs(numeric % 1) > 0.0000001;
  return formatNumber(numeric, {
    minimumFractionDigits: hasFraction ? 4 : 0,
    maximumFractionDigits: hasFraction ? 4 : 0,
  });
}

function formatShare(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '';
  }
  const numeric = Number(value);
  return `${formatNumber(numeric, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

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

function formatPromptValue(value, { fallback = 'Not available', currency } = {}) {
  if (value === null || value === undefined) {
    return fallback;
  }

  let text = typeof value === 'string' ? value.trim() : String(value);
  if (!text || text === '\u2014') {
    return fallback;
  }

  const currencySuffix = currency && currency !== '\u2014' ? String(currency).trim().toUpperCase() : '';
  if (currencySuffix && text !== fallback && !text.toUpperCase().endsWith(currencySuffix)) {
    text = `${text} ${currencySuffix}`.trim();
  }

  return text;
}

function buildExplainMovementPrompt(position) {
  if (!position) {
    return '';
  }

  const today = new Date();
  const isoDate = Number.isNaN(today.getTime()) ? '' : today.toISOString().slice(0, 10);
  const symbol = typeof position.symbol === 'string' && position.symbol.trim() ? position.symbol.trim().toUpperCase() : 'Unknown symbol';
  const description = typeof position.description === 'string' && position.description.trim()
    ? position.description.trim()
    : 'Unknown company';

  let accountIdentifier = 'Not specified';
  if (typeof position.accountNumber === 'string' && position.accountNumber.trim()) {
    accountIdentifier = position.accountNumber.trim();
  } else if (position.accountId !== null && position.accountId !== undefined) {
    accountIdentifier = String(position.accountId);
  }

  const currency = typeof position.currency === 'string' && position.currency.trim()
    ? position.currency.trim().toUpperCase()
    : '';

  const quantity = formatPromptValue(formatQuantity(position.openQuantity));
  const averagePrice = formatPromptValue(
    formatMoney(position.averageEntryPrice, { minimumFractionDigits: 4, maximumFractionDigits: 4 }),
    { currency }
  );
  const currentPrice = formatPromptValue(
    formatMoney(position.currentPrice, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    { currency }
  );
  const marketValue = formatPromptValue(
    formatMoney(position.currentMarketValue, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    { currency }
  );
  const costBasis = formatPromptValue(
    formatMoney(resolveTotalCost(position), { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    { currency }
  );
  const openPnl = formatPromptValue(
    formatSignedMoney(position.openPnl, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    { currency }
  );
  const openPnlPercent = formatPromptValue(
    typeof position.openPnlPercent === 'number'
      ? formatSignedPercent(position.openPnlPercent, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '\u2014',
    { fallback: 'n/a' }
  );
  const dayPnl = formatPromptValue(
    formatSignedMoney(position.dayPnl, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    { currency }
  );
  const dayPnlPercent = formatPromptValue(
    typeof position.dayPnlPercent === 'number'
      ? formatSignedPercent(position.dayPnlPercent, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '\u2014',
    { fallback: 'n/a' }
  );
  const portfolioShare = formatPromptValue(formatShare(position.portfolioShare), { fallback: 'n/a' });

  const movementClassification = classifyPnL(typeof position.dayPnl === 'number' ? position.dayPnl : 0);
  const movementDescriptorMap = {
    positive: `${symbol} traded higher today.`,
    negative: `${symbol} declined today.`,
    neutral: `${symbol} was roughly flat today.`,
  };
  const movementDescriptor = movementDescriptorMap[movementClassification] || `${symbol} had limited movement today.`;

  const dayPnlSummary = dayPnl === 'Not available'
    ? 'No intraday P&L data is available for today.'
    : dayPnlPercent !== 'n/a'
        ? `${dayPnl} (${dayPnlPercent})`
        : dayPnl;

  const positionSideLine =
    quantity === 'Not available'
      ? '- Position side: Long position (share count not available)'
      : `- Position side: Long ${quantity}`;

  const contextLines = [
    `- Symbol: ${symbol}`,
    `- Company name: ${description}`,
    `- Account: ${accountIdentifier}`,
    positionSideLine,
    `- Trading currency: ${currency || 'Not specified'}`,
    `- Average entry price: ${averagePrice}`,
    `- Current price: ${currentPrice}`,
    `- Position market value: ${marketValue}`,
    `- Cost basis: ${costBasis}`,
    `- Unrealized P&L: ${openPnl}${openPnlPercent !== 'n/a' ? ` (${openPnlPercent})` : ''}`,
    `- Today's intraday P&L: ${dayPnlSummary}`,
    `- Portfolio weight: ${portfolioShare}`,
  ];

  const sanitizedContext = contextLines.map((line) => line.replace(/\s+/g, ' ').trim());

  const lines = [
    'You are a sell-side equity analyst preparing a post-trade explanation.',
    isoDate ? `Today is ${isoDate}. ${movementDescriptor}` : movementDescriptor,
    `Research credible, real-world financial news and market data published today (extend back up to 72 hours if needed) about:`,
    '1. The overall market (major North American indices, macroeconomic releases, rates, and cross-asset moves).',
    `2. The sector or industry most relevant to ${symbol}.`,
    `3. Company-specific developments for ${symbol} (${description}).`,
    '',
    'Use that research to narrate why the stock moved the way it did today.',
    '',
    'Holding context:',
    ...sanitizedContext,
    '',
    'Please respond with clearly labeled sections:',
    '1. Market context',
    '2. Sector/industry context',
    '3. Company-specific catalysts',
    `4. Narrative linking the catalysts to why ${symbol} moved the way it did today (cover timing, magnitude, and investor reaction).`,
    '5. Confidence assessment (High/Medium/Low) and key follow-ups to monitor next.',
    '',
    'If no direct news exists, identify plausible drivers such as sympathy moves, analyst commentary, fund flows, or technical factors, and make it clear that direct news was not found.',
    'Cite publication timestamps when possible.',
  ];

  return lines.join('\n');
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

function PnlBadge({ value, percent, mode, onToggle }) {
  const tone = classifyPnL(value);
  const isPercentMode = mode === 'percent';
  const hasPercent = percent !== null && Number.isFinite(percent);
  const formattedPercent = hasPercent
    ? formatSignedPercent(percent, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '';
  const formattedCurrency = sanitizeDisplayValue(formatSignedMoney(value));
  const sanitizedPercent = sanitizeDisplayValue(formattedPercent);
  const formatted = isPercentMode ? sanitizedPercent : formattedCurrency;
  const tooltip = isPercentMode ? formattedCurrency : sanitizedPercent;

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
};

PnlBadge.defaultProps = {
  value: 0,
  percent: null,
};

function isPnlColumn(columnKey) {
  return columnKey === 'dayPnl' || columnKey === 'openPnl';
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
  forceShowTargetColumn = false,
}) {
  const resolvedDirection = sortDirection === 'asc' ? 'asc' : 'desc';
  const initialExternalMode = externalPnlMode === 'percent' || externalPnlMode === 'currency'
    ? externalPnlMode
    : 'currency';

  const [sortState, setSortState] = useState(() => ({
    column: sortColumn,
    direction: resolvedDirection,
    valueMode: isPnlColumn(sortColumn) ? initialExternalMode : null,
  }));
  const [internalPnlMode, setInternalPnlMode] = useState('currency');
  const menuRef = useRef(null);
  const [contextMenuState, setContextMenuState] = useState({ open: false, x: 0, y: 0, position: null });

  const closeContextMenu = useCallback(() => {
    setContextMenuState((state) => {
      if (!state.open) {
        return state;
      }
      return { open: false, x: 0, y: 0, position: null };
    });
  }, []);

  const pnlMode = externalPnlMode === 'percent' || externalPnlMode === 'currency'
    ? externalPnlMode
    : internalPnlMode;

  useEffect(() => {
    setSortState((current) => {
      if (current.column === sortColumn && current.direction === resolvedDirection) {
        return current;
      }
      return {
        column: sortColumn,
        direction: resolvedDirection,
        valueMode: isPnlColumn(sortColumn) ? pnlMode : null,
      };
    });
  }, [sortColumn, resolvedDirection, pnlMode]);

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
      const { dayPnlPercent, openPnlPercent } = derivePercentages(position);
      let share = position.portfolioShare;
      if (typeof share !== 'number') {
        share = aggregateMarketValue > 0 ? ((position.currentMarketValue || 0) / aggregateMarketValue) * 100 : null;
      }
      return {
        ...position,
        portfolioShare: share,
        dayPnlPercent,
        openPnlPercent,
      };
    });
  }, [positions, aggregateMarketValue]);

  const showTargetColumn = useMemo(
    () =>
      forceShowTargetColumn ||
      decoratedPositions.some((position) => hasTargetProportionValue(position)),
    [decoratedPositions, forceShowTargetColumn]
  );

  const activeHeaders = showTargetColumn ? TABLE_HEADERS : TABLE_HEADERS_WITHOUT_TARGET;

  const sortedPositions = useMemo(() => {
    const header = activeHeaders.find((column) => column.key === sortState.column);
    if (!header) {
      return decoratedPositions.slice();
    }
    let accessorOverride = null;
    const effectiveMode = sortState.valueMode === 'percent' ? 'percent' : 'currency';

    if (effectiveMode === 'percent') {
      if (header.key === 'dayPnl') {
        accessorOverride = (row) => row.dayPnlPercent ?? 0;
      } else if (header.key === 'openPnl') {
        accessorOverride = (row) => row.openPnlPercent ?? 0;
      }
    }
    const sorter = compareRows(header, sortState.direction, accessorOverride);
    return decoratedPositions.slice().sort((a, b) => sorter(a, b));
  }, [activeHeaders, decoratedPositions, sortState]);

  const handleSort = useCallback((columnKey) => {
    const header = activeHeaders.find((column) => column.key === columnKey);
    if (!header) {
      return;
    }
    setSortState((current) => {
      let nextState;
      if (current.column === columnKey) {
        let nextDirection = current.direction === 'asc' ? 'desc' : 'asc';
        let nextValueMode = current.valueMode;

        if (isPnlColumn(columnKey)) {
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
          valueMode: isPnlColumn(columnKey) ? pnlMode : null,
        };
      }
      if (typeof onSortChange === 'function') {
        onSortChange({ column: nextState.column, direction: nextState.direction });
      }
      return nextState;
    });
  }, [activeHeaders, onSortChange, pnlMode]);

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
      setContextMenuState({
        open: true,
        x: event.clientX,
        y: event.clientY,
        position,
      });
    },
    []
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
      const provider = event.altKey ? 'yahoo' : 'google';
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

  const tableClassName = showTargetColumn ? 'positions-table' : 'positions-table positions-table--no-target';

  const renderTable = () => (
    <div className={tableClassName} role="table">
      <div className="positions-table__row positions-table__row--head" role="row">
        {activeHeaders.map((column) => {
          const isSorted = column.key === sortState.column;
          const sortDirectionValue = isSorted ? (sortState.direction === 'asc' ? 'ascending' : 'descending') : 'none';
          return (
            <div
              key={column.key}
              role="columnheader"
              aria-sort={sortDirectionValue}
              className={`positions-table__head ${column.className}${isSorted ? ' sorted' : ''}`}
            >
              <button type="button" className="positions-table__head-button" onClick={() => handleSort(column.key)}>
                <span>{column.label}</span>
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
          const currentMarketValue = sanitizeDisplayValue(
            formatMoney(position.currentMarketValue, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          );
          const fallbackKey = `${position.accountNumber || position.accountId || 'row'}:${
            position.symbolId ?? position.symbol ?? index
          }`;
          const rowKey = position.rowId || fallbackKey;
          const normalizedSymbol =
            typeof position.symbol === 'string' ? position.symbol.trim().toUpperCase() : '';
          const symbolLabel =
            typeof position.symbol === 'string' && position.symbol.trim()
              ? position.symbol.trim()
              : position.symbol || 'this symbol';
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

          return (
            <div
              key={rowKey}
              className="positions-table__row positions-table__row--clickable"
              role="row"
              onClick={(event) => handleRowNavigation(event, position.symbol)}
              onContextMenu={(event) => handleRowContextMenu(event, position)}
            >
              <div className="positions-table__cell positions-table__cell--symbol" role="cell">
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
                <div className="positions-table__symbol-name" title={symbolTooltip || ''}>
                  {displayDescription}
                </div>
              </div>
              <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                <PnlBadge
                  value={position.dayPnl}
                  percent={position.dayPnlPercent}
                  mode={pnlMode}
                  onToggle={handleTogglePnlMode}
                />
              </div>
              <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                <PnlBadge
                  value={position.openPnl}
                  percent={position.openPnlPercent}
                  mode={pnlMode}
                  onToggle={handleTogglePnlMode}
                />
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
                <span>{position.currency || ''}</span>
              </div>
              <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                {displayShare}
              </div>
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

  if (embedded) {
    return (
      <>
        {renderTable()}
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
        </header>

        {renderTable()}
      </section>
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
  forceShowTargetColumn: PropTypes.bool,
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
  forceShowTargetColumn: false,
};

export default PositionsTable;
