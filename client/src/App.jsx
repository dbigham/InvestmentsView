import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import AccountSelector from './components/AccountSelector';
import SummaryMetrics from './components/SummaryMetrics';
import TodoSummary from './components/TodoSummary';
import PositionsTable from './components/PositionsTable';
import OrdersTable from './components/OrdersTable';
import {
  getSummary,
  getQqqTemperature,
  getQuote,
  getInvestmentModelTemperature,
  getBenchmarkReturns,
  markAccountRebalanced,
  getTotalPnlSeries,
  setAccountTargetProportions,
  getPortfolioNews,
  setAccountSymbolNotes,
  setAccountPlanningContext,
} from './api/questrade';
import usePersistentState from './hooks/usePersistentState';
import PeopleDialog from './components/PeopleDialog';
import PnlHeatmapDialog from './components/PnlHeatmapDialog';
import InvestEvenlyDialog from './components/InvestEvenlyDialog';
import DeploymentAdjustmentDialog from './components/DeploymentAdjustmentDialog';
import AnnualizedReturnDialog from './components/AnnualizedReturnDialog';
import QqqTemperatureSection from './components/QqqTemperatureSection';
import QqqTemperatureDialog from './components/QqqTemperatureDialog';
import TotalPnlDialog from './components/TotalPnlDialog';
import CashBreakdownDialog from './components/CashBreakdownDialog';
import DividendBreakdown from './components/DividendBreakdown';
import TargetProportionsDialog from './components/TargetProportionsDialog';
import PortfolioNews from './components/PortfolioNews';
import SymbolNotesDialog from './components/SymbolNotesDialog';
import PlanningContextDialog from './components/PlanningContextDialog';
import { formatMoney, formatNumber, formatDate } from './utils/formatters';
import { copyTextToClipboard } from './utils/clipboard';
import { openChatGpt } from './utils/chat';
import { buildAccountSummaryUrl } from './utils/questrade';
import {
  buildAccountViewUrl,
  readAccountIdFromLocation,
  readTodoActionFromLocation,
  readTodoReminderFromLocation,
} from './utils/navigation';
import './App.css';

const DEFAULT_POSITIONS_SORT = { column: 'portfolioShare', direction: 'desc' };
const EMPTY_OBJECT = Object.freeze({});
const MODEL_CHART_DEFAULT_START_DATE = '1980-01-01';
const MAX_NEWS_SYMBOLS = 24;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DIVIDEND_TIMEFRAME_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: '1y', label: 'Last year' },
  { value: '6m', label: 'Last 6 months' },
  { value: '1m', label: 'Last month' },
  { value: '1w', label: 'Last week' },
  { value: '1d', label: 'Last day' },
];

const DEFAULT_DIVIDEND_TIMEFRAME = DIVIDEND_TIMEFRAME_OPTIONS[0].value;

function extractTargetProportionsFromSymbols(symbols) {
  if (!symbols) {
    return null;
  }

  const entries = [];

  const recordEntry = (symbolCandidate, entryValue) => {
    if (!entryValue || typeof entryValue !== 'object') {
      return;
    }
    const symbol = typeof symbolCandidate === 'string' ? symbolCandidate.trim().toUpperCase() : '';
    if (!symbol) {
      return;
    }
    const percent = Number(entryValue.targetProportion);
    if (!Number.isFinite(percent)) {
      return;
    }
    entries.push([symbol, percent]);
  };

  if (symbols instanceof Map) {
    symbols.forEach((entryValue, symbolCandidate) => {
      recordEntry(symbolCandidate, entryValue);
    });
  } else if (typeof symbols === 'object') {
    Object.entries(symbols).forEach(([symbolCandidate, entryValue]) => {
      recordEntry(symbolCandidate, entryValue);
    });
  } else {
    return null;
  }

  if (!entries.length) {
    return null;
  }

  entries.sort((a, b) => a[0].localeCompare(b[0]));

  return entries.reduce((acc, [symbol, percent]) => {
    acc[symbol] = percent;
    return acc;
  }, {});
}

function parseDateOnly(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split('-');
  if (parts.length === 3) {
    const year = Number(parts[0]);
    const month = Number(parts[1]) - 1;
    const day = Number(parts[2]);
    if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
      const timestamp = Date.UTC(year, month, day);
      if (!Number.isNaN(timestamp)) {
        return { date: new Date(timestamp), time: timestamp };
      }
    }
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  const timestamp = Date.UTC(
    parsed.getUTCFullYear(),
    parsed.getUTCMonth(),
    parsed.getUTCDate()
  );
  if (Number.isNaN(timestamp)) {
    return null;
  }
  return { date: new Date(timestamp), time: timestamp };
}

function normalizePositiveInteger(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    const rounded = Math.round(value);
    return Number.isFinite(rounded) && rounded > 0 ? rounded : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    const rounded = Math.round(numeric);
    return Number.isFinite(rounded) && rounded > 0 ? rounded : null;
  }
  if (typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'value')) {
      return normalizePositiveInteger(value.value);
    }
  }
  return null;
}

function normalizeAccountGroupKey(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const stringValue = typeof value === 'string' ? value : String(value);
  if (!stringValue) {
    return null;
  }
  const normalized = stringValue.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }
  return normalized.toLowerCase();
}

function buildInvestmentModelChartKey(modelConfig) {
  if (!modelConfig || typeof modelConfig !== 'object') {
    return null;
  }
  const modelName = typeof modelConfig.model === 'string' ? modelConfig.model.trim() : '';
  if (!modelName) {
    return null;
  }
  const parts = [modelName.toUpperCase()];
  const baseSymbol = typeof modelConfig.symbol === 'string' ? modelConfig.symbol.trim().toUpperCase() : '';
  if (baseSymbol) {
    parts.push(`base:${baseSymbol}`);
  }
  const leveragedSymbol =
    typeof modelConfig.leveragedSymbol === 'string' ? modelConfig.leveragedSymbol.trim().toUpperCase() : '';
  if (leveragedSymbol) {
    parts.push(`lev:${leveragedSymbol}`);
  }
  const reserveSymbol =
    typeof modelConfig.reserveSymbol === 'string' ? modelConfig.reserveSymbol.trim().toUpperCase() : '';
  if (reserveSymbol) {
    parts.push(`res:${reserveSymbol}`);
  }
  return parts.join('|');
}

function resolveAccountModelsForDisplay(account) {
  if (!account || typeof account !== 'object') {
    return [];
  }

  const rawModels = Array.isArray(account.investmentModels) ? account.investmentModels : [];
  const normalized = rawModels
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const rawModel = typeof entry.model === 'string' ? entry.model.trim() : '';
      if (!rawModel) {
        return null;
      }
      const normalizedEntry = { model: rawModel };
      if (typeof entry.symbol === 'string' && entry.symbol.trim()) {
        normalizedEntry.symbol = entry.symbol.trim();
      }
      if (typeof entry.leveragedSymbol === 'string' && entry.leveragedSymbol.trim()) {
        normalizedEntry.leveragedSymbol = entry.leveragedSymbol.trim();
      }
      if (typeof entry.reserveSymbol === 'string' && entry.reserveSymbol.trim()) {
        normalizedEntry.reserveSymbol = entry.reserveSymbol.trim();
      }
      if (typeof entry.lastRebalance === 'string' && entry.lastRebalance.trim()) {
        normalizedEntry.lastRebalance = entry.lastRebalance.trim();
      }
      const normalizedPeriod = normalizePositiveInteger(entry.rebalancePeriod);
      if (normalizedPeriod !== null) {
        normalizedEntry.rebalancePeriod = normalizedPeriod;
      }
      if (typeof entry.title === 'string' && entry.title.trim()) {
        normalizedEntry.title = entry.title.trim();
      }
      return normalizedEntry;
    })
    .filter(Boolean);

  if (normalized.length) {
    return normalized;
  }

  const fallbackModel = typeof account.investmentModel === 'string' ? account.investmentModel.trim() : '';
  if (!fallbackModel) {
    return [];
  }

  const fallbackEntry = { model: fallbackModel };
  if (
    typeof account.investmentModelLastRebalance === 'string' &&
    account.investmentModelLastRebalance.trim()
  ) {
    fallbackEntry.lastRebalance = account.investmentModelLastRebalance.trim();
  }
  const fallbackPeriod = normalizePositiveInteger(account.rebalancePeriod);
  if (fallbackPeriod !== null) {
    fallbackEntry.rebalancePeriod = fallbackPeriod;
  }

  return [fallbackEntry];
}

function getAccountLabel(account) {
  if (!account || typeof account !== 'object') {
    return '';
  }
  const displayName = typeof account.displayName === 'string' ? account.displayName.trim() : '';
  if (displayName) {
    return displayName;
  }
  const name = typeof account.name === 'string' ? account.name.trim() : '';
  if (name) {
    return name;
  }
  const number = typeof account.number === 'string' ? account.number.trim() : '';
  if (number) {
    return number;
  }
  return '';
}

function isAccountGroupSelection(value) {
  if (typeof value !== 'string') {
    return false;
  }
  return value.startsWith('group:');
}

function isAggregateAccountSelection(value) {
  return value === 'all' || isAccountGroupSelection(value);
}

function extractSymbolsForNews(positions) {
  if (!Array.isArray(positions) || positions.length === 0) {
    return [];
  }
  const seen = new Set();
  const symbols = [];
  for (let index = 0; index < positions.length; index += 1) {
    const position = positions[index];
    const rawSymbol = position && typeof position.symbol === 'string' ? position.symbol.trim() : '';
    if (!rawSymbol) {
      continue;
    }
    const normalized = rawSymbol.toUpperCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    symbols.push(normalized);
    if (symbols.length >= MAX_NEWS_SYMBOLS) {
      break;
    }
  }
  return symbols;
}

function normalizeModelAction(action) {
  if (!action) {
    return '';
  }
  const raw = String(action).trim().toLowerCase();
  if (!raw) {
    return '';
  }
  return raw.replace(/[^a-z0-9]+/g, ' ').trim();
}

function isRebalanceAction(action) {
  const normalized = normalizeModelAction(action);
  return normalized.includes('rebalance');
}

function isHoldAction(action) {
  const normalized = normalizeModelAction(action);
  return normalized === '' || normalized === 'hold';
}

function getModelActionPriority(action) {
  if (isRebalanceAction(action)) {
    return 0;
  }
  if (isHoldAction(action)) {
    return 2;
  }
  return 1;
}

function getModelSectionPriority(section) {
  if (!section || typeof section !== 'object') {
    return 2;
  }
  const basePriority = getModelActionPriority(section.evaluationAction);
  if (basePriority === 2) {
    const status = section.evaluationStatus;
    if (status && status !== 'ok') {
      return 1;
    }
  }
  return basePriority;
}

function formatQuantity(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '—';
  }
  const numeric = Number(value);
  const hasFraction = Math.abs(numeric % 1) > 0.0000001;
  return formatNumber(numeric, {
    minimumFractionDigits: hasFraction ? 4 : 0,
    maximumFractionDigits: hasFraction ? 4 : 0,
  });
}

function formatPortfolioShare(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '—';
  }
  const numeric = Number(value);
  return `${formatNumber(numeric, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function buildPositionsAllocationTable(positions) {
  if (!Array.isArray(positions) || positions.length === 0) {
    return 'No positions';
  }

  const columns = [
    {
      key: 'symbol',
      label: 'Symbol',
      getValue: (row) => (row.symbol ? String(row.symbol).trim() : '—'),
    },
    {
      key: 'portfolioShare',
      label: '% of portfolio',
      getValue: (row) => formatPortfolioShare(row.portfolioShare),
    },
    {
      key: 'targetProportion',
      label: 'Target %',
      getValue: (row) => {
        if (!Number.isFinite(row.targetProportion)) {
          return '—';
        }
        return `${formatNumber(row.targetProportion, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}%`;
      },
    },
    {
      key: 'shares',
      label: 'Shares',
      getValue: (row) => {
        const formattedQuantity = formatQuantity(row.openQuantity);
        if (formattedQuantity === '—') {
          return '—';
        }
        const numericQuantity = Number(row.openQuantity);
        const isSingular = Number.isFinite(numericQuantity) && Math.abs(numericQuantity - 1) < 1e-9;
        return `${formattedQuantity} ${isSingular ? 'share' : 'shares'}`;
      },
    },
    {
      key: 'currentValue',
      label: 'Current value',
      getValue: (row) => {
        const formattedValue = formatMoney(row.currentMarketValue);
        if (formattedValue === '—') {
          return '—';
        }
        const currency = row.currency ? String(row.currency).trim().toUpperCase() : '';
        return currency ? `${formattedValue} ${currency}` : formattedValue;
      },
    },
  ];

  const rows = positions.map((position) => {
    return columns.map((column) => {
      try {
        return column.getValue(position) ?? '—';
      } catch (error) {
        console.error('Failed to format column', column.key, error);
        return '—';
      }
    });
  });

  const header = columns.map((column) => column.label);
  const widths = header.map((label, columnIndex) => {
    const maxRowWidth = rows.reduce((max, row) => {
      const value = row[columnIndex];
      const length = typeof value === 'string' ? value.length : String(value ?? '').length;
      return Math.max(max, length);
    }, 0);
    return Math.max(label.length, maxRowWidth);
  });

  const formatRow = (cells) => {
    return cells
      .map((cell, index) => {
        const value = typeof cell === 'string' ? cell : String(cell ?? '');
        return value.padEnd(widths[index], ' ');
      })
      .join('  ');
  };

  const lines = [];
  lines.push(formatRow(header));
  lines.push(
    widths
      .map((width) => {
        return '-'.repeat(width);
      })
      .join('  ')
  );
  rows.forEach((row) => {
    lines.push(formatRow(row));
  });

  const noteEntries = [];
  const seenNotes = new Set();

  const appendNoteEntry = (label, note) => {
    if (!label) {
      return;
    }
    if (typeof note !== 'string') {
      return;
    }
    const trimmed = note.trim();
    if (!trimmed) {
      return;
    }
    const normalized = trimmed.replace(/\r\n/g, '\n');
    const key = `${label}\n${normalized}`;
    if (seenNotes.has(key)) {
      return;
    }
    seenNotes.add(key);
    const noteLines = normalized.split('\n');
    noteLines.forEach((line, index) => {
      if (index === 0) {
        noteEntries.push(`${label}: ${line}`);
      } else {
        noteEntries.push(`  ${line}`);
      }
    });
  };

  positions.forEach((position) => {
    const symbolLabel = position && position.symbol ? String(position.symbol).trim().toUpperCase() : '';
    if (!symbolLabel) {
      return;
    }
    let appended = false;
    if (Array.isArray(position.accountNotes) && position.accountNotes.length) {
      position.accountNotes.forEach((entry) => {
        const noteValue = typeof entry?.notes === 'string' ? entry.notes : '';
        if (!noteValue.trim()) {
          return;
        }
        const accountLabel = entry?.accountDisplayName || entry?.accountNumber || entry?.accountId || null;
        const label = accountLabel ? `${symbolLabel} (${accountLabel})` : symbolLabel;
        appendNoteEntry(label, noteValue);
        appended = true;
      });
    }
    if (!appended) {
      appendNoteEntry(symbolLabel, typeof position.notes === 'string' ? position.notes : '');
    }
  });

  if (noteEntries.length) {
    lines.push('');
    lines.push('Notes:');
    noteEntries.forEach((entry) => {
      lines.push(entry);
    });
  }

  return lines.join('\n');
}

function buildClipboardSummary({ positions, planningContext }) {
  const sections = [];

  if (planningContext && typeof planningContext === 'string') {
    const trimmedContext = planningContext.trim();
    if (trimmedContext) {
      sections.push(`Account context:\n${trimmedContext}`);
    }
  }

  const allocation = buildPositionsAllocationTable(positions);
  if (allocation) {
    sections.push(allocation);
  }

  return sections.join('\n\n');
}

function createEmptyDividendSummary() {
  return {
    entries: [],
    totalsByCurrency: {},
    totalCad: 0,
    totalCount: 0,
    conversionIncomplete: false,
    startDate: null,
    endDate: null,
  };
}

function resolveDividendSummaryForTimeframe(summary, timeframeKey) {
  if (!summary || typeof summary !== 'object') {
    return null;
  }
  const normalizedKey = typeof timeframeKey === 'string' && timeframeKey ? timeframeKey : 'all';
  if (normalizedKey === 'all') {
    return summary;
  }
  const map =
    summary.timeframes && typeof summary.timeframes === 'object' && !Array.isArray(summary.timeframes)
      ? summary.timeframes
      : null;
  if (map) {
    const match = map[normalizedKey];
    if (match && typeof match === 'object') {
      return match;
    }
    const fallback = map.all;
    if (fallback && typeof fallback === 'object') {
      return fallback;
    }
  }
  return summary;
}

function parseDateLike(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
}

function aggregateDividendSummaries(dividendsByAccount, accountIds, timeframeKey = 'all') {
  if (!dividendsByAccount || typeof dividendsByAccount !== 'object') {
    return createEmptyDividendSummary();
  }

  const seenIds = new Set();
  const normalizedIds = [];
  if (Array.isArray(accountIds)) {
    accountIds.forEach((accountId) => {
      if (accountId === null || accountId === undefined) {
        return;
      }
      const key = String(accountId);
      if (!key || seenIds.has(key)) {
        return;
      }
      seenIds.add(key);
      normalizedIds.push(key);
    });
  }

  if (!normalizedIds.length) {
    return createEmptyDividendSummary();
  }

  const entryMap = new Map();
  const totalsByCurrency = new Map();
  let totalCad = 0;
  let totalCadHasValue = false;
  let totalCount = 0;
  let conversionIncomplete = false;
  let aggregateStart = null;
  let aggregateEnd = null;
  let processedSummary = false;

  const normalizeCurrencyKey = (currency) => {
    if (typeof currency === 'string' && currency.trim()) {
      return currency.trim().toUpperCase();
    }
    return '';
  };

  normalizedIds.forEach((accountId) => {
    const container = dividendsByAccount[accountId];
    const summary = resolveDividendSummaryForTimeframe(container, timeframeKey);
    if (!summary || typeof summary !== 'object') {
      return;
    }
    processedSummary = true;

    const summaryTotals =
      summary.totalsByCurrency && typeof summary.totalsByCurrency === 'object'
        ? summary.totalsByCurrency
        : {};

    Object.entries(summaryTotals).forEach(([currency, value]) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        return;
      }
      const key = normalizeCurrencyKey(currency);
      const current = totalsByCurrency.get(key) || 0;
      totalsByCurrency.set(key, current + numeric);
    });

    if (Number.isFinite(summary.totalCad)) {
      totalCad += summary.totalCad;
      totalCadHasValue = true;
    }

    if (Number.isFinite(summary.totalCount)) {
      totalCount += summary.totalCount;
    }

    if (summary.conversionIncomplete) {
      conversionIncomplete = true;
    }

    const summaryStart = parseDateLike(summary.startDate);
    if (summaryStart && (!aggregateStart || summaryStart < aggregateStart)) {
      aggregateStart = summaryStart;
    }
    const summaryEnd = parseDateLike(summary.endDate);
    if (summaryEnd && (!aggregateEnd || summaryEnd > aggregateEnd)) {
      aggregateEnd = summaryEnd;
    }

    const entries = Array.isArray(summary.entries) ? summary.entries : [];
    entries.forEach((entry) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }

      const canonicalSymbol =
        typeof entry.symbol === 'string' && entry.symbol.trim() ? entry.symbol.trim() : '';
      const displaySymbol =
        typeof entry.displaySymbol === 'string' && entry.displaySymbol.trim()
          ? entry.displaySymbol.trim()
          : '';
      const description =
        typeof entry.description === 'string' && entry.description.trim()
          ? entry.description.trim()
          : '';
      const rawSymbolsArray = Array.isArray(entry.rawSymbols) ? entry.rawSymbols : [];
      const rawSymbolLabel = rawSymbolsArray
        .map((raw) => (typeof raw === 'string' ? raw.trim() : ''))
        .filter(Boolean)
        .join('|');

      const entryKey =
        canonicalSymbol || displaySymbol || rawSymbolLabel || description || `entry-${entryMap.size}`;

      let aggregateEntry = entryMap.get(entryKey);
      if (!aggregateEntry) {
        aggregateEntry = {
          symbol: canonicalSymbol || null,
          displaySymbol: displaySymbol || canonicalSymbol || null,
          rawSymbols: new Set(),
          description: description || null,
          currencyTotals: new Map(),
          cadAmount: 0,
          cadAmountHasValue: false,
          conversionIncomplete: false,
          activityCount: 0,
          firstDate: null,
          lastDate: null,
          lastTimestamp: null,
          lastAmount: null,
          lastCurrency: null,
        };
        entryMap.set(entryKey, aggregateEntry);
      } else {
        if (!aggregateEntry.symbol && canonicalSymbol) {
          aggregateEntry.symbol = canonicalSymbol;
        }
        if (!aggregateEntry.displaySymbol && (displaySymbol || canonicalSymbol)) {
          aggregateEntry.displaySymbol = displaySymbol || canonicalSymbol;
        }
        if (!aggregateEntry.description && description) {
          aggregateEntry.description = description;
        }
      }

      rawSymbolsArray.forEach((raw) => {
        if (typeof raw === 'string' && raw.trim()) {
          aggregateEntry.rawSymbols.add(raw.trim());
        }
      });

      const entryTotals =
        entry.currencyTotals && typeof entry.currencyTotals === 'object'
          ? entry.currencyTotals
          : {};
      Object.entries(entryTotals).forEach(([currency, value]) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
          return;
        }
        const key = normalizeCurrencyKey(currency);
        const current = aggregateEntry.currencyTotals.get(key) || 0;
        aggregateEntry.currencyTotals.set(key, current + numeric);
      });

      const cadAmount = Number(entry.cadAmount);
      if (Number.isFinite(cadAmount)) {
        aggregateEntry.cadAmount += cadAmount;
        aggregateEntry.cadAmountHasValue = true;
      }

      if (entry.conversionIncomplete) {
        aggregateEntry.conversionIncomplete = true;
      }

      const activityCount = Number(entry.activityCount);
      if (Number.isFinite(activityCount)) {
        aggregateEntry.activityCount += activityCount;
      }

      const entryFirst = parseDateLike(entry.firstDate || entry.startDate);
      if (entryFirst && (!aggregateEntry.firstDate || entryFirst < aggregateEntry.firstDate)) {
        aggregateEntry.firstDate = entryFirst;
      }

      const entryLast = parseDateLike(entry.lastDate || entry.endDate);
      if (entryLast && (!aggregateEntry.lastDate || entryLast > aggregateEntry.lastDate)) {
        aggregateEntry.lastDate = entryLast;
      }

      const entryTimestamp = parseDateLike(entry.lastTimestamp || entry.lastDate || entry.endDate);
      if (entryTimestamp && (!aggregateEntry.lastTimestamp || entryTimestamp > aggregateEntry.lastTimestamp)) {
        aggregateEntry.lastTimestamp = entryTimestamp;
        const lastAmount = Number(entry.lastAmount);
        aggregateEntry.lastAmount = Number.isFinite(lastAmount) ? lastAmount : null;
        aggregateEntry.lastCurrency =
          typeof entry.lastCurrency === 'string' && entry.lastCurrency.trim()
            ? entry.lastCurrency.trim().toUpperCase()
            : null;
      }
    });
  });

  if (!processedSummary) {
    return createEmptyDividendSummary();
  }

  let computedStart = aggregateStart;
  let computedEnd = aggregateEnd;

  const finalEntries = Array.from(entryMap.values()).map((entry) => {
    if (entry.firstDate && (!computedStart || entry.firstDate < computedStart)) {
      computedStart = entry.firstDate;
    }
    if (entry.lastDate && (!computedEnd || entry.lastDate > computedEnd)) {
      computedEnd = entry.lastDate;
    }

    const rawSymbols = Array.from(entry.rawSymbols);
    const currencyTotalsObject = {};
    entry.currencyTotals.forEach((value, currency) => {
      currencyTotalsObject[currency] = value;
    });

    const cadAmount = entry.cadAmountHasValue ? entry.cadAmount : null;
    const magnitude =
      cadAmount !== null
        ? Math.abs(cadAmount)
        : Array.from(entry.currencyTotals.values()).reduce((sum, value) => sum + Math.abs(value), 0);

    return {
      symbol: entry.symbol || null,
      displaySymbol:
        entry.displaySymbol || entry.symbol || (rawSymbols.length ? rawSymbols[0] : null) || null,
      rawSymbols: rawSymbols.length ? rawSymbols : undefined,
      description: entry.description || null,
      currencyTotals: currencyTotalsObject,
      cadAmount,
      conversionIncomplete: entry.conversionIncomplete || undefined,
      activityCount: entry.activityCount,
      firstDate: entry.firstDate ? entry.firstDate.toISOString().slice(0, 10) : null,
      lastDate: entry.lastDate ? entry.lastDate.toISOString().slice(0, 10) : null,
      lastTimestamp: entry.lastTimestamp ? entry.lastTimestamp.toISOString() : null,
      lastAmount: Number.isFinite(entry.lastAmount) ? entry.lastAmount : null,
      lastCurrency: entry.lastCurrency || null,
      _magnitude: magnitude,
    };
  });

  finalEntries.sort((a, b) => (b._magnitude || 0) - (a._magnitude || 0));

  const cleanedEntries = finalEntries.map((entry) => {
    const cleaned = { ...entry };
    delete cleaned._magnitude;
    if (!cleaned.rawSymbols) {
      delete cleaned.rawSymbols;
    }
    if (!cleaned.conversionIncomplete) {
      delete cleaned.conversionIncomplete;
    }
    return cleaned;
  });

  const totalsByCurrencyObject = {};
  totalsByCurrency.forEach((value, currency) => {
    totalsByCurrencyObject[currency] = value;
  });

  return {
    entries: cleanedEntries,
    totalsByCurrency: totalsByCurrencyObject,
    totalCad: totalCadHasValue ? totalCad : null,
    totalCount,
    conversionIncomplete: conversionIncomplete || undefined,
    startDate: computedStart ? computedStart.toISOString().slice(0, 10) : null,
    endDate: computedEnd ? computedEnd.toISOString().slice(0, 10) : null,
  };
}

function useSummaryData(accountNumber, refreshKey) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const lastAccountRef = useRef();

  useEffect(() => {
    let cancelled = false;
    const previousAccount = lastAccountRef.current;
    const isSameAccount = previousAccount === accountNumber;
    lastAccountRef.current = accountNumber;

    setState((prev) => {
      const nextData = isSameAccount ? prev.data : null;
      return { loading: true, data: nextData, error: null };
    });

    getSummary(accountNumber)
      .then((summary) => {
        if (!cancelled) {
          setState({ loading: false, data: summary, error: null });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState((prev) => ({
            loading: false,
            data: isSameAccount ? prev.data : null,
            error,
          }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [accountNumber, refreshKey]);

  return state;
}

function sortCurrencyKeys(keys) {
  const preferredOrder = { CAD: 0, USD: 1 };
  return keys
    .slice()
    .sort((a, b) => {
      const rankA = preferredOrder[a] ?? 99;
      const rankB = preferredOrder[b] ?? 99;
      if (rankA !== rankB) {
        return rankA - rankB;
      }
      return a.localeCompare(b);
    });
}

function buildCurrencyOptions(balances) {
  if (!balances) {
    return [];
  }
  const options = [];

  if (balances.combined) {
    sortCurrencyKeys(Object.keys(balances.combined)).forEach((currency) => {
      options.push({
        value: `combined:${currency}`,
        label: `Combined in ${currency}`,
        scope: 'combined',
        currency,
      });
    });
  }

  if (balances.perCurrency) {
    sortCurrencyKeys(Object.keys(balances.perCurrency)).forEach((currency) => {
      options.push({
        value: `currency:${currency}`,
        label: currency,
        scope: 'perCurrency',
        currency,
      });
    });
  }

  return options;
}

function resolveTotalPnl(position) {
  const marketValue = position.currentMarketValue || 0;
  const totalCost =
    position.totalCost !== undefined && position.totalCost !== null
      ? position.totalCost
      : marketValue - (position.openPnl || 0) - (position.dayPnl || 0);
  return marketValue - (totalCost || 0);
}

function buildPnlSummaries(positions) {
  return positions.reduce(
    (acc, position) => {
      const currency = (position.currency || 'CAD').toUpperCase();
      if (!acc.perCurrency[currency]) {
        acc.perCurrency[currency] = { dayPnl: 0, openPnl: 0, totalPnl: 0 };
      }

      const day = position.dayPnl || 0;
      const open = position.openPnl || 0;
      const total = resolveTotalPnl(position);

      acc.perCurrency[currency].dayPnl += day;
      acc.perCurrency[currency].openPnl += open;
      acc.perCurrency[currency].totalPnl += total;

      acc.combined.dayPnl += day;
      acc.combined.openPnl += open;
      acc.combined.totalPnl += total;

      return acc;
    },
    { combined: { dayPnl: 0, openPnl: 0, totalPnl: 0 }, perCurrency: {} }
  );
}


function coerceNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const isParenthesized = /^\(.*\)$/.test(trimmed);
    const normalized = trimmed.replace(/[^0-9.-]/g, '');
    if (!normalized) {
      return null;
    }
    const numeric = Number(normalized);
    if (!Number.isNaN(numeric)) {
      return isParenthesized ? -numeric : numeric;
    }
  }
  return null;
}

function coercePositiveNumber(value) {
  const numeric = coerceNumber(value);
  if (numeric === null || !Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}

function normalizePriceOverrides(overrides) {
  const map = new Map();
  if (!overrides) {
    return map;
  }

  const entries =
    overrides instanceof Map
      ? Array.from(overrides.entries())
      : typeof overrides === 'object'
        ? Object.entries(overrides)
        : [];

  entries.forEach(([key, value]) => {
    const symbol = typeof key === 'string' ? key.trim().toUpperCase() : '';
    if (!symbol) {
      return;
    }

    const payload = value && typeof value === 'object' ? value : { price: value };
    const price = coercePositiveNumber(payload.price);
    if (!price) {
      return;
    }

    const currency =
      typeof payload.currency === 'string' && payload.currency.trim()
        ? payload.currency.trim().toUpperCase()
        : null;
    const description = typeof payload.description === 'string' ? payload.description : null;
    map.set(symbol, { price, currency, description });
  });

  return map;
}

function resolvePriceOverride(priceOverrides, symbol) {
  if (!symbol) {
    return null;
  }
  const normalizedSymbol = symbol.trim().toUpperCase();
  if (!normalizedSymbol) {
    return null;
  }
  if (!priceOverrides || !(priceOverrides instanceof Map)) {
    return null;
  }
  return priceOverrides.get(normalizedSymbol) || null;
}

function buildBalancePnlMap(balances) {
  const result = { combined: {}, perCurrency: {} };
  if (!balances) {
    return result;
  }
  ['combined', 'perCurrency'].forEach((scope) => {
    const scopeBalances = balances[scope];
    if (!scopeBalances) {
      return;
    }
    Object.entries(scopeBalances).forEach(([currency, data]) => {
      if (!data) {
        return;
      }
      const day = coerceNumber(data.dayPnl ?? data.dayPnL);
      const open = coerceNumber(data.openPnl ?? data.openPnL);
      const total = coerceNumber(
        data.totalPnl ?? data.totalPnL ?? data.unrealizedPnl ?? data.totalReturn ?? data.totalGain
      );
      if (day === null && open === null && total === null) {
        return;
      }
      result[scope][currency] = {
        dayPnl: day,
        openPnl: open,
        totalPnl: total,
      };
    });
  });
  return result;
}

function resolveDisplayTotalEquity(balances) {
  if (!balances || !balances.combined) {
    return null;
  }
  const cadBucket = balances.combined.CAD;
  const cadValue = coerceNumber(cadBucket?.totalEquity);
  if (cadValue !== null) {
    return cadValue;
  }
  const combinedEntries = Object.values(balances.combined);
  for (const entry of combinedEntries) {
    const totalEquity = coerceNumber(entry?.totalEquity);
    if (totalEquity !== null) {
      return totalEquity;
    }
  }
  return null;
}

const ZERO_PNL = Object.freeze({ dayPnl: 0, openPnl: 0, totalPnl: 0 });
const MINIMUM_CASH_BREAKDOWN_AMOUNT = 5;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function convertAmountToCurrency(value, sourceCurrency, targetCurrency, currencyRates, baseCurrency = 'CAD') {
  if (!isFiniteNumber(value)) {
    return 0;
  }

  const normalizedBase = (baseCurrency || 'CAD').toUpperCase();
  const normalizedSource = (sourceCurrency || normalizedBase).toUpperCase();
  const normalizedTarget = (targetCurrency || normalizedBase).toUpperCase();

  const sourceRate = currencyRates?.get(normalizedSource);
  let baseValue = null;
  if (isFiniteNumber(sourceRate) && sourceRate > 0) {
    baseValue = value * sourceRate;
  } else if (normalizedSource === normalizedBase) {
    baseValue = value;
  }

  if (baseValue === null) {
    return 0;
  }

  if (normalizedTarget === normalizedBase) {
    return baseValue;
  }

  const targetRate = currencyRates?.get(normalizedTarget);
  if (isFiniteNumber(targetRate) && targetRate > 0) {
    return baseValue / targetRate;
  }

  return baseValue;
}

function convertCombinedPnl(perCurrencySummary, currencyRates, targetCurrency, baseCurrency = 'CAD') {
  const result = { dayPnl: 0, openPnl: 0, totalPnl: 0 };
  if (!perCurrencySummary) {
    return result;
  }

  Object.entries(perCurrencySummary).forEach(([currency, summary]) => {
    if (!summary) {
      return;
    }
    const normalizedCurrency = (currency || baseCurrency).toUpperCase();
    result.dayPnl += convertAmountToCurrency(
      summary.dayPnl ?? 0,
      normalizedCurrency,
      targetCurrency,
      currencyRates,
      baseCurrency
    );
    result.openPnl += convertAmountToCurrency(
      summary.openPnl ?? 0,
      normalizedCurrency,
      targetCurrency,
      currencyRates,
      baseCurrency
    );
    result.totalPnl += convertAmountToCurrency(
      summary.totalPnl ?? 0,
      normalizedCurrency,
      targetCurrency,
      currencyRates,
      baseCurrency
    );
  });

  return result;
}

function findBalanceEntryForCurrency(balances, currency) {
  if (!balances || !currency) {
    return null;
  }

  const normalizedCurrency = String(currency).trim().toUpperCase();
  const scopes = ['perCurrency', 'combined'];

  for (const scope of scopes) {
    const bucket = balances[scope];
    if (!bucket || typeof bucket !== 'object') {
      continue;
    }

    if (bucket[normalizedCurrency]) {
      return bucket[normalizedCurrency];
    }

    const matchedKey = Object.keys(bucket).find((key) => {
      return key && String(key).trim().toUpperCase() === normalizedCurrency;
    });
    if (matchedKey) {
      return bucket[matchedKey];
    }

    const matchedEntry = Object.values(bucket).find((entry) => {
      return (
        entry &&
        typeof entry === 'object' &&
        typeof entry.currency === 'string' &&
        entry.currency.trim().toUpperCase() === normalizedCurrency
      );
    });
    if (matchedEntry) {
      return matchedEntry;
    }
  }

  return null;
}

function resolveCashForCurrency(balances, currency) {
  const entry = findBalanceEntryForCurrency(balances, currency);
  if (!entry || typeof entry !== 'object') {
    return 0;
  }

  const cashFields = ['cash', 'buyingPower', 'available', 'availableCash'];
  for (const field of cashFields) {
    const value = coerceNumber(entry[field]);
    if (value !== null) {
      return value;
    }
  }

  return 0;
}

function normalizeAccountBalanceSummary(balances) {
  if (!balances || typeof balances !== 'object') {
    return null;
  }
  if (balances.combined || balances.perCurrency) {
    return balances;
  }
  return { combined: balances };
}

function buildCashBreakdownForCurrency({ currency, accountIds, accountsById, accountBalances }) {
  const normalizedCurrency = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  if (!normalizedCurrency) {
    return null;
  }

  if (!Array.isArray(accountIds) || accountIds.length === 0) {
    return null;
  }

  if (!accountsById || typeof accountsById.get !== 'function') {
    return null;
  }

  if (!accountBalances || typeof accountBalances !== 'object') {
    return null;
  }

  const entries = [];

  accountIds.forEach((accountId) => {
    if (!accountId || !accountsById.has(accountId)) {
      return;
    }

    const account = accountsById.get(accountId);
    const balanceSummary = normalizeAccountBalanceSummary(accountBalances[accountId]);
    if (!balanceSummary) {
      return;
    }

    const cashValue = resolveCashForCurrency(balanceSummary, normalizedCurrency);
    if (!Number.isFinite(cashValue)) {
      return;
    }

    if (cashValue <= 0) {
      return;
    }

    if (cashValue < MINIMUM_CASH_BREAKDOWN_AMOUNT - 0.01) {
      return;
    }

    const displayName =
      typeof account.displayName === 'string' && account.displayName.trim()
        ? account.displayName.trim()
        : '';
    const ownerLabel =
      typeof account.ownerLabel === 'string' && account.ownerLabel.trim()
        ? account.ownerLabel.trim()
        : '';
    const accountNumber =
      typeof account.number === 'string' && account.number.trim() ? account.number.trim() : '';

    let primaryName = displayName;
    if (!primaryName) {
      if (ownerLabel && accountNumber) {
        primaryName = `${ownerLabel} ${accountNumber}`;
      } else {
        primaryName = accountNumber || ownerLabel || accountId;
      }
    }

    const subtitleParts = [];
    if (ownerLabel && ownerLabel !== primaryName) {
      subtitleParts.push(ownerLabel);
    }
    if (accountNumber && accountNumber !== primaryName) {
      subtitleParts.push(accountNumber);
    }
    const uniqueSubtitleParts = Array.from(new Set(subtitleParts));
    const subtitle = uniqueSubtitleParts.length ? uniqueSubtitleParts.join(' • ') : null;

    entries.push({
      accountId,
      name: primaryName,
      subtitle,
      amount: cashValue,
    });
  });

  if (!entries.length) {
    return null;
  }

  const total = entries.reduce((sum, entry) => sum + entry.amount, 0);
  if (!(total > 0)) {
    return null;
  }

  const rankedEntries = entries
    .map((entry) => ({
      ...entry,
      percent: (entry.amount / total) * 100,
    }))
    .sort((a, b) => {
      const diff = b.amount - a.amount;
      if (Math.abs(diff) > 0.01) {
        return diff;
      }
      return a.name.localeCompare(b.name);
    });

  return {
    currency: normalizedCurrency,
    total,
    entries: rankedEntries,
  };
}

const TODO_CASH_THRESHOLD = 10;
const TODO_AMOUNT_EPSILON = 0.009;
const TODO_AMOUNT_TOLERANCE = 0.01;
const TODO_TYPE_ORDER = { rebalance: 0, cash: 1 };

const RESERVE_SYMBOLS = new Set(['SGOV', 'BIL', 'VBIL', 'PSA.TO', 'HFR.TO']);
const RESERVE_FALLBACK_SYMBOL = 'VBIL';

function normalizeSymbolKey(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : '';
}

function normalizeQueryValue(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (value !== undefined && value !== null) {
    const stringValue = String(value).trim();
    return stringValue ? stringValue : null;
  }
  return null;
}

function buildTodoItems({ accountIds, accountsById, accountBalances, investmentModelSections }) {
  if (!Array.isArray(accountIds) || accountIds.length === 0) {
    return [];
  }

  const uniqueAccountIds = Array.from(
    new Set(
      accountIds
        .map((accountId) => {
          if (accountId === null || accountId === undefined) {
            return null;
          }
          const normalized = String(accountId).trim();
          return normalized || null;
        })
        .filter(Boolean)
    )
  );

  if (!uniqueAccountIds.length) {
    return [];
  }

  const sectionsByAccount = new Map();
  if (Array.isArray(investmentModelSections)) {
    investmentModelSections.forEach((section) => {
      if (!section || typeof section !== 'object') {
        return;
      }
      const rawAccountId = section.accountId ?? null;
      if (rawAccountId === undefined || rawAccountId === null) {
        return;
      }
      const normalizedAccountId = String(rawAccountId).trim();
      if (!normalizedAccountId) {
        return;
      }
      if (!sectionsByAccount.has(normalizedAccountId)) {
        sectionsByAccount.set(normalizedAccountId, []);
      }
      sectionsByAccount.get(normalizedAccountId).push(section);
    });
  }

  const items = [];

  uniqueAccountIds.forEach((accountId) => {
    const account = accountsById && typeof accountsById.get === 'function' ? accountsById.get(accountId) : null;
    let accountLabel = getAccountLabel(account);
    if (typeof accountLabel === 'string') {
      accountLabel = accountLabel.trim();
    }
    if (!accountLabel) {
      accountLabel = accountId;
    }

    const balanceSummary = normalizeAccountBalanceSummary(
      accountBalances && typeof accountBalances === 'object' ? accountBalances[accountId] : null
    );
    const ignoreSittingCashThreshold =
      account &&
      typeof account.ignoreSittingCash === 'number' &&
      Number.isFinite(account.ignoreSittingCash)
        ? Math.max(0, account.ignoreSittingCash)
        : null;
    if (balanceSummary) {
      ['CAD', 'USD'].forEach((currency) => {
        const cashValue = resolveCashForCurrency(balanceSummary, currency);
        if (
          Number.isFinite(cashValue) &&
          cashValue > 0 &&
          cashValue >= TODO_CASH_THRESHOLD - TODO_AMOUNT_EPSILON
        ) {
          const shouldIgnoreCashTodo =
            ignoreSittingCashThreshold !== null &&
            cashValue <= ignoreSittingCashThreshold + TODO_AMOUNT_EPSILON;
          if (shouldIgnoreCashTodo) {
            return;
          }
          items.push({
            id: `cash:${accountId}:${currency}`,
            type: 'cash',
            accountId,
            accountLabel,
            currency,
            amount: cashValue,
          });
        }
      });
    }

    const sections = sectionsByAccount.get(accountId) || [];
    let accountRebalanceIndex = 0;
    sections.forEach((section) => {
      if (!section || typeof section !== 'object') {
        return;
      }
      if (!isRebalanceAction(section.evaluationAction)) {
        return;
      }
      const title =
        (typeof section.title === 'string' && section.title.trim()) ||
        (typeof section.model === 'string' && section.model.trim()
          ? `${section.model.trim()} Investment Model`
          : 'Investment Model');
      const lastRebalance =
        typeof section.lastRebalance === 'string' && section.lastRebalance.trim()
          ? section.lastRebalance.trim()
          : null;
      const identifierSource =
        (typeof section.model === 'string' && section.model.trim()) ||
        (typeof section.chartKey === 'string' && section.chartKey.trim()) ||
        (typeof section.title === 'string' && section.title.trim()) ||
        `model-${accountRebalanceIndex}`;
      accountRebalanceIndex += 1;
      const modelName = typeof section.model === 'string' ? section.model.trim() : '';
      const chartKey = typeof section.chartKey === 'string' ? section.chartKey.trim() : '';

      items.push({
        id: `rebalance:${accountId}:${identifierSource}`,
        type: 'rebalance',
        accountId,
        accountLabel,
        modelLabel: title,
        lastRebalance,
        model: modelName || null,
        chartKey: chartKey || null,
      });
    });
  });

  items.sort((itemA, itemB) => {
    const labelA = typeof itemA.accountLabel === 'string' ? itemA.accountLabel : '';
    const labelB = typeof itemB.accountLabel === 'string' ? itemB.accountLabel : '';
    if (labelA && labelB) {
      const accountCompare = labelA.localeCompare(labelB, undefined, { sensitivity: 'base' });
      if (accountCompare !== 0) {
        return accountCompare;
      }
    } else if (labelA) {
      return -1;
    } else if (labelB) {
      return 1;
    }

    const typeOrderA = TODO_TYPE_ORDER[itemA.type] ?? 99;
    const typeOrderB = TODO_TYPE_ORDER[itemB.type] ?? 99;
    if (typeOrderA !== typeOrderB) {
      return typeOrderA - typeOrderB;
    }

    if (itemA.type === 'cash' && itemB.type === 'cash') {
      const currencyCompare = (itemA.currency || '').localeCompare(itemB.currency || '', undefined, {
        sensitivity: 'base',
      });
      if (currencyCompare !== 0) {
        return currencyCompare;
      }
      return (itemB.amount || 0) - (itemA.amount || 0);
    }

    if (itemA.type === 'rebalance' && itemB.type === 'rebalance') {
      return (itemA.modelLabel || '').localeCompare(itemB.modelLabel || '', undefined, {
        sensitivity: 'base',
      });
    }

    return (itemA.id || '').localeCompare(itemB.id || '', undefined, { sensitivity: 'base' });
  });

  return items;
}

function amountsApproximatelyEqual(a, b, tolerance = TODO_AMOUNT_TOLERANCE) {
  const numericA = Number(a);
  const numericB = Number(b);
  const hasA = Number.isFinite(numericA);
  const hasB = Number.isFinite(numericB);
  if (!hasA && !hasB) {
    return true;
  }
  if (!hasA || !hasB) {
    return false;
  }
  return Math.abs(numericA - numericB) <= tolerance;
}

function areTodoListsEqual(listA, listB) {
  if (listA === listB) {
    return true;
  }
  if (!Array.isArray(listA) || !Array.isArray(listB)) {
    return false;
  }
  if (listA.length !== listB.length) {
    return false;
  }
  for (let index = 0; index < listA.length; index += 1) {
    const itemA = listA[index];
    const itemB = listB[index];
    if (!itemA && !itemB) {
      continue;
    }
    if (!itemA || !itemB) {
      return false;
    }
    if ((itemA.id || '') !== (itemB.id || '')) {
      return false;
    }
    if ((itemA.type || '') !== (itemB.type || '')) {
      return false;
    }
    if ((itemA.accountId || '') !== (itemB.accountId || '')) {
      return false;
    }
    if ((itemA.accountLabel || '') !== (itemB.accountLabel || '')) {
      return false;
    }
    if (itemA.type === 'cash') {
      if ((itemA.currency || '') !== (itemB.currency || '')) {
        return false;
      }
      if (!amountsApproximatelyEqual(itemA.amount, itemB.amount)) {
        return false;
      }
    } else if (itemA.type === 'rebalance') {
      if ((itemA.modelLabel || '') !== (itemB.modelLabel || '')) {
        return false;
      }
      if ((itemA.lastRebalance || '') !== (itemB.lastRebalance || '')) {
        return false;
      }
      if ((itemA.model || '') !== (itemB.model || '')) {
        return false;
      }
      if ((itemA.chartKey || '') !== (itemB.chartKey || '')) {
        return false;
      }
    } else if ((itemA.title || '') !== (itemB.title || '')) {
      return false;
    }
  }
  return true;
}

function findPositionDetails(positions, symbol) {
  if (!Array.isArray(positions) || !symbol) {
    return null;
  }

  const normalizedSymbol = String(symbol).trim().toUpperCase();
  if (!normalizedSymbol) {
    return null;
  }

  for (const position of positions) {
    if (!position) {
      continue;
    }
    const positionSymbol = position.symbol ? String(position.symbol).trim().toUpperCase() : '';
    if (positionSymbol !== normalizedSymbol) {
      continue;
    }

    const price = coerceNumber(position.currentPrice);
    const currency = typeof position.currency === 'string' ? position.currency.trim().toUpperCase() : null;
    const description = typeof position.description === 'string' ? position.description : null;

    return {
      price: price !== null && price > 0 ? price : null,
      currency,
      description,
    };
  }

  return null;
}

function positionsAlignedWithAccount(positions, accountId) {
  if (!accountId) {
    return true;
  }

  if (!Array.isArray(positions)) {
    return false;
  }

  const normalizedAccountId = String(accountId);

  for (const position of positions) {
    if (!position) {
      continue;
    }

    const rowId = typeof position.rowId === 'string' ? position.rowId : '';
    if (rowId.startsWith('all:')) {
      return false;
    }

    if (position.accountId !== undefined && position.accountId !== null) {
      if (String(position.accountId) !== normalizedAccountId) {
        return false;
      }
    }
  }

  return true;
}

const DLR_SHARE_VALUE_USD = 10;
const CENTS_PER_UNIT = 100;

function alignRoundedAmountsToTotal(purchases) {
  const validPurchases = purchases.filter(
    (purchase) => Number.isFinite(purchase?.amount) && purchase.amount > 0
  );

  if (!validPurchases.length) {
    return 0;
  }

  const rawTotal = validPurchases.reduce((sum, purchase) => sum + purchase.amount, 0);
  const targetCents = Math.round((rawTotal + Number.EPSILON) * CENTS_PER_UNIT);

  const entries = validPurchases.map((purchase, index) => {
    const exactAmount = purchase.amount;
    const exactCents = exactAmount * CENTS_PER_UNIT;
    const flooredCents = Math.floor(exactCents + 1e-6);
    const remainder = exactCents - flooredCents;
    return {
      purchase,
      index,
      flooredCents,
      remainder,
    };
  });

  let allocatedCents = entries.reduce((sum, entry) => sum + entry.flooredCents, 0);
  let penniesToDistribute = targetCents - allocatedCents;

  if (penniesToDistribute > 0) {
    const sorted = [...entries].sort((a, b) => {
      if (b.remainder !== a.remainder) {
        return b.remainder - a.remainder;
      }
      return a.index - b.index;
    });
    let cursor = 0;
    while (penniesToDistribute > 0 && sorted.length) {
      const entry = sorted[cursor % sorted.length];
      entry.flooredCents += 1;
      penniesToDistribute -= 1;
      cursor += 1;
    }
  } else if (penniesToDistribute < 0) {
    const sorted = [...entries].sort((a, b) => {
      if (a.remainder !== b.remainder) {
        return a.remainder - b.remainder;
      }
      return b.purchase.amount - a.purchase.amount;
    });
    let cursor = 0;
    while (penniesToDistribute < 0 && sorted.length) {
      const entry = sorted[cursor % sorted.length];
      if (entry.flooredCents <= 0) {
        cursor += 1;
        if (cursor >= sorted.length) {
          break;
        }
        continue;
      }
      entry.flooredCents -= 1;
      penniesToDistribute += 1;
      cursor += 1;
    }
  }

  let adjustedTotal = 0;
  entries.forEach((entry) => {
    const adjustedAmount = entry.flooredCents / CENTS_PER_UNIT;
    entry.purchase.amount = adjustedAmount;
    adjustedTotal += adjustedAmount;
  });

  return adjustedTotal;
}

function buildInvestEvenlyPlan({
  positions,
  balances,
  currencyRates,
  baseCurrency = 'CAD',
  priceOverrides = null,
  cashOverrides = null,
  skipCadPurchases = false,
  skipUsdPurchases = false,
  targetProportions = null,
  useTargetProportions = false,
}) {
  if (!Array.isArray(positions) || positions.length === 0) {
    return null;
  }

  const normalizedBase = (baseCurrency || 'CAD').toUpperCase();
  const normalizedPriceOverrides = normalizePriceOverrides(priceOverrides);
  const normalizedCashOverrides =
    cashOverrides && typeof cashOverrides === 'object' ? cashOverrides : null;
  const hasCadOverride =
    normalizedCashOverrides && Object.prototype.hasOwnProperty.call(normalizedCashOverrides, 'cad');
  const hasUsdOverride =
    normalizedCashOverrides && Object.prototype.hasOwnProperty.call(normalizedCashOverrides, 'usd');
  const cadOverride = hasCadOverride ? coerceNumber(normalizedCashOverrides.cad) : null;
  const usdOverride = hasUsdOverride ? coerceNumber(normalizedCashOverrides.usd) : null;
  const cadCashRaw = Number.isFinite(cadOverride)
    ? cadOverride
    : resolveCashForCurrency(balances, 'CAD');
  const usdCashRaw = Number.isFinite(usdOverride)
    ? usdOverride
    : resolveCashForCurrency(balances, 'USD');
  const cadCash = Number.isFinite(cadCashRaw) ? cadCashRaw : 0;
  const usdCash = Number.isFinite(usdCashRaw) ? usdCashRaw : 0;

  const cadInBase = normalizeCurrencyAmount(cadCash, 'CAD', currencyRates, normalizedBase);
  const usdInBase = normalizeCurrencyAmount(usdCash, 'USD', currencyRates, normalizedBase);
  const totalCashInBase = cadInBase + usdInBase;
  const skipCadRequested = Boolean(skipCadPurchases);
  const skipUsdRequested = Boolean(skipUsdPurchases);
  const skipCadMode = skipCadRequested && !skipUsdRequested;
  const skipUsdMode = skipUsdRequested && !skipCadRequested;

  const investableBaseTotal = skipCadMode
    ? usdInBase
    : skipUsdMode
    ? cadInBase
    : totalCashInBase;

  if (!Number.isFinite(investableBaseTotal)) {
    return null;
  }

  const requiresPositiveBalance = !skipCadMode && !skipUsdMode;

  if (requiresPositiveBalance && investableBaseTotal <= 0) {
    return null;
  }

  const investablePositions = positions.filter((position) => {
    if (!position) {
      return false;
    }
    const symbol = position.symbol ? String(position.symbol).trim() : '';
    if (!symbol) {
      return false;
    }
    const currency = (position.currency || normalizedBase).toUpperCase();
    if (currency !== 'CAD' && currency !== 'USD') {
      return false;
    }
    const normalizedValue = Number(position.normalizedMarketValue);
    if (!Number.isFinite(normalizedValue) || normalizedValue <= 0) {
      return false;
    }
    const price = Number(position.currentPrice);
    if (!Number.isFinite(price) || price <= 0) {
      return false;
    }
    return true;
  });

  if (!investablePositions.length) {
    return null;
  }

  const supportsCadPurchases = investablePositions.some((position) => {
    const currency = (position.currency || normalizedBase).toUpperCase();
    return currency === 'CAD';
  });

  const supportsUsdPurchases = investablePositions.some((position) => {
    const currency = (position.currency || normalizedBase).toUpperCase();
    return currency === 'USD';
  });

  let activePositions = investablePositions;

  if (skipCadMode) {
    activePositions = investablePositions.filter((position) => {
      const currency = (position.currency || normalizedBase).toUpperCase();
      return currency === 'USD';
    });
  } else if (skipUsdMode) {
    activePositions = investablePositions.filter((position) => {
      const currency = (position.currency || normalizedBase).toUpperCase();
      return currency === 'CAD';
    });
  }

  if (!activePositions.length) {
    return null;
  }

  const targetWeightMap = new Map();
  if (targetProportions instanceof Map) {
    targetProportions.forEach((value, key) => {
      const symbol = typeof key === 'string' ? key.trim().toUpperCase() : null;
      const numeric = Number(value);
      if (symbol && Number.isFinite(numeric) && numeric > 0) {
        targetWeightMap.set(symbol, numeric);
      }
    });
  } else if (targetProportions && typeof targetProportions === 'object') {
    Object.entries(targetProportions).forEach(([key, value]) => {
      const symbol = typeof key === 'string' ? key.trim().toUpperCase() : null;
      const numeric = Number(value);
      if (symbol && Number.isFinite(numeric) && numeric > 0) {
        targetWeightMap.set(symbol, numeric);
      }
    });
  }

  let totalTargetWeight = 0;
  if (targetWeightMap.size) {
    activePositions.forEach((position) => {
      const symbol =
        typeof position.symbol === 'string' && position.symbol.trim()
          ? position.symbol.trim().toUpperCase()
          : null;
      if (!symbol) {
        return;
      }
      const candidate = targetWeightMap.get(symbol);
      if (Number.isFinite(candidate) && candidate > 0) {
        totalTargetWeight += candidate;
      }
    });
  }

  const usingTargetWeights = Boolean(useTargetProportions) && totalTargetWeight > 0;
  const sanitizedTargetProportions = targetWeightMap.size
    ? Array.from(targetWeightMap.entries()).reduce((acc, [symbol, percent]) => {
        acc[symbol] = percent;
        return acc;
      }, {})
    : null;

  const totalNormalizedValue = activePositions.reduce((sum, position) => {
    const value = Number(position.normalizedMarketValue);
    return Number.isFinite(value) && value > 0 ? sum + value : sum;
  }, 0);

  if (!Number.isFinite(totalNormalizedValue) || totalNormalizedValue <= 0) {
    return null;
  }

  const plan = {
    cash: {
      cad: cadCash,
      usd: usdCash,
      totalCad: totalCashInBase,
      investableCad: investableBaseTotal,
      investableCurrency: skipCadMode ? 'USD' : skipUsdMode ? 'CAD' : null,
    },
    baseCurrency: normalizedBase,
    purchases: [],
    totals: {
      cadNeeded: 0,
      usdNeeded: 0,
      cadRemaining: 0,
      usdRemaining: 0,
    },
    conversions: [],
    summaryText: '',
    targetProportions: sanitizedTargetProportions,
    usingTargetProportions: false,
  };

  let totalCadNeeded = 0;
  let totalUsdNeeded = 0;

  const USD_SHARE_PRECISION = 4;
  const usdRate = currencyRates?.get('USD');
  const hasUsdRate = Number.isFinite(usdRate) && usdRate > 0;

  const computePurchaseAllocation = (targetAmount, currency, price) => {
    let shares = 0;
    let spentCurrency = 0;
    let note = '';

    if (price > 0 && targetAmount > 0) {
      if (currency === 'CAD') {
        shares = Math.floor(targetAmount / price);
        spentCurrency = shares * price;
        if (shares === 0) {
          note = 'Insufficient for 1 share';
        }
      } else {
        const factor = Math.pow(10, USD_SHARE_PRECISION);
        shares = Math.floor((targetAmount / price) * factor) / factor;
        spentCurrency = shares * price;
        if (shares === 0) {
          note = 'Insufficient for minimum fractional share';
        }
      }
    }

    if (!Number.isFinite(shares)) {
      shares = 0;
    }
    if (!Number.isFinite(spentCurrency) || spentCurrency < 0) {
      spentCurrency = 0;
    }

    return { shares, spentCurrency, note };
  };

  activePositions.forEach((position) => {
    const symbol = String(position.symbol).trim();
    const currency = (position.currency || normalizedBase).toUpperCase();
    const price = Number(position.currentPrice);
    const normalizedValue = Number(position.normalizedMarketValue);
    const normalizedSymbol = symbol ? symbol.toUpperCase() : '';
    const configuredTarget = normalizedSymbol ? Number(targetWeightMap.get(normalizedSymbol)) : null;
    const allocationWeight = usingTargetWeights
      ? Number.isFinite(configuredTarget) && configuredTarget > 0
        ? configuredTarget / totalTargetWeight
        : 0
      : normalizedValue / totalNormalizedValue;
    const targetCadAmount = investableBaseTotal * (Number.isFinite(allocationWeight) ? allocationWeight : 0);

    let targetCurrencyAmount = targetCadAmount;
    if (currency !== normalizedBase) {
      targetCurrencyAmount = convertAmountToCurrency(
        targetCadAmount,
        normalizedBase,
        currency,
        currencyRates,
        normalizedBase
      );
    }

    if (!Number.isFinite(targetCurrencyAmount) || targetCurrencyAmount <= 0) {
      targetCurrencyAmount = 0;
    }

    const { shares, spentCurrency, note } = computePurchaseAllocation(
      targetCurrencyAmount,
      currency,
      price
    );

    if (currency === 'CAD') {
      totalCadNeeded += spentCurrency;
    } else if (currency === 'USD') {
      totalUsdNeeded += spentCurrency;
    }

    plan.purchases.push({
      symbol,
      description: position.description ?? null,
      currency,
      amount: spentCurrency,
      targetAmount: targetCurrencyAmount,
      shares,
      sharePrecision: currency === 'CAD' ? 0 : USD_SHARE_PRECISION,
      price,
      note: note || null,
      weight: Number.isFinite(allocationWeight) ? allocationWeight : 0,
      targetPercent:
        Number.isFinite(configuredTarget) && configuredTarget > 0 ? configuredTarget : null,
    });
  });

  plan.usingTargetProportions = usingTargetWeights;
  plan.targetWeightTotal = usingTargetWeights ? totalTargetWeight : null;

  const cadShortfall = totalCadNeeded > cadCash ? totalCadNeeded - cadCash : 0;
  const usdShortfall = totalUsdNeeded > usdCash ? totalUsdNeeded - usdCash : 0;

  const dlrToDetails = findPositionDetails(positions, 'DLR.TO');
  const dlrUDetails = findPositionDetails(positions, 'DLR.U.TO');
  const dlrToOverride = resolvePriceOverride(normalizedPriceOverrides, 'DLR.TO');
  const dlrUOverride = resolvePriceOverride(normalizedPriceOverrides, 'DLR.U.TO');

  const dlrToPrice =
    coercePositiveNumber(dlrToOverride?.price) ??
    coercePositiveNumber(dlrToDetails?.price) ??
    (hasUsdRate ? usdRate * DLR_SHARE_VALUE_USD : null);
  const dlrUPrice =
    coercePositiveNumber(dlrUOverride?.price) ??
    coercePositiveNumber(dlrUDetails?.price) ??
    DLR_SHARE_VALUE_USD;

  let cadAvailableAfterConversions = cadCash;
  let usdAvailableAfterConversions = usdCash;

  if (!skipCadMode && !skipUsdMode && usdShortfall > 0.01) {
    const cadEquivalent = hasUsdRate ? usdShortfall * usdRate : null;
    let dlrShares = null;
    let dlrSpendCad = cadEquivalent;
    let actualUsdReceived = null;
    const dlrDescription = dlrToOverride?.description ?? dlrToDetails?.description ?? null;
    const dlrCurrency = dlrToOverride?.currency ?? dlrToDetails?.currency ?? 'CAD';

    if (dlrToPrice && cadEquivalent !== null) {
      dlrShares = Math.floor(cadEquivalent / dlrToPrice);
      dlrSpendCad = dlrShares * dlrToPrice;
      if (dlrShares > 0 && dlrUPrice) {
        actualUsdReceived = dlrShares * dlrUPrice;
      }
    }

    if (Number.isFinite(dlrSpendCad)) {
      cadAvailableAfterConversions -= dlrSpendCad;
    }
    if (Number.isFinite(actualUsdReceived)) {
      usdAvailableAfterConversions += actualUsdReceived;
    }

    plan.conversions.push({
      type: 'CAD_TO_USD',
      symbol: 'DLR.TO',
      description: dlrDescription,
      cadAmount: cadEquivalent,
      usdAmount: usdShortfall,
      sharePrice: dlrToPrice,
      shares: dlrShares,
      sharePrecision: 0,
      spendAmount: dlrSpendCad,
      currency: dlrCurrency || 'CAD',
      targetCurrency: 'USD',
      actualSpendAmount: dlrSpendCad,
      actualReceiveAmount: actualUsdReceived,
    });
  }

  if (!skipCadMode && !skipUsdMode && cadShortfall > 0.01) {
    const usdEquivalent = hasUsdRate ? cadShortfall / usdRate : null;
    let dlrUShares = null;
    let dlrSpendUsd = usdEquivalent;
    let actualCadReceived = null;
    const dlrUDescription = dlrUOverride?.description ?? dlrUDetails?.description ?? null;
    const dlrUCurrency = dlrUOverride?.currency ?? dlrUDetails?.currency ?? 'USD';

    if (dlrUPrice && usdEquivalent !== null) {
      dlrUShares = Math.floor(usdEquivalent / dlrUPrice);
      dlrSpendUsd = dlrUShares * dlrUPrice;
      if (dlrUShares > 0 && dlrToPrice) {
        actualCadReceived = dlrUShares * dlrToPrice;
      }
    }

    if (Number.isFinite(dlrSpendUsd)) {
      usdAvailableAfterConversions -= dlrSpendUsd;
    }
    if (Number.isFinite(actualCadReceived)) {
      cadAvailableAfterConversions += actualCadReceived;
    }

    plan.conversions.push({
      type: 'USD_TO_CAD',
      symbol: 'DLR.U.TO',
      description: dlrUDescription,
      cadAmount: cadShortfall,
      usdAmount: usdEquivalent,
      sharePrice: dlrUPrice,
      shares: dlrUShares,
      sharePrecision: 0,
      spendAmount: dlrSpendUsd,
      currency: dlrUCurrency || 'USD',
      targetCurrency: 'CAD',
      actualSpendAmount: dlrSpendUsd,
      actualReceiveAmount: actualCadReceived,
    });
  }

  if (!Number.isFinite(cadAvailableAfterConversions)) {
    cadAvailableAfterConversions = 0;
  }
  if (!Number.isFinite(usdAvailableAfterConversions)) {
    usdAvailableAfterConversions = 0;
  }

  const totalCadPlanned = plan.purchases
    .filter((purchase) => purchase.currency === 'CAD')
    .reduce((sum, purchase) => sum + (Number.isFinite(purchase.amount) ? purchase.amount : 0), 0);
  const totalUsdPlanned = plan.purchases
    .filter((purchase) => purchase.currency === 'USD')
    .reduce((sum, purchase) => sum + (Number.isFinite(purchase.amount) ? purchase.amount : 0), 0);

  const cadScale =
    totalCadPlanned > 0 && cadAvailableAfterConversions < totalCadPlanned
      ? Math.max(cadAvailableAfterConversions, 0) / totalCadPlanned
      : 1;
  const usdScale =
    totalUsdPlanned > 0 && usdAvailableAfterConversions < totalUsdPlanned
      ? Math.max(usdAvailableAfterConversions, 0) / totalUsdPlanned
      : 1;

  let updatedCadTotal = 0;
  let updatedUsdTotal = 0;

  plan.purchases.forEach((purchase) => {
    let scaledTarget = purchase.targetAmount ?? 0;
    if (purchase.currency === 'CAD' && cadScale < 0.9999) {
      scaledTarget *= cadScale;
    } else if (purchase.currency === 'USD' && usdScale < 0.9999) {
      scaledTarget *= usdScale;
    }

    const { shares, spentCurrency, note } = computePurchaseAllocation(
      scaledTarget,
      purchase.currency,
      purchase.price
    );

    purchase.amount = spentCurrency;
    purchase.shares = shares;
    purchase.note = note || null;

    if (purchase.currency === 'CAD') {
      updatedCadTotal += spentCurrency;
    } else if (purchase.currency === 'USD') {
      updatedUsdTotal += spentCurrency;
    }
  });

  updatedCadTotal = alignRoundedAmountsToTotal(
    plan.purchases.filter((purchase) => purchase.currency === 'CAD')
  );
  updatedUsdTotal = alignRoundedAmountsToTotal(
    plan.purchases.filter((purchase) => purchase.currency === 'USD')
  );

  const cadRemaining = cadAvailableAfterConversions - updatedCadTotal;
  const usdRemaining = usdAvailableAfterConversions - updatedUsdTotal;

  plan.totals = {
    cadNeeded: updatedCadTotal,
    usdNeeded: updatedUsdTotal,
    cadRemaining,
    usdRemaining,
  };

  const summaryLines = [];
  summaryLines.push('Invest cash evenly plan');
  summaryLines.push('');
  summaryLines.push('Available cash:');
  summaryLines.push(`  CAD: ${formatMoney(cadCash)} CAD`);
  summaryLines.push(`  USD: ${formatMoney(usdCash)} USD`);
  summaryLines.push(`Total available (CAD): ${formatMoney(totalCashInBase)} CAD`);

  if (sanitizedTargetProportions) {
    summaryLines.push('');
    summaryLines.push(
      usingTargetWeights
        ? 'Target proportions applied to this allocation.'
        : 'Target proportions are configured but current allocation weights were used.'
    );
  }

  if (skipCadMode) {
    summaryLines.push(`Investable USD funds (CAD): ${formatMoney(investableBaseTotal)} CAD`);
  } else if (skipUsdMode) {
    summaryLines.push(`Investable CAD funds (CAD): ${formatMoney(investableBaseTotal)} CAD`);
  }

  if (plan.conversions.length) {
    summaryLines.push('');
    summaryLines.push('FX conversions:');
    plan.conversions.forEach((conversion) => {
      if (conversion.type === 'CAD_TO_USD') {
        const spendCad = Number.isFinite(conversion.actualSpendAmount)
          ? conversion.actualSpendAmount
          : conversion.cadAmount;
        const receiveUsd = Number.isFinite(conversion.actualReceiveAmount)
          ? conversion.actualReceiveAmount
          : conversion.usdAmount;
        const sharesText =
          conversion.shares && conversion.shares > 0
            ? ` (${formatNumber(conversion.shares, { minimumFractionDigits: 0, maximumFractionDigits: 0 })} shares)`
            : '';
        const spendLabel = Number.isFinite(spendCad) ? `${formatMoney(spendCad)} CAD` : 'CAD';
        const receiveLabel = Number.isFinite(receiveUsd)
          ? `${formatMoney(receiveUsd)} USD`
          : 'USD';
        summaryLines.push(
          `  Convert ${spendLabel} into ${receiveLabel} via DLR.TO${sharesText}`
        );
      } else if (conversion.type === 'USD_TO_CAD') {
        const spendUsd = Number.isFinite(conversion.actualSpendAmount)
          ? conversion.actualSpendAmount
          : conversion.usdAmount;
        const receiveCad = Number.isFinite(conversion.actualReceiveAmount)
          ? conversion.actualReceiveAmount
          : conversion.cadAmount;
        const sharesText =
          conversion.shares && conversion.shares > 0
            ? ` (${formatNumber(conversion.shares, { minimumFractionDigits: 0, maximumFractionDigits: 0 })} shares)`
            : '';
        const spendLabel = Number.isFinite(spendUsd) ? `${formatMoney(spendUsd)} USD` : 'USD';
        const receiveLabel = Number.isFinite(receiveCad)
          ? `${formatMoney(receiveCad)} CAD`
          : 'CAD';
        summaryLines.push(`  Convert ${receiveLabel} from ${spendLabel} via DLR.U.TO${sharesText}`);
      }
    });
  }

  summaryLines.push('');
  summaryLines.push('Purchases:');
  plan.purchases.forEach((purchase) => {
    const shareDigits =
      purchase.currency === 'CAD'
        ? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
        : { minimumFractionDigits: USD_SHARE_PRECISION, maximumFractionDigits: USD_SHARE_PRECISION };
    const formattedAmount = `${formatMoney(purchase.amount)} ${purchase.currency}`;
    const formattedShares = formatNumber(purchase.shares, shareDigits);
    const formattedPrice =
      purchase.price > 0 ? `${formatMoney(purchase.price)} ${purchase.currency}` : '—';
    const noteParts = [];
    if (purchase.note) {
      noteParts.push(purchase.note);
    }
    if (Number.isFinite(purchase.targetPercent) && purchase.targetPercent > 0) {
      noteParts.push(
        `target ${formatNumber(purchase.targetPercent, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}%`
      );
    }
    const annotation = noteParts.length ? ` (${noteParts.join('; ')})` : '';
    summaryLines.push(
      `  ${purchase.symbol} (${purchase.currency}): buy ${formattedAmount} → ${formattedShares} shares @ ${formattedPrice}${annotation}`
    );
  });

  summaryLines.push('');
  summaryLines.push('Totals:');
  summaryLines.push(`  CAD purchases: ${formatMoney(updatedCadTotal)} CAD`);
  summaryLines.push(`  USD purchases: ${formatMoney(updatedUsdTotal)} USD`);

  if (skipCadMode) {
    summaryLines.push('');
    summaryLines.push('CAD purchases were already completed. Only USD purchases are included.');
  } else if (skipUsdMode) {
    summaryLines.push('');
    summaryLines.push('USD purchases were already completed. Only CAD purchases are included.');
  }

  plan.summaryText = summaryLines.join('\n');
  plan.skipCadPurchases = skipCadMode;
  plan.skipUsdPurchases = skipUsdMode;
  plan.supportsCadPurchaseToggle = supportsCadPurchases;
  plan.supportsUsdPurchaseToggle = supportsUsdPurchases;
  return plan;
}

function buildDeploymentAdjustmentPlan({
  positions,
  balances,
  currencyRates,
  baseCurrency = 'CAD',
  reserveSymbols = RESERVE_SYMBOLS,
  targetDeployedPercent,
  priceOverrides = null,
}) {
  if (!Array.isArray(positions) || positions.length === 0) {
    return null;
  }

  const TRANSACTION_EPSILON = 0.005;
  const USD_SHARE_PRECISION = 4;

  const normalizedBase = (baseCurrency || 'CAD').toUpperCase();
  const rawTarget = Number(targetDeployedPercent);
  const targetPercent = Number.isFinite(rawTarget) ? Math.min(100, Math.max(0, rawTarget)) : null;
  if (targetPercent === null) {
    return null;
  }

  const reserveSet = reserveSymbols instanceof Set ? reserveSymbols : new Set(reserveSymbols || []);
  const priceOverrideMap = normalizePriceOverrides(priceOverrides);

  const deployedHoldings = [];
  const reserveHoldings = [];

  let deployedBaseTotal = 0;
  let reserveBaseTotal = 0;

  positions.forEach((position) => {
    if (!position) {
      return;
    }
    const symbol = typeof position.symbol === 'string' ? position.symbol.trim() : '';
    if (!symbol) {
      return;
    }
    const symbolKey = normalizeSymbolKey(symbol);
    const currency = (position.currency || normalizedBase).toUpperCase();
    const normalizedValue = resolveNormalizedMarketValue(position, currencyRates, normalizedBase);
    if (!Number.isFinite(normalizedValue)) {
      return;
    }
    const description = typeof position.description === 'string' ? position.description : null;
    const override = resolvePriceOverride(priceOverrideMap, symbol);
    const overridePrice = coercePositiveNumber(override?.price);
    const price = overridePrice ?? coercePositiveNumber(position.currentPrice);
    const quantity = Number.isFinite(position.openQuantity) ? position.openQuantity : null;
    const holding = {
      symbol,
      description,
      currency,
      normalizedValue,
      price: price ?? null,
      quantity,
    };

    if (reserveSet.has(symbolKey)) {
      reserveHoldings.push(holding);
      reserveBaseTotal += normalizedValue;
    } else {
      deployedHoldings.push(holding);
      deployedBaseTotal += normalizedValue;
    }
  });

  const cadCash = resolveCashForCurrency(balances, 'CAD');
  const usdCash = resolveCashForCurrency(balances, 'USD');
  const cadCashBase = normalizeCurrencyAmount(cadCash, 'CAD', currencyRates, normalizedBase);
  const usdCashBase = normalizeCurrencyAmount(usdCash, 'USD', currencyRates, normalizedBase);
  const cashReserveBase = cadCashBase + usdCashBase;

  const totalBase = deployedBaseTotal + reserveBaseTotal + cadCashBase + usdCashBase;
  if (!Number.isFinite(totalBase) || totalBase <= 0) {
    return null;
  }

  const currentReserveBase = reserveBaseTotal + cadCashBase + usdCashBase;
  const currentDeployedBase = totalBase - currentReserveBase;

  const targetDeployedBase = (targetPercent / 100) * totalBase;
  const targetReserveBase = totalBase - targetDeployedBase;

  const targetCashTotalBase = Math.min(targetReserveBase, cashReserveBase);
  const cashScale =
    cashReserveBase > TRANSACTION_EPSILON && targetCashTotalBase > 0
      ? targetCashTotalBase / cashReserveBase
      : 0;
  const targetCashCadBase = cashReserveBase > TRANSACTION_EPSILON ? cadCashBase * cashScale : 0;
  const targetCashUsdBase = cashReserveBase > TRANSACTION_EPSILON ? usdCashBase * cashScale : 0;
  const desiredReserveHoldingsBase = Math.max(0, targetReserveBase - targetCashTotalBase);

  const deployScale = currentDeployedBase > 0 ? targetDeployedBase / currentDeployedBase : 0;
  const reserveHoldingsBase = reserveBaseTotal;
  const hasReserveHoldings = reserveHoldings.some(
    (holding) => Number.isFinite(holding.normalizedValue) && Math.abs(holding.normalizedValue) > TRANSACTION_EPSILON
  );
  const reserveScale =
    hasReserveHoldings && reserveHoldingsBase > TRANSACTION_EPSILON
      ? desiredReserveHoldingsBase / reserveHoldingsBase
      : null;

  if (currentDeployedBase <= 0 && targetDeployedBase > 0) {
    return null;
  }

  const transactions = [];
  const netFlows = new Map();

  const recordFlow = (currency, amount) => {
    if (!Number.isFinite(amount) || Math.abs(amount) < TRANSACTION_EPSILON) {
      return;
    }
    const key = (currency || normalizedBase).toUpperCase();
    const existing = netFlows.get(key) || 0;
    netFlows.set(key, existing + amount);
  };

  const pushTransaction = (entry) => {
    transactions.push(entry);
    recordFlow(entry.currency, entry.amount);
  };

  deployedHoldings.forEach((holding) => {
    if (!Number.isFinite(holding.normalizedValue) || holding.normalizedValue === 0) {
      return;
    }
    const targetValue = holding.normalizedValue * deployScale;
    const deltaBase = targetValue - holding.normalizedValue;
    if (!Number.isFinite(deltaBase) || Math.abs(deltaBase) < TRANSACTION_EPSILON) {
      return;
    }
    const deltaCurrency = convertAmountToCurrency(
      deltaBase,
      normalizedBase,
      holding.currency,
      currencyRates,
      normalizedBase
    );
    if (!Number.isFinite(deltaCurrency) || Math.abs(deltaCurrency) < TRANSACTION_EPSILON) {
      return;
    }
    const price = holding.price;
    const shares = Number.isFinite(price) && price > 0 ? deltaCurrency / price : null;
    const side = deltaCurrency >= 0 ? 'BUY' : 'SELL';
    pushTransaction({
      scope: 'DEPLOYED',
      side,
      symbol: holding.symbol,
      description: holding.description,
      currency: holding.currency,
      amount: deltaCurrency,
      shares,
      sharePrecision: holding.currency === 'CAD' ? 0 : USD_SHARE_PRECISION,
      price: price ?? null,
    });
  });

  if (reserveScale !== null) {
    reserveHoldings.forEach((holding) => {
      if (!Number.isFinite(holding.normalizedValue) || holding.normalizedValue === 0) {
        return;
      }
      const targetValue = holding.normalizedValue * reserveScale;
      const deltaBase = targetValue - holding.normalizedValue;
      if (!Number.isFinite(deltaBase) || Math.abs(deltaBase) < TRANSACTION_EPSILON) {
        return;
      }
      const deltaCurrency = convertAmountToCurrency(
        deltaBase,
        normalizedBase,
        holding.currency,
        currencyRates,
        normalizedBase
      );
      if (!Number.isFinite(deltaCurrency) || Math.abs(deltaCurrency) < TRANSACTION_EPSILON) {
        return;
      }
      const price = holding.price;
      const shares = Number.isFinite(price) && price > 0 ? deltaCurrency / price : null;
      const side = deltaCurrency >= 0 ? 'BUY' : 'SELL';
      pushTransaction({
        scope: 'RESERVE',
        side,
        symbol: holding.symbol,
        description: holding.description,
        currency: holding.currency,
        amount: deltaCurrency,
        shares,
        sharePrecision: holding.currency === 'CAD' ? 0 : USD_SHARE_PRECISION,
        price: price ?? null,
      });
    });
  }

  if (reserveScale === null) {
    const reserveIncreaseBase = desiredReserveHoldingsBase;
    if (reserveIncreaseBase > TRANSACTION_EPSILON) {
      let targets = reserveHoldings
        .filter((holding) => Number.isFinite(holding.price) && holding.price > 0)
        .map((holding) => ({
          symbol: holding.symbol,
          description: holding.description,
          currency: holding.currency,
          price: holding.price ?? null,
          weight: holding.normalizedValue > 0 ? holding.normalizedValue : 0,
          sharePrecision: holding.currency === 'CAD' ? 0 : USD_SHARE_PRECISION,
        }));

      if (!targets.length) {
        const fallbackSymbol = RESERVE_FALLBACK_SYMBOL;
        const fallbackOverride = resolvePriceOverride(priceOverrideMap, fallbackSymbol);
        const fallbackDetails = findPositionDetails(positions, fallbackSymbol);
        const fallbackPrice =
          coercePositiveNumber(fallbackOverride?.price) ??
          coercePositiveNumber(fallbackDetails?.price) ??
          null;
        const fallbackCurrency = (
          fallbackOverride?.currency || fallbackDetails?.currency || 'USD'
        ).toUpperCase();
        const fallbackDescription = fallbackOverride?.description ?? fallbackDetails?.description ?? null;

        targets = [
          {
            symbol: fallbackSymbol,
            description: fallbackDescription,
            currency: fallbackCurrency,
            price: fallbackPrice,
            weight: 1,
            sharePrecision: fallbackCurrency === 'CAD' ? 0 : USD_SHARE_PRECISION,
          },
        ];
      }

      const weightTotal = targets.reduce(
        (sum, entry) => sum + (Number.isFinite(entry.weight) && entry.weight > 0 ? entry.weight : 0),
        0
      );
      if (weightTotal > 0) {
        targets = targets.map((entry) => ({ ...entry, weight: entry.weight / weightTotal }));
      } else if (targets.length > 0) {
        const equalWeight = 1 / targets.length;
        targets = targets.map((entry) => ({ ...entry, weight: equalWeight }));
      }

      targets.forEach((entry) => {
        if (!Number.isFinite(entry.weight) || entry.weight <= 0) {
          return;
        }
        const allocationBase = reserveIncreaseBase * entry.weight;
        if (!Number.isFinite(allocationBase) || allocationBase <= TRANSACTION_EPSILON) {
          return;
        }
        const allocationAmount = convertAmountToCurrency(
          allocationBase,
          normalizedBase,
          entry.currency,
          currencyRates,
          normalizedBase
        );
        if (!Number.isFinite(allocationAmount) || allocationAmount <= TRANSACTION_EPSILON) {
          return;
        }
        const price = entry.price;
        const shares = Number.isFinite(price) && price > 0 ? allocationAmount / price : null;
        pushTransaction({
          scope: 'RESERVE',
          side: 'BUY',
          symbol: entry.symbol,
          description: entry.description,
          currency: entry.currency,
          amount: allocationAmount,
          shares,
          sharePrecision: entry.sharePrecision,
          price: price ?? null,
        });
      });
    }
  }

  const targetCashCad = convertAmountToCurrency(
    targetCashCadBase,
    normalizedBase,
    'CAD',
    currencyRates,
    normalizedBase
  );
  const targetCashUsd = convertAmountToCurrency(
    targetCashUsdBase,
    normalizedBase,
    'USD',
    currencyRates,
    normalizedBase
  );
  const cashDeltaCad = targetCashCad - cadCash;
  const cashDeltaUsd = targetCashUsd - usdCash;
  recordFlow('CAD', cashDeltaCad);
  recordFlow('USD', cashDeltaUsd);

  const conversions = [];
  const usdRate = currencyRates?.get('USD');
  const hasUsdRate = Number.isFinite(usdRate) && usdRate > 0;
  const dlrToDetails = findPositionDetails(positions, 'DLR.TO');
  const dlrUDetails = findPositionDetails(positions, 'DLR.U.TO');
  const dlrToOverride = resolvePriceOverride(priceOverrideMap, 'DLR.TO');
  const dlrUOverride = resolvePriceOverride(priceOverrideMap, 'DLR.U.TO');
  const dlrToPrice =
    coercePositiveNumber(dlrToOverride?.price) ??
    coercePositiveNumber(dlrToDetails?.price) ??
    (hasUsdRate ? usdRate * 10 : null);
  const dlrUPrice =
    coercePositiveNumber(dlrUOverride?.price) ??
    coercePositiveNumber(dlrUDetails?.price) ??
    10;
  const dlrDescription = dlrToOverride?.description ?? dlrToDetails?.description ?? 'DLR Norbert conversion';

  const adjustFlow = (currency, delta) => {
    if (!Number.isFinite(delta) || Math.abs(delta) < TRANSACTION_EPSILON) {
      return;
    }
    const key = (currency || normalizedBase).toUpperCase();
    const existing = netFlows.get(key) || 0;
    netFlows.set(key, existing + delta);
  };

  const planCadToUsdConversion = (usdAmountNeeded) => {
    if (!hasUsdRate || usdAmountNeeded <= TRANSACTION_EPSILON) {
      return;
    }
    let cadSpent = usdAmountNeeded * usdRate;
    let usdReceived = usdAmountNeeded;
    let shares = null;
    if (dlrToPrice && dlrUPrice) {
      const estimatedShares = Math.floor((cadSpent / dlrToPrice) + 1e-6);
      if (estimatedShares > 0) {
        shares = estimatedShares;
        cadSpent = shares * dlrToPrice;
        usdReceived = shares * dlrUPrice;
      }
    }
    conversions.push({
      type: 'CAD_TO_USD',
      symbol: 'DLR.TO',
      description: dlrDescription,
      cadAmount: cadSpent,
      usdAmount: usdAmountNeeded,
      sharePrice: dlrToPrice,
      shares,
      sharePrecision: 0,
      spendAmount: cadSpent,
      currency: dlrToOverride?.currency ?? dlrToDetails?.currency ?? 'CAD',
      targetCurrency: 'USD',
      actualSpendAmount: cadSpent,
      actualReceiveAmount: usdReceived,
    });
    adjustFlow('CAD', cadSpent);
    adjustFlow('USD', -usdReceived);
  };

  const planUsdToCadConversion = (cadAmountNeeded) => {
    if (!hasUsdRate || cadAmountNeeded <= TRANSACTION_EPSILON) {
      return;
    }
    let usdSpent = cadAmountNeeded / usdRate;
    let cadReceived = cadAmountNeeded;
    let shares = null;
    if (dlrUPrice && dlrToPrice) {
      const estimatedShares = Math.floor((usdSpent / dlrUPrice) + 1e-6);
      if (estimatedShares > 0) {
        shares = estimatedShares;
        usdSpent = shares * dlrUPrice;
        cadReceived = shares * dlrToPrice;
      }
    }
    conversions.push({
      type: 'USD_TO_CAD',
      symbol: 'DLR.U.TO',
      description: dlrUOverride?.description ?? dlrUDetails?.description ?? dlrDescription,
      cadAmount: cadAmountNeeded,
      usdAmount: usdSpent,
      sharePrice: dlrUPrice,
      shares,
      sharePrecision: 0,
      spendAmount: usdSpent,
      currency: dlrUOverride?.currency ?? dlrUDetails?.currency ?? 'USD',
      targetCurrency: 'CAD',
      actualSpendAmount: usdSpent,
      actualReceiveAmount: cadReceived,
    });
    adjustFlow('USD', usdSpent);
    adjustFlow('CAD', -cadReceived);
  };

  let cadNeed = netFlows.get('CAD') || 0;
  let usdNeed = netFlows.get('USD') || 0;

  if (cadNeed > TRANSACTION_EPSILON && usdNeed < -TRANSACTION_EPSILON) {
    const availableUsd = -usdNeed;
    const cadRequired = cadNeed;
    const usdEquivalent = hasUsdRate ? cadRequired / usdRate : 0;
    const usdToConvert = Math.min(availableUsd, usdEquivalent);
    if (usdToConvert > TRANSACTION_EPSILON) {
      const cadAmount = usdToConvert * usdRate;
      planUsdToCadConversion(cadAmount);
      cadNeed = netFlows.get('CAD') || 0;
      usdNeed = netFlows.get('USD') || 0;
    }
  }

  if (usdNeed > TRANSACTION_EPSILON && cadNeed < -TRANSACTION_EPSILON) {
    const availableCad = -cadNeed;
    const usdRequired = usdNeed;
    const cadEquivalent = hasUsdRate ? usdRequired * usdRate : 0;
    const cadToConvert = Math.min(availableCad, cadEquivalent);
    if (cadToConvert > TRANSACTION_EPSILON) {
      const usdAmount = cadToConvert / usdRate;
      planCadToUsdConversion(usdAmount);
      cadNeed = netFlows.get('CAD') || 0;
      usdNeed = netFlows.get('USD') || 0;
    }
  }

  const totals = {
    cadBuys: 0,
    cadSells: 0,
    usdBuys: 0,
    usdSells: 0,
    cadNet: netFlows.get('CAD') || 0,
    usdNet: netFlows.get('USD') || 0,
  };

  transactions.forEach((transaction) => {
    const amount = transaction.amount;
    if (transaction.currency === 'CAD') {
      if (amount >= 0) {
        totals.cadBuys += amount;
      } else {
        totals.cadSells += -amount;
      }
    } else if (transaction.currency === 'USD') {
      if (amount >= 0) {
        totals.usdBuys += amount;
      } else {
        totals.usdSells += -amount;
      }
    }
  });

  const currentDeployedPercent = (currentDeployedBase / totalBase) * 100;
  const currentReservePercent = (currentReserveBase / totalBase) * 100;

  const summaryLines = [];
  summaryLines.push(
    `Current deployed: ${formatMoney(currentDeployedBase)} ${normalizedBase} (${formatNumber(currentDeployedPercent, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}%)`
  );
  summaryLines.push(
    `Target deployed: ${formatMoney(targetDeployedBase)} ${normalizedBase} (${formatNumber(targetPercent, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}%)`
  );
  summaryLines.push(
    `Target reserve: ${formatMoney(targetReserveBase)} ${normalizedBase} (${formatNumber(100 - targetPercent, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}%)`
  );

  if (transactions.length) {
    summaryLines.push('');
    summaryLines.push('Trades:');
    transactions.forEach((transaction) => {
      summaryLines.push(
        `  ${transaction.side} ${transaction.symbol}: ${formatMoney(Math.abs(transaction.amount))} ${transaction.currency}`
      );
    });
  }

  if (conversions.length) {
    summaryLines.push('');
    summaryLines.push('Conversions:');
    conversions.forEach((conversion) => {
      summaryLines.push(
        `  ${conversion.type === 'CAD_TO_USD' ? 'CAD→USD' : 'USD→CAD'} via ${conversion.symbol}: ${formatMoney(
          conversion.spendAmount
        )} ${conversion.currency}`
      );
    });
  }

  const plan = {
    type: 'DEPLOYMENT_ADJUSTMENT',
    baseCurrency: normalizedBase,
    targetDeployedPercent: targetPercent,
    targetReservePercent: 100 - targetPercent,
    currentDeployedPercent,
    currentReservePercent,
    currentDeployedValue: currentDeployedBase,
    currentReserveValue: currentReserveBase,
    targetDeployedValue: targetDeployedBase,
    targetReserveValue: targetReserveBase,
    transactions,
    conversions,
    totals,
    cashDeltas: {
      CAD: cashDeltaCad,
      USD: cashDeltaUsd,
    },
    summaryText: summaryLines.join('\n'),
  };

  return plan;
}

function pickBalanceEntry(bucket, currency) {
  if (!bucket || !currency) {
    return null;
  }
  const normalized = currency.toUpperCase();
  return bucket[normalized] || bucket[currency] || bucket[normalized.toLowerCase()] || null;
}

function resolvePositionTotalCost(position) {
  if (position && position.totalCost !== undefined && position.totalCost !== null) {
    return position.totalCost;
  }
  if (position && isFiniteNumber(position.averageEntryPrice) && isFiniteNumber(position.openQuantity)) {
    return position.averageEntryPrice * position.openQuantity;
  }
  return null;
}

function deriveExchangeRate(perEntry, combinedEntry, baseCombinedEntry) {
  if (!perEntry && !combinedEntry) {
    return null;
  }

  const directFields = ['exchangeRate', 'fxRate', 'conversionRate', 'rate'];
  for (const field of directFields) {
    const candidate = (perEntry && perEntry[field]) ?? (combinedEntry && combinedEntry[field]) ?? null;
    if (isFiniteNumber(candidate) && candidate > 0) {
      return candidate;
    }
  }

  if (baseCombinedEntry && combinedEntry) {
    const baseFields = ['totalEquity', 'marketValue', 'cash', 'buyingPower'];
    for (const field of baseFields) {
      const baseValue = baseCombinedEntry[field];
      const currencyValue = combinedEntry[field];
      if (!isFiniteNumber(baseValue) || !isFiniteNumber(currencyValue)) {
        continue;
      }
      if (Math.abs(currencyValue) <= 1e-9) {
        continue;
      }

      const ratio = baseValue / currencyValue;
      if (isFiniteNumber(ratio) && Math.abs(ratio) > 1e-9) {
        return Math.abs(ratio);
      }
    }
  }

  const ratioSources = [
    ['totalEquity', 'totalEquity'],
    ['marketValue', 'marketValue'],
  ];

  for (const [perField, combinedField] of ratioSources) {
    const perValue = perEntry ? perEntry[perField] : null;
    const combinedValue = combinedEntry ? combinedEntry[combinedField] : null;
    if (!isFiniteNumber(perValue) || !isFiniteNumber(combinedValue)) {
      continue;
    }
    if (Math.abs(perValue) <= 1e-9 || Math.abs(combinedValue) <= 1e-9) {
      continue;
    }

    const ratio = combinedValue / perValue;
    if (isFiniteNumber(ratio) && Math.abs(ratio) > 1e-9) {
      return Math.abs(ratio);
    }
  }

  return null;
}

function buildCurrencyRateMap(balances, baseCurrency = 'CAD') {
  const normalizedBase = (baseCurrency || 'CAD').toUpperCase();
  const rates = new Map();
  rates.set(normalizedBase, 1);

  if (!balances) {
    return rates;
  }

  const combined = balances.combined || {};
  const perCurrency = balances.perCurrency || {};
  const baseCombinedEntry = pickBalanceEntry(combined, normalizedBase);
  const allKeys = new Set([
    ...Object.keys(combined || {}),
    ...Object.keys(perCurrency || {}),
  ]);

  allKeys.forEach((key) => {
    if (!key) {
      return;
    }
    const normalizedKey = key.toUpperCase();
    if (rates.has(normalizedKey)) {
      return;
    }

    const perEntry = pickBalanceEntry(perCurrency, key) || pickBalanceEntry(perCurrency, normalizedKey);
    const combinedEntry = pickBalanceEntry(combined, key) || pickBalanceEntry(combined, normalizedKey);

    const derived = deriveExchangeRate(perEntry, combinedEntry, baseCombinedEntry);
    if (derived && derived > 0) {
      rates.set(normalizedKey, derived);
      return;
    }

    if (normalizedKey === normalizedBase) {
      rates.set(normalizedKey, 1);
    }
  });

  return rates;
}

function normalizeCurrencyAmount(value, currency, currencyRates, baseCurrency = 'CAD') {
  if (!isFiniteNumber(value)) {
    return 0;
  }
  const normalizedBase = (baseCurrency || 'CAD').toUpperCase();
  const normalizedCurrency = (currency || normalizedBase).toUpperCase();
  const rate = currencyRates.get(normalizedCurrency);
  if (isFiniteNumber(rate) && rate > 0) {
    return value * rate;
  }
  if (normalizedCurrency === normalizedBase) {
    return value;
  }
  return value;
}


function extractBalanceBuckets(summary) {
  if (!summary || typeof summary !== 'object') {
    return [];
  }

  const buckets = [];
  if (summary.combined && typeof summary.combined === 'object') {
    buckets.push(summary.combined);
  }
  if (summary.perCurrency && typeof summary.perCurrency === 'object') {
    buckets.push(summary.perCurrency);
  }
  if (!buckets.length) {
    buckets.push(summary);
  }
  return buckets;
}

function resolveAccountTotalInBase(combined, currencyRates, baseCurrency = 'CAD') {
  if (!combined || typeof combined !== 'object') {
    return 0;
  }

  const normalizedBase = (baseCurrency || 'CAD').toUpperCase();

  const bucketSources = extractBalanceBuckets(combined).filter(
    (bucket) => bucket && typeof bucket === 'object'
  );
  if (!bucketSources.length) {
    return 0;
  }

  const pickBaseTotal = (entry) => {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    if (isFiniteNumber(entry.totalEquityCad)) {
      return entry.totalEquityCad;
    }
    const entryCurrency =
      typeof entry.currency === 'string' && entry.currency.trim()
        ? entry.currency.toUpperCase()
        : null;
    const reference =
      entry.totalEquity ?? entry.marketValue ?? entry.cash ?? entry.buyingPower ?? null;
    if (isFiniteNumber(reference) && entryCurrency === normalizedBase) {
      return reference;
    }
    return null;
  };

  for (const bucket of bucketSources) {
    const baseKey = Object.keys(bucket).find((key) => key && key.toUpperCase() === normalizedBase);
    if (baseKey) {
      const resolved = pickBaseTotal(bucket[baseKey]);
      if (resolved !== null) {
        return resolved;
      }
    }
  }

  for (const bucket of bucketSources) {
    for (const entryKey of Object.keys(bucket)) {
      const resolved = pickBaseTotal(bucket[entryKey]);
      if (resolved !== null) {
        return resolved;
      }
    }
  }

  let fallbackTotal = 0;
  const seenCurrencies = new Set();

  bucketSources.forEach((bucket) => {
    Object.entries(bucket).forEach(([currencyKey, values]) => {
      if (!values || typeof values !== 'object') {
        return;
      }
      const reference =
        values.totalEquity ?? values.marketValue ?? values.cash ?? values.buyingPower ?? null;
      if (!isFiniteNumber(reference)) {
        return;
      }

      const entryCurrency =
        typeof values.currency === 'string' && values.currency.trim()
          ? values.currency.trim().toUpperCase()
          : typeof currencyKey === 'string' && currencyKey.trim()
            ? currencyKey.trim().toUpperCase()
            : null;

      const seenKey = entryCurrency || currencyKey;
      if (seenKey) {
        const normalizedKey = String(seenKey).toUpperCase();
        if (seenCurrencies.has(normalizedKey)) {
          return;
        }
        seenCurrencies.add(normalizedKey);
      }

      fallbackTotal += normalizeCurrencyAmount(reference, entryCurrency, currencyRates, baseCurrency);
    });
  });

  return fallbackTotal;
}

function resolveAccountPnlInBase(combined, field, currencyRates, baseCurrency = 'CAD') {
  if (!combined || typeof combined !== 'object') {
    return 0;
  }

  const normalizedBase = (baseCurrency || 'CAD').toUpperCase();

  const bucketSources = extractBalanceBuckets(combined).filter(
    (bucket) => bucket && typeof bucket === 'object'
  );
  if (!bucketSources.length) {
    return 0;
  }

  let total = 0;
  bucketSources.forEach((bucket) => {
    Object.entries(bucket).forEach(([currencyKey, values]) => {
      if (!values || typeof values !== 'object') {
        return;
      }
      const amount = coerceNumber(values[field]);
      if (amount === null) {
        return;
      }
      const entryCurrency =
        typeof values.currency === 'string' && values.currency.trim()
          ? values.currency.trim().toUpperCase()
          : typeof currencyKey === 'string' && currencyKey.trim()
            ? currencyKey.trim().toUpperCase()
            : normalizedBase;
      total += normalizeCurrencyAmount(amount, entryCurrency, currencyRates, baseCurrency);
    });
  });

  return total;
}


function aggregatePositionsBySymbol(positions, { currencyRates, baseCurrency = 'CAD' }) {
  if (!Array.isArray(positions) || positions.length === 0) {
    return [];
  }

  const normalizedBase = (baseCurrency || 'CAD').toUpperCase();
  const convert = (amount, currency) => normalizeCurrencyAmount(amount, currency, currencyRates, normalizedBase);

  const groups = new Map();
  const passthrough = [];

  positions.forEach((position) => {
    const symbolKey = position && position.symbol ? String(position.symbol).trim().toUpperCase() : '';
    if (!symbolKey) {
      if (position) {
        passthrough.push(position);
      }
      return;
    }

    let group = groups.get(symbolKey);
    if (!group) {
      group = {
        symbol: position.symbol,
        symbolId: position.symbolId ?? null,
        description: position.description || null,
        currencyBuckets: new Map(),
        openQuantity: 0,
        marketValueBase: 0,
        dayPnlBase: 0,
        openPnlBase: 0,
        totalCostBase: 0,
        totalCostBaseWeight: 0,
        currentPriceAccumulator: 0,
        currentPriceWeight: 0,
        isRealTime: Boolean(position?.isRealTime),
        rowId: `all:${symbolKey}`,
        key: symbolKey,
        accountNotes: new Map(),
        dividendYieldPercent: null,
      };
      groups.set(symbolKey, group);
    }

    if (!group.symbol && position.symbol) {
      group.symbol = position.symbol;
    }
    if (!group.symbolId && position.symbolId) {
      group.symbolId = position.symbolId;
    }
    if (!group.description && position.description) {
      group.description = position.description;
    }

    const quantity = isFiniteNumber(position.openQuantity) ? position.openQuantity : 0;
    const marketValue = isFiniteNumber(position.currentMarketValue) ? position.currentMarketValue : 0;
    const dayPnl = isFiniteNumber(position.dayPnl) ? position.dayPnl : 0;
    const openPnl = isFiniteNumber(position.openPnl) ? position.openPnl : 0;
    const currency = (position.currency || normalizedBase).toUpperCase();
    const totalCost = resolvePositionTotalCost(position);
    const currentPrice = isFiniteNumber(position.currentPrice) ? position.currentPrice : null;
    const positionDividendYield = isFiniteNumber(position.dividendYieldPercent)
      ? position.dividendYieldPercent
      : null;

    group.openQuantity += quantity;
    group.marketValueBase += convert(marketValue, currency);
    group.dayPnlBase += convert(dayPnl, currency);
    group.openPnlBase += convert(openPnl, currency);
    if (totalCost !== null) {
      group.totalCostBase += convert(totalCost, currency);
      group.totalCostBaseWeight += quantity;
    }
    group.isRealTime = group.isRealTime || Boolean(position.isRealTime);

    if (positionDividendYield !== null && positionDividendYield > 0) {
      const currentYield = isFiniteNumber(group.dividendYieldPercent) ? group.dividendYieldPercent : 0;
      group.dividendYieldPercent = Math.max(currentYield, positionDividendYield);
    }

    if (currentPrice !== null && Math.abs(quantity) > 1e-9) {
      const weight = Math.abs(quantity);
      group.currentPriceAccumulator += currentPrice * weight;
      group.currentPriceWeight += weight;
    }

    let bucket = group.currencyBuckets.get(currency);
    if (!bucket) {
      bucket = { marketValue: 0, dayPnl: 0, openPnl: 0, totalCost: 0, costWeight: 0 };
      group.currencyBuckets.set(currency, bucket);
    }
    bucket.marketValue += marketValue;
    bucket.dayPnl += dayPnl;
    bucket.openPnl += openPnl;
    if (totalCost !== null) {
      bucket.totalCost += totalCost;
      bucket.costWeight += quantity;
    }

    const appendAccountNote = (entry) => {
      if (!entry) {
        return;
      }
      const accountKey = entry.accountId || entry.accountNumber;
      if (!accountKey) {
        return;
      }
      const normalizedKey = String(accountKey);
      if (!normalizedKey) {
        return;
      }
      const existing = group.accountNotes.get(normalizedKey) || {
        accountId: entry.accountId || null,
        accountNumber: entry.accountNumber || null,
        accountDisplayName: entry.accountDisplayName || null,
        accountOwnerLabel: entry.accountOwnerLabel || null,
        notes: '',
        targetProportion: Number.isFinite(entry.targetProportion) ? entry.targetProportion : null,
      };
      const candidateNote = typeof entry.notes === 'string' ? entry.notes : '';
      if (candidateNote) {
        existing.notes = candidateNote;
      }
      if (!existing.accountDisplayName && entry.accountDisplayName) {
        existing.accountDisplayName = entry.accountDisplayName;
      }
      if (!existing.accountOwnerLabel && entry.accountOwnerLabel) {
        existing.accountOwnerLabel = entry.accountOwnerLabel;
      }
      if (!existing.accountNumber && entry.accountNumber) {
        existing.accountNumber = entry.accountNumber;
      }
      if (!existing.accountId && entry.accountId) {
        existing.accountId = entry.accountId;
      }
      if (Number.isFinite(entry.targetProportion)) {
        existing.targetProportion = entry.targetProportion;
      }
      group.accountNotes.set(normalizedKey, existing);
    };

    if (Array.isArray(position.accountNotes) && position.accountNotes.length) {
      position.accountNotes.forEach((entry) => {
        appendAccountNote(entry);
      });
    } else {
      appendAccountNote({
        accountId: position.accountId || null,
        accountNumber: position.accountNumber || null,
        accountDisplayName: position.accountDisplayName || null,
        accountOwnerLabel: position.accountOwnerLabel || null,
        notes: typeof position.notes === 'string' ? position.notes : '',
        targetProportion: Number.isFinite(position.targetProportion) ? position.targetProportion : null,
      });
    }
  });

  const aggregated = Array.from(groups.values()).map((group) => {
    const currencies = Array.from(group.currencyBuckets.keys());
    const hasSingleCurrency = currencies.length === 1;
    const displayCurrency = hasSingleCurrency ? currencies[0] : normalizedBase;
    const bucket = hasSingleCurrency ? group.currencyBuckets.get(displayCurrency) : null;

    let currentMarketValue = hasSingleCurrency && bucket ? bucket.marketValue : group.marketValueBase;
    if (!isFiniteNumber(currentMarketValue)) {
      currentMarketValue = 0;
    }

    let dayPnl = hasSingleCurrency && bucket ? bucket.dayPnl : group.dayPnlBase;
    if (!isFiniteNumber(dayPnl)) {
      dayPnl = 0;
    }

    let openPnl = hasSingleCurrency && bucket ? bucket.openPnl : group.openPnlBase;
    if (!isFiniteNumber(openPnl)) {
      openPnl = 0;
    }

    let totalCost = null;
    let averageEntryPrice = null;
    if (hasSingleCurrency && bucket) {
      if (isFiniteNumber(bucket.totalCost) && Math.abs(bucket.costWeight) > 1e-9) {
        totalCost = bucket.totalCost;
        averageEntryPrice = bucket.totalCost / bucket.costWeight;
      }
    }
    if (totalCost === null && Math.abs(group.totalCostBaseWeight) > 1e-9) {
      totalCost = group.totalCostBase;
      averageEntryPrice = group.totalCostBase / group.totalCostBaseWeight;
      if (!hasSingleCurrency) {
        currentMarketValue = group.marketValueBase;
        dayPnl = group.dayPnlBase;
        openPnl = group.openPnlBase;
      }
    }

    if (!isFiniteNumber(averageEntryPrice)) {
      averageEntryPrice = null;
    }

    const currentPrice =
      group.currentPriceWeight > 0
        ? group.currentPriceAccumulator / group.currentPriceWeight
        : null;

    const resolvedSymbolId = group.symbolId ?? group.key;
    const accountNotes = group.accountNotes
      ? Array.from(group.accountNotes.values()).map((entry) => {
          return {
            accountId: entry.accountId || null,
            accountNumber: entry.accountNumber || null,
            accountDisplayName: entry.accountDisplayName || null,
            accountOwnerLabel: entry.accountOwnerLabel || null,
            notes: typeof entry.notes === 'string' ? entry.notes : '',
            targetProportion: Number.isFinite(entry.targetProportion) ? entry.targetProportion : null,
          };
        })
      : [];
    accountNotes.sort((a, b) => {
      const labelA = (a.accountDisplayName || a.accountNumber || a.accountId || '').toString();
      const labelB = (b.accountDisplayName || b.accountNumber || b.accountId || '').toString();
      return labelA.localeCompare(labelB, undefined, { sensitivity: 'base' });
    });

    return {
      symbol: group.symbol ?? group.key,
      symbolId: resolvedSymbolId,
      description: group.description ?? null,
      dayPnl,
      openPnl,
      openQuantity: group.openQuantity,
      averageEntryPrice,
      currentPrice,
      currentMarketValue,
      currency: displayCurrency,
      totalCost: totalCost ?? null,
      dividendYieldPercent: isFiniteNumber(group.dividendYieldPercent) ? group.dividendYieldPercent : null,
      accountId: 'all',
      accountNumber: 'all',
      isRealTime: group.isRealTime,
      rowId: group.rowId,
      normalizedMarketValue: group.marketValueBase,
      notes: null,
      accountNotes,
    };
  });

  if (!passthrough.length) {
    return aggregated;
  }

  return aggregated.concat(passthrough);
}

function resolveNormalizedMarketValue(position, currencyRates, baseCurrency = 'CAD') {
  if (position && isFiniteNumber(position.normalizedMarketValue)) {
    return position.normalizedMarketValue;
  }
  const value = position?.currentMarketValue ?? 0;
  const currency = position?.currency;
  return normalizeCurrencyAmount(value, currency, currencyRates, baseCurrency);
}

function resolveNormalizedPnl(position, field, currencyRates, baseCurrency = 'CAD') {
  if (!position || !isFiniteNumber(position?.[field])) {
    return 0;
  }
  const currency = position?.currency || baseCurrency;
  return normalizeCurrencyAmount(position[field], currency, currencyRates, baseCurrency);
}

function preparePositionsForHeatmap(positions, currencyRates, baseCurrency = 'CAD') {
  if (!Array.isArray(positions) || positions.length === 0) {
    return { positions: [], totalMarketValue: 0 };
  }

  const enriched = positions.map((position) => {
    const normalizedMarketValue = resolveNormalizedMarketValue(position, currencyRates, baseCurrency);
    const normalizedDayPnl = resolveNormalizedPnl(position, 'dayPnl', currencyRates, baseCurrency);
    const normalizedOpenPnl = resolveNormalizedPnl(position, 'openPnl', currencyRates, baseCurrency);

    return {
      ...position,
      normalizedMarketValue,
      normalizedDayPnl,
      normalizedOpenPnl,
    };
  });

  const totalMarketValue = enriched.reduce((sum, entry) => {
    const value = isFiniteNumber(entry.normalizedMarketValue) ? entry.normalizedMarketValue : 0;
    return sum + value;
  }, 0);

  if (totalMarketValue <= 0) {
    return {
      positions: enriched.map((entry) => ({ ...entry, portfolioShare: 0 })),
      totalMarketValue: 0,
    };
  }

  const withShare = enriched.map((entry) => {
    const share = isFiniteNumber(entry.normalizedMarketValue)
      ? (entry.normalizedMarketValue / totalMarketValue) * 100
      : 0;
    return {
      ...entry,
      portfolioShare: share,
    };
  });

  return { positions: withShare, totalMarketValue };
}

export default function App() {
  const initialAccountIdFromUrl = useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }
    return readAccountIdFromLocation(window.location);
  }, []);

  const initialTodoActionFromUrl = useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }
    return readTodoActionFromLocation(window.location);
  }, []);

  const initialTodoReminderFromUrl = useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }
    return readTodoReminderFromLocation(window.location);
  }, []);

  const [selectedAccountState, setSelectedAccountState] = useState(() => {
    if (!initialAccountIdFromUrl || initialAccountIdFromUrl === 'default') {
      return 'all';
    }
    return initialAccountIdFromUrl;
  });
  const [activeAccountId, setActiveAccountId] = useState(() => initialAccountIdFromUrl || 'default');
  const [currencyView, setCurrencyView] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
  const [positionsSort, setPositionsSort] = usePersistentState('positionsTableSort', DEFAULT_POSITIONS_SORT);
  const [positionsPnlMode, setPositionsPnlMode] = usePersistentState('positionsTablePnlMode', 'currency');
  const [portfolioViewTab, setPortfolioViewTab] = usePersistentState('portfolioViewTab', 'positions');
  const [ordersFilter, setOrdersFilter] = useState('');
  const [dividendTimeframe, setDividendTimeframe] = useState(DEFAULT_DIVIDEND_TIMEFRAME);
  const [_accountPlanningContexts, _setAccountPlanningContexts] = usePersistentState(
    'accountPlanningContexts',
    EMPTY_OBJECT
  );
  const [showPeople, setShowPeople] = useState(false);
  const [investEvenlyPlan, setInvestEvenlyPlan] = useState(null);
  const [investEvenlyPlanInputs, setInvestEvenlyPlanInputs] = useState(null);
  const [deploymentPlan, setDeploymentPlan] = useState(null);
  const [deploymentPlanInputs, setDeploymentPlanInputs] = useState(null);
  const [targetProportionEditor, setTargetProportionEditor] = useState(null);
  const [forcedTargetAccounts, setForcedTargetAccounts] = useState(() => new Set());
  const [symbolNotesEditor, setSymbolNotesEditor] = useState(null);
  const [planningContextEditor, setPlanningContextEditor] = useState(null);
  const [pnlBreakdownMode, setPnlBreakdownMode] = useState(null);
  const [showReturnBreakdown, setShowReturnBreakdown] = useState(false);
  const [cashBreakdownCurrency, setCashBreakdownCurrency] = useState(null);
  const [todoState, setTodoState] = useState({ items: [], checked: false, scopeKey: null });
  const [pendingTodoAction, setPendingTodoAction] = useState(() => {
    if (!initialTodoActionFromUrl) {
      return null;
    }
    const type = initialTodoActionFromUrl.type;
    if (!type) {
      return null;
    }
    const accountId = normalizeQueryValue(initialTodoActionFromUrl.accountId);
    const model = normalizeQueryValue(initialTodoActionFromUrl.model);
    const chartKey = normalizeQueryValue(initialTodoActionFromUrl.chartKey);
    return {
      type,
      accountId,
      model,
      chartKey,
    };
  });
  const [selectedRebalanceReminder, setSelectedRebalanceReminder] = useState(() => {
    if (!initialTodoReminderFromUrl) {
      return null;
    }
    const accountId = normalizeQueryValue(initialTodoReminderFromUrl.accountId);
    const accountNumber = normalizeQueryValue(initialTodoReminderFromUrl.accountNumber);
    const rawModelKey = normalizeQueryValue(initialTodoReminderFromUrl.modelKey);
    const modelKey = rawModelKey ? rawModelKey.toUpperCase() : null;
    if (!accountId && !accountNumber && !modelKey) {
      return null;
    }
    return {
      accountId,
      accountNumber,
      modelKey,
    };
  });
  const [activeInvestmentModelDialog, setActiveInvestmentModelDialog] = useState(null);
  const [qqqData, setQqqData] = useState(null);
  const [qqqLoading, setQqqLoading] = useState(false);
  const [qqqError, setQqqError] = useState(null);
  const [benchmarkSummary, setBenchmarkSummary] = useState({ status: 'idle', data: null, error: null });
  const [investmentModelCharts, setInvestmentModelCharts] = useState({});
  const investmentModelChartsRef = useRef({});
  const [portfolioNewsState, setPortfolioNewsState] = useState({
    status: 'idle',
    articles: [],
    error: null,
    disclaimer: null,
    generatedAt: null,
    cacheKey: null,
    symbols: [],
  });
  const [portfolioNewsRetryKey, setPortfolioNewsRetryKey] = useState(0);
  const quoteCacheRef = useRef(new Map());
  const [showTotalPnlDialog, setShowTotalPnlDialog] = useState(false);
  const [totalPnlSeriesState, setTotalPnlSeriesState] = useState({
    status: 'idle',
    data: null,
    error: null,
    accountKey: null,
    mode: 'cagr',
  });
  const [totalPnlRange, setTotalPnlRange] = useState('all');
  const lastAccountForRange = useRef(null);
  const lastCagrStartDate = useRef(null);
  const { loading, data, error } = useSummaryData(activeAccountId, refreshKey);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const nextUrl = buildAccountViewUrl(activeAccountId, undefined, {
      todoAction: null,
      todoModel: null,
      todoChart: null,
      todoAccountNumber: null,
    });
    if (!nextUrl || nextUrl === window.location.href) {
      return;
    }
    window.history.replaceState(null, '', nextUrl);
  }, [activeAccountId]);

  const accounts = useMemo(() => data?.accounts ?? [], [data?.accounts]);
  const accountGroups = useMemo(() => {
    const rawGroups = data?.accountGroups;
    if (!Array.isArray(rawGroups)) {
      return [];
    }
    const seenIds = new Set();
    return rawGroups
      .map((group) => {
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
          : null;
        const accountIds = Array.isArray(group.accountIds)
          ? Array.from(
              new Set(
                group.accountIds
                  .map((value) => (value === undefined || value === null ? '' : String(value).trim()))
                  .filter(Boolean)
              )
            )
          : [];
        const accountNumbers = Array.isArray(group.accountNumbers)
          ? Array.from(
              new Set(
                group.accountNumbers
                  .map((value) => (value === undefined || value === null ? '' : String(value).trim()))
                  .filter(Boolean)
              )
            )
          : [];
        const ownerLabels = Array.isArray(group.ownerLabels)
          ? Array.from(
              new Set(
                group.ownerLabels
                  .map((value) => (typeof value === 'string' ? value.trim() : ''))
                  .filter(Boolean)
              )
            )
          : [];
        return {
          id,
          name,
          memberCount: memberCount !== null ? memberCount : accountIds.length,
          accountIds,
          accountNumbers,
          ownerLabels,
        };
      })
      .filter((group) => {
        if (!group) {
          return false;
        }
        if (seenIds.has(group.id)) {
          return false;
        }
        seenIds.add(group.id);
        return true;
      });
  }, [data?.accountGroups]);
  const groupRelations = useMemo(() => {
    const raw = data?.groupRelations;
    if (!raw || typeof raw !== 'object') {
      return {};
    }
    // Normalize names (trim only; preserve case for display)
    const normalized = {};
    Object.entries(raw).forEach(([child, parents]) => {
      const name = typeof child === 'string' ? child.trim() : '';
      if (!name) return;
      const list = Array.isArray(parents) ? parents : [parents];
      normalized[name] = list
        .map((p) => (typeof p === 'string' ? p.trim() : ''))
        .filter(Boolean);
    });
    return normalized;
  }, [data?.groupRelations]);
  const accountGroupChildrenMap = useMemo(() => {
    const map = new Map();
    Object.entries(groupRelations).forEach(([childName, parents]) => {
      const childKey = normalizeAccountGroupKey(childName);
      if (!childKey) {
        return;
      }
      const parentList = Array.isArray(parents) ? parents : [parents];
      parentList.forEach((parentName) => {
        const parentKey = normalizeAccountGroupKey(parentName);
        if (!parentKey) {
          return;
        }
        let set = map.get(parentKey);
        if (!set) {
          set = new Set();
          map.set(parentKey, set);
        }
        set.add(childKey);
      });
    });
    return map;
  }, [groupRelations]);
  const accountGroupsById = useMemo(() => {
    const map = new Map();
    accountGroups.forEach((group) => {
      map.set(group.id, group);
    });
    return map;
  }, [accountGroups]);
  const rebalanceTodos = useMemo(() => {
    if (!accounts.length) {
      return [];
    }
    const items = [];
    const seenIds = new Set();
    const today = new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

    accounts.forEach((account) => {
      if (!account) {
        return;
      }
      const accountLabel = getAccountLabel(account);
      const accountId = typeof account.id === 'string' && account.id ? account.id : null;
      const rawAccountNumber =
        account.number !== undefined && account.number !== null ? String(account.number).trim() : '';
      const accountNumberValue = rawAccountNumber || null;
      const models = resolveAccountModelsForDisplay(account);
      models.forEach((model) => {
        const last = typeof model.lastRebalance === 'string' ? model.lastRebalance.trim() : '';
        if (!last) {
          return;
        }
        const periodDays =
          normalizePositiveInteger(model.rebalancePeriod) ??
          normalizePositiveInteger(account.rebalancePeriod);
        if (periodDays === null) {
          return;
        }
        const parsedLast = parseDateOnly(last);
        if (!parsedLast) {
          return;
        }
        const dueTime = parsedLast.time + periodDays * MS_PER_DAY;
        if (!Number.isFinite(dueTime)) {
          return;
        }
        const dueDate = new Date(dueTime);
        if (Number.isNaN(dueDate.getTime())) {
          return;
        }
        const dueUtc = Date.UTC(
          dueDate.getUTCFullYear(),
          dueDate.getUTCMonth(),
          dueDate.getUTCDate()
        );
        if (!Number.isFinite(dueUtc)) {
          return;
        }
        if (todayUtc < dueUtc) {
          return;
        }

        const accountKey = accountId || accountNumberValue;
        const modelKey = typeof model.model === 'string' ? model.model.trim().toUpperCase() : 'ACCOUNT';
        const todoId = `${accountKey || 'account'}:${modelKey || 'MODEL'}`;
        if (seenIds.has(todoId)) {
          return;
        }
        seenIds.add(todoId);

        const overdueDays = todayUtc > dueUtc ? Math.floor((todayUtc - dueUtc) / MS_PER_DAY) : 0;
        const dueIso = new Date(dueUtc).toISOString().slice(0, 10);
        items.push({
          id: todoId,
          accountId,
          accountNumber: accountNumberValue,
          accountLabel,
          modelKey: modelKey || null,
          modelTitle: model.title || null,
          lastRebalance: last,
          dueDate: dueIso,
          dueTimestamp: dueUtc,
          overdueDays: overdueDays > 0 ? overdueDays : 0,
          dueToday: overdueDays <= 0,
          periodDays,
        });
      });
    });

    items.sort((a, b) => {
      if (a.dueTimestamp !== b.dueTimestamp) {
        return a.dueTimestamp - b.dueTimestamp;
      }
      const labelCompare = (a.accountLabel || '').localeCompare(b.accountLabel || '', undefined, {
        sensitivity: 'base',
      });
      if (labelCompare !== 0) {
        return labelCompare;
      }
      return (a.modelTitle || '').localeCompare(b.modelTitle || '', undefined, { sensitivity: 'base' });
    });

    return items;
  }, [accounts]);
  const accountsById = useMemo(() => {
    const map = new Map();
    accounts.forEach((account) => {
      if (account && typeof account.id === 'string' && account.id) {
        map.set(account.id, account);
      }
    });
    return map;
  }, [accounts]);
  const accountsByGroupName = useMemo(() => {
    const map = new Map();
    accounts.forEach((account) => {
      if (!account) {
        return;
      }
      const groupKey = normalizeAccountGroupKey(account.accountGroup);
      if (!groupKey) {
        return;
      }
      if (!map.has(groupKey)) {
        map.set(groupKey, []);
      }
      map.get(groupKey).push(account);
    });
    return map;
  }, [accounts]);
  const filteredAccountIds = useMemo(
    () => (Array.isArray(data?.filteredAccountIds) ? data.filteredAccountIds : []),
    [data?.filteredAccountIds]
  );
  const resolvedCashAccountIds = useMemo(() => {
    if (filteredAccountIds.length) {
      return filteredAccountIds.filter((accountId) => accountId && accountsById.has(accountId));
    }
    return Array.from(accountsById.keys());
  }, [filteredAccountIds, accountsById]);
  const accountsInView = useMemo(() => {
    const candidateIds =
      filteredAccountIds.length > 0 ? filteredAccountIds : Array.from(accountsById.keys());
    return candidateIds.filter((accountId) => accountId && accountsById.has(accountId));
  }, [filteredAccountIds, accountsById]);
  const selectedAccount = useMemo(() => {
    if (activeAccountId === 'default') {
      if (filteredAccountIds.length === 1) {
        return filteredAccountIds[0];
      }
      if (filteredAccountIds.length > 1) {
        return 'all';
      }
    }
    return selectedAccountState;
  }, [activeAccountId, filteredAccountIds, selectedAccountState]);
  const selectedAccountGroup = useMemo(() => {
    if (!isAccountGroupSelection(selectedAccount)) {
      return null;
    }
    return accountGroupsById.get(selectedAccount) || null;
  }, [selectedAccount, accountGroupsById]);
  const aggregateAccountLabel = useMemo(() => {
    if (selectedAccount === 'all') {
      return 'All accounts';
    }
    return selectedAccountGroup ? selectedAccountGroup.name : null;
  }, [selectedAccount, selectedAccountGroup]);
  const showingAllAccounts = selectedAccount === 'all';
  const isAggregateSelection = isAggregateAccountSelection(selectedAccount);

  const selectedAccountInfo = useMemo(() => {
    if (!selectedAccount || isAggregateSelection) {
      return null;
    }
    return (
      accounts.find((account) => {
        if (!account) {
          return false;
        }
        const accountId = typeof account.id === 'string' ? account.id : null;
        const accountNumber = typeof account.number === 'string' ? account.number : null;
        return accountId === selectedAccount || accountNumber === selectedAccount;
      }) || null
    );
  }, [accounts, selectedAccount, isAggregateSelection]);

  const selectedAccountTargetProportions = useMemo(() => {
    if (!selectedAccountInfo) {
      return null;
    }
    return extractTargetProportionsFromSymbols(selectedAccountInfo.symbols);
  }, [selectedAccountInfo]);

  const activePlanningContext = useMemo(() => {
    if (isAggregateSelection) {
      return '';
    }
    const stored = selectedAccountInfo?.planningContext;
    return typeof stored === 'string' ? stored : '';
  }, [isAggregateSelection, selectedAccountInfo]);

  useEffect(() => {
    if (activeAccountId !== 'default') {
      return;
    }
    if (filteredAccountIds.length === 1) {
      const resolvedId = filteredAccountIds[0];
      if (resolvedId && selectedAccountState !== resolvedId) {
        setSelectedAccountState(resolvedId);
      }
      return;
    }
    if (filteredAccountIds.length > 1 && selectedAccountState !== 'all') {
      setSelectedAccountState('all');
    }
  }, [activeAccountId, filteredAccountIds, selectedAccountState, setSelectedAccountState]);

  const handleAccountChange = useCallback(
    (value) => {
      if (!value) {
        return;
      }
      setSelectedRebalanceReminder(null);
      setSelectedAccountState(value);
      setActiveAccountId(value);
    },
    [setActiveAccountId, setSelectedAccountState, setSelectedRebalanceReminder]
  );

  const handleTodoSelect = useCallback(
    (item, event) => {
      if (!item || !isAggregateSelection) {
        return;
      }
      const shouldOpenInNewTab = Boolean(
        event && (event.ctrlKey || event.metaKey || event.button === 1)
      );
      const directId = typeof item.accountId === 'string' && item.accountId ? item.accountId : null;
      const normalizedAccountNumber =
        typeof item.accountNumber === 'string' && item.accountNumber.trim() ? item.accountNumber.trim() : null;
      let resolvedAccountId = directId;
      let resolvedAccountNumber = normalizedAccountNumber;

      if (!resolvedAccountId && normalizedAccountNumber) {
        const match = accounts.find((account) => {
          if (!account) {
            return false;
          }
          const accountNumber =
            account.number !== undefined && account.number !== null ? String(account.number).trim() : '';
          const accountId = typeof account.id === 'string' ? account.id : '';
          return accountNumber === normalizedAccountNumber || accountId === normalizedAccountNumber;
        });
        if (match && typeof match.id === 'string' && match.id) {
          resolvedAccountId = match.id;
          const matchNumber =
            match.number !== undefined && match.number !== null
              ? String(match.number).trim()
              : typeof match.accountNumber === 'string' && match.accountNumber.trim()
              ? match.accountNumber.trim()
              : null;
          if (matchNumber) {
            resolvedAccountNumber = matchNumber;
          }
        }
      } else if (resolvedAccountId) {
        const match = accounts.find((account) => {
          if (!account) {
            return false;
          }
          return (typeof account.id === 'string' ? account.id : '') === resolvedAccountId;
        });
        if (match) {
          const matchNumber =
            match.number !== undefined && match.number !== null
              ? String(match.number).trim()
              : typeof match.accountNumber === 'string' && match.accountNumber.trim()
              ? match.accountNumber.trim()
              : null;
          if (matchNumber) {
            resolvedAccountNumber = matchNumber;
          }
        }
      }

      const targetAccountIdentifier = resolvedAccountId || normalizedAccountNumber || null;
      if (shouldOpenInNewTab && targetAccountIdentifier) {
        event.preventDefault();
        if (typeof event.stopPropagation === 'function') {
          event.stopPropagation();
        }
        const reminderModelKey =
          typeof item.modelKey === 'string' && item.modelKey.trim()
            ? item.modelKey.trim().toUpperCase()
            : null;
        const targetUrl = buildAccountViewUrl(targetAccountIdentifier, undefined, {
          todoModel: reminderModelKey,
          todoAccountNumber: resolvedAccountNumber,
        });
        if (targetUrl && typeof window !== 'undefined' && typeof window.open === 'function') {
          window.open(targetUrl, '_blank', 'noopener,noreferrer');
        }
        return;
      }

      setSelectedRebalanceReminder({
        accountId: resolvedAccountId,
        accountNumber: resolvedAccountNumber,
        modelKey:
          typeof item.modelKey === 'string' && item.modelKey.trim() ? item.modelKey.trim().toUpperCase() : null,
      });

      if (resolvedAccountId) {
        setSelectedAccountState(resolvedAccountId);
        setActiveAccountId(resolvedAccountId);
        return;
      }
      if (normalizedAccountNumber) {
        const match = accounts.find((account) => {
          if (!account) {
            return false;
          }
          const accountNumber =
            account.number !== undefined && account.number !== null
              ? String(account.number)
              : '';
          const accountId = typeof account.id === 'string' ? account.id : '';
          return accountNumber === normalizedAccountNumber || accountId === normalizedAccountNumber;
        });
        if (match && typeof match.id === 'string') {
          setSelectedAccountState(match.id);
          setActiveAccountId(match.id);
        }
      }
    },
    [
      isAggregateSelection,
      accounts,
      setSelectedAccountState,
      setActiveAccountId,
      setSelectedRebalanceReminder,
      buildAccountViewUrl,
    ]
  );

  const selectedAccountKey = useMemo(() => {
    if (selectedAccount === 'all') {
      return 'all';
    }
    if (isAccountGroupSelection(selectedAccount)) {
      return selectedAccount;
    }
    if (!selectedAccountInfo) {
      return null;
    }
    if (selectedAccountInfo.id) {
      return String(selectedAccountInfo.id);
    }
    if (selectedAccountInfo.number) {
      return String(selectedAccountInfo.number);
    }
    if (selectedAccount && !isAggregateSelection) {
      return String(selectedAccount);
    }
    return null;
  }, [selectedAccountInfo, selectedAccount, isAggregateSelection]);

  const totalPnlDialogAccountLabel = useMemo(() => {
    if (isAggregateSelection) {
      return aggregateAccountLabel;
    }
    if (!selectedAccountInfo) {
      return null;
    }
    const label = getAccountLabel(selectedAccountInfo);
    if (label) {
      return label;
    }
    if (selectedAccountInfo.number) {
      return String(selectedAccountInfo.number);
    }
    return null;
  }, [isAggregateSelection, aggregateAccountLabel, selectedAccountInfo]);

  useEffect(() => {
    if (!selectedRebalanceReminder) {
      return;
    }
    if (isAggregateSelection) {
      setSelectedRebalanceReminder(null);
      return;
    }
    if (!selectedAccountInfo) {
      setSelectedRebalanceReminder(null);
      return;
    }
    const accountId = typeof selectedAccountInfo.id === 'string' ? selectedAccountInfo.id : null;
    const rawNumber = selectedAccountInfo.number ?? selectedAccountInfo.accountNumber;
    const accountNumber =
      typeof rawNumber === 'string' ? rawNumber.trim() : rawNumber != null ? String(rawNumber).trim() : null;
    const matchesId = accountId && selectedRebalanceReminder.accountId === accountId;
    const matchesNumber = accountNumber && selectedRebalanceReminder.accountNumber === accountNumber;
    if (!matchesId && !matchesNumber) {
      setSelectedRebalanceReminder(null);
    }
  }, [isAggregateSelection, selectedAccountInfo, selectedRebalanceReminder, setSelectedRebalanceReminder]);

  useEffect(() => {
    setShowTotalPnlDialog(false);
    setTotalPnlSeriesState({ status: 'idle', data: null, error: null, accountKey: null });
  }, [selectedAccountKey]);

  const markRebalanceContext = useMemo(() => {
    if (!selectedAccountInfo || isAggregateSelection) {
      return null;
    }
    const rawNumber = selectedAccountInfo.number ?? selectedAccountInfo.accountNumber;
    const accountNumber =
      typeof rawNumber === 'string' ? rawNumber.trim() : rawNumber != null ? String(rawNumber).trim() : '';
    if (!accountNumber) {
      return null;
    }
    const accountId = typeof selectedAccountInfo.id === 'string' ? selectedAccountInfo.id : null;
    const reminderMatchesAccount = (() => {
      if (!selectedRebalanceReminder) {
        return false;
      }
      const reminderId =
        typeof selectedRebalanceReminder.accountId === 'string' && selectedRebalanceReminder.accountId
          ? selectedRebalanceReminder.accountId
          : null;
      const reminderNumber =
        typeof selectedRebalanceReminder.accountNumber === 'string' && selectedRebalanceReminder.accountNumber
          ? selectedRebalanceReminder.accountNumber
          : null;
      if (reminderId && accountId && reminderId === accountId) {
        return true;
      }
      if (reminderNumber && reminderNumber === accountNumber) {
        return true;
      }
      return false;
    })();

    const selectedModelKey = reminderMatchesAccount
      ? typeof selectedRebalanceReminder?.modelKey === 'string' && selectedRebalanceReminder.modelKey
        ? selectedRebalanceReminder.modelKey
        : null
      : null;

    const models = resolveAccountModelsForDisplay(selectedAccountInfo);
    let targetModel = null;
    if (selectedModelKey) {
      targetModel = models.find((model) => {
        const modelName = typeof model.model === 'string' ? model.model.trim().toUpperCase() : '';
        return modelName === selectedModelKey;
      });
    }

    const withRebalance = targetModel
      ? targetModel
      : models.find((model) => typeof model.lastRebalance === 'string' && model.lastRebalance.trim());

    if (withRebalance) {
      const resolvedModelName =
        targetModel && selectedModelKey
          ? selectedModelKey
          : typeof withRebalance.model === 'string' && withRebalance.model.trim()
          ? withRebalance.model.trim().toUpperCase()
          : null;
      return {
        accountId,
        accountNumber,
        model: resolvedModelName,
        lastRebalance: withRebalance.lastRebalance,
      };
    }
    const fallbackLast =
      typeof selectedAccountInfo.investmentModelLastRebalance === 'string'
        ? selectedAccountInfo.investmentModelLastRebalance.trim()
        : '';
    if (fallbackLast) {
      return {
        accountId,
        accountNumber,
        model: null,
        lastRebalance: fallbackLast,
      };
    }
    return null;
  }, [selectedAccountInfo, isAggregateSelection, selectedRebalanceReminder]);
  const rawPositions = useMemo(() => data?.positions ?? [], [data?.positions]);
  const rawOrders = useMemo(() => (Array.isArray(data?.orders) ? data.orders : []), [data?.orders]);
  const ordersFilterInputId = useId();
  const dividendTimeframeSelectId = useId();
  const normalizedDividendTimeframe = useMemo(() => {
    if (DIVIDEND_TIMEFRAME_OPTIONS.some((option) => option.value === dividendTimeframe)) {
      return dividendTimeframe;
    }
    return DEFAULT_DIVIDEND_TIMEFRAME;
  }, [dividendTimeframe]);
  const balances = data?.balances || null;
  const normalizedOrdersFilter = typeof ordersFilter === 'string' ? ordersFilter.trim() : '';
  const ordersFilterQuery = normalizedOrdersFilter.toLowerCase();
  const ordersForSelectedAccount = useMemo(() => {
    if (!rawOrders.length) {
      return [];
    }

    if (isAggregateSelection) {
      if (!accountsInView.length) {
        return [];
      }
      const allowedIds = new Set(accountsInView.map((id) => String(id)));
      return rawOrders.filter((order) => {
        const orderAccountId = order && order.accountId ? String(order.accountId) : null;
        return orderAccountId && allowedIds.has(orderAccountId);
      });
    }

    const targetAccountId =
      (selectedAccountInfo && typeof selectedAccountInfo.id === 'string' && selectedAccountInfo.id) ||
      (typeof selectedAccount === 'string' ? selectedAccount : null);
    if (!targetAccountId) {
      return [];
    }
    const normalizedTarget = String(targetAccountId);
    return rawOrders.filter((order) => {
      const orderAccountId = order && order.accountId ? String(order.accountId) : null;
      return orderAccountId === normalizedTarget;
    });
  }, [rawOrders, isAggregateSelection, selectedAccountInfo, accountsInView]);
  const filteredOrdersForSelectedAccount = useMemo(() => {
    if (!ordersFilterQuery) {
      return ordersForSelectedAccount;
    }

    return ordersForSelectedAccount.filter((order) => {
      if (!order || typeof order !== 'object') {
        return false;
      }
      const fields = [
        order.symbol,
        order.description,
        order.status,
        order.action,
        order.type,
        order.displayName,
        order.accountOwnerLabel,
        order.accountNumber,
        order.orderId,
        order.currency,
        order.notes,
      ];
      if (order.creationTime) {
        fields.push(order.creationTime);
      }
      if (order.updateTime) {
        fields.push(order.updateTime);
      }
      if (Number.isFinite(order.totalQuantity)) {
        fields.push(String(order.totalQuantity));
      }
      if (Number.isFinite(order.filledQuantity)) {
        fields.push(String(order.filledQuantity));
      }
      if (Number.isFinite(order.openQuantity)) {
        fields.push(String(order.openQuantity));
      }
      return fields.some((value) => {
        if (value === null || value === undefined) {
          return false;
        }
        return String(value).toLowerCase().includes(ordersFilterQuery);
      });
    });
  }, [ordersForSelectedAccount, ordersFilterQuery]);
  const hasOrdersFilter = normalizedOrdersFilter.length > 0;
  const ordersEmptyMessage = hasOrdersFilter
    ? 'No orders match the current filter.'
    : 'No orders found for this period.';
  const accountFundingSource = data?.accountFunding;
  const accountFunding = useMemo(
    () => (accountFundingSource && typeof accountFundingSource === 'object' ? accountFundingSource : EMPTY_OBJECT),
    [accountFundingSource]
  );
  const accountDividendSource = data?.accountDividends;
  const accountDividends = useMemo(
    () => (accountDividendSource && typeof accountDividendSource === 'object' ? accountDividendSource : EMPTY_OBJECT),
    [accountDividendSource]
  );
  const accountBalances = data?.accountBalances ?? EMPTY_OBJECT;
  const selectedAccountFunding = useMemo(() => {
    if (!isAggregateSelection) {
      if (!selectedAccountInfo) {
        return null;
      }
      const entry = accountFunding[selectedAccountInfo.id];
      return entry && typeof entry === 'object' ? entry : null;
    }

    const aggregateKey = selectedAccount === 'all' ? 'all' : selectedAccount;
    const directEntry = aggregateKey ? accountFunding[aggregateKey] : null;
    if (directEntry && typeof directEntry === 'object') {
      return directEntry;
    }

    const memberAccountIds = (() => {
      if (selectedAccount === 'all') {
        if (accountsInView.length) {
          return accountsInView;
        }
        if (filteredAccountIds.length) {
          return filteredAccountIds;
        }
        return Array.from(accountsById.keys());
      }
      if (selectedAccountGroup?.accountIds?.length) {
        return selectedAccountGroup.accountIds;
      }
      if (accountsInView.length) {
        return accountsInView;
      }
      return [];
    })();

    if (!memberAccountIds.length) {
      return null;
    }

    let netDepositsTotal = 0;
    let netDepositsCount = 0;
    let totalPnlTotal = 0;
    let totalPnlCount = 0;
    let totalEquityTotal = 0;
    let totalEquityCount = 0;

    memberAccountIds.forEach((accountId) => {
      const key = accountId === undefined || accountId === null ? '' : String(accountId).trim();
      if (!key) {
        return;
      }
      const entry = accountFunding[key];
      if (!entry || typeof entry !== 'object') {
        return;
      }
      const netDepositsCad = entry?.netDeposits?.combinedCad;
      if (isFiniteNumber(netDepositsCad)) {
        netDepositsTotal += netDepositsCad;
        netDepositsCount += 1;
      }
      const totalPnlCad = entry?.totalPnl?.combinedCad;
      if (isFiniteNumber(totalPnlCad)) {
        totalPnlTotal += totalPnlCad;
        totalPnlCount += 1;
      }
      const totalEquityCad = entry?.totalEquityCad;
      if (isFiniteNumber(totalEquityCad)) {
        totalEquityTotal += totalEquityCad;
        totalEquityCount += 1;
      }
    });

    if (netDepositsCount === 0 && totalPnlCount === 0 && totalEquityCount === 0) {
      return null;
    }

    const aggregate = {};
    if (netDepositsCount > 0) {
      aggregate.netDeposits = { combinedCad: netDepositsTotal };
    }
    if (totalPnlCount > 0) {
      aggregate.totalPnl = { combinedCad: totalPnlTotal };
    } else if (netDepositsCount > 0 && totalEquityCount > 0) {
      const derivedTotalPnl = totalEquityTotal - netDepositsTotal;
      if (isFiniteNumber(derivedTotalPnl)) {
        aggregate.totalPnl = { combinedCad: derivedTotalPnl };
      }
    }
    if (totalEquityCount > 0) {
      aggregate.totalEquityCad = totalEquityTotal;
    }

    return Object.keys(aggregate).length > 0 ? aggregate : null;
  }, [
    isAggregateSelection,
    selectedAccount,
    selectedAccountGroup,
    accountFunding,
    selectedAccountInfo,
    accountsInView,
    filteredAccountIds,
    accountsById,
  ]);
  const selectedAccountDividends = useMemo(() => {
    if (isAggregateSelection) {
      const aggregateKey = selectedAccount === 'all' ? 'all' : selectedAccount;
      const directEntry = aggregateKey ? accountDividends[aggregateKey] : null;
      if (directEntry && typeof directEntry === 'object') {
        const summary = resolveDividendSummaryForTimeframe(
          directEntry,
          normalizedDividendTimeframe
        );
        if (summary && typeof summary === 'object') {
          return summary;
        }
      }

      const aggregateAccountIds = (() => {
        if (selectedAccount === 'all') {
          return accountsInView.length ? accountsInView : filteredAccountIds;
        }
        if (selectedAccountGroup?.accountIds?.length) {
          return selectedAccountGroup.accountIds;
        }
        return accountsInView;
      })();

      return aggregateDividendSummaries(
        accountDividends,
        aggregateAccountIds,
        normalizedDividendTimeframe
      );
    }
    if (!selectedAccountInfo) {
      return null;
    }
    const entry = accountDividends[selectedAccountInfo.id];
    const resolvedSummary = resolveDividendSummaryForTimeframe(
      entry,
      normalizedDividendTimeframe
    );
    if (resolvedSummary && typeof resolvedSummary === 'object') {
      return resolvedSummary;
    }
    if (entry && typeof entry === 'object') {
      return createEmptyDividendSummary();
    }
    return createEmptyDividendSummary();
  }, [
    isAggregateSelection,
    selectedAccount,
    selectedAccountGroup,
    selectedAccountInfo,
    accountDividends,
    accountsInView,
    filteredAccountIds,
    normalizedDividendTimeframe,
  ]);
  const hasDividendSummary = Boolean(selectedAccountDividends);
  const showDividendsPanel = hasDividendSummary && portfolioViewTab === 'dividends';
  const showOrdersPanel = portfolioViewTab === 'orders';
  const showNewsPanel = portfolioViewTab === 'news';
  
  const positionsTabId = 'portfolio-tab-positions';
  const ordersTabId = 'portfolio-tab-orders';
  const dividendsTabId = 'portfolio-tab-dividends';
  const modelsTabId = 'portfolio-tab-models';
  const newsTabId = 'portfolio-tab-news';
  const positionsPanelId = 'portfolio-panel-positions';
  const ordersPanelId = 'portfolio-panel-orders';
  const dividendsPanelId = 'portfolio-panel-dividends';
  const modelsPanelId = 'portfolio-panel-models';
  const newsPanelId = 'portfolio-panel-news';
  const investmentModelEvaluations = data?.investmentModelEvaluations ?? EMPTY_OBJECT;
  const a1ReferenceAccount = useMemo(() => {
    if (!accounts.length) {
      return null;
    }
    const targetModel = 'A1';
    return (
      accounts.find((account) => {
        const models = resolveAccountModelsForDisplay(account);
        return models.some((entry) => String(entry.model || '').trim().toUpperCase() === targetModel);
      }) || null
    );
  }, [accounts]);
  const a1LastRebalance = useMemo(() => {
    if (!a1ReferenceAccount) {
      return null;
    }
    const models = resolveAccountModelsForDisplay(a1ReferenceAccount);
    const match = models.find((entry) => String(entry.model || '').trim().toUpperCase() === 'A1');
    return match?.lastRebalance || null;
  }, [a1ReferenceAccount]);
  const a1Evaluation = useMemo(() => {
    if (!a1ReferenceAccount?.id) {
      return null;
    }
    const bucket = investmentModelEvaluations[a1ReferenceAccount.id];
    if (!bucket || typeof bucket !== 'object') {
      return null;
    }
    if (bucket.A1) {
      return bucket.A1;
    }
    const entries = Object.entries(bucket);
    const match = entries.find(([key]) => String(key || '').toUpperCase() === 'A1');
    return match ? match[1] : null;
  }, [a1ReferenceAccount, investmentModelEvaluations]);
  const asOf = data?.asOf || null;

  const baseCurrency = 'CAD';
  const currencyRates = useMemo(() => buildCurrencyRateMap(balances, baseCurrency), [balances]);

  const usdToCadRate = useMemo(() => {
    const apiRate = isFiniteNumber(data?.usdToCadRate) && data.usdToCadRate > 0 ? data.usdToCadRate : null;
    if (apiRate !== null) {
      return apiRate;
    }
    const derived = currencyRates.get('USD');
    if (isFiniteNumber(derived) && derived > 0) {
      return derived;
    }
    return null;
  }, [data?.usdToCadRate, currencyRates]);

  const positions = useMemo(() => {
    if (isAggregateSelection) {
      return aggregatePositionsBySymbol(rawPositions, { currencyRates, baseCurrency });
    }
    return rawPositions;
  }, [rawPositions, isAggregateSelection, currencyRates, baseCurrency]);

  const totalMarketValue = useMemo(() => {
    if (!positions.length) {
      return 0;
    }
    return positions.reduce((acc, position) => {
      return acc + resolveNormalizedMarketValue(position, currencyRates, baseCurrency);
    }, 0);
  }, [positions, currencyRates, baseCurrency]);

  const positionsWithShare = useMemo(() => {
    if (!positions.length) {
      return [];
    }
    return positions.map((position) => {
      const normalizedValue = resolveNormalizedMarketValue(position, currencyRates, baseCurrency);
      const share = totalMarketValue > 0 ? (normalizedValue / totalMarketValue) * 100 : 0;
      const normalizedDayPnl = resolveNormalizedPnl(position, 'dayPnl', currencyRates, baseCurrency);
      const normalizedOpenPnl = resolveNormalizedPnl(position, 'openPnl', currencyRates, baseCurrency);
      const targetProportion = Number.isFinite(position.targetProportion)
        ? position.targetProportion
        : null;
      return {
        ...position,
        portfolioShare: share,
        normalizedMarketValue: normalizedValue,
        normalizedDayPnl,
        normalizedOpenPnl,
        targetProportion,
      };
    });
  }, [positions, totalMarketValue, currencyRates, baseCurrency]);

  const orderedPositions = useMemo(() => {
    const list = positionsWithShare.slice();
    list.sort((a, b) => {
      const shareDiff = (b.portfolioShare || 0) - (a.portfolioShare || 0);
      if (Math.abs(shareDiff) > 0.0001) {
        return shareDiff;
      }
      const marketDiff = (b.currentMarketValue || 0) - (a.currentMarketValue || 0);
      if (Math.abs(marketDiff) > 0.01) {
        return marketDiff;
      }
      return a.symbol.localeCompare(b.symbol);
    });
    return list;
  }, [positionsWithShare]);

  const hasTargetProportionsForSelection = useMemo(
    () => orderedPositions.some((position) => Number.isFinite(position?.targetProportion)),
    [orderedPositions]
  );

  const forcedTargetForSelectedAccount = selectedAccountKey
    ? forcedTargetAccounts.has(selectedAccountKey)
    : false;

  const showTargetColumnForSelection =
    hasTargetProportionsForSelection || forcedTargetForSelectedAccount;

  const newsSymbols = useMemo(() => extractSymbolsForNews(orderedPositions), [orderedPositions]);
  const resolvedNewsSymbols =
    Array.isArray(portfolioNewsState.symbols) && portfolioNewsState.symbols.length
      ? portfolioNewsState.symbols
      : newsSymbols;
  const newsStatus = portfolioNewsState.status === 'idle' ? 'loading' : portfolioNewsState.status;

  const newsAccountId = useMemo(() => {
    if (isAggregateSelection) {
      if (selectedAccount === 'all') {
        return 'all';
      }
      if (typeof selectedAccount === 'string' && selectedAccount.trim()) {
        return selectedAccount.trim();
      }
    }
    if (selectedAccountInfo && selectedAccountInfo.id !== undefined && selectedAccountInfo.id !== null) {
      return String(selectedAccountInfo.id);
    }
    if (typeof selectedAccount === 'string' && selectedAccount.trim()) {
      return selectedAccount.trim();
    }
    return '';
  }, [isAggregateSelection, selectedAccount, selectedAccountInfo]);
  const newsAccountLabel = useMemo(() => {
    if (isAggregateSelection) {
      return aggregateAccountLabel || '';
    }
    if (selectedAccountInfo) {
      return getAccountLabel(selectedAccountInfo) || '';
    }
    return '';
  }, [isAggregateSelection, aggregateAccountLabel, selectedAccountInfo]);
  const newsCacheKey = useMemo(() => {
    const accountComponent = newsAccountId || newsAccountLabel || 'portfolio';
    return `${accountComponent}|${newsSymbols.join('|')}`;
  }, [newsAccountId, newsAccountLabel, newsSymbols]);

  const currencyOptions = useMemo(() => buildCurrencyOptions(balances), [balances]);

  useEffect(() => {
    if (!currencyOptions.length) {
      setCurrencyView(null);
      return;
    }
    if (!currencyOptions.some((option) => option.value === currencyView)) {
      setCurrencyView(currencyOptions[0].value);
    }
  }, [currencyOptions, currencyView]);

  useEffect(() => {
    if (portfolioViewTab !== 'news') {
      return;
    }

    if (!newsSymbols.length) {
      setPortfolioNewsState((prev) => {
        if (
          prev.status === 'ready' &&
          !prev.error &&
          (Array.isArray(prev.symbols) ? prev.symbols.length === 0 : true) &&
          prev.cacheKey === newsCacheKey
        ) {
          return prev;
        }
        return {
          status: 'ready',
          articles: [],
          error: null,
          disclaimer: null,
          generatedAt: null,
          cacheKey: newsCacheKey,
          symbols: [],
        };
      });
      return;
    }

    let shouldFetch = true;

    setPortfolioNewsState((prev) => {
      if (prev.cacheKey === newsCacheKey) {
        if (prev.status === 'ready') {
          shouldFetch = false;
          return prev;
        }
        if (prev.status === 'loading') {
          shouldFetch = false;
          return prev;
        }
        if (prev.status === 'error') {
          shouldFetch = false;
          return prev;
        }
      }

      return {
        ...prev,
        status: 'loading',
        error: null,
        cacheKey: newsCacheKey,
        symbols: newsSymbols,
      };
    });

    if (!shouldFetch) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    getPortfolioNews(
      {
        accountId: newsAccountId,
        accountLabel: newsAccountLabel,
        symbols: newsSymbols,
      },
      { signal: controller.signal }
    )
      .then((payload) => {
        if (cancelled) {
          return;
        }
        const articles = Array.isArray(payload?.articles) ? payload.articles.filter(Boolean) : [];
        const disclaimer = typeof payload?.disclaimer === 'string' ? payload.disclaimer.trim() : '';
        const generatedAt = typeof payload?.generatedAt === 'string' ? payload.generatedAt : null;
        const responseSymbols = Array.isArray(payload?.symbols)
          ? payload.symbols.map((symbol) => (typeof symbol === 'string' ? symbol.trim().toUpperCase() : '')).filter(Boolean)
          : null;
        setPortfolioNewsState({
          status: 'ready',
          articles,
          error: null,
          disclaimer: disclaimer || null,
          generatedAt,
          cacheKey: newsCacheKey,
          symbols: responseSymbols && responseSymbols.length ? responseSymbols : newsSymbols,
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        if (error && error.name === 'AbortError') {
          return;
        }
        const message = error && error.message ? error.message : 'Failed to load portfolio news';
        setPortfolioNewsState({
          status: 'error',
          articles: [],
          error: message,
          disclaimer: null,
          generatedAt: null,
          cacheKey: newsCacheKey,
          symbols: newsSymbols,
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [portfolioViewTab, newsSymbols, newsAccountId, newsAccountLabel, newsCacheKey, portfolioNewsRetryKey]);

  const balancePnlSummaries = useMemo(() => buildBalancePnlMap(balances), [balances]);
  const positionPnlSummaries = useMemo(() => buildPnlSummaries(positions), [positions]);

  const normalizedAccountBalances = useMemo(() => {
    if (accountBalances && typeof accountBalances === 'object') {
      return accountBalances;
    }
    return EMPTY_OBJECT;
  }, [accountBalances]);

  const accountPnlTotals = useMemo(() => {
    if (!Array.isArray(rawPositions) || rawPositions.length === 0) {
      return new Map();
    }

    const totals = new Map();

    rawPositions.forEach((position) => {
      const accountId = position?.accountId;
      if (!accountId) {
        return;
      }

      const currency = position?.currency || baseCurrency;
      const day = isFiniteNumber(position?.dayPnl) ? position.dayPnl : 0;
      const open = isFiniteNumber(position?.openPnl) ? position.openPnl : 0;

      const bucket = totals.get(accountId) || { dayPnl: 0, openPnl: 0 };
      if (day) {
        bucket.dayPnl += normalizeCurrencyAmount(day, currency, currencyRates, baseCurrency);
      }
      if (open) {
        bucket.openPnl += normalizeCurrencyAmount(open, currency, currencyRates, baseCurrency);
      }
      totals.set(accountId, bucket);
    });

    return totals;
  }, [rawPositions, currencyRates, baseCurrency]);
  const childAccountSummaries = useMemo(() => {
    if (!accounts.length) {
      return [];
    }

    const parentKeys = new Set();

    if (isAccountGroupSelection(selectedAccount) && selectedAccountGroup) {
      const groupKey = normalizeAccountGroupKey(selectedAccountGroup.name);
      if (groupKey) {
        parentKeys.add(groupKey);
      }
    } else if (!isAggregateSelection && selectedAccountInfo) {
      [
        selectedAccountInfo.accountGroup,
        selectedAccountInfo.displayName,
        selectedAccountInfo.name,
      ].forEach((value) => {
        const key = normalizeAccountGroupKey(value);
        if (key) {
          parentKeys.add(key);
        }
      });
    } else {
      return [];
    }

    if (!parentKeys.size) {
      return [];
    }

    const queue = Array.from(parentKeys);
    const visitedGroups = new Set();
    const targetGroupKeys = new Set();

    while (queue.length) {
      const currentKey = queue.shift();
      if (!currentKey || visitedGroups.has(currentKey)) {
        continue;
      }
      visitedGroups.add(currentKey);
      targetGroupKeys.add(currentKey);
      const children = accountGroupChildrenMap.get(currentKey);
      if (children && children.size) {
        children.forEach((childKey) => {
          if (!visitedGroups.has(childKey)) {
            queue.push(childKey);
          }
        });
      }
    }

    if (!targetGroupKeys.size) {
      return [];
    }

    const excludeAccountIds = new Set();
    if (!isAccountGroupSelection(selectedAccount) && selectedAccountInfo?.id !== undefined && selectedAccountInfo?.id !== null) {
      const parentId = String(selectedAccountInfo.id).trim();
      if (parentId) {
        excludeAccountIds.add(parentId);
      }
    }

    const seenAccountIds = new Set();
    const items = [];

    targetGroupKeys.forEach((groupKey) => {
      const members = accountsByGroupName.get(groupKey);
      if (!members || !members.length) {
        return;
      }
      members.forEach((account) => {
        if (!account || account.id === undefined || account.id === null) {
          return;
        }
        const accountId = String(account.id).trim();
        if (!accountId || excludeAccountIds.has(accountId) || seenAccountIds.has(accountId)) {
          return;
        }
        seenAccountIds.add(accountId);

        const balanceSummary = normalizeAccountBalanceSummary(normalizedAccountBalances[accountId]);
        let totalEquityCad = null;
        if (balanceSummary) {
          const total = resolveAccountTotalInBase(balanceSummary, currencyRates, baseCurrency);
          if (Number.isFinite(total)) {
            totalEquityCad = total;
          }
        }
        if (totalEquityCad === null) {
          const fallbackTotal = accountFunding[accountId]?.totalEquityCad;
          if (Number.isFinite(fallbackTotal)) {
            totalEquityCad = fallbackTotal;
          }
        }

        let dayPnlCad = null;
        const pnlEntry = accountPnlTotals.get(accountId);
        if (pnlEntry && Number.isFinite(pnlEntry.dayPnl)) {
          dayPnlCad = pnlEntry.dayPnl;
        } else if (balanceSummary) {
          const fallbackDay = resolveAccountPnlInBase(balanceSummary, 'dayPnl', currencyRates, baseCurrency);
          if (Number.isFinite(fallbackDay)) {
            dayPnlCad = fallbackDay;
          }
        }

        const accountNumber =
          account.number !== undefined && account.number !== null
            ? String(account.number).trim()
            : account.accountNumber !== undefined && account.accountNumber !== null
              ? String(account.accountNumber).trim()
              : null;

        const href = buildAccountViewUrl(accountId) || null;

        items.push({
          id: accountId,
          label: getAccountLabel(account) || accountId,
          accountNumber: accountNumber && accountNumber.length ? accountNumber : null,
          totalEquityCad: Number.isFinite(totalEquityCad) ? totalEquityCad : null,
          dayPnlCad: Number.isFinite(dayPnlCad) ? dayPnlCad : null,
          href,
        });
      });
    });

    if (!items.length) {
      return [];
    }

    items.sort((a, b) => {
      const aValue = Number.isFinite(a.totalEquityCad) ? a.totalEquityCad : -Infinity;
      const bValue = Number.isFinite(b.totalEquityCad) ? b.totalEquityCad : -Infinity;
      if (aValue !== bValue) {
        return bValue - aValue;
      }
      return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    });

    return items;
  }, [
    accounts,
    accountsByGroupName,
    accountGroupChildrenMap,
    normalizedAccountBalances,
    accountPnlTotals,
    accountFunding,
    currencyRates,
    baseCurrency,
    selectedAccount,
    selectedAccountInfo,
    selectedAccountGroup,
    isAggregateSelection,
    buildAccountViewUrl,
  ]);

  const peopleSummary = useMemo(() => {
    if (!accounts.length) {
      return { totals: [], missingAccounts: [], hasBalances: false };
    }

    const balanceEntries = normalizedAccountBalances;
    const accountMap = new Map();
    accounts.forEach((account) => {
      if (account && account.id) {
        accountMap.set(account.id, account);
      }
    });

    const totalsMap = new Map();
    const allAccountBuckets = new Map();
    const coveredAccountBuckets = new Map();

    const ensureAggregate = (beneficiary) => {
      if (!totalsMap.has(beneficiary)) {
        totalsMap.set(beneficiary, { total: 0, dayPnl: 0, openPnl: 0 });
      }
      return totalsMap.get(beneficiary);
    };

    accountMap.forEach((account) => {
      const beneficiary = account.beneficiary || 'Unassigned';
      ensureAggregate(beneficiary);
      if (!allAccountBuckets.has(beneficiary)) {
        allAccountBuckets.set(beneficiary, new Set());
      }
      allAccountBuckets.get(beneficiary).add(account.id);
      if (!coveredAccountBuckets.has(beneficiary)) {
        coveredAccountBuckets.set(beneficiary, new Set());
      }
    });

    let hasBalanceEntries = false;

    Object.entries(balanceEntries).forEach(([accountId, combined]) => {
      const account = accountMap.get(accountId);
      if (!account) {
        return;
      }
      hasBalanceEntries = true;
      const beneficiary = account.beneficiary || 'Unassigned';
      const accountTotal = resolveAccountTotalInBase(combined, currencyRates, baseCurrency);
      const aggregate = ensureAggregate(beneficiary);
      aggregate.total += accountTotal;
      const accountPnl = accountPnlTotals.get(accountId);
      if (accountPnl) {
        aggregate.dayPnl += accountPnl.dayPnl;
        aggregate.openPnl += accountPnl.openPnl;
      } else {
        aggregate.dayPnl += resolveAccountPnlInBase(combined, 'dayPnl', currencyRates, baseCurrency);
        aggregate.openPnl += resolveAccountPnlInBase(combined, 'openPnl', currencyRates, baseCurrency);
      }
      const coveredSet = coveredAccountBuckets.get(beneficiary) || new Set();
      coveredSet.add(accountId);
      coveredAccountBuckets.set(beneficiary, coveredSet);
    });

    const missingAccounts = [];
    accountMap.forEach((account, accountId) => {
      const beneficiary = account.beneficiary || 'Unassigned';
      const coveredSet = coveredAccountBuckets.get(beneficiary);
      if (!coveredSet || !coveredSet.has(accountId)) {
        missingAccounts.push(account);
      }
    });

    const totals = Array.from(totalsMap.entries())
      .map(([beneficiary, aggregate]) => {
        const coveredSet = coveredAccountBuckets.get(beneficiary);
        const allSet = allAccountBuckets.get(beneficiary);
        return {
          beneficiary,
          total: aggregate.total,
          dayPnl: aggregate.dayPnl,
          openPnl: aggregate.openPnl,
          accountCount: coveredSet ? coveredSet.size : 0,
          totalAccounts: allSet ? allSet.size : coveredSet ? coveredSet.size : 0,
        };
      })
      .sort((a, b) => {
        const diff = (b.total || 0) - (a.total || 0);
        if (Math.abs(diff) > 0.01) {
          return diff;
        }
        return a.beneficiary.localeCompare(b.beneficiary);
      });

    return {
      totals,
      missingAccounts,
      hasBalances: hasBalanceEntries,
    };
  }, [
    accounts,
    normalizedAccountBalances,
    currencyRates,
    baseCurrency,
    accountPnlTotals,
  ]);

  const activeCurrency = currencyOptions.find((option) => option.value === currencyView) || null;
  const activeBalances =
    activeCurrency && balances ? balances[activeCurrency.scope]?.[activeCurrency.currency] ?? null : null;
  const activeAccountIdsForDeployment = useMemo(() => {
    if (isAggregateSelection) {
      if (!accountsInView.length) {
        return null;
      }
      const identifiers = accountsInView
        .map((accountId) => {
          if (accountId === undefined || accountId === null) {
            return '';
          }
          const normalized = String(accountId).trim();
          return normalized || '';
        })
        .filter(Boolean);
      return identifiers.length ? new Set(identifiers) : null;
    }

    const identifiers = new Set();
    if (selectedAccountInfo && selectedAccountInfo.id !== undefined && selectedAccountInfo.id !== null) {
      const normalizedId = String(selectedAccountInfo.id).trim();
      if (normalizedId) {
        identifiers.add(normalizedId);
      }
    }
    if (selectedAccount !== undefined && selectedAccount !== null && !isAggregateSelection) {
      const normalizedSelection = String(selectedAccount).trim();
      if (normalizedSelection) {
        identifiers.add(normalizedSelection);
      }
    }

    return identifiers.size ? identifiers : null;
  }, [isAggregateSelection, selectedAccount, selectedAccountInfo, accountsInView]);

  const reservePositionsByCurrency = useMemo(() => {
    if (!Array.isArray(rawPositions) || rawPositions.length === 0) {
      return new Map();
    }

    let relevantPositions = rawPositions;
    if (activeAccountIdsForDeployment && activeAccountIdsForDeployment.size > 0) {
      relevantPositions = rawPositions.filter((position) => {
        if (!position) {
          return false;
        }
        const positionAccountId =
          position.accountId !== undefined && position.accountId !== null
            ? String(position.accountId).trim()
            : '';
        if (positionAccountId && activeAccountIdsForDeployment.has(positionAccountId)) {
          return true;
        }
        const positionAccountNumber =
          position.accountNumber !== undefined && position.accountNumber !== null
            ? String(position.accountNumber).trim()
            : '';
        if (positionAccountNumber && activeAccountIdsForDeployment.has(positionAccountNumber)) {
          return true;
        }
        return false;
      });
    }

    if (!relevantPositions.length) {
      return new Map();
    }

    const totals = new Map();
    relevantPositions.forEach((position) => {
      if (!position) {
        return;
      }
      const symbolKey = normalizeSymbolKey(position.symbol);
      if (!symbolKey || !RESERVE_SYMBOLS.has(symbolKey)) {
        return;
      }

      const marketValue = coerceNumber(position.currentMarketValue);
      if (marketValue === null || !Number.isFinite(marketValue) || marketValue <= 0) {
        return;
      }

      const currencyKey = normalizeSymbolKey(position.currency);
      if (!currencyKey) {
        return;
      }

      const existing = totals.get(currencyKey) || 0;
      totals.set(currencyKey, existing + marketValue);
    });

    return totals;
  }, [rawPositions, activeAccountIdsForDeployment]);

  const activeDeploymentSummary = useMemo(() => {
    if (!activeCurrency || !activeBalances) {
      return null;
    }

    const totalEquityValue = coerceNumber(activeBalances.totalEquity);
    const marketValueValue = coerceNumber(activeBalances.marketValue);
    const total =
      totalEquityValue !== null
        ? totalEquityValue
        : marketValueValue !== null
          ? marketValueValue
          : 0;

    const cashValueRaw = coerceNumber(activeBalances.cash);
    const cashValue = cashValueRaw !== null ? cashValueRaw : 0;

    let reserveFromPositions = 0;
    if (reservePositionsByCurrency && reservePositionsByCurrency.size > 0) {
      const targetCurrency = normalizeSymbolKey(activeCurrency.currency) || baseCurrency;
      reservePositionsByCurrency.forEach((amount, sourceCurrency) => {
        if (!Number.isFinite(amount) || amount <= 0) {
          return;
        }
        const converted = convertAmountToCurrency(
          amount,
          sourceCurrency,
          targetCurrency,
          currencyRates,
          baseCurrency
        );
        if (Number.isFinite(converted)) {
          reserveFromPositions += converted;
        }
      });
    }

    const reserveValue = Math.max(0, cashValue + reserveFromPositions);
    const deployedValue = Math.max(0, total - reserveValue);
    const deployedPercent = total > 0 ? (deployedValue / total) * 100 : null;
    const reservePercent = total > 0 ? (reserveValue / total) * 100 : null;

    return {
      deployedValue,
      deployedPercent,
      reserveValue,
      reservePercent,
    };
  }, [
    activeCurrency,
    activeBalances,
    reservePositionsByCurrency,
    currencyRates,
    baseCurrency,
  ]);

  const fundingSummaryVariants = useMemo(() => {
    if (!selectedAccountFunding) {
      return null;
    }
    if (!activeCurrency || activeCurrency.scope !== 'combined' || activeCurrency.currency !== 'CAD') {
      return null;
    }

    const normalizeDate = (value) => {
      if (typeof value !== 'string') {
        return null;
      }
      const trimmed = value.trim();
      return trimmed || null;
    };

    const extractAnnualizedDetails = (rawValue) => {
      if (!rawValue || typeof rawValue !== 'object') {
        return null;
      }
      const rate = isFiniteNumber(rawValue.rate) ? rawValue.rate : null;
      const asOf =
        typeof rawValue.asOf === 'string' && rawValue.asOf.trim() ? rawValue.asOf.trim() : null;
      const startDate = normalizeDate(rawValue.startDate);
      const incomplete = rawValue.incomplete === true;
      return { rate, asOf, startDate, incomplete };
    };

    const returnBreakdown = Array.isArray(selectedAccountFunding?.returnBreakdown)
      ? selectedAccountFunding.returnBreakdown.filter((entry) => entry && typeof entry === 'object')
      : [];

    const periodEndDate = normalizeDate(selectedAccountFunding?.periodEndDate);
    const totalEquityCad = isFiniteNumber(selectedAccountFunding?.totalEquityCad)
      ? selectedAccountFunding.totalEquityCad
      : null;

    const baseSummary = {
      totalEquityCad,
      returnBreakdown,
      periodEndDate,
    };

    const effectiveNetDeposits = isFiniteNumber(selectedAccountFunding?.netDeposits?.combinedCad)
      ? selectedAccountFunding.netDeposits.combinedCad
      : null;
    const effectiveTotalPnl = isFiniteNumber(selectedAccountFunding?.totalPnlSinceDisplayStartCad)
      ? selectedAccountFunding.totalPnlSinceDisplayStartCad
      : isFiniteNumber(selectedAccountFunding?.totalPnl?.combinedCad)
        ? selectedAccountFunding.totalPnl.combinedCad
        : null;
    const effectiveTotalPnlDelta = isFiniteNumber(selectedAccountFunding?.totalPnlSinceDisplayStartCad)
      ? selectedAccountFunding.totalPnlSinceDisplayStartCad
      : null;
    const effectiveTotalEquityDelta = isFiniteNumber(selectedAccountFunding?.totalEquitySinceDisplayStartCad)
      ? selectedAccountFunding.totalEquitySinceDisplayStartCad
      : null;
    const displayStartTotals =
      selectedAccountFunding?.displayStartTotals && typeof selectedAccountFunding.displayStartTotals === 'object'
        ? selectedAccountFunding.displayStartTotals
        : null;
    const effectivePeriodStart = normalizeDate(selectedAccountFunding?.periodStartDate);

    const normalizedOriginalPeriodStart =
      normalizeDate(selectedAccountFunding?.originalPeriodStartDate) || null;

    const effectiveAnnualizedRaw = extractAnnualizedDetails(selectedAccountFunding?.annualizedReturn);
    const allTimeAnnualizedRaw = extractAnnualizedDetails(
      selectedAccountFunding?.annualizedReturnAllTime
    );

    const effectiveAnnualized = {
      rate: effectiveAnnualizedRaw?.rate ?? null,
      asOf: effectiveAnnualizedRaw?.asOf ?? null,
      incomplete:
        typeof effectiveAnnualizedRaw?.incomplete === 'boolean'
          ? effectiveAnnualizedRaw.incomplete
          : false,
      startDate: effectiveAnnualizedRaw?.startDate ?? effectivePeriodStart ?? null,
    };

    const effectiveVariant = {
      ...baseSummary,
      netDepositsCad: effectiveNetDeposits,
      totalPnlCad: effectiveTotalPnl,
      totalPnlDeltaCad: effectiveTotalPnlDelta,
      totalEquityDeltaCad: effectiveTotalEquityDelta,
      displayStartTotals,
      periodStartDate: effectivePeriodStart,
      annualizedReturnRate: effectiveAnnualized.rate,
      annualizedReturnAsOf: effectiveAnnualized.asOf,
      annualizedReturnIncomplete: effectiveAnnualized.incomplete,
      annualizedReturnStartDate: effectiveAnnualized.startDate,
    };

    const allTimeNetDeposits = isFiniteNumber(selectedAccountFunding?.netDeposits?.allTimeCad)
      ? selectedAccountFunding.netDeposits.allTimeCad
      : effectiveVariant.netDepositsCad;
    const allTimeTotalPnl = isFiniteNumber(selectedAccountFunding?.totalPnl?.allTimeCad)
      ? selectedAccountFunding.totalPnl.allTimeCad
      : effectiveVariant.totalPnlCad;
    const allTimePeriodStart =
      normalizedOriginalPeriodStart || effectiveVariant.periodStartDate;

    const allTimeAnnualized = {
      rate: allTimeAnnualizedRaw?.rate ?? effectiveAnnualized.rate ?? null,
      asOf: allTimeAnnualizedRaw?.asOf ?? effectiveAnnualized.asOf ?? null,
      incomplete:
        typeof allTimeAnnualizedRaw?.incomplete === 'boolean'
          ? allTimeAnnualizedRaw.incomplete
          : effectiveAnnualized.incomplete,
      startDate:
        allTimeAnnualizedRaw?.startDate ??
        normalizedOriginalPeriodStart ??
        effectiveAnnualized.startDate ??
        allTimePeriodStart ??
        null,
    };

    const allTimeVariant = {
      ...baseSummary,
      netDepositsCad: allTimeNetDeposits,
      totalPnlCad: allTimeTotalPnl,
      totalPnlDeltaCad: effectiveTotalPnlDelta,
      totalEquityDeltaCad: effectiveTotalEquityDelta,
      displayStartTotals,
      periodStartDate: allTimePeriodStart,
      annualizedReturnRate: allTimeAnnualized.rate,
      annualizedReturnAsOf: allTimeAnnualized.asOf,
      annualizedReturnIncomplete: allTimeAnnualized.incomplete,
      annualizedReturnStartDate: allTimeAnnualized.startDate,
    };

    const rawCagrStartDate =
      typeof selectedAccountFunding?.cagrStartDate === 'string' && selectedAccountFunding.cagrStartDate.trim()
        ? selectedAccountFunding.cagrStartDate.trim()
        : null;

    return {
      effective: effectiveVariant,
      allTime: allTimeVariant,
      metadata: {
        cagrStartDate: rawCagrStartDate,
      },
    };
  }, [selectedAccountFunding, activeCurrency]);

  const cagrStartDate = fundingSummaryVariants?.metadata?.cagrStartDate || null;

  const fundingSummaryForDisplay = useMemo(() => {
    if (!fundingSummaryVariants) {
      return null;
    }
    if (totalPnlRange === 'all') {
      return { ...fundingSummaryVariants.allTime, mode: 'all' };
    }
    return { ...fundingSummaryVariants.effective, mode: 'cagr' };
  }, [fundingSummaryVariants, totalPnlRange]);

  const totalPnlRangeOptions = useMemo(() => {
    if (!fundingSummaryVariants) {
      return [];
    }
    const options = [];
    if (cagrStartDate) {
      const formatted = formatDate(cagrStartDate);
      if (formatted && formatted !== '\u2014') {
        options.push({ value: 'cagr', label: `From ${formatted.replace(',', '')}` });
      }
    }
    options.push({ value: 'all', label: 'From start' });
    return options;
  }, [fundingSummaryVariants, cagrStartDate]);

  useEffect(() => {
    const currentAccount = selectedAccountKey || null;
    const normalizedCagrStartDate = cagrStartDate || null;
    const accountChanged = lastAccountForRange.current !== currentAccount;
    const cagrChanged = lastCagrStartDate.current !== normalizedCagrStartDate;

    if (!accountChanged && !cagrChanged) {
      return;
    }

    lastAccountForRange.current = currentAccount;
    lastCagrStartDate.current = normalizedCagrStartDate;

    if (!currentAccount) {
      setTotalPnlRange('all');
      return;
    }

    if (normalizedCagrStartDate) {
      setTotalPnlRange('cagr');
    } else {
      setTotalPnlRange('all');
    }
  }, [selectedAccountKey, cagrStartDate]);

  const handleTotalPnlRangeChange = useCallback(
    (nextValue) => {
      const normalized = nextValue === 'all' ? 'all' : 'cagr';
      if (normalized === 'cagr' && !cagrStartDate) {
        return;
      }
      setTotalPnlRange((current) => (current === normalized ? current : normalized));
    },
    [cagrStartDate]
  );

  const benchmarkPeriod = useMemo(() => {
    if (!fundingSummaryForDisplay) {
      return null;
    }

    const normalizeDate = (value) => {
      if (typeof value !== 'string') {
        return null;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
        return trimmed.slice(0, 10);
      }
      const parsed = new Date(trimmed);
      if (Number.isNaN(parsed.getTime())) {
        return null;
      }
      return parsed.toISOString().slice(0, 10);
    };

    const normalizedStart = normalizeDate(fundingSummaryForDisplay.periodStartDate);
    if (!normalizedStart) {
      return null;
    }

    const normalizedEnd =
      normalizeDate(fundingSummaryForDisplay.periodEndDate) ||
      normalizeDate(fundingSummaryForDisplay.annualizedReturnAsOf) ||
      normalizeDate(asOf);

    return {
      startDate: normalizedStart,
      endDate: normalizedEnd || null,
    };
  }, [fundingSummaryForDisplay, asOf]);

  const benchmarkPeriodStart = benchmarkPeriod?.startDate || null;
  const benchmarkPeriodEnd = benchmarkPeriod?.endDate || null;

  useEffect(() => {
    if (!benchmarkPeriodStart) {
      setBenchmarkSummary({ status: 'idle', data: null, error: null });
      return undefined;
    }

    let cancelled = false;
    const desiredEnd = benchmarkPeriodEnd || null;

    setBenchmarkSummary((previous) => {
      const previousStart = previous?.data?.startDate || null;
      const previousEnd = previous?.data?.endDate || null;
      if (previousStart === benchmarkPeriodStart && previousEnd === desiredEnd) {
        if (previous?.status === 'ready') {
          return { status: 'refreshing', data: previous.data, error: null };
        }
        if (previous?.status === 'refreshing' || previous?.status === 'loading') {
          return previous;
        }
      }
      return { status: 'loading', data: null, error: null };
    });

    getBenchmarkReturns({
      startDate: benchmarkPeriodStart,
      endDate: desiredEnd || undefined,
    })
      .then((result) => {
        if (cancelled) {
          return;
        }
        setBenchmarkSummary({ status: 'ready', data: result, error: null });
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        const normalizedError = err instanceof Error ? err : new Error('Failed to load benchmark returns');
        setBenchmarkSummary({ status: 'error', data: null, error: normalizedError });
      });

    return () => {
      cancelled = true;
    };
  }, [benchmarkPeriodStart, benchmarkPeriodEnd]);
  const displayTotalEquity = useMemo(() => {
    const canonical = resolveDisplayTotalEquity(balances);
    if (canonical !== null) {
      return canonical;
    }
    return coerceNumber(activeBalances?.totalEquity);
  }, [balances, activeBalances]);

  const fallbackPnl = useMemo(() => {
    if (!activeCurrency) {
      return ZERO_PNL;
    }
    if (activeCurrency.scope === 'combined') {
      return convertCombinedPnl(
        positionPnlSummaries.perCurrency,
        currencyRates,
        activeCurrency.currency,
        baseCurrency
      );
    }
    return positionPnlSummaries.perCurrency[activeCurrency.currency] || ZERO_PNL;
  }, [activeCurrency, positionPnlSummaries, currencyRates, baseCurrency]);

  const activePnl = useMemo(() => {
    if (!activeCurrency) {
      return ZERO_PNL;
    }
    const balanceEntry = balancePnlSummaries[activeCurrency.scope]?.[activeCurrency.currency] || null;
    const totalFromBalance = balanceEntry ? balanceEntry.totalPnl : null;
    const hasBalanceTotal = isFiniteNumber(totalFromBalance);

    if (!balanceEntry) {
      return {
        dayPnl: fallbackPnl.dayPnl,
        openPnl: fallbackPnl.openPnl,
        totalPnl: null,
      };
    }
    return {
      dayPnl: balanceEntry.dayPnl ?? fallbackPnl.dayPnl,
      openPnl: balanceEntry.openPnl ?? fallbackPnl.openPnl,
      totalPnl:
        fundingSummaryForDisplay && isFiniteNumber(fundingSummaryForDisplay.totalPnlCad)
          ? fundingSummaryForDisplay.totalPnlCad
          : hasBalanceTotal
            ? totalFromBalance
            : null,
    };
  }, [activeCurrency, balancePnlSummaries, fallbackPnl, fundingSummaryForDisplay]);

  const heatmapMarketValue = useMemo(() => {
    if (activeBalances && typeof activeBalances === 'object') {
      const balanceTotalEquity = coerceNumber(activeBalances.totalEquity);
      const balanceMarketValue = coerceNumber(activeBalances.marketValue);
      const resolvedBalanceValue =
        balanceTotalEquity !== null ? balanceTotalEquity : balanceMarketValue !== null ? balanceMarketValue : null;

      if (resolvedBalanceValue !== null) {
        const balanceCurrency =
          (activeCurrency && typeof activeCurrency.currency === 'string'
            ? activeCurrency.currency
            : baseCurrency) || baseCurrency;
        return normalizeCurrencyAmount(resolvedBalanceValue, balanceCurrency, currencyRates, baseCurrency);
      }
    }
    return totalMarketValue;
  }, [
    activeBalances,
    activeCurrency,
    currencyRates,
    baseCurrency,
    totalMarketValue,
  ]);

  const heatmapAccountOptions = useMemo(() => {
    if (!Array.isArray(rawPositions)) {
      return [];
    }

    const accountOrder = accountsInView.map((accountId) => String(accountId));
    const positionsByAccount = new Map();

    rawPositions.forEach((position) => {
      const rawAccountId = position?.accountId;
      if (rawAccountId === undefined || rawAccountId === null) {
        return;
      }
      const accountId = String(rawAccountId);
      if (!positionsByAccount.has(accountId)) {
        positionsByAccount.set(accountId, []);
      }
      positionsByAccount.get(accountId).push(position);
    });

    const entries = [];
    const shouldIncludeAggregateOption =
      isAggregateSelection || accountOrder.length > 1;

    if (shouldIncludeAggregateOption) {
      const aggregated = aggregatePositionsBySymbol(rawPositions, { currencyRates, baseCurrency });
      const preparedAggregate = preparePositionsForHeatmap(aggregated, currencyRates, baseCurrency);
      const aggregateValue = isAggregateSelection
        ? selectedAccount === 'all'
          ? 'all'
          : String(selectedAccount)
        : 'all';
      const aggregateLabel = isAggregateSelection
        ? aggregateAccountLabel || 'All accounts'
        : 'All accounts';
      entries.push({
        value: aggregateValue,
        label: aggregateLabel,
        positions: preparedAggregate.positions,
        totalMarketValue: preparedAggregate.totalMarketValue,
      });
    }

    accountOrder.forEach((accountId) => {
      const account = accountsById.get(accountId);
      if (!account) {
        return;
      }
      const accountPositions = positionsByAccount.get(accountId) || [];
      const prepared = preparePositionsForHeatmap(accountPositions, currencyRates, baseCurrency);
      const baseLabel = getAccountLabel(account) || 'Account';
      const accountNumber = typeof account.number === 'string' ? account.number.trim() : '';
      const label = accountNumber && accountNumber !== baseLabel ? `${baseLabel} (${accountNumber})` : baseLabel;
      entries.push({
        value: accountId,
        label,
        positions: prepared.positions,
        totalMarketValue: prepared.totalMarketValue,
      });
    });

    if (!entries.length) {
      const preparedAll = preparePositionsForHeatmap(rawPositions, currencyRates, baseCurrency);
      entries.push({
        value: 'all',
        label: 'All accounts',
        positions: preparedAll.positions,
        totalMarketValue: preparedAll.totalMarketValue,
      });
    }

    return entries;
  }, [
    rawPositions,
    accountsInView,
    accountsById,
    currencyRates,
    baseCurrency,
    isAggregateSelection,
    selectedAccount,
    aggregateAccountLabel,
  ]);

  const heatmapDefaultAccount = useMemo(() => {
    if (!heatmapAccountOptions.length) {
      return null;
    }

    const normalizedSelected =
      selectedAccount === undefined || selectedAccount === null ? null : String(selectedAccount);

    if (normalizedSelected === 'all') {
      const hasAll = heatmapAccountOptions.some((option) => option.value === 'all');
      if (hasAll) {
        return 'all';
      }
    } else if (normalizedSelected) {
      const match = heatmapAccountOptions.find((option) => option.value === normalizedSelected);
      if (match) {
        return normalizedSelected;
      }
    }

    const fallbackAll = heatmapAccountOptions.find((option) => option.value === 'all');
    if (fallbackAll) {
      return fallbackAll.value;
    }

    return heatmapAccountOptions[0].value;
  }, [heatmapAccountOptions, selectedAccount]);

  const peopleTotals = peopleSummary.totals;
  const peopleMissingAccounts = peopleSummary.missingAccounts;
  const investmentModelsForView = useMemo(() => {
    if (isAggregateSelection) {
      if (!accountsInView.length) {
        return [];
      }
      return accountsInView.reduce((accumulator, accountId) => {
        const account = accountsById.get(accountId);
        if (!account) {
          return accumulator;
        }
        const models = resolveAccountModelsForDisplay(account);
        if (!models.length) {
          return accumulator;
        }
        const accountLabel = getAccountLabel(account);
        const rawAccountNumber =
          account?.number !== undefined && account?.number !== null
            ? String(account.number).trim()
            : account?.accountNumber !== undefined && account?.accountNumber !== null
              ? String(account.accountNumber).trim()
              : '';
        models.forEach((model) => {
          accumulator.push({
            ...model,
            accountId,
            accountLabel,
            accountNumber: rawAccountNumber || null,
          });
        });
        return accumulator;
      }, []);
    }

    if (!selectedAccountInfo?.id) {
      return [];
    }

    const accountLabel = getAccountLabel(selectedAccountInfo);
    const rawAccountNumber =
      selectedAccountInfo?.number !== undefined && selectedAccountInfo?.number !== null
        ? String(selectedAccountInfo.number).trim()
        : selectedAccountInfo?.accountNumber !== undefined && selectedAccountInfo?.accountNumber !== null
          ? String(selectedAccountInfo.accountNumber).trim()
          : '';
    return resolveAccountModelsForDisplay(selectedAccountInfo).map((model) => ({
      ...model,
      accountId: selectedAccountInfo.id,
      accountLabel,
      accountNumber: rawAccountNumber || null,
    }));
  }, [selectedAccount, selectedAccountInfo, accountsInView, accountsById]);
  const investmentModelSections = useMemo(() => {
    if (!investmentModelsForView.length) {
      return [];
    }

    const sections = investmentModelsForView.map((model) => {
      const modelKey = typeof model.model === 'string' ? model.model.trim() : '';
      const normalizedKey = modelKey.toUpperCase();
      let evaluation = null;
      if (model.accountId) {
        const bucket = investmentModelEvaluations[model.accountId];
        if (bucket && typeof bucket === 'object') {
          if (modelKey && bucket[modelKey]) {
            evaluation = bucket[modelKey];
          }
          if (!evaluation && modelKey) {
            const fallbackKey = Object.keys(bucket).find(
              (key) => String(key || '').toUpperCase() === normalizedKey
            );
            if (fallbackKey) {
              evaluation = bucket[fallbackKey];
            }
          }
        }
      }

      const chartKey = buildInvestmentModelChartKey(model);
      const chartState = chartKey && investmentModelCharts[chartKey] ? investmentModelCharts[chartKey] : null;
      const evaluationAction =
        evaluation?.data?.decision?.action ?? evaluation?.decision?.action ?? evaluation?.action ?? null;
      const evaluationStatus = evaluation?.status ?? null;
      const accountInfo = accountsById.get(model.accountId);
      const accountLabel = model.accountLabel || getAccountLabel(accountInfo);
      const resolvedAccountNumber = (() => {
        if (typeof model.accountNumber === 'string' && model.accountNumber.trim()) {
          return model.accountNumber.trim();
        }
        const candidate =
          accountInfo?.number !== undefined && accountInfo?.number !== null
            ? String(accountInfo.number).trim()
            : accountInfo?.accountNumber !== undefined && accountInfo?.accountNumber !== null
              ? String(accountInfo.accountNumber).trim()
              : '';
        return candidate || null;
      })();
      const modelLabel = model.title
        ? model.title
        : modelKey
        ? `${modelKey} Investment Model`
        : 'Investment Model';
      const displayTitle = isAggregateSelection && accountLabel ? `${accountLabel} — ${modelLabel}` : modelLabel;

      return {
        ...model,
        accountLabel,
        chartKey,
        chart: chartState || { data: null, loading: false, error: null },
        evaluation,
        evaluationAction,
        evaluationStatus,
        displayTitle,
        accountNumber: resolvedAccountNumber,
      };
    });

    sections.sort((sectionA, sectionB) => {
      const priorityDiff = getModelSectionPriority(sectionA) - getModelSectionPriority(sectionB);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      if (isAggregateSelection) {
        const accountCompare = (sectionA.accountLabel || '').localeCompare(sectionB.accountLabel || '', undefined, {
          sensitivity: 'base',
        });
        if (accountCompare !== 0) {
          return accountCompare;
        }
      }
      return (sectionA.model || '').localeCompare(sectionB.model || '', undefined, { sensitivity: 'base' });
    });

    return sections;
  }, [
    investmentModelsForView,
    investmentModelEvaluations,
    investmentModelCharts,
    selectedAccount,
    accountsById,
    isAggregateSelection,
  ]);
  const shouldShowInvestmentModels = investmentModelSections.length > 0;
  const shouldShowQqqDetails = Boolean(selectedAccountInfo?.showQQQDetails);
  const modelsRequireAttention = useMemo(() => {
    if (!shouldShowInvestmentModels) {
      return false;
    }
    return investmentModelSections.some((section) => getModelSectionPriority(section) === 0);
  }, [shouldShowInvestmentModels, investmentModelSections]);
  const showModelsPanel = shouldShowInvestmentModels && portfolioViewTab === 'models';

  const investmentModelSymbolMap = useMemo(() => {
    if (!selectedAccountInfo?.id) {
      return null;
    }
    const targetAccountId = String(selectedAccountInfo.id);
    const map = new Map();
    investmentModelSections.forEach((section) => {
      if (!section || typeof section !== 'object') {
        return;
      }
      if (String(section.accountId ?? '') !== targetAccountId) {
        return;
      }
      const symbols = [];
      if (typeof section.symbol === 'string' && section.symbol.trim()) {
        symbols.push(section.symbol.trim());
      }
      if (typeof section.leveragedSymbol === 'string' && section.leveragedSymbol.trim()) {
        symbols.push(section.leveragedSymbol.trim());
      }
      symbols.forEach((symbol) => {
        const normalized = symbol.toUpperCase();
        if (normalized) {
          map.set(normalized, section);
        }
      });
    });
    return map.size > 0 ? map : null;
  }, [selectedAccountInfo, investmentModelSections]);

  const activeAccountModelSection = useMemo(() => {
    if (activeInvestmentModelDialog?.type !== 'account-model') {
      return null;
    }
    const targetModel = String(activeInvestmentModelDialog.model || '').trim().toUpperCase();
    if (!targetModel) {
      return null;
    }
    const targetAccountId =
      activeInvestmentModelDialog.accountId !== undefined && activeInvestmentModelDialog.accountId !== null
        ? String(activeInvestmentModelDialog.accountId)
        : null;
    return (
      investmentModelSections.find((section) => {
        if (!section || typeof section !== 'object') {
          return false;
        }
        const sectionModel = String(section.model || '').trim().toUpperCase();
        if (!sectionModel || sectionModel !== targetModel) {
          return false;
        }
        if (targetAccountId === null) {
          return true;
        }
        return String(section.accountId ?? '') === targetAccountId;
      }) || null
    );
  }, [activeInvestmentModelDialog, investmentModelSections]);

  useEffect(() => {
    if (
      portfolioViewTab !== 'positions' &&
      portfolioViewTab !== 'orders' &&
      portfolioViewTab !== 'dividends' &&
      portfolioViewTab !== 'models' &&
      portfolioViewTab !== 'news'
    ) {
      setPortfolioViewTab('positions');
      return;
    }
    if (portfolioViewTab === 'dividends' && !hasDividendSummary) {
      setPortfolioViewTab(shouldShowInvestmentModels ? 'models' : 'positions');
      return;
    }
    if (portfolioViewTab === 'models' && !shouldShowInvestmentModels) {
      setPortfolioViewTab(hasDividendSummary ? 'dividends' : 'positions');
    }
  }, [portfolioViewTab, hasDividendSummary, shouldShowInvestmentModels, setPortfolioViewTab]);

  const showingAggregateAccounts = isAggregateSelection;

  useEffect(() => {
    if (!showingAggregateAccounts && activeInvestmentModelDialog?.type === 'global') {
      setActiveInvestmentModelDialog(null);
    }
  }, [showingAggregateAccounts, activeInvestmentModelDialog]);

  useEffect(() => {
    if (activeInvestmentModelDialog?.type !== 'account-model') {
      return;
    }
    if (!selectedAccountInfo) {
      setActiveInvestmentModelDialog(null);
      return;
    }
    const dialogAccountId = activeInvestmentModelDialog.accountId;
    if (
      dialogAccountId !== undefined &&
      dialogAccountId !== null &&
      String(dialogAccountId) !== String(selectedAccountInfo.id)
    ) {
      setActiveInvestmentModelDialog(null);
    }
  }, [activeInvestmentModelDialog, selectedAccountInfo]);

  const cashBreakdownData = useMemo(() => {
    if (!cashBreakdownCurrency) {
      return null;
    }
    return buildCashBreakdownForCurrency({
      currency: cashBreakdownCurrency,
      accountIds: resolvedCashAccountIds,
      accountsById,
      accountBalances: normalizedAccountBalances,
    });
  }, [
    cashBreakdownCurrency,
    resolvedCashAccountIds,
    accountsById,
    normalizedAccountBalances,
  ]);

  useEffect(() => {
    if (!cashBreakdownCurrency) {
      return;
    }
    if (!cashBreakdownData || !showingAggregateAccounts) {
      setCashBreakdownCurrency(null);
      return;
    }
    if (
      !activeCurrency ||
      activeCurrency.scope !== 'perCurrency' ||
      activeCurrency.currency !== cashBreakdownCurrency
    ) {
      setCashBreakdownCurrency(null);
    }
  }, [
    cashBreakdownCurrency,
    cashBreakdownData,
    showingAggregateAccounts,
    activeCurrency,
  ]);

  const handleShowCashBreakdown = useCallback(
    (currency) => {
      if (!showingAggregateAccounts) {
        return;
      }
      const normalizedCurrency = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
      if (!normalizedCurrency || (normalizedCurrency !== 'CAD' && normalizedCurrency !== 'USD')) {
        return;
      }
      const breakdown = buildCashBreakdownForCurrency({
        currency: normalizedCurrency,
        accountIds: resolvedCashAccountIds,
        accountsById,
        accountBalances: normalizedAccountBalances,
      });
      if (!breakdown) {
        return;
      }
      setCashBreakdownCurrency(normalizedCurrency);
    },
    [
      showingAggregateAccounts,
      resolvedCashAccountIds,
      accountsById,
      normalizedAccountBalances,
    ]
  );

  const handleCloseCashBreakdown = useCallback(() => {
    setCashBreakdownCurrency(null);
  }, []);

  const handleSelectAccountFromBreakdown = useCallback(
    (accountId) => {
      if (!accountId) {
        return;
      }
      setCashBreakdownCurrency(null);
      handleAccountChange(accountId);
    },
    [handleAccountChange]
  );

  const cashBreakdownAvailable =
    showingAggregateAccounts &&
    activeCurrency &&
    activeCurrency.scope === 'perCurrency' &&
    (activeCurrency.currency === 'CAD' || activeCurrency.currency === 'USD');

  useEffect(() => {
    investmentModelChartsRef.current = investmentModelCharts;
  }, [investmentModelCharts]);

  const fetchInvestmentModelChart = useCallback(
    (modelConfig, options = {}) => {
      if (!modelConfig || typeof modelConfig !== 'object') {
        return;
      }
      const chartKey = buildInvestmentModelChartKey(modelConfig);
      const modelName = typeof modelConfig.model === 'string' ? modelConfig.model.trim() : '';
      if (!chartKey || !modelName) {
        return;
      }
      const existing = investmentModelChartsRef.current[chartKey];
      if (!options.force) {
        if (existing && (existing.loading || (existing.data && !existing.error))) {
          return;
        }
      } else if (existing && existing.loading) {
        return;
      }

      setInvestmentModelCharts((prev) => {
        const previous = prev[chartKey] || null;
        return {
          ...prev,
          [chartKey]: {
            data: previous?.data || null,
            loading: true,
            error: null,
          },
        };
      });

      const todayIso = new Date().toISOString().slice(0, 10);
      const request = {
        model: modelName,
        startDate: MODEL_CHART_DEFAULT_START_DATE,
        endDate: todayIso,
      };
      if (typeof modelConfig.symbol === 'string' && modelConfig.symbol.trim()) {
        request.symbol = modelConfig.symbol.trim();
      }
      if (typeof modelConfig.leveragedSymbol === 'string' && modelConfig.leveragedSymbol.trim()) {
        request.leveragedSymbol = modelConfig.leveragedSymbol.trim();
      }
      if (typeof modelConfig.reserveSymbol === 'string' && modelConfig.reserveSymbol.trim()) {
        request.reserveSymbol = modelConfig.reserveSymbol.trim();
      }

      getInvestmentModelTemperature(request)
        .then((data) => {
          setInvestmentModelCharts((prev) => ({
            ...prev,
            [chartKey]: { data, loading: false, error: null },
          }));
        })
        .catch((error) => {
          const normalizedError = error instanceof Error ? error : new Error(String(error));
          setInvestmentModelCharts((prev) => ({
            ...prev,
            [chartKey]: {
              data: prev[chartKey]?.data || null,
              loading: false,
              error: normalizedError,
            },
          }));
        });
    },
    [setInvestmentModelCharts]
  );

  useEffect(() => {
    if (!shouldShowInvestmentModels) {
      return;
    }
    investmentModelsForView.forEach((model) => {
      const chartKey = buildInvestmentModelChartKey(model);
      if (!chartKey) {
        return;
      }
      const state = investmentModelCharts[chartKey];
      if (state && (state.loading || state.data || state.error)) {
        return;
      }
      fetchInvestmentModelChart(model);
    });
  }, [
    shouldShowInvestmentModels,
    investmentModelsForView,
    investmentModelCharts,
    fetchInvestmentModelChart,
  ]);

  const fetchQqqTemperature = useCallback(() => {
    if (qqqLoading) {
      return;
    }
    setQqqLoading(true);
    setQqqError(null);
    getQqqTemperature()
      .then((result) => {
        setQqqData(result);
      })
      .catch((err) => {
        const normalized = err instanceof Error ? err : new Error('Failed to load QQQ temperature data');
        setQqqError(normalized);
      })
      .finally(() => {
        setQqqLoading(false);
      });
  }, [qqqLoading]);

  useEffect(() => {
    if (!shouldShowQqqDetails && !showingAggregateAccounts) {
      return;
    }
    if (qqqData || qqqLoading || qqqError) {
      return;
    }
    fetchQqqTemperature();
  }, [
    shouldShowQqqDetails,
    showingAggregateAccounts,
    qqqData,
    qqqLoading,
    qqqError,
    fetchQqqTemperature,
  ]);
  const fetchTotalPnlSeries = useCallback(async (accountKey, options = {}) => {
    if (!accountKey) {
      return;
    }
    let applyCagr = true;
    if (accountKey === 'all') {
      applyCagr = false;
    } else if (options && options.applyAccountCagrStartDate === false) {
      applyCagr = false;
    }
    const mode = applyCagr ? 'cagr' : 'all';
    const normalizedOptions =
      options && typeof options === 'object'
        ? { ...options, applyAccountCagrStartDate: applyCagr }
        : { applyAccountCagrStartDate: applyCagr };
    setTotalPnlSeriesState((prev) => ({
      status: 'loading',
      data: prev.accountKey === accountKey && prev.mode === mode ? prev.data : null,
      error: null,
      accountKey,
      mode,
    }));
    try {
      const payload = await getTotalPnlSeries(accountKey, normalizedOptions);
      setTotalPnlSeriesState({ status: 'success', data: payload, error: null, accountKey, mode });
    } catch (err) {
      const normalized = err instanceof Error ? err : new Error('Failed to load Total P&L series');
      setTotalPnlSeriesState({ status: 'error', data: null, error: normalized, accountKey, mode });
    }
  }, []);

  const handleShowTotalPnlDialog = useCallback(() => {
    if (!selectedAccountKey) {
      return;
    }
    setShowTotalPnlDialog(true);
    if (
      totalPnlSeriesState.accountKey !== selectedAccountKey ||
      totalPnlSeriesState.mode !== 'cagr' ||
      totalPnlSeriesState.status === 'error' ||
      totalPnlSeriesState.status === 'idle'
    ) {
      fetchTotalPnlSeries(selectedAccountKey);
    }
  }, [selectedAccountKey, fetchTotalPnlSeries, totalPnlSeriesState]);

  const handleRetryTotalPnlSeries = useCallback(() => {
    if (!selectedAccountKey) {
      return;
    }
    const applyCagr = totalPnlSeriesState.mode !== 'all';
    fetchTotalPnlSeries(selectedAccountKey, { applyAccountCagrStartDate: applyCagr });
  }, [fetchTotalPnlSeries, selectedAccountKey, totalPnlSeriesState.mode]);

  const handleCloseTotalPnlDialog = useCallback(() => {
    setShowTotalPnlDialog(false);
  }, []);

  const handleChangeTotalPnlSeriesMode = useCallback(
    (mode) => {
      if (!selectedAccountKey) {
        return;
      }
      if (selectedAccountKey === 'all' && mode !== 'all') {
        return;
      }
      const normalizedMode = mode === 'all' ? 'all' : 'cagr';
      if (
        totalPnlSeriesState.accountKey === selectedAccountKey &&
        totalPnlSeriesState.mode === normalizedMode &&
        totalPnlSeriesState.status === 'success'
      ) {
        return;
      }
      const applyCagr = normalizedMode !== 'all';
      fetchTotalPnlSeries(selectedAccountKey, { applyAccountCagrStartDate: applyCagr });
    },
    [selectedAccountKey, fetchTotalPnlSeries, totalPnlSeriesState]
  );

  const handleShowInvestmentModelDialog = useCallback(() => {
    if (!qqqData && !qqqLoading && !qqqError) {
      fetchQqqTemperature();
    }
    setActiveInvestmentModelDialog({ type: 'global' });
  }, [qqqData, qqqLoading, qqqError, fetchQqqTemperature]);

  const handleShowAccountInvestmentModel = useCallback(
    (modelSection) => {
      if (!modelSection || typeof modelSection !== 'object') {
        return;
      }
      if (typeof modelSection.model !== 'string' || !modelSection.model.trim()) {
        return;
      }
      fetchInvestmentModelChart(modelSection);
      const accountId = modelSection.accountId ?? null;
      setActiveInvestmentModelDialog({
        type: 'account-model',
        accountId,
        model: modelSection.model,
      });
    },
    [fetchInvestmentModelChart]
  );

  const handleCloseInvestmentModelDialog = useCallback(() => {
    setActiveInvestmentModelDialog(null);
  }, []);
  const handleRetryInvestmentModelChart = useCallback(
    (modelConfig) => {
      if (!modelConfig) {
        return;
      }
      fetchInvestmentModelChart(modelConfig, { force: true });
    },
    [fetchInvestmentModelChart]
  );
  const qqqSummary = useMemo(() => {
    const latestTemperature = Number(qqqData?.latest?.temperature);
    const latestDate =
      typeof qqqData?.latest?.date === 'string' && qqqData.latest.date.trim()
        ? qqqData.latest.date
        : typeof qqqData?.rangeEnd === 'string'
        ? qqqData.rangeEnd
        : null;

    if (Number.isFinite(latestTemperature)) {
      return {
        status: qqqLoading ? 'refreshing' : 'ready',
        temperature: latestTemperature,
        date: latestDate,
      };
    }

    if (qqqError) {
      return {
        status: 'error',
        message: qqqError.message || 'Unable to load QQQ temperature data',
      };
    }

    if (qqqLoading) {
      return { status: 'loading' };
    }

    if (qqqData) {
      return { status: 'error', message: 'QQQ temperature unavailable' };
    }

    return { status: 'loading' };
  }, [qqqData, qqqLoading, qqqError]);

  const peopleDisabled = !peopleSummary.hasBalances;
  const selectedAccountChatUrl = useMemo(() => {
    if (!selectedAccountInfo || typeof selectedAccountInfo.chatURL !== 'string') {
      return null;
    }
    const trimmed = selectedAccountInfo.chatURL.trim();
    return trimmed || null;
  }, [selectedAccountInfo]);

  const resolvedSortColumn =
    positionsSort && typeof positionsSort.column === 'string' && positionsSort.column.trim()
      ? positionsSort.column
      : DEFAULT_POSITIONS_SORT.column;
  const resolvedSortDirection = (() => {
    if (!positionsSort || typeof positionsSort.direction !== 'string') {
      return DEFAULT_POSITIONS_SORT.direction;
    }
    const normalized = positionsSort.direction.toLowerCase();
    if (normalized === 'asc' || normalized === 'desc') {
      return normalized;
    }
    return DEFAULT_POSITIONS_SORT.direction;
  })();

  const hasData = Boolean(data);
  const isRefreshing = loading && hasData;
  const showContent = hasData;

  const todoAccountIds = useMemo(() => {
    if (!showContent) {
      return [];
    }
    if (isAggregateSelection) {
      if (!accountsInView.length) {
        return [];
      }
      return accountsInView.map((accountId) => String(accountId));
    }
    if (selectedAccountInfo?.id) {
      return [String(selectedAccountInfo.id)];
    }
    if (selectedAccount && !isAggregateSelection && accountsById.has(selectedAccount)) {
      return [String(selectedAccount)];
    }
    return [];
  }, [
    showContent,
    isAggregateSelection,
    selectedAccount,
    selectedAccountInfo,
    accountsInView,
    accountsById,
  ]);

  const todoScopeKey = useMemo(() => {
    if (!showContent) {
      return null;
    }
    if (isAggregateSelection) {
      if (!accountsInView.length) {
        return null;
      }
      const sorted = [...accountsInView]
        .map((accountId) => String(accountId))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      const scopeKeyPrefix = selectedAccount === 'all' ? 'all' : 'group';
      return `${scopeKeyPrefix}:${sorted.join(',')}`;
    }
    const directAccountId =
      (selectedAccountInfo?.id && String(selectedAccountInfo.id)) ||
      (selectedAccount && !isAggregateSelection && accountsById.has(selectedAccount)
        ? String(selectedAccount)
        : null);
    return directAccountId ? `account:${directAccountId}` : null;
  }, [
    showContent,
    isAggregateSelection,
    selectedAccount,
    selectedAccountInfo,
    accountsInView,
    accountsById,
  ]);

  const computeTodos = useCallback(() => {
    if (!todoAccountIds.length) {
      return [];
    }
    return buildTodoItems({
      accountIds: todoAccountIds,
      accountsById,
      accountBalances,
      investmentModelSections,
    });
  }, [todoAccountIds, accountsById, accountBalances, investmentModelSections]);

  useEffect(() => {
    if (!showContent) {
      setTodoState((prev) => {
        if (!prev.items.length && !prev.checked && prev.scopeKey === null) {
          return prev;
        }
        return { items: [], checked: false, scopeKey: null };
      });
      return;
    }
    if (!todoScopeKey) {
      setTodoState((prev) => {
        if (prev.scopeKey === null && !prev.items.length && !prev.checked) {
          return prev;
        }
        return { items: [], checked: false, scopeKey: null };
      });
      return;
    }
    if (isAggregateSelection) {
      const items = computeTodos();
      setTodoState((prev) => {
        if (prev.scopeKey === todoScopeKey && prev.checked && areTodoListsEqual(prev.items, items)) {
          return prev;
        }
        return { items, checked: true, scopeKey: todoScopeKey };
      });
      return;
    }
    setTodoState((prev) => {
      if (prev.scopeKey !== todoScopeKey) {
        return { items: [], checked: false, scopeKey: todoScopeKey };
      }
      if (!prev.checked) {
        return prev;
      }
      const items = computeTodos();
      if (areTodoListsEqual(prev.items, items)) {
        return prev;
      }
      return { ...prev, items };
    });
  }, [showContent, isAggregateSelection, todoScopeKey, computeTodos]);

  const handleCheckTodos = useCallback(async () => {
    if (!todoScopeKey) {
      setTodoState((prev) => {
        if (prev.scopeKey === null && !prev.items.length && !prev.checked) {
          return prev;
        }
        return { items: [], checked: false, scopeKey: null };
      });
      return;
    }
    const items = computeTodos();
    setTodoState((prev) => {
      if (prev.scopeKey === todoScopeKey && prev.checked && areTodoListsEqual(prev.items, items)) {
        return prev;
      }
      return { items, checked: true, scopeKey: todoScopeKey };
    });
  }, [computeTodos, todoScopeKey]);

  const currentTodoItems = todoState.items || [];

  const handleTodoItemSelect = useCallback((item, event) => {
    if (!item || typeof item !== 'object') {
      return;
    }

    const normalizedType = typeof item.type === 'string' ? item.type.trim().toLowerCase() : '';
    if (!normalizedType) {
      return;
    }

    const accountId =
      item.accountId !== undefined && item.accountId !== null ? String(item.accountId) : null;

    const shouldOpenInNewTab = Boolean(
      event && (event.ctrlKey || event.metaKey || event.button === 1)
    );

    if (shouldOpenInNewTab && accountId) {
      event.preventDefault();
      if (typeof event.stopPropagation === 'function') {
        event.stopPropagation();
      }
      const extraParams = {
        todoAction: normalizedType,
        todoModel:
          normalizedType === 'rebalance' && item.model ? String(item.model) : null,
        todoChart: normalizedType === 'rebalance' && item.chartKey ? String(item.chartKey) : null,
        todoAccountNumber:
          item.accountNumber !== undefined && item.accountNumber !== null
            ? String(item.accountNumber).trim()
            : null,
      };
      const targetUrl = buildAccountViewUrl(accountId, undefined, extraParams);
      if (targetUrl && typeof window !== 'undefined' && typeof window.open === 'function') {
        window.open(targetUrl, '_blank', 'noopener,noreferrer');
      }
      return;
    }

    if (normalizedType === 'cash') {
      setPendingTodoAction({ type: 'cash', accountId });
      return;
    }

    if (normalizedType === 'rebalance') {
      const modelName = typeof item.model === 'string' ? item.model.trim() : '';
      const chartKey = typeof item.chartKey === 'string' ? item.chartKey.trim() : '';
      setPendingTodoAction({
        type: 'rebalance',
        accountId,
        model: modelName || null,
        chartKey: chartKey || null,
      });
    }
  }, [buildAccountViewUrl, setPendingTodoAction]);

  const handleMarkAccountAsRebalanced = useCallback(async () => {
    if (!markRebalanceContext) {
      return;
    }
    try {
      await markAccountRebalanced(markRebalanceContext.accountNumber, {
        model: markRebalanceContext.model,
      });
      setRefreshKey((value) => value + 1);
    } catch (error) {
      console.error('Failed to update rebalance date', error);
    }
  }, [markRebalanceContext, setRefreshKey]);

  const handleMarkModelAsRebalanced = useCallback(
    async (section) => {
      if (!section || typeof section !== 'object') {
        return;
      }
      const rawAccountNumber =
        section.accountNumber !== undefined && section.accountNumber !== null
          ? String(section.accountNumber).trim()
          : '';
      const modelName = typeof section.model === 'string' ? section.model.trim() : '';
      if (!rawAccountNumber || !modelName) {
        return;
      }
      try {
        await markAccountRebalanced(rawAccountNumber, { model: modelName });
        setRefreshKey((value) => value + 1);
      } catch (error) {
        console.error('Failed to update investment model rebalance date', error);
      }
    },
    [setRefreshKey]
  );

  const enhancePlanWithAccountContext = useCallback(
    (plan) => {
      if (!plan) {
        return null;
      }

      const accountName =
        (selectedAccountInfo?.displayName && selectedAccountInfo.displayName.trim()) ||
        (selectedAccountInfo?.name && selectedAccountInfo.name.trim()) ||
        null;
      const accountNumber = selectedAccountInfo?.number || null;
      const accountUrl = buildAccountSummaryUrl(selectedAccountInfo);
      const contextLabel =
        accountName || accountNumber || (isAggregateSelection ? aggregateAccountLabel : null);

      return {
        ...plan,
        accountName: accountName || null,
        accountNumber: accountNumber || null,
        accountLabel: contextLabel || null,
        accountUrl: accountUrl || null,
      };
    },
    [selectedAccountInfo, isAggregateSelection, aggregateAccountLabel]
  );

  const handlePlanInvestEvenly = useCallback(async () => {
    const priceOverrides = new Map();
    const dlrDetails = findPositionDetails(orderedPositions, 'DLR.TO');
    const hasDlrPrice = coercePositiveNumber(dlrDetails?.price) !== null;

    if (!hasDlrPrice) {
      const cachedOverride = quoteCacheRef.current.get('DLR.TO');
      if (cachedOverride && coercePositiveNumber(cachedOverride.price)) {
        priceOverrides.set('DLR.TO', cachedOverride);
      } else {
        try {
          const quote = await getQuote('DLR.TO');
          if (quote && coercePositiveNumber(quote.price)) {
            const override = {
              price: coercePositiveNumber(quote.price),
              currency:
                typeof quote.currency === 'string' && quote.currency.trim()
                  ? quote.currency.trim().toUpperCase()
                  : null,
              description: typeof quote.name === 'string' ? quote.name : null,
            };
            quoteCacheRef.current.set('DLR.TO', override);
            priceOverrides.set('DLR.TO', override);
          }
        } catch (error) {
          console.error('Failed to load DLR.TO quote for invest evenly plan', error);
        }
      }
    }

    const planInputs = {
      positions: orderedPositions,
      balances,
      currencyRates,
      baseCurrency,
      priceOverrides: priceOverrides.size ? new Map(priceOverrides) : null,
      cashOverrides: null,
      targetProportions: selectedAccountTargetProportions,
      useTargetProportions: false,
    };

    const plan = buildInvestEvenlyPlan(planInputs);

    if (!plan) {
      if (typeof window !== 'undefined') {
        window.alert('Unable to build an invest evenly plan. Ensure cash balances and prices are available.');
      }
      return;
    }

    console.log('Invest cash evenly plan summary:\n' + plan.summaryText);

    setInvestEvenlyPlan(enhancePlanWithAccountContext(plan));
    setInvestEvenlyPlanInputs(planInputs);
  }, [
    orderedPositions,
    balances,
    currencyRates,
    baseCurrency,
    enhancePlanWithAccountContext,
    selectedAccountTargetProportions,
  ]);

  const handleOpenDeploymentAdjustment = useCallback(async () => {
    if (!orderedPositions.length) {
      return;
    }

    const initialPercent = Number.isFinite(activeDeploymentSummary?.deployedPercent)
      ? activeDeploymentSummary.deployedPercent
      : 0;

    const priceOverrides = new Map();

    const hasReserveHoldings = orderedPositions.some((position) => {
      if (!position || typeof position.symbol !== 'string') {
        return false;
      }
      const symbolKey = normalizeSymbolKey(position.symbol);
      if (!symbolKey || !RESERVE_SYMBOLS.has(symbolKey)) {
        return false;
      }
      const quantity = coercePositiveNumber(position.openQuantity);
      const marketValue = coercePositiveNumber(position.marketValue);
      return (Number.isFinite(quantity) && quantity > 0) || (Number.isFinite(marketValue) && marketValue > 0);
    });

    if (!hasReserveHoldings) {
      const fallbackSymbol = RESERVE_FALLBACK_SYMBOL;
      const fallbackDetails = findPositionDetails(orderedPositions, fallbackSymbol);
      const fallbackPrice = coercePositiveNumber(fallbackDetails?.price);
      if (fallbackPrice !== null) {
        priceOverrides.set(fallbackSymbol, {
          price: fallbackPrice,
          currency:
            typeof fallbackDetails?.currency === 'string'
              ? fallbackDetails.currency.toUpperCase()
              : null,
          description: fallbackDetails?.description ?? null,
        });
      } else {
        const cachedOverride = quoteCacheRef.current.get(fallbackSymbol);
        if (cachedOverride && coercePositiveNumber(cachedOverride.price)) {
          priceOverrides.set(fallbackSymbol, cachedOverride);
        } else {
          try {
            const quote = await getQuote(fallbackSymbol);
            if (quote && coercePositiveNumber(quote.price)) {
              const override = {
                price: coercePositiveNumber(quote.price),
                currency:
                  typeof quote.currency === 'string' && quote.currency.trim()
                    ? quote.currency.trim().toUpperCase()
                    : null,
                description: typeof quote.name === 'string' ? quote.name : null,
              };
              quoteCacheRef.current.set(fallbackSymbol, override);
              priceOverrides.set(fallbackSymbol, override);
            }
          } catch (error) {
            console.error('Failed to load reserve fallback quote', error);
          }
        }
      }
    }

    const planInputs = {
      positions: orderedPositions,
      balances,
      currencyRates,
      baseCurrency,
      reserveSymbols: RESERVE_SYMBOLS,
      priceOverrides: priceOverrides.size ? new Map(priceOverrides) : null,
    };

    const plan = buildDeploymentAdjustmentPlan({
      ...planInputs,
      targetDeployedPercent: initialPercent,
    });

    if (!plan) {
      if (typeof window !== 'undefined') {
        window.alert(
          'Unable to build a deployment adjustment plan. Ensure balances and prices are available.'
        );
      }
      return;
    }

    setDeploymentPlan(enhancePlanWithAccountContext(plan));
    setDeploymentPlanInputs({
      ...planInputs,
      targetDeployedPercent: plan.targetDeployedPercent,
    });
  }, [
    orderedPositions,
    balances,
    currencyRates,
    baseCurrency,
    activeDeploymentSummary,
    enhancePlanWithAccountContext,
  ]);

  const handleAdjustDeploymentPlan = useCallback(
    (nextPercent) => {
      if (!deploymentPlanInputs) {
        return;
      }

      const plan = buildDeploymentAdjustmentPlan({
        ...deploymentPlanInputs,
        targetDeployedPercent: nextPercent,
      });

      if (!plan) {
        return;
      }

      setDeploymentPlan(enhancePlanWithAccountContext(plan));
      setDeploymentPlanInputs((prev) => {
        if (!prev) {
          return prev;
        }
        return { ...prev, targetDeployedPercent: plan.targetDeployedPercent };
      });
    },
    [deploymentPlanInputs, enhancePlanWithAccountContext]
  );

  const handleCloseDeploymentAdjustment = useCallback(() => {
    setDeploymentPlan(null);
    setDeploymentPlanInputs(null);
  }, []);

  const handleEditTargetProportions = useCallback(() => {
    if (!selectedAccountInfo) {
      return;
    }
    const accountKeyRaw =
      (selectedAccountInfo.number && String(selectedAccountInfo.number).trim()) ||
      (selectedAccountInfo.id && String(selectedAccountInfo.id).trim()) ||
      null;
    if (!accountKeyRaw) {
      return;
    }
    const normalizedAccountId =
      selectedAccountInfo.id && String(selectedAccountInfo.id).trim() ? String(selectedAccountInfo.id).trim() : null;
    const normalizedAccountNumber =
      selectedAccountInfo.number && String(selectedAccountInfo.number).trim()
        ? String(selectedAccountInfo.number).trim()
        : null;
    const accountLabel = getAccountLabel(selectedAccountInfo);
    const relevantPositions = orderedPositions.filter((position) => {
      if (!position) {
        return false;
      }
      const positionAccountId =
        position.accountId !== undefined && position.accountId !== null
          ? String(position.accountId).trim()
          : null;
      const positionAccountNumber =
        position.accountNumber !== undefined && position.accountNumber !== null
          ? String(position.accountNumber).trim()
          : null;
      if (normalizedAccountId && positionAccountId === normalizedAccountId) {
        return true;
      }
      if (normalizedAccountNumber && positionAccountNumber === normalizedAccountNumber) {
        return true;
      }
      return !normalizedAccountId && !normalizedAccountNumber;
    });

    const normalizedAccountKey = normalizedAccountId || normalizedAccountNumber || accountKeyRaw;

    setTargetProportionEditor({
      accountKey: accountKeyRaw,
      normalizedAccountKey: normalizedAccountKey || null,
      accountLabel: accountLabel || accountKeyRaw,
      positions: relevantPositions,
      targetProportions: selectedAccountTargetProportions || null,
    });
  }, [orderedPositions, selectedAccountInfo, selectedAccountTargetProportions]);

  const handleCloseTargetProportions = useCallback(() => {
    setTargetProportionEditor(null);
  }, []);

  const handleSaveTargetProportions = useCallback(
    async (nextProportions) => {
      if (!targetProportionEditor || !targetProportionEditor.accountKey) {
        return;
      }
      const accountKey = targetProportionEditor.accountKey;
      const normalizedAccountKey =
        (targetProportionEditor.normalizedAccountKey &&
          String(targetProportionEditor.normalizedAccountKey).trim()) ||
        null;
      const hasConfiguredTargets =
        nextProportions && typeof nextProportions === 'object' && Object.keys(nextProportions).length > 0;
      try {
        await setAccountTargetProportions(accountKey, nextProportions);
        setForcedTargetAccounts((previous) => {
          const forcedKeySource = normalizedAccountKey || accountKey;
          const forcedKeyString =
            typeof forcedKeySource === 'string'
              ? forcedKeySource
              : forcedKeySource
              ? String(forcedKeySource)
              : '';
          const forcedKey = forcedKeyString.trim();
          if (!forcedKey) {
            return previous;
          }
          const next = new Set(previous);
          if (hasConfiguredTargets) {
            if (next.has(forcedKey)) {
              return previous;
            }
            next.add(forcedKey);
            return next;
          }
          if (!next.has(forcedKey)) {
            return previous;
          }
          next.delete(forcedKey);
          return next;
        });
        setTargetProportionEditor(null);
        setRefreshKey((value) => value + 1);
      } catch (error) {
        console.error('Failed to update target proportions', error);
        if (typeof window !== 'undefined') {
          const message = error instanceof Error && error.message ? error.message : 'Failed to update target proportions';
          window.alert(message);
        }
      }
    },
    [targetProportionEditor, setForcedTargetAccounts, setRefreshKey]
  );

  useEffect(() => {
    if (!pendingTodoAction) {
      return;
    }

    const targetAccountId = pendingTodoAction.accountId ? String(pendingTodoAction.accountId) : null;
    const selectedAccountId = isAggregateSelection
      ? null
      : selectedAccountInfo?.id
      ? String(selectedAccountInfo.id)
      : selectedAccount
      ? String(selectedAccount)
      : null;

    if (targetAccountId && targetAccountId !== selectedAccountId) {
      const targetAccount = accountsById.get(targetAccountId);
      const nextSelection = targetAccount?.id ? String(targetAccount.id) : targetAccountId;
      handleAccountChange(nextSelection);
      return;
    }

    const expectedScope = targetAccountId ? `account:${targetAccountId}` : null;
    if (expectedScope && todoScopeKey && todoScopeKey !== expectedScope) {
      return;
    }

    if (loading || !data || !showContent) {
      return;
    }

    if (pendingTodoAction.type === 'cash') {
      if (
        targetAccountId &&
        !positionsAlignedWithAccount(orderedPositions, targetAccountId)
      ) {
        return;
      }

      handlePlanInvestEvenly();
      setPendingTodoAction(null);
      return;
    }

    if (pendingTodoAction.type === 'rebalance') {
      const targetModel = pendingTodoAction.model
        ? pendingTodoAction.model.toUpperCase()
        : null;
      const targetChartKey = pendingTodoAction.chartKey || null;
      const section = investmentModelSections.find((candidate) => {
        if (!candidate || typeof candidate !== 'object') {
          return false;
        }
        if (
          targetAccountId &&
          String(candidate.accountId ?? '') !== String(targetAccountId)
        ) {
          return false;
        }
        const sectionModel =
          typeof candidate.model === 'string' ? candidate.model.trim().toUpperCase() : '';
        if (targetModel && sectionModel === targetModel) {
          return true;
        }
        if (targetChartKey && candidate.chartKey === targetChartKey) {
          return true;
        }
        return false;
      });

      if (!section) {
        return;
      }

      handleShowAccountInvestmentModel(section);
      setPendingTodoAction(null);
    }
  }, [
    pendingTodoAction,
    selectedAccount,
    selectedAccountInfo,
    isAggregateSelection,
    accountsById,
    todoScopeKey,
    handleAccountChange,
    loading,
    data,
    showContent,
    handlePlanInvestEvenly,
    investmentModelSections,
    handleShowAccountInvestmentModel,
    orderedPositions,
  ]);

  const getSummaryText = useCallback(() => {
    if (!showContent) {
      return null;
    }

    return buildClipboardSummary({
      selectedAccountId: selectedAccount,
      accounts,
      balances: activeBalances,
      displayTotalEquity,
      usdToCadRate,
      pnl: activePnl,
      positions: orderedPositions,
      asOf,
      currencyOption: activeCurrency,
      planningContext: activePlanningContext,
    });
  }, [
    showContent,
    selectedAccount,
    accounts,
    activeBalances,
    displayTotalEquity,
    usdToCadRate,
    activePnl,
    orderedPositions,
    asOf,
    activeCurrency,
    activePlanningContext,
  ]);

  const handleCopySummary = useCallback(async () => {
    const text = getSummaryText();
    if (!text) {
      return;
    }

    try {
      await copyTextToClipboard(text);
    } catch (error) {
      console.error('Failed to copy account summary', error);
    }
  }, [getSummaryText]);

  const handleOrdersFilterChange = useCallback((event) => {
    setOrdersFilter(event.target.value);
  }, []);

  const handleClearOrdersFilter = useCallback(() => {
    setOrdersFilter('');
  }, []);

  const handleShowSymbolNotes = useCallback(
    (position) => {
      if (!position || typeof position.symbol !== 'string') {
        return;
      }
      const trimmedSymbol = position.symbol.trim().toUpperCase();
      if (!trimmedSymbol) {
        return;
      }

      const sourceEntries = Array.isArray(position.accountNotes) && position.accountNotes.length
        ? position.accountNotes
        : [
            {
              accountId: position.accountId || null,
              accountNumber: position.accountNumber || null,
              accountDisplayName: position.accountDisplayName || null,
              accountOwnerLabel: position.accountOwnerLabel || null,
              notes: typeof position.notes === 'string' ? position.notes : '',
              targetProportion: Number.isFinite(position.targetProportion)
                ? position.targetProportion
                : null,
            },
          ];

      const bucket = new Map();
      sourceEntries.forEach((entry) => {
        if (!entry) {
          return;
        }
        const rawAccountId = entry.accountId != null ? String(entry.accountId) : null;
        const rawAccountNumber = entry.accountNumber != null ? String(entry.accountNumber) : null;
        const key = rawAccountId || rawAccountNumber;
        if (!key) {
          return;
        }
        const existing = bucket.get(key) || {
          accountKey: key,
          accountId: rawAccountId,
          accountNumber: rawAccountNumber,
          accountLabel: null,
          ownerLabel: null,
          notes: '',
          targetProportion: Number.isFinite(entry.targetProportion) ? entry.targetProportion : null,
        };
        const accountRecord = rawAccountId && accountsById.has(rawAccountId) ? accountsById.get(rawAccountId) : null;
        const displayNameCandidate =
          (typeof entry.accountDisplayName === 'string' && entry.accountDisplayName.trim()) ||
          (accountRecord && accountRecord.displayName) ||
          (rawAccountNumber && rawAccountNumber.trim());
        if (displayNameCandidate) {
          existing.accountLabel = displayNameCandidate;
        }
        const ownerCandidate =
          entry.accountOwnerLabel ||
          (accountRecord && (accountRecord.ownerLabel || accountRecord.loginLabel)) ||
          null;
        if (ownerCandidate) {
          existing.ownerLabel = ownerCandidate;
        }
        const noteValue = typeof entry.notes === 'string' ? entry.notes : '';
        if (noteValue) {
          existing.notes = noteValue;
        }
        if (Number.isFinite(entry.targetProportion)) {
          existing.targetProportion = entry.targetProportion;
        }
        bucket.set(key, existing);
      });

      const normalizedEntries = Array.from(bucket.values())
        .map((entry) => {
          const label = entry.accountLabel || entry.accountNumber || entry.accountId || entry.accountKey;
          return {
            accountKey: entry.accountKey,
            accountId: entry.accountId,
            accountNumber: entry.accountNumber,
            accountLabel: label,
            ownerLabel: entry.ownerLabel || null,
            notes: typeof entry.notes === 'string' ? entry.notes : '',
            targetProportion: Number.isFinite(entry.targetProportion) ? entry.targetProportion : null,
          };
        })
        .filter((entry) => entry.accountKey)
        .sort((a, b) => a.accountLabel.localeCompare(b.accountLabel, undefined, { sensitivity: 'base' }));

      if (!normalizedEntries.length) {
        return;
      }

      setSymbolNotesEditor({ symbol: trimmedSymbol, entries: normalizedEntries });
    },
    [accountsById]
  );

  const handleShowSymbolOrders = useCallback(
    (position) => {
      if (!position || typeof position.symbol !== 'string') {
        return;
      }
      const trimmedSymbol = position.symbol.trim().toUpperCase();
      if (!trimmedSymbol) {
        return;
      }
      setPortfolioViewTab('orders');
      setOrdersFilter(trimmedSymbol);
    },
    [setOrdersFilter, setPortfolioViewTab]
  );

  const handleCloseSymbolNotes = useCallback(() => {
    setSymbolNotesEditor(null);
  }, []);

  const handleSaveSymbolNotes = useCallback(
    async (drafts) => {
      if (!symbolNotesEditor || !symbolNotesEditor.symbol) {
        return;
      }
      const { symbol, entries } = symbolNotesEditor;
      const changes = [];
      entries.forEach((entry) => {
        if (!entry || !entry.accountKey) {
          return;
        }
        const currentValue = drafts && Object.prototype.hasOwnProperty.call(drafts, entry.accountKey)
          ? drafts[entry.accountKey]
          : entry.notes;
        const normalizedExisting = typeof entry.notes === 'string' ? entry.notes.trim() : '';
        const normalizedNext = typeof currentValue === 'string' ? currentValue.trim() : '';
        if (normalizedExisting === normalizedNext) {
          return;
        }
        changes.push({ accountKey: entry.accountKey, note: normalizedNext });
      });

      if (!changes.length) {
        setSymbolNotesEditor(null);
        return;
      }

      try {
        for (const { accountKey, note } of changes) {
          // Save sequentially to avoid overwriting concurrent updates on the server
          // where each request rewrites the full accounts configuration file.
          await setAccountSymbolNotes(accountKey, symbol, note);
        }
        setSymbolNotesEditor(null);
        setRefreshKey((value) => value + 1);
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : 'Failed to save notes.';
        throw new Error(message);
      }
    },
    [setRefreshKey, symbolNotesEditor]
  );

  const handleSetPlanningContext = useCallback(() => {
    if (isAggregateSelection || !selectedAccountInfo) {
      return;
    }

    const initialValue = typeof activePlanningContext === 'string' ? activePlanningContext : '';
    const accountLabel = getAccountLabel(selectedAccountInfo) || 'Selected account';

    setPlanningContextEditor({
      accountKey: selectedAccount,
      accountLabel,
      initialValue,
    });
  }, [
    activePlanningContext,
    isAggregateSelection,
    selectedAccountInfo,
    setPlanningContextEditor,
  ]);

  const handleClosePlanningContext = useCallback(() => {
    setPlanningContextEditor(null);
  }, [setPlanningContextEditor]);

  const handleSavePlanningContext = useCallback(
    async (accountKey, value) => {
      if (!accountKey) {
        setPlanningContextEditor(null);
        return;
      }

      const trimmed = typeof value === 'string' ? value.trim() : '';
      const existing = typeof activePlanningContext === 'string' ? activePlanningContext.trim() : '';
      if (trimmed === existing) {
        setPlanningContextEditor(null);
        return;
      }

      try {
        await setAccountPlanningContext(accountKey, trimmed);
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : 'Failed to save planning context.';
        throw new Error(message);
      }

      setPlanningContextEditor(null);
      setRefreshKey((value) => value + 1);
    },
    [activePlanningContext, setPlanningContextEditor, setRefreshKey]
  );

  useEffect(() => {
    if (isAggregateSelection) {
      setPlanningContextEditor(null);
    }
  }, [isAggregateSelection, setPlanningContextEditor]);

  const handleEstimateFutureCagr = useCallback(async () => {
    openChatGpt();

    const summary = getSummaryText();
    if (!summary) {
      return;
    }

    const prompt =
      "Please review the general economic news for the last 1 year, 6 months, 1 month, 1 week, and 1 day, and then review the news and performance of the below companies for 1 year, 6 months, 1 week, and 1 day. Once you've digested all of the news, put that information to work coming up with your best estimate of the CAGR of this portfolio over the next 10 years.\n\nPortfolio:\n\n" +
      summary;

    try {
      await copyTextToClipboard(prompt);
    } catch (error) {
      console.error('Failed to copy CAGR estimate prompt', error);
    }
  }, [getSummaryText]);

  const skipCadToggle = investEvenlyPlan?.skipCadPurchases ?? false;
  const skipUsdToggle = investEvenlyPlan?.skipUsdPurchases ?? false;

  const handleAdjustInvestEvenlyPlan = useCallback(
    (options) => {
      if (!investEvenlyPlanInputs) {
        return;
      }

      const nextSkipCadPurchases = options?.skipCadPurchases ?? skipCadToggle;
      const nextSkipUsdPurchases = options?.skipUsdPurchases ?? skipUsdToggle;
      const hasCashOverrideOption =
        options && Object.prototype.hasOwnProperty.call(options, 'cashOverrides');
      const hasTargetOption =
        options && Object.prototype.hasOwnProperty.call(options, 'useTargetProportions');
      const {
        priceOverrides,
        cashOverrides: storedCashOverrides,
        ...restInputs
      } = investEvenlyPlanInputs;
      const nextCashOverrides = hasCashOverrideOption
        ? options.cashOverrides
        : storedCashOverrides ?? null;
      const nextUseTargetProportions = hasTargetOption
        ? Boolean(options.useTargetProportions)
        : Boolean(restInputs.useTargetProportions);
      const plan = buildInvestEvenlyPlan({
        ...restInputs,
        priceOverrides:
          priceOverrides instanceof Map ? new Map(priceOverrides) : priceOverrides || null,
        cashOverrides: nextCashOverrides,
        skipCadPurchases: nextSkipCadPurchases,
        skipUsdPurchases: nextSkipUsdPurchases,
        useTargetProportions: nextUseTargetProportions,
      });

      if (!plan) {
        return;
      }

      console.log('Invest cash evenly plan summary (adjusted):\n' + plan.summaryText);
      setInvestEvenlyPlan(enhancePlanWithAccountContext(plan));
      setInvestEvenlyPlanInputs((prev) => {
        if (!prev) {
          return prev;
        }
        const nextPriceOverrides =
          prev.priceOverrides instanceof Map ? new Map(prev.priceOverrides) : prev.priceOverrides || null;
        return {
          ...prev,
          priceOverrides: nextPriceOverrides,
          cashOverrides: nextCashOverrides ?? null,
          useTargetProportions: nextUseTargetProportions,
        };
      });
    },
    [
      investEvenlyPlanInputs,
      skipCadToggle,
      skipUsdToggle,
      enhancePlanWithAccountContext,
      setInvestEvenlyPlanInputs,
    ]
  );

  useEffect(() => {
    if (!autoRefreshEnabled) {
      return undefined;
    }

    if (typeof window === 'undefined') {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setRefreshKey((value) => value + 1);
    }, 10000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [autoRefreshEnabled]);

  useEffect(() => {
    if (!hasData && pnlBreakdownMode) {
      setPnlBreakdownMode(null);
    }
  }, [hasData, pnlBreakdownMode]);

  useEffect(() => {
    if (!showReturnBreakdown) {
      return;
    }
    if (!fundingSummaryForDisplay?.returnBreakdown?.length) {
      setShowReturnBreakdown(false);
    }
  }, [showReturnBreakdown, fundingSummaryForDisplay]);

  const handleRetryNews = useCallback(() => {
    setPortfolioNewsState((prev) => ({
      ...prev,
      status: 'idle',
      error: null,
      cacheKey: null,
    }));
    setPortfolioNewsRetryKey((value) => value + 1);
  }, []);

  const handleRetryQqqDetails = useCallback(() => {
    fetchQqqTemperature();
  }, [fetchQqqTemperature]);

  const handleRefresh = (event) => {
    if (event?.ctrlKey) {
      event.preventDefault();
      setAutoRefreshEnabled((value) => !value);
      return;
    }
    setRefreshKey((value) => value + 1);
    if (showingAggregateAccounts || shouldShowQqqDetails) {
      fetchQqqTemperature();
    }
  };

  const handleShowPnlBreakdown = (mode) => {
    if (!showContent || !orderedPositions.length) {
      return;
    }
    if (mode !== 'day' && mode !== 'open') {
      return;
    }
    setPnlBreakdownMode(mode);
  };

  const handleClosePnlBreakdown = () => {
    setPnlBreakdownMode(null);
  };

  const handleShowAnnualizedReturnDetails = useCallback(() => {
    if (!fundingSummaryForDisplay?.returnBreakdown?.length) {
      return;
    }
    setShowReturnBreakdown(true);
  }, [fundingSummaryForDisplay]);

  const handleCloseAnnualizedReturnDetails = useCallback(() => {
    setShowReturnBreakdown(false);
  }, []);

  const handleOpenPeople = () => {
    if (!peopleSummary.hasBalances) {
      return;
    }
    setShowPeople(true);
  };

  const handleClosePeople = () => {
    setShowPeople(false);
  };

  const handleCloseInvestEvenlyDialog = useCallback(() => {
    setInvestEvenlyPlan(null);
    setInvestEvenlyPlanInputs(null);
  }, []);

  let showInvestmentModelDialog = Boolean(activeInvestmentModelDialog);
  let investmentModelDialogData = null;
  let investmentModelDialogLoading = false;
  let investmentModelDialogError = null;
  let investmentModelDialogOnRetry = null;
  let investmentModelDialogModelName = null;
  let investmentModelDialogLastRebalance = null;
  let investmentModelDialogEvaluation = null;
  let investmentModelDialogTitle = 'Investment Model';
  let investmentModelDialogOnMarkRebalanced = null;

  if (activeInvestmentModelDialog?.type === 'global') {
    investmentModelDialogData = qqqData;
    investmentModelDialogLoading = qqqLoading;
    investmentModelDialogError = qqqError;
    investmentModelDialogOnRetry = fetchQqqTemperature;
    investmentModelDialogModelName = 'A1';
    investmentModelDialogLastRebalance = a1LastRebalance;
    investmentModelDialogEvaluation = a1Evaluation;
  } else if (activeInvestmentModelDialog?.type === 'account-model') {
    const chartState = activeAccountModelSection?.chart || { data: null, loading: false, error: null };
    investmentModelDialogData = chartState.data || null;
    investmentModelDialogLoading = Boolean(chartState.loading);
    investmentModelDialogError = chartState.error || null;
    investmentModelDialogOnRetry =
      activeAccountModelSection && activeAccountModelSection.chartKey
        ? () => handleRetryInvestmentModelChart(activeAccountModelSection)
        : null;
    investmentModelDialogModelName =
      activeAccountModelSection?.model || activeInvestmentModelDialog.model || null;
    investmentModelDialogLastRebalance = activeAccountModelSection?.lastRebalance || null;
    investmentModelDialogEvaluation = activeAccountModelSection?.evaluation || null;
    investmentModelDialogTitle =
      activeAccountModelSection?.displayTitle ||
      activeAccountModelSection?.title ||
      (investmentModelDialogModelName ? `${investmentModelDialogModelName} Investment Model` : 'Investment Model');
    if (activeAccountModelSection?.accountNumber && activeAccountModelSection?.model) {
      investmentModelDialogOnMarkRebalanced = () => handleMarkModelAsRebalanced(activeAccountModelSection);
    }
  } else {
    showInvestmentModelDialog = false;
  }

  const totalPnlDialogData =
    totalPnlSeriesState.accountKey === selectedAccountKey ? totalPnlSeriesState.data : null;
  const totalPnlDialogLoading =
    totalPnlSeriesState.accountKey === selectedAccountKey && totalPnlSeriesState.status === 'loading';
  const totalPnlDialogError =
    totalPnlSeriesState.accountKey === selectedAccountKey && totalPnlSeriesState.status === 'error'
      ? totalPnlSeriesState.error
      : null;

  if (loading && !data) {
    return (
      <div className="summary-page summary-page--initial-loading">
        <div className="initial-loading" role="status" aria-live="polite">
          <span className="visually-hidden">Loading latest account data…</span>
          <span className="initial-loading__spinner" aria-hidden="true" />
        </div>
      </div>
    );
  }

  const summaryMainClassName =
    !showTargetColumnForSelection && orderedPositions.length > 0
      ? 'summary-main summary-main--compact'
      : 'summary-main';

  return (
    <div className="summary-page">
      <main className={summaryMainClassName}>
        <header className="page-header">
          <AccountSelector
            accounts={accounts}
            accountGroups={accountGroups}
            groupRelations={groupRelations}
            selected={selectedAccount}
            onChange={handleAccountChange}
            disabled={loading && !data}
          />
        </header>

        {rebalanceTodos.length > 0 && (
          <section className="todo-panel" aria-label="Account reminders">
            <h2 className="todo-panel__title">TODOs</h2>
            <ul className="todo-panel__list">
              {rebalanceTodos.map((todo) => {
                const dueLabel = todo.dueDate ? formatDate(todo.dueDate) : null;
                const lastLabel = todo.lastRebalance ? formatDate(todo.lastRebalance) : null;
                const statusLabel =
                  todo.overdueDays > 0
                    ? `${todo.overdueDays} day${todo.overdueDays === 1 ? '' : 's'} overdue`
                    : 'Due today';
                const detailParts = [];
                if (dueLabel) {
                  detailParts.push(`Due ${dueLabel}`);
                }
                if (lastLabel) {
                  detailParts.push(`Last ${lastLabel}`);
                }
                if (Number.isFinite(todo.periodDays)) {
                  detailParts.push(`Every ${todo.periodDays} days`);
                }
                const detailText = detailParts.join(' • ');
                const modelLabel =
                  todo.modelTitle || (todo.modelKey && todo.modelKey !== 'ACCOUNT' ? todo.modelKey : null);
                const buttonLabel = modelLabel
                  ? `Rebalance ${todo.accountLabel} — ${modelLabel}`
                  : `Rebalance ${todo.accountLabel}`;
                return (
                  <li key={todo.id} className="todo-panel__item">
                    <button
                      type="button"
                      className="todo-panel__button"
                      onClick={(event) => handleTodoSelect(todo, event)}
                      disabled={!isAggregateSelection}
                      data-status={todo.overdueDays > 0 ? 'overdue' : 'due'}
                    >
                      <span className="todo-panel__primary">{buttonLabel}</span>
                      <span className="todo-panel__meta">
                        {statusLabel}
                        {detailText ? ` • ${detailText}` : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {isAggregateSelection ? (
              <p className="todo-panel__hint">Select an item to jump to that account.</p>
            ) : null}
          </section>
        )}

        {error && (
          <div className="status-message error">
            <strong>Unable to load data.</strong>
            <p>{error.message}</p>
          </div>
        )}

        {showContent && currentTodoItems.length > 0 && (
          <TodoSummary items={currentTodoItems} onSelectItem={handleTodoItemSelect} />
        )}

        {showContent && (
          <SummaryMetrics
            currencyOption={activeCurrency}
            currencyOptions={currencyOptions}
            onCurrencyChange={setCurrencyView}
            balances={activeBalances}
            deploymentSummary={activeDeploymentSummary}
            pnl={activePnl}
            fundingSummary={fundingSummaryForDisplay}
            asOf={asOf}
            onRefresh={handleRefresh}
            displayTotalEquity={displayTotalEquity}
            usdToCadRate={usdToCadRate}
            onShowPeople={handleOpenPeople}
            peopleDisabled={peopleDisabled}
            onShowCashBreakdown={
              cashBreakdownAvailable && activeCurrency
                ? () => handleShowCashBreakdown(activeCurrency.currency)
                : null
            }
            onShowPnlBreakdown={orderedPositions.length ? handleShowPnlBreakdown : null}
            onShowTotalPnl={handleShowTotalPnlDialog}
            onShowAnnualizedReturn={handleShowAnnualizedReturnDetails}
            isRefreshing={isRefreshing}
            isAutoRefreshing={autoRefreshEnabled}
            onCopySummary={handleCopySummary}
            onEstimateFutureCagr={handleEstimateFutureCagr}
            onMarkRebalanced={markRebalanceContext ? handleMarkAccountAsRebalanced : null}
            onPlanInvestEvenly={handlePlanInvestEvenly}
            onCheckTodos={handleCheckTodos}
            onSetPlanningContext={isAggregateSelection ? null : handleSetPlanningContext}
            onEditTargetProportions={
              !isAggregateSelection && selectedAccountInfo ? handleEditTargetProportions : null
            }
            chatUrl={selectedAccountChatUrl}
            showQqqTemperature={showingAggregateAccounts}
            qqqSummary={qqqSummary}
            onShowInvestmentModel={
              showingAggregateAccounts ? handleShowInvestmentModelDialog : null
            }
            benchmarkComparison={benchmarkSummary}
            totalPnlRangeOptions={totalPnlRangeOptions}
            selectedTotalPnlRange={totalPnlRange}
            onTotalPnlRangeChange={handleTotalPnlRangeChange}
            onAdjustDeployment={handleOpenDeploymentAdjustment}
            childAccounts={childAccountSummaries}
            onSelectAccount={handleAccountChange}
          />
        )}

        {showContent && shouldShowQqqDetails && (
          <QqqTemperatureSection
            data={qqqData}
            loading={qqqLoading}
            error={qqqError}
            onRetry={handleRetryQqqDetails}
            title="QQQ temperature"
            modelName={null}
            lastRebalance={null}
            evaluation={null}
          />
        )}

        {showContent && (
          <section className="positions-card">
            <header className="positions-card__header">
              <div className="positions-card__tabs" role="tablist" aria-label="Portfolio data views">
                <button
                  type="button"
                  id={positionsTabId}
                  role="tab"
                  aria-selected={portfolioViewTab === 'positions'}
                  aria-controls={positionsPanelId}
                  className={portfolioViewTab === 'positions' ? 'active' : ''}
                  onClick={() => setPortfolioViewTab('positions')}
                >
                  Positions
                </button>
                <button
                  type="button"
                  id={ordersTabId}
                  role="tab"
                  aria-selected={portfolioViewTab === 'orders'}
                  aria-controls={ordersPanelId}
                  className={portfolioViewTab === 'orders' ? 'active' : ''}
                  onClick={() => setPortfolioViewTab('orders')}
                >
                  Orders
                </button>
                {shouldShowInvestmentModels ? (
                  <button
                    type="button"
                    id={modelsTabId}
                    role="tab"
                    aria-selected={portfolioViewTab === 'models'}
                    aria-controls={modelsPanelId}
                    className={[
                      portfolioViewTab === 'models' ? 'active' : '',
                      modelsRequireAttention ? 'positions-card__tab--attention' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => setPortfolioViewTab('models')}
                  >
                    <span className="positions-card__tab-label">
                      Models
                      {modelsRequireAttention ? (
                        <>
                          <span className="positions-card__tab-indicator" aria-hidden="true" />
                          <span className="visually-hidden"> — action required</span>
                        </>
                      ) : null}
                    </span>
                  </button>
                ) : null}
                {hasDividendSummary ? (
                  <button
                    type="button"
                    id={dividendsTabId}
                    role="tab"
                    aria-selected={portfolioViewTab === 'dividends'}
                    aria-controls={dividendsPanelId}
                    className={portfolioViewTab === 'dividends' ? 'active' : ''}
                    onClick={() => setPortfolioViewTab('dividends')}
                  >
                    Dividends
                  </button>
                ) : null}
                <button
                  type="button"
                  id={newsTabId}
                  role="tab"
                  aria-selected={portfolioViewTab === 'news'}
                  aria-controls={newsPanelId}
                  className={portfolioViewTab === 'news' ? 'active' : ''}
                  onClick={() => setPortfolioViewTab('news')}
                >
                  News
                </button>
              </div>
            </header>

            <div
              id={positionsPanelId}
              role="tabpanel"
              aria-labelledby={positionsTabId}
              hidden={portfolioViewTab !== 'positions'}
            >
              <PositionsTable
                positions={orderedPositions}
                totalMarketValue={totalMarketValue}
                sortColumn={resolvedSortColumn}
                sortDirection={resolvedSortDirection}
                onSortChange={setPositionsSort}
                pnlMode={positionsPnlMode}
                onPnlModeChange={setPositionsPnlMode}
                embedded
                investmentModelSymbolMap={investmentModelSymbolMap}
                onShowInvestmentModel={selectedAccountInfo ? handleShowAccountInvestmentModel : null}
                onShowNotes={handleShowSymbolNotes}
                onShowOrders={handleShowSymbolOrders}
                forceShowTargetColumn={forcedTargetForSelectedAccount}
              />
            </div>

            <div
              id={ordersPanelId}
              role="tabpanel"
              aria-labelledby={ordersTabId}
              hidden={!showOrdersPanel}
            >
              <div className="orders-panel__controls">
                <div className="orders-panel__input-group">
                  <input
                    id={ordersFilterInputId}
                    type="text"
                    className="orders-panel__filter-input"
                    value={ordersFilter}
                    onChange={handleOrdersFilterChange}
                    placeholder="Search by symbol, account, action, or status"
                    inputMode="search"
                    aria-label="Filter orders"
                    autoComplete="off"
                  />
                  {hasOrdersFilter ? (
                    <button
                      type="button"
                      className="orders-panel__clear"
                      onClick={handleClearOrdersFilter}
                      aria-label="Clear order filter"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              </div>
              <OrdersTable
                orders={filteredOrdersForSelectedAccount}
                accountsById={accountsById}
                showAccountColumn={isAggregateSelection}
                emptyMessage={ordersEmptyMessage}
              />
            </div>

            {shouldShowInvestmentModels ? (
              <div
                id={modelsPanelId}
                role="tabpanel"
                aria-labelledby={modelsTabId}
                hidden={!showModelsPanel}
                className="positions-card__models-panel"
              >
                {showModelsPanel
                  ? investmentModelSections.map((section, index) => {
                    const modelKey = section.model || '';
                    const chartState = section.chart || { data: null, loading: false, error: null };
                    const mapKey = `${section.accountId || 'account'}-${section.chartKey || modelKey || index}`;
                    const retryHandler =
                      section.chartKey && typeof handleRetryInvestmentModelChart === 'function'
                      ? () => handleRetryInvestmentModelChart(section)
                      : null;
                    return (
                      <QqqTemperatureSection
                        key={mapKey}
                        data={chartState.data}
                        loading={chartState.loading}
                        error={chartState.error}
                        onRetry={retryHandler}
                        title={section.displayTitle || null}
                        modelName={modelKey || null}
                        lastRebalance={section.lastRebalance || null}
                        evaluation={section.evaluation || null}
                        onMarkRebalanced={
                          section.accountNumber && section.model
                            ? () => handleMarkModelAsRebalanced(section)
                            : null
                        }
                      />
                    );
                  })
                  : null}
              </div>
            ) : null}
            {hasDividendSummary ? (
              <div
                id={dividendsPanelId}
                role="tabpanel"
                aria-labelledby={dividendsTabId}
                hidden={!showDividendsPanel}
              >
                <div className="dividends-panel__controls">
                  <label className="dividends-panel__label" htmlFor={dividendTimeframeSelectId}>
                    Timeframe
                  </label>
                  <select
                    id={dividendTimeframeSelectId}
                    className="dividends-panel__select"
                    value={normalizedDividendTimeframe}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      if (
                        DIVIDEND_TIMEFRAME_OPTIONS.some((option) => option.value === nextValue)
                      ) {
                        setDividendTimeframe(nextValue);
                      } else {
                        setDividendTimeframe(DEFAULT_DIVIDEND_TIMEFRAME);
                      }
                    }}
                  >
                    {DIVIDEND_TIMEFRAME_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <DividendBreakdown summary={selectedAccountDividends} variant="panel" />
              </div>
            ) : null}
            <div
              id={newsPanelId}
              role="tabpanel"
              aria-labelledby={newsTabId}
              hidden={!showNewsPanel}
            >
              <PortfolioNews
                status={newsStatus}
                articles={portfolioNewsState.articles}
                error={portfolioNewsState.error}
                disclaimer={portfolioNewsState.disclaimer}
                generatedAt={portfolioNewsState.generatedAt}
                symbols={resolvedNewsSymbols}
                accountLabel={newsAccountLabel}
                onRetry={handleRetryNews}
              />
            </div>
          </section>
        )}

      </main>
      {showReturnBreakdown && fundingSummaryForDisplay?.returnBreakdown?.length > 0 && (
        <AnnualizedReturnDialog
          onClose={handleCloseAnnualizedReturnDetails}
          annualizedRate={fundingSummaryForDisplay.annualizedReturnRate}
          asOf={fundingSummaryForDisplay.annualizedReturnAsOf}
          breakdown={fundingSummaryForDisplay.returnBreakdown}
          incomplete={fundingSummaryForDisplay.annualizedReturnIncomplete}
          startDate={fundingSummaryForDisplay.annualizedReturnStartDate}
        />
      )}
      {showPeople && (
        <PeopleDialog
          totals={peopleTotals}
          onClose={handleClosePeople}
          baseCurrency={baseCurrency}
          isFilteredView={!showingAllAccounts}
          missingAccounts={peopleMissingAccounts}
          asOf={asOf}
        />
      )}
      {cashBreakdownData && (
        <CashBreakdownDialog
          currency={cashBreakdownData.currency}
          total={cashBreakdownData.total}
          entries={cashBreakdownData.entries}
          onClose={handleCloseCashBreakdown}
          onSelectAccount={handleSelectAccountFromBreakdown}
        />
      )}
      {showInvestmentModelDialog && (
        <QqqTemperatureDialog
          onClose={handleCloseInvestmentModelDialog}
          data={investmentModelDialogData}
          loading={investmentModelDialogLoading}
          error={investmentModelDialogError}
          onRetry={investmentModelDialogOnRetry}
          modelName={investmentModelDialogModelName}
          lastRebalance={investmentModelDialogLastRebalance}
          evaluation={investmentModelDialogEvaluation}
          title={investmentModelDialogTitle}
          onMarkRebalanced={investmentModelDialogOnMarkRebalanced}
        />
      )}
      {showTotalPnlDialog && (
      <TotalPnlDialog
        onClose={handleCloseTotalPnlDialog}
        data={totalPnlDialogData}
        loading={totalPnlDialogLoading}
        error={totalPnlDialogError}
        onRetry={handleRetryTotalPnlSeries}
        accountLabel={totalPnlDialogAccountLabel}
        supportsCagrToggle={selectedAccountKey !== 'all' && Boolean(cagrStartDate)}
        mode={totalPnlSeriesState.mode}
        onModeChange={handleChangeTotalPnlSeriesMode}
        cagrStartDate={cagrStartDate}
      />
      )}
      {investEvenlyPlan && (
        <InvestEvenlyDialog
          plan={investEvenlyPlan}
          onClose={handleCloseInvestEvenlyDialog}
          copyToClipboard={copyTextToClipboard}
          onAdjustPlan={handleAdjustInvestEvenlyPlan}
        />
      )}
      {deploymentPlan && (
        <DeploymentAdjustmentDialog
          plan={deploymentPlan}
          onClose={handleCloseDeploymentAdjustment}
          onAdjustTarget={handleAdjustDeploymentPlan}
          copyToClipboard={copyTextToClipboard}
        />
      )}
      {targetProportionEditor && (
        <TargetProportionsDialog
          accountLabel={targetProportionEditor.accountLabel}
          positions={targetProportionEditor.positions}
          targetProportions={targetProportionEditor.targetProportions}
          onClose={handleCloseTargetProportions}
          onSave={handleSaveTargetProportions}
        />
      )}
      {planningContextEditor && (
        <PlanningContextDialog
          accountLabel={planningContextEditor.accountLabel}
          initialValue={planningContextEditor.initialValue}
          onClose={handleClosePlanningContext}
          onSave={(value) => handleSavePlanningContext(planningContextEditor.accountKey, value)}
        />
      )}
      {symbolNotesEditor && (
        <SymbolNotesDialog
          symbol={symbolNotesEditor.symbol}
          entries={symbolNotesEditor.entries}
          onClose={handleCloseSymbolNotes}
          onSave={handleSaveSymbolNotes}
        />
      )}
      {pnlBreakdownMode && (
        <PnlHeatmapDialog
          positions={orderedPositions}
          mode={pnlBreakdownMode}
          onClose={handleClosePnlBreakdown}
          baseCurrency={baseCurrency}
          asOf={asOf}
          totalMarketValue={heatmapMarketValue}
          accountOptions={heatmapAccountOptions}
          initialAccount={heatmapDefaultAccount}
        />
      )}
    </div>
  );
}
