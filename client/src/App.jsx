import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import AccountSelector from './components/AccountSelector';
import SummaryMetrics from './components/SummaryMetrics';
import GlobalSearch from './components/GlobalSearch';
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
  getSymbolAnnualized,
  getSymbolPriceHistory,
  setAccountTargetProportions,
  getPortfolioNews,
  setAccountSymbolNotes,
  setAccountPlanningContext,
  setAccountMetadata,
  getRangeTotalPnlBreakdown,
  getLogins,
  addLogin,
  getAccountOverrides,
  setAccountOverrides,
  getAccounts,
  getEarnings,
  setOtherAssets,
} from './api/questrade';
import usePersistentState from './hooks/usePersistentState';
import PeopleDialog from './components/PeopleDialog';
import PnlHeatmapDialog from './components/PnlHeatmapDialog';
import HoldingsPieChartDialog from './components/HoldingsPieChartDialog';
import InvestEvenlyDialog from './components/InvestEvenlyDialog';
import DeploymentAdjustmentDialog from './components/DeploymentAdjustmentDialog';
import AnnualizedReturnDialog from './components/AnnualizedReturnDialog';
import QqqTemperatureSection from './components/QqqTemperatureSection';
import QqqTemperatureDialog from './components/QqqTemperatureDialog';
import TotalPnlDialog from './components/TotalPnlDialog';
import ProjectionDialog from './components/ProjectionDialog';
import CashBreakdownDialog from './components/CashBreakdownDialog';
import DividendBreakdown, { formatCurrencyTotals as formatDividendCurrencyTotals } from './components/DividendBreakdown';
import TargetProportionsDialog from './components/TargetProportionsDialog';
import PortfolioNews from './components/PortfolioNews';
import SymbolNotesDialog from './components/SymbolNotesDialog';
import PlanningContextDialog from './components/PlanningContextDialog';
import NewsPromptDialog from './components/NewsPromptDialog';
import AccountMetadataDialog from './components/AccountMetadataDialog';
import AccountActionDialog from './components/AccountActionDialog';
import QuestradeLoginDialog from './components/QuestradeLoginDialog';
import QuestradeRefreshTokenDialog from './components/QuestradeRefreshTokenDialog';
import AccountStructureDialog from './components/AccountStructureDialog';
import {
  formatMoney,
  formatNumber,
  formatDate,
  formatPercent,
  formatSignedMoney,
  formatSignedPercent,
} from './utils/formatters';
import { copyTextToClipboard } from './utils/clipboard';
import { openChatGpt } from './utils/chat';
import { buildAccountSummaryUrl, openAccountSummary } from './utils/questrade';
import { resolveSymbolAnnualizedEntry } from './utils/annualized.js';
import {
  buildAccountViewUrl,
  readAccountIdFromLocation,
  readTodoActionFromLocation,
  readTodoReminderFromLocation,
  readSymbolFromLocation,
} from './utils/navigation';
import {
  buildExplainMovementPrompt,
  resolveAccountForPosition,
  listAccountsForPosition,
} from './utils/positions';
import { buildQuoteUrl, openQuote } from './utils/quotes';
import './App.css';
import deploymentDisplay from '../../shared/deploymentDisplay.js';
import {
  getSymbolGroupByKey,
  getSymbolGroupForSymbol,
  getSymbolGroupMembers,
  getDefaultPriceSymbol,
  normalizeSymbolKey as normalizeSymbolGroupKey,
} from '../../shared/symbolGroups.js';

const inflightSummaryRequests = new Map();

const DEFAULT_POSITIONS_SORT = { column: 'portfolioShare', direction: 'desc' };
const EMPTY_OBJECT = Object.freeze({});
const MODEL_CHART_DEFAULT_START_DATE = '1980-01-01';
const MAX_NEWS_SYMBOLS = 24;
const DEMO_MODE_STORAGE_KEY = 'investmentsViewDemoMode';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const RESERVE_SYMBOLS = new Set(
  Array.isArray(deploymentDisplay?.RESERVE_SYMBOLS)
    ? deploymentDisplay.RESERVE_SYMBOLS.map((symbol) =>
        typeof symbol === 'string' ? symbol.trim().toUpperCase() : ''
      ).filter(Boolean)
    : []
);

const CRYPTO_THEME_DEFINITIONS = Object.freeze([
  { key: 'CRYPTO-BITCOIN', label: 'Bitcoin', keywords: ['bitcoin'] },
  { key: 'CRYPTO-ETHEREUM', label: 'Ethereum', keywords: ['ethereum'] },
  {
    key: 'CRYPTO-CURRENCIES',
    label: 'Crypto currencies',
    keywords: ['crypto', 'cryptocurrency', 'cryptocurrencies'],
  },
]);
const CRYPTO_PRICE_SYMBOL_BY_KEY = Object.freeze({
  [normalizeSymbolGroupKey('CRYPTO-BITCOIN')]: 'BTC-USD',
  [normalizeSymbolGroupKey('CRYPTO-ETHEREUM')]: 'ETH-USD',
});
const CRYPTO_DISPLAY_LABEL_BY_KEY = Object.freeze({
  [normalizeSymbolGroupKey('CRYPTO-BITCOIN')]: 'BITCOIN',
  [normalizeSymbolGroupKey('CRYPTO-ETHEREUM')]: 'ETHEREUM',
  [normalizeSymbolGroupKey('CRYPTO-CURRENCIES')]: 'CRYPTO',
});
const CRYPTO_AGGREGATE_KEY = normalizeSymbolGroupKey('CRYPTO-CURRENCIES');
const CRYPTO_THEME_KEY_SET = new Set(
  CRYPTO_THEME_DEFINITIONS.map((theme) => normalizeSymbolGroupKey(theme?.key)).filter(Boolean)
);

function areSymbolGroupMapsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.size !== b.size) return false;
  for (const [key, groupA] of a.entries()) {
    const groupB = b.get(key);
    if (!groupB) return false;
    if (groupA.label !== groupB.label) return false;
    if (groupA.defaultPriceSymbol !== groupB.defaultPriceSymbol) return false;
    const aSymbols = Array.isArray(groupA.symbols) ? groupA.symbols : [];
    const bSymbols = Array.isArray(groupB.symbols) ? groupB.symbols : [];
    if (aSymbols.length !== bSymbols.length) return false;
    for (let i = 0; i < aSymbols.length; i += 1) {
      if (aSymbols[i] !== bSymbols[i]) {
        return false;
      }
    }
  }
  return true;
}

function buildRebalanceOverrideKey(accountNumber, model) {
  const acct = typeof accountNumber === 'string' ? accountNumber.trim() : accountNumber != null ? String(accountNumber).trim() : '';
  const mod = typeof model === 'string' ? model.trim().toUpperCase() : '';
  return `${acct}|${mod}`;
}

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

function persistDemoModePreference(enabled) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(DEMO_MODE_STORAGE_KEY, JSON.stringify(Boolean(enabled)));
  } catch {
    // ignore persistence failures
  }
}

const PEG_SOURCE_LABELS = {
  'quote.trailingPegRatio': 'Trailing PEG ratio (quote)',
  'quote.pegRatio': 'PEG ratio (quote)',
  'quote.forwardPegRatio': 'Forward PEG ratio (quote)',
  'summaryDetail.trailingPegRatio': 'Trailing PEG ratio (summary detail)',
  'summaryDetail.pegRatio': 'PEG ratio (summary detail)',
  'defaultKeyStatistics.pegRatio': 'PEG ratio (default key statistics)',
  'financialData.pegRatio': 'PEG ratio (financial data)',
  'financialData.forwardPegRatio': 'Forward PEG ratio (financial data)',
  'derived.forwardPeOverEarningsGrowth': 'Derived from forward P/E and earnings growth',
};

const PEG_REASON_MESSAGES = {
  missing: 'Yahoo did not provide a value.',
  invalid: 'Yahoo returned an invalid PEG ratio.',
  non_positive: 'Yahoo reported a PEG ratio that was not positive.',
  missing_inputs: 'Unable to derive PEG because both forward P/E and earnings growth were missing.',
  missing_forward_pe: 'Unable to derive PEG because forward P/E was missing.',
  missing_earnings_growth: 'Unable to derive PEG because earnings growth was missing.',
  invalid_growth: 'Unable to derive PEG because earnings growth was not positive.',
};

function normalizePegDiagnostics(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const normalizeCandidate = (candidate, stageName) => {
    if (!candidate || typeof candidate !== 'object') {
      return null;
    }
    const source = typeof candidate.source === 'string' && candidate.source.trim() ? candidate.source.trim() : null;
    const stage =
      typeof candidate.stage === 'string' && candidate.stage.trim()
        ? candidate.stage.trim()
        : typeof stageName === 'string' && stageName.trim()
        ? stageName.trim()
        : null;
    const value =
      candidate.value === null || candidate.value === undefined || Number.isNaN(Number(candidate.value))
        ? null
        : Number(candidate.value);
    const normalizedCandidate = { stage, source, value };
    if (candidate.reason && typeof candidate.reason === 'string' && candidate.reason.trim()) {
      normalizedCandidate.reason = candidate.reason.trim();
    }
    if (candidate.raw !== undefined) {
      normalizedCandidate.raw = candidate.raw;
    }
    return normalizedCandidate;
  };

  const normalizeStage = (stage) => {
    if (!stage || typeof stage !== 'object') {
      return null;
    }
    const stageName = typeof stage.stage === 'string' && stage.stage.trim() ? stage.stage.trim() : null;
    const accepted = Array.isArray(stage.accepted)
      ? stage.accepted.map((candidate) => normalizeCandidate(candidate, stageName)).filter(Boolean)
      : [];
    const rejected = Array.isArray(stage.rejected)
      ? stage.rejected.map((candidate) => normalizeCandidate(candidate, stageName)).filter(Boolean)
      : [];
    const normalizedStage = {
      stage: stageName,
      accepted,
      rejected,
    };
    if (stage.error && typeof stage.error === 'string' && stage.error.trim()) {
      normalizedStage.error = stage.error.trim();
    }
    return normalizedStage;
  };

  const stages = Array.isArray(raw.stages)
    ? raw.stages.map((stage) => normalizeStage(stage)).filter(Boolean)
    : [];

  const resolveCandidateWrapper = (wrapper) => {
    if (!wrapper || typeof wrapper !== 'object') {
      return null;
    }
    const stageName = typeof wrapper.stage === 'string' && wrapper.stage.trim() ? wrapper.stage.trim() : null;
    const candidate = normalizeCandidate(wrapper.candidate, stageName);
    if (!candidate) {
      return null;
    }
    const resolvedStage = stageName || candidate.stage || null;
    return {
      stage: resolvedStage,
      candidate: {
        ...candidate,
        stage: candidate.stage || resolvedStage,
      },
    };
  };

  const resolved = resolveCandidateWrapper(raw.resolved);
  const failure = resolveCandidateWrapper(raw.failure);

  const contextSource = raw.context && typeof raw.context === 'object' ? raw.context : null;
  const normalizeContextValue = (value) =>
    value === null || value === undefined || Number.isNaN(Number(value)) ? null : Number(value);
  const context = contextSource
    ? {
        trailingPe: normalizeContextValue(contextSource.trailingPe),
        trailingPeSource:
          typeof contextSource.trailingPeSource === 'string' && contextSource.trailingPeSource.trim()
            ? contextSource.trailingPeSource.trim()
            : null,
        forwardPe: normalizeContextValue(contextSource.forwardPe),
        forwardPeSource:
          typeof contextSource.forwardPeSource === 'string' && contextSource.forwardPeSource.trim()
            ? contextSource.forwardPeSource.trim()
            : null,
        earningsGrowth: normalizeContextValue(contextSource.earningsGrowth),
        earningsGrowthPercent: normalizeContextValue(contextSource.earningsGrowthPercent),
        earningsGrowthSource:
          typeof contextSource.earningsGrowthSource === 'string' && contextSource.earningsGrowthSource.trim()
            ? contextSource.earningsGrowthSource.trim()
            : null,
      }
    : null;

  return {
    stages,
    resolved,
    failure,
    context,
  };
}

function describePegStage(stage) {
  if (!stage || typeof stage !== 'string') {
    return null;
  }
  const trimmed = stage.trim();
  if (!trimmed) {
    return null;
  }
  switch (trimmed) {
    case 'quote':
      return 'Quote snapshot';
    case 'quote-summary':
      return 'Quote summary';
    default:
      return trimmed;
  }
}

function describePegSource(source) {
  if (!source || typeof source !== 'string') {
    return null;
  }
  const trimmed = source.trim();
  if (!trimmed) {
    return null;
  }
  return PEG_SOURCE_LABELS[trimmed] || trimmed;
}

function describePegReason(reason) {
  if (!reason || typeof reason !== 'string') {
    return null;
  }
  const trimmed = reason.trim();
  if (!trimmed) {
    return null;
  }
  return PEG_REASON_MESSAGES[trimmed] || trimmed;
}

function formatPegMetricLine(label, value, options = {}, source) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return null;
  }
  const numericValue = Number(value);
  const digitsOption = options.digits || { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  let formattedValue = null;
  if (options.type === 'percent') {
    formattedValue = formatPercent(numericValue, digitsOption);
  } else {
    formattedValue = formatNumber(numericValue, digitsOption);
  }
  const trimmedSource = typeof source === 'string' && source.trim() ? source.trim() : null;
  return trimmedSource ? `${label}: ${formattedValue} (${trimmedSource})` : `${label}: ${formattedValue}`;
}

function buildPegTooltip(diagnostics, options = {}) {
  if (!diagnostics) {
    if (options.formattedPegValue) {
      return `PEG: ${options.formattedPegValue}`;
    }
    return 'PEG ratio unavailable.';
  }

  const lines = [];
  const resolvedCandidate = diagnostics.resolved && diagnostics.resolved.candidate ? diagnostics.resolved.candidate : null;
  const resolvedStageLabel = diagnostics.resolved ? describePegStage(diagnostics.resolved.stage) : null;

  if (resolvedCandidate) {
    const sourceLabel = describePegSource(resolvedCandidate.source);
    const pegValueLine =
      options.formattedPegValue ||
      (Number.isFinite(resolvedCandidate.value)
        ? formatNumber(resolvedCandidate.value, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : options.fallbackDisplay || '?');
    const headerParts = [`PEG ${pegValueLine}`];
    if (sourceLabel) {
      headerParts.push(sourceLabel);
    }
    if (resolvedStageLabel) {
      headerParts.push(`from ${resolvedStageLabel.toLowerCase()}`);
    }
    lines.push(headerParts.join(' — '));

    if (resolvedCandidate.source === 'derived.forwardPeOverEarningsGrowth') {
      const context = diagnostics.context || {};
      const componentLines = [];
      const forwardLine = formatPegMetricLine(
        'Forward P/E',
        context.forwardPe,
        { type: 'number', digits: { minimumFractionDigits: 2, maximumFractionDigits: 2 } },
        context.forwardPeSource
      );
      if (forwardLine) {
        componentLines.push(`• ${forwardLine}`);
      }
      let growthPercentValue = null;
      if (context.earningsGrowthPercent !== null && context.earningsGrowthPercent !== undefined) {
        growthPercentValue = context.earningsGrowthPercent;
      } else if (context.earningsGrowth !== null && context.earningsGrowth !== undefined) {
        growthPercentValue = context.earningsGrowth * 100;
      }
      const growthLine = formatPegMetricLine(
        'Earnings growth',
        growthPercentValue,
        { type: 'percent', digits: { minimumFractionDigits: 1, maximumFractionDigits: 1 } },
        context.earningsGrowthSource
      );
      if (growthLine) {
        componentLines.push(`• ${growthLine}`);
      }
      if (componentLines.length) {
        lines.push('Components:');
        lines.push(...componentLines);
      }
    }

    const stageErrors = Array.isArray(diagnostics.stages)
      ? diagnostics.stages
          .filter((stage) => stage && stage.error)
          .map((stage) => {
            const label = describePegStage(stage.stage);
            return `${label || stage.stage}: ${stage.error}`;
          })
          .filter(Boolean)
      : [];
    if (stageErrors.length) {
      lines.push(...stageErrors);
    }
    return lines.filter(Boolean).join('\n');
  }

  lines.push('PEG ratio unavailable.');
  const failureCandidate = diagnostics.failure && diagnostics.failure.candidate ? diagnostics.failure.candidate : null;
  const failureStageLabel = diagnostics.failure ? describePegStage(diagnostics.failure.stage) : null;
  if (failureCandidate) {
    const sourceLabel = describePegSource(failureCandidate.source);
    if (sourceLabel || failureStageLabel) {
      const failureParts = [];
      if (sourceLabel) {
        failureParts.push(sourceLabel);
      }
      if (failureStageLabel) {
        failureParts.push(`(${failureStageLabel})`);
      }
      if (failureParts.length) {
        lines.push(failureParts.join(' '));
      }
    }
    const reasonMessage = describePegReason(failureCandidate.reason);
    if (reasonMessage) {
      lines.push(reasonMessage);
    }
  }

  const context = diagnostics.context || {};
  const availableLines = [];
  const forwardLine = formatPegMetricLine(
    'Forward P/E',
    context.forwardPe,
    { type: 'number', digits: { minimumFractionDigits: 2, maximumFractionDigits: 2 } },
    context.forwardPeSource
  );
  if (forwardLine) {
    availableLines.push(`• ${forwardLine}`);
  }
  const trailingLine = formatPegMetricLine(
    'Trailing P/E',
    context.trailingPe,
    { type: 'number', digits: { minimumFractionDigits: 2, maximumFractionDigits: 2 } },
    context.trailingPeSource
  );
  if (trailingLine) {
    availableLines.push(`• ${trailingLine}`);
  }
  let growthPercentValue = null;
  if (context.earningsGrowthPercent !== null && context.earningsGrowthPercent !== undefined) {
    growthPercentValue = context.earningsGrowthPercent;
  } else if (context.earningsGrowth !== null && context.earningsGrowth !== undefined) {
    growthPercentValue = context.earningsGrowth * 100;
  }
  const growthLine = formatPegMetricLine(
    'Earnings growth',
    growthPercentValue,
    { type: 'percent', digits: { minimumFractionDigits: 1, maximumFractionDigits: 1 } },
    context.earningsGrowthSource
  );
  if (growthLine) {
    availableLines.push(`• ${growthLine}`);
  }
  if (availableLines.length) {
    lines.push('Available metrics:');
    lines.push(...availableLines);
  }

  const missingMetrics = [];
  const failureReason = failureCandidate && failureCandidate.reason ? failureCandidate.reason : null;
  if (failureReason === 'missing_forward_pe' || failureReason === 'missing_inputs') {
    missingMetrics.push('Forward P/E');
  }
  if (failureReason === 'missing_earnings_growth' || failureReason === 'missing_inputs') {
    missingMetrics.push('Earnings growth');
  }
  if (failureReason === 'invalid_growth') {
    missingMetrics.push('Positive earnings growth');
  }
  if (missingMetrics.length) {
    lines.push('Missing metrics:');
    lines.push(...missingMetrics.map((label) => `• ${label}`));
  }

  const stageErrors = Array.isArray(diagnostics.stages)
    ? diagnostics.stages
        .filter((stage) => stage && stage.error)
        .map((stage) => {
          const label = describePegStage(stage.stage);
          return `${label || stage.stage}: ${stage.error}`;
        })
        .filter(Boolean)
    : [];
  if (stageErrors.length) {
    lines.push(...stageErrors);
  }

  return lines.filter(Boolean).join('\n') || null;
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

const HIDDEN_ACCOUNT_PATTERN = /(?:not\s*used|unused)/i;

function containsHiddenKeyword(value) {
  if (value == null) {
    return false;
  }
  const stringValue = typeof value === 'string' ? value : String(value);
  return HIDDEN_ACCOUNT_PATTERN.test(stringValue);
}

function shouldHideAccountSummaryEntry(account) {
  if (!account || typeof account !== 'object') {
    return false;
  }
  const fieldsToCheck = [
    account.displayName,
    account.ownerLabel,
    account.clientAccountType,
    account.type,
    account.number,
    account.name,
  ];
  return fieldsToCheck.some(containsHiddenKeyword);
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

function resolveAccountMetadataKey(account) {
  if (!account || typeof account !== 'object') {
    return null;
  }
  const number =
    account.number !== undefined && account.number !== null ? String(account.number).trim() : '';
  if (number) {
    return number;
  }
  const id = account.id !== undefined && account.id !== null ? String(account.id).trim() : '';
  if (id) {
    return id;
  }
  return null;
}

function resolveGroupMetadataKey(group) {
  if (!group || typeof group !== 'object') {
    return null;
  }
  const name = typeof group.name === 'string' ? group.name.trim() : '';
  if (name) {
    return name;
  }
  const id = typeof group.id === 'string' ? group.id.trim() : '';
  return id || null;
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

function buildPositionsAllocationTable(positions, options = {}) {
  if (!Array.isArray(positions) || positions.length === 0) {
    return 'No positions';
  }

  const sectionDivider = '-'.repeat(80);
  const emptyCell = '\u2014';
  const {
    symbolTotalPnlByAccountMap = null,
    symbolAnnualizedByAccountMap = null,
    symbolAnnualizedMap = null,
    accountKey = null,
    includeNotes = true,
    includeTarget = null,
  } = options;

  const hasTargetData =
    includeTarget === true
      ? true
      : includeTarget === false
        ? false
        : positions.some((row) => Number.isFinite(row?.targetProportion));

  const columns = [
    {
      key: 'symbol',
      label: 'Symbol',
      getValue: (row) => (row.symbol ? String(row.symbol).trim() : emptyCell),
    },
    {
      key: 'portfolioShare',
      label: '% of portfolio',
      align: 'right',
      getValue: (row) => formatPortfolioShare(row.portfolioShare),
    },
    ...(hasTargetData
      ? [
        {
          key: 'targetProportion',
          label: 'Target %',
          align: 'right',
          getValue: (row) => {
            if (!Number.isFinite(row.targetProportion)) {
              return emptyCell;
            }
            return `${formatNumber(row.targetProportion, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}%`;
          },
        },
      ]
      : []),
    {
      key: 'shares',
      label: 'Shares',
      getValue: (row) => {
        const formattedQuantity = formatQuantity(row.openQuantity);
        if (formattedQuantity === emptyCell) {
          return emptyCell;
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
        if (formattedValue === emptyCell) {
          return emptyCell;
        }
        const currency = row.currency ? String(row.currency).trim().toUpperCase() : '';
        return currency ? `${formattedValue} ${currency}` : formattedValue;
      },
    },
    {
      key: 'totalPnl',
      label: 'Total P&L',
      align: 'right',
      getValue: (row) => {
        const symbolKey = normalizeSymbolGroupKey(row?.symbol || '');
        const resolvedAccountKey = row?.accountId ?? row?.accountNumber ?? accountKey;
        const mappedTotal = resolveSymbolTotalPnlValue(symbolKey, resolvedAccountKey, symbolTotalPnlByAccountMap);
        const baseTotal = Number.isFinite(mappedTotal)
          ? mappedTotal
          : Number.isFinite(row?.totalPnl)
            ? row.totalPnl
            : null;
        const dayPnl = Number.isFinite(row?.normalizedDayPnl)
          ? row.normalizedDayPnl
          : Number.isFinite(row?.dayPnl)
            ? row.dayPnl
            : 0;
        const totalValue =
          Number.isFinite(baseTotal) && Number.isFinite(dayPnl) ? baseTotal + dayPnl : baseTotal;
        if (!Number.isFinite(totalValue)) {
          return emptyCell;
        }
        const formatted = formatSignedMoney(totalValue);
        return formatted === emptyCell ? emptyCell : `${formatted} CAD`;
      },
    },
    {
      key: 'annualizedReturn',
      label: 'Annualized return',
      align: 'right',
      getValue: (row) => {
        const symbolKey = normalizeSymbolGroupKey(row?.symbol || '');
        const resolvedAccountKey = row?.accountId ?? row?.accountNumber ?? accountKey;
        const annualizedEntry = resolveSymbolAnnualizedEntry(
          symbolKey,
          resolvedAccountKey,
          symbolAnnualizedByAccountMap,
          symbolAnnualizedMap
        );
        const rate = annualizedEntry && Number.isFinite(annualizedEntry.rate) ? annualizedEntry.rate : null;
        if (!Number.isFinite(rate)) {
          return emptyCell;
        }
        return formatPercent(rate * 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      },
    },
  ];

  const rows = positions
    .slice()
    .sort((a, b) => {
      const aValue = Number(a?.currentMarketValue ?? 0) || 0;
      const bValue = Number(b?.currentMarketValue ?? 0) || 0;
      if (aValue !== bValue) {
        return bValue - aValue;
      }
      const aSymbol = a?.symbol ? String(a.symbol) : '';
      const bSymbol = b?.symbol ? String(b.symbol) : '';
      return aSymbol.localeCompare(bSymbol, undefined, { sensitivity: 'base' });
    })
    .map((position) => {
      return columns.map((column) => {
        try {
          return column.getValue(position) ?? emptyCell;
        } catch (error) {
          console.error('Failed to format column', column.key, error);
          return emptyCell;
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
        const column = columns[index];
        const alignRight = column && column.align === 'right';
        return alignRight ? value.padStart(widths[index], ' ') : value.padEnd(widths[index], ' ');
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

  if (includeNotes && noteEntries.length) {
    lines.push('');
    lines.push('Notes:');
    lines.push('');
    noteEntries.forEach((entry) => {
      lines.push(entry);
    });
  }

  return lines.join('\n');
}

function buildAccountHierarchySummary({
  selectedAccountId,
  accounts,
  accountGroups,
  groupRelations,
  accountFunding,
  positions,
  symbolTotalPnlByAccountMap,
  symbolAnnualizedByAccountMap,
  symbolAnnualizedMap,
}) {
  if (!selectedAccountId || !Array.isArray(accounts) || accounts.length === 0) {
    return null;
  }

  const sectionDivider = '-'.repeat(80);

  const resolvedAccounts = accounts.filter(Boolean);
  const resolvedGroups = Array.isArray(accountGroups) ? accountGroups.filter(Boolean) : [];
  const resolvedRelations = groupRelations && typeof groupRelations === 'object' ? groupRelations : {};

  const normalizeLabel = (value) => {
    if (!value) {
      return '';
    }
    return String(value)
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const toFriendlyLabel = (value) => {
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
  };

  const buildPrimaryLabel = (account) => {
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
  };

  const groupsById = new Map();
  const groupNamesByKey = new Map();
  const groupIdsByKey = new Map();
  const groupNodesByKey = new Map();
  const groupNodesList = [];
  const accountNodes = [];

  const baseGroupCount = resolvedGroups.length;
  let syntheticGroupIndex = 0;

  resolvedGroups.forEach((group, index) => {
    const rawName = typeof group.name === 'string' ? group.name.trim() : '';
    const key = normalizeAccountGroupKey(rawName);
    if (key) {
      if (!groupNamesByKey.has(key)) {
        groupNamesByKey.set(key, rawName);
      }
      if (group.id !== undefined && group.id !== null) {
        groupIdsByKey.set(key, String(group.id).trim());
      }
    }
    if (group && group.id !== undefined && group.id !== null) {
      groupsById.set(String(group.id).trim(), group);
    }
    if (group) {
      const groupName = typeof group.name === 'string' ? group.name.trim() : '';
      if (groupName && key) {
        const node = {
          type: 'group',
          option: { primary: groupName },
          orderIndex: index,
          normalizedKey: key,
          children: [],
          parent: null,
        };
        groupNodesByKey.set(key, node);
        groupNodesList.push(node);
      }
    }
  });

  resolvedAccounts.forEach((account, index) => {
    const rawGroup = typeof account.accountGroup === 'string' ? account.accountGroup.trim() : '';
    const key = normalizeAccountGroupKey(rawGroup);
    if (key && !groupNamesByKey.has(key)) {
      groupNamesByKey.set(key, rawGroup);
    }
    if (shouldHideAccountSummaryEntry(account)) {
      return;
    }
    accountNodes.push({
      type: 'account',
      option: { primary: buildPrimaryLabel(account) },
      orderIndex: index,
      account,
      children: [],
    });
  });

  Object.entries(resolvedRelations).forEach(([childName, parents]) => {
    const childKey = normalizeAccountGroupKey(childName);
    if (childKey && !groupNamesByKey.has(childKey)) {
      groupNamesByKey.set(childKey, childName);
    }
    const parentList = Array.isArray(parents) ? parents : [parents];
    parentList.forEach((parentName) => {
      const parentKey = normalizeAccountGroupKey(parentName);
      if (parentKey && !groupNamesByKey.has(parentKey)) {
        groupNamesByKey.set(parentKey, parentName);
      }
    });
  });

  const groupParentsMap = new Map();
  const groupChildrenMap = new Map();

  Object.entries(resolvedRelations).forEach(([childName, parents]) => {
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
      if (!groupParentsMap.has(childKey)) {
        groupParentsMap.set(childKey, new Set());
      }
      groupParentsMap.get(childKey).add(parentKey);

      if (!groupChildrenMap.has(parentKey)) {
        groupChildrenMap.set(parentKey, new Set());
      }
      groupChildrenMap.get(parentKey).add(childKey);
    });
  });

  const accountsByGroupKey = new Map();
  resolvedAccounts.forEach((account) => {
    if (shouldHideAccountSummaryEntry(account)) {
      return;
    }
    const key = normalizeAccountGroupKey(account.accountGroup);
    if (!key) {
      return;
    }
    if (!accountsByGroupKey.has(key)) {
      accountsByGroupKey.set(key, []);
    }
    accountsByGroupKey.get(key).push(account);
  });

  const allGroupKeys = new Set();
  groupNamesByKey.forEach((_, key) => allGroupKeys.add(key));
  accountsByGroupKey.forEach((_, key) => allGroupKeys.add(key));
  groupChildrenMap.forEach((_, key) => allGroupKeys.add(key));
  groupParentsMap.forEach((_, key) => allGroupKeys.add(key));

  const resolveGroupLabel = (key) => groupNamesByKey.get(key) || key;

  const resolveAccountKey = (account) => {
    if (!account || typeof account !== 'object') {
      return null;
    }
    if (account.id !== undefined && account.id !== null) {
      const id = String(account.id).trim();
      if (id) {
        return id;
      }
    }
    const number = account.number !== undefined && account.number !== null ? String(account.number).trim() : '';
    return number || null;
  };

  const resolveFundingEntry = (key) => {
    if (!key || !accountFunding || typeof accountFunding !== 'object') {
      return null;
    }
    const entry = accountFunding[key];
    return entry && typeof entry === 'object' ? entry : null;
  };

  const resolveStartDate = (entry, mode, account) => {
    const candidates =
      mode === 'all'
        ? [
          entry?.annualizedReturnAllTime?.startDate,
          entry?.annualizedReturn?.startDate,
          entry?.annualizedReturnStartDate,
          entry?.cagrStartDate,
          entry?.periodStartDate,
          account?.cagrStartDate,
        ]
        : [
          entry?.annualizedReturn?.startDate,
          entry?.annualizedReturnStartDate,
          entry?.cagrStartDate,
          entry?.periodStartDate,
          account?.cagrStartDate,
          entry?.annualizedReturnAllTime?.startDate,
        ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
    return null;
  };

  const resolveAnnualizedRate = (entry, mode) => {
    const candidates =
      mode === 'all'
        ? [
          entry?.annualizedReturnAllTime?.rate,
          entry?.annualizedReturn?.rate,
          entry?.annualizedReturnRate,
        ]
        : [
          entry?.annualizedReturn?.rate,
          entry?.annualizedReturnRate,
          entry?.annualizedReturnAllTime?.rate,
        ];
    for (const candidate of candidates) {
      if (Number.isFinite(candidate)) {
        return candidate;
      }
    }
    return null;
  };

  const resolveTotalPnl = (entry, mode) => {
    const candidates =
      mode === 'all'
        ? [
          entry?.totalPnl?.allTimeCad,
          entry?.totalPnlCad,
          entry?.totalPnl?.combinedCad,
          entry?.totalPnlSinceDisplayStartCad,
        ]
        : [
          entry?.totalPnlSinceDisplayStartCad,
          entry?.totalPnl?.combinedCad,
          entry?.totalPnlCad,
          entry?.totalPnl?.allTimeCad,
        ];
    for (const candidate of candidates) {
      if (Number.isFinite(candidate)) {
        return candidate;
      }
    }
    return null;
  };

  const resolveTotalEquity = (primaryEntry, fallbackEntry) => {
    if (Number.isFinite(primaryEntry?.totalEquityCad)) {
      return primaryEntry.totalEquityCad;
    }
    if (Number.isFinite(fallbackEntry?.totalEquityCad)) {
      return fallbackEntry.totalEquityCad;
    }
    return null;
  };

  const formatAmount = (value) => (Number.isFinite(value) ? `${formatMoney(value)} CAD` : '—');
  const formatRate = (value) =>
    Number.isFinite(value)
      ? formatPercent(value * 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '—';
  const formatDateValue = (value) => {
    if (typeof value === 'string' && value.trim()) {
      return value.trim().slice(0, 10);
    }
    return '—';
  };

  const collectGroupAccountIds = (groupKey) => {
    const accountIds = new Set();
    if (!groupKey) {
      return accountIds;
    }
    const queue = [groupKey];
    const visited = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (!current || visited.has(current)) {
        continue;
      }
      visited.add(current);
      const members = accountsByGroupKey.get(current) || [];
      members.forEach((account) => {
        const accountId = resolveAccountKey(account);
        if (accountId) {
          accountIds.add(accountId);
        }
      });
      const children = groupChildrenMap.get(current);
      if (children && children.size) {
        children.forEach((childKey) => {
          if (childKey && !visited.has(childKey)) {
            queue.push(childKey);
          }
        });
      }
    }
    return accountIds;
  };

  const positionsByAccountKey = new Map();
  const positionsSource = Array.isArray(positions) ? positions.filter(Boolean) : [];
  const addPositionToAccount = (key, position) => {
    if (!key) {
      return;
    }
    if (!positionsByAccountKey.has(key)) {
      positionsByAccountKey.set(key, []);
    }
    positionsByAccountKey.get(key).push(position);
  };

  positionsSource.forEach((position) => {
    const accountId =
      position?.accountId !== undefined && position?.accountId !== null ? String(position.accountId).trim() : '';
    const accountNumber =
      position?.accountNumber !== undefined && position?.accountNumber !== null
        ? String(position.accountNumber).trim()
        : '';
    if (accountId) {
      addPositionToAccount(accountId, position);
    }
    if (accountNumber && accountNumber !== accountId) {
      addPositionToAccount(accountNumber, position);
    }
  });

  const collectPositionsForAccount = (account) => {
    if (!account) {
      return [];
    }
    const keys = new Set();
    const accountId = account?.id !== undefined && account?.id !== null ? String(account.id).trim() : '';
    const accountNumber =
      account?.number !== undefined && account?.number !== null ? String(account.number).trim() : '';
    if (accountId) {
      keys.add(accountId);
    }
    if (accountNumber) {
      keys.add(accountNumber);
    }
    const results = [];
    const seen = new Set();
    keys.forEach((key) => {
      const entries = positionsByAccountKey.get(key) || [];
      entries.forEach((entry) => {
        if (!seen.has(entry)) {
          seen.add(entry);
          results.push(entry);
        }
      });
    });
    return results;
  };

  const appendixAccounts = new Map();
  const appendixOrder = [];

  const addAppendixAccount = (account, label) => {
    if (!account) {
      return;
    }
    const key = resolveAccountKey(account);
    if (!key || appendixAccounts.has(key)) {
      return;
    }
    if (!isAccountGroupSelection(selectedAccountId)) {
      if (selectedAccountId && (key === selectedAccountId || account?.number === selectedAccountId)) {
        return;
      }
    }
    const context = typeof account.planningContext === 'string' ? account.planningContext.trim() : '';
    appendixAccounts.set(key, { label, context, account });
    appendixOrder.push(key);
  };

  const buildAccountLine = (account, depth) => {
    const indent = '  '.repeat(depth);
    const isRootAccountLine =
      depth === 0 && !isAccountGroupSelection(selectedAccountId) && selectedAccountId !== 'all';
    const prefix = isRootAccountLine ? '' : `${indent}- `;
    const accountId = resolveAccountKey(account);
    const labelBase = getAccountLabel(account) || accountId || 'Account';
    const number = account?.number ? String(account.number).trim() : '';
    const label =
      number && labelBase && !labelBase.includes(number) ? `${labelBase} (${number})` : labelBase;

    const fundingEntry = resolveFundingEntry(accountId);
    const totalEquity = resolveTotalEquity(fundingEntry, null);
    const totalPnl = resolveTotalPnl(fundingEntry, 'cagr');
    const startDate = resolveStartDate(fundingEntry, 'cagr', account);
    const annualizedRate = resolveAnnualizedRate(fundingEntry, 'cagr');

    const metrics = [
      `Value: ${formatAmount(totalEquity)}`,
      `Total P&L: ${formatAmount(totalPnl)}`,
      `Start: ${formatDateValue(startDate)}`,
      `Annualized return (XIRR): ${formatRate(annualizedRate)}`,
    ].join(' | ');

    const detailParts = [label, metrics].filter(Boolean);
    addAppendixAccount(account, label);
    return `${prefix}${detailParts.join(' | ')}`;
  };

  const buildGroupLine = (groupKey, metrics, depth) => {
    const indent = '  '.repeat(depth);
    const label = `${resolveGroupLabel(groupKey)} (Group)`;
    const metricsText = [
      `Value: ${formatAmount(metrics.totalEquity)}`,
      `Total P&L: ${formatAmount(metrics.totalPnl)}`,
      `Start: ${formatDateValue(metrics.startDate)}`,
      `Annualized return (XIRR): ${formatRate(metrics.annualizedRate)}`,
    ].join(' | ');
    return `${indent}- ${[label, metricsText].filter(Boolean).join(' | ')}`;
  };

  const buildGroupMetrics = (groupKey) => {
    const groupId = groupIdsByKey.get(groupKey) || null;
    const directEntry = groupId ? resolveFundingEntry(groupId) : null;
    const accountIds = Array.from(collectGroupAccountIds(groupKey));
    const aggregateEntry =
      accountIds.length > 0 ? aggregateFundingSummariesForAccounts(accountFunding, accountIds) : null;

    const resolvedEntry = directEntry || aggregateEntry;
    const totalEquity = resolveTotalEquity(directEntry, aggregateEntry);
    const totalPnl = resolveTotalPnl(resolvedEntry, 'all');
    const startDate = resolveStartDate(resolvedEntry, 'all', null);
    const annualizedRate = resolveAnnualizedRate(resolvedEntry, 'all');

    return {
      totalEquity,
      totalPnl,
      startDate,
      annualizedRate,
    };
  };

  const lines = [];
  const visitedGroups = new Set();
  const accountNodesByGroupKey = new Map();
  const rootAccountNodes = [];
  const ensureGroupNode = (groupKey, groupName) => {
    if (!groupKey) {
      return null;
    }
    if (groupNodesByKey.has(groupKey)) {
      return groupNodesByKey.get(groupKey);
    }
    const display = groupName || resolveGroupLabel(groupKey);
    const node = {
      type: 'group',
      option: { primary: display },
      orderIndex: baseGroupCount + syntheticGroupIndex,
      normalizedKey: groupKey,
      children: [],
      parent: null,
      isPlaceholder: true,
    };
    syntheticGroupIndex += 1;
    groupNodesByKey.set(groupKey, node);
    groupNodesList.push(node);
    return node;
  };

  groupParentsMap.forEach((parents, childKey) => {
    if (childKey && !groupNodesByKey.has(childKey)) {
      ensureGroupNode(childKey, resolveGroupLabel(childKey));
    }
    parents.forEach((parentKey) => {
      if (parentKey && !groupNodesByKey.has(parentKey)) {
        ensureGroupNode(parentKey, resolveGroupLabel(parentKey));
      }
    });
  });

  accountNodes.forEach((node) => {
    const account = node.account;
    const groupKey = normalizeAccountGroupKey(account?.accountGroup);
    if (groupKey) {
      const parent = ensureGroupNode(groupKey, resolveGroupLabel(groupKey));
      parent.children.push(node);
      node.parent = parent;
      if (!accountNodesByGroupKey.has(groupKey)) {
        accountNodesByGroupKey.set(groupKey, []);
      }
      accountNodesByGroupKey.get(groupKey).push(node);
    } else {
      rootAccountNodes.push(node);
    }
  });

  const isAncestor = (maybeParentName, childName) => {
    const parentKey = normalizeAccountGroupKey(maybeParentName);
    const childKey = normalizeAccountGroupKey(childName);
    if (!parentKey || !childKey || parentKey === childKey) {
      return false;
    }
    const seen = new Set();
    const queue = [childKey];
    while (queue.length) {
      const current = queue.shift();
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      const parents = groupParentsMap.get(current);
      if (!parents) {
        continue;
      }
      if (parents.has(parentKey)) {
        return true;
      }
      parents.forEach((p) => {
        if (!seen.has(p)) {
          queue.push(p);
        }
      });
    }
    return false;
  };

  const rootGroupNodes = [];
  const sortedGroupNodes = groupNodesList
    .slice()
    .sort((a, b) => {
      const aOrder = Number.isFinite(a.orderIndex) ? a.orderIndex : Number.MAX_SAFE_INTEGER;
      const bOrder = Number.isFinite(b.orderIndex) ? b.orderIndex : Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }
      const aName = (a.option?.primary || '').toLowerCase();
      const bName = (b.option?.primary || '').toLowerCase();
      return aName.localeCompare(bName);
    });

  sortedGroupNodes.forEach((node) => {
    const key = node.normalizedKey;
    if (!key) {
      rootGroupNodes.push(node);
      return;
    }
    const parentCandidates = groupParentsMap.get(key) ? Array.from(groupParentsMap.get(key)) : [];
    let parentNode = null;
    for (let i = 0; i < parentCandidates.length; i += 1) {
      const parentKey = parentCandidates[i];
      if (!parentKey || parentKey === key) {
        continue;
      }
      if (isAncestor(key, parentKey)) {
        continue;
      }
      const candidate = groupNodesByKey.get(parentKey);
      if (candidate) {
        parentNode = candidate;
        break;
      }
    }
    if (parentNode) {
      node.parent = parentNode;
      parentNode.children.push(node);
    } else {
      rootGroupNodes.push(node);
    }
  });

  const computeEffectiveOrder = (node) => {
    if (!node) {
      return Number.MAX_SAFE_INTEGER;
    }
    if (node.type === 'account') {
      const orderValue = Number.isFinite(node.orderIndex)
        ? node.orderIndex
        : Number.MAX_SAFE_INTEGER;
      node.effectiveOrder = orderValue;
      return orderValue;
    }
    let minOrder = Number.isFinite(node.orderIndex)
      ? node.orderIndex
      : Number.MAX_SAFE_INTEGER;
    node.children.forEach((child) => {
      const childOrder = computeEffectiveOrder(child);
      if (childOrder < minOrder) {
        minOrder = childOrder;
      }
    });
    node.effectiveOrder = minOrder;
    return minOrder;
  };

  const compareNodes = (a, b) => {
    const aOrder = Number.isFinite(a.effectiveOrder) ? a.effectiveOrder : Number.MAX_SAFE_INTEGER;
    const bOrder = Number.isFinite(b.effectiveOrder) ? b.effectiveOrder : Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) {
      return aOrder - bOrder;
    }
    if (a.type !== b.type) {
      if (a.type === 'group') {
        return -1;
      }
      if (b.type === 'group') {
        return 1;
      }
    }
    const aName = (a.option?.primary || '').toLowerCase();
    const bName = (b.option?.primary || '').toLowerCase();
    if (aName && bName) {
      const cmp = aName.localeCompare(bName, undefined, { sensitivity: 'base' });
      if (cmp !== 0) {
        return cmp;
      }
    }
    return 0;
  };

  const renderGroup = (groupKey, depth, forceRender) => {
    if (!groupKey || visitedGroups.has(groupKey)) {
      return;
    }
    visitedGroups.add(groupKey);

    const groupNode = groupNodesByKey.get(groupKey);
    const groupAccounts = accountNodesByGroupKey.get(groupKey) || [];
    const childGroupNodes =
      groupNode && Array.isArray(groupNode.children)
        ? groupNode.children.filter((child) => child.type === 'group')
        : [];

    if (!forceRender && groupAccounts.length === 0 && childGroupNodes.length === 0) {
      return;
    }

    const metrics = buildGroupMetrics(groupKey);
    lines.push(buildGroupLine(groupKey, metrics, depth));

    childGroupNodes
      .slice()
      .sort(compareNodes)
      .forEach((childNode) => {
        renderGroup(childNode.normalizedKey, depth + 1, false);
    });
    groupAccounts
      .slice()
      .sort(compareNodes)
      .forEach((node) => {
        lines.push(buildAccountLine(node.account, depth + 1));
    });
  };

  if (selectedAccountId === 'all') {
    const topLevelNodes = [...rootGroupNodes, ...rootAccountNodes];
    topLevelNodes.forEach((node) => {
      computeEffectiveOrder(node);
    });
    const sortedTopLevel = topLevelNodes.slice().sort(compareNodes);
    sortedTopLevel.forEach((node) => {
      if (node.type === 'group') {
        renderGroup(node.normalizedKey, 0, false);
      } else if (node.type === 'account') {
        lines.push(buildAccountLine(node.account, 0));
      }
    });
  } else if (isAccountGroupSelection(selectedAccountId)) {
    const group = groupsById.get(selectedAccountId) || null;
    const groupKey = group ? normalizeAccountGroupKey(group.name) : null;
    if (groupKey) {
      const rootNode = groupNodesByKey.get(groupKey);
      if (rootNode) {
        computeEffectiveOrder(rootNode);
      }
      renderGroup(groupKey, 0, true);
    }
  } else {
    const match = resolvedAccounts.find((account) => {
      const accountId = resolveAccountKey(account);
      return accountId === selectedAccountId || account?.number === selectedAccountId;
    });
    if (match && !shouldHideAccountSummaryEntry(match)) {
      lines.push(buildAccountLine(match, 0));
    }
  }

  if (!lines.length) {
    return null;
  }

  const appendixLines = [];
  if (appendixAccounts.size) {
    const entries = appendixOrder
      .map((key) => appendixAccounts.get(key))
      .filter(Boolean);
    entries.forEach((entry, index) => {
      if (index > 0) {
        appendixLines.push('');
      }
      const account = entry.account || null;
      const accountId = account?.id !== undefined && account?.id !== null ? String(account.id).trim() : '';
      const accountNumber =
        account?.number !== undefined && account?.number !== null ? String(account.number).trim() : '';
      const resolvedAccountKey = accountId || accountNumber || null;
      const accountPositions = collectPositionsForAccount(account);
      const positionsTable = buildPositionsAllocationTable(accountPositions, {
        symbolTotalPnlByAccountMap,
        symbolAnnualizedByAccountMap,
        symbolAnnualizedMap,
        accountKey: resolvedAccountKey,
      });

      appendixLines.push(sectionDivider);
      appendixLines.push(entry.label);
      appendixLines.push(sectionDivider);
      appendixLines.push('');
      if (entry.context) {
        entry.context.split('\n').forEach((line) => {
          appendixLines.push(`  ${line}`);
        });
        appendixLines.push('');
      }
      appendixLines.push(positionsTable);
    });
  }

  let parentLine = null;
  if (selectedAccountId !== 'all') {
    if (isAccountGroupSelection(selectedAccountId)) {
      const group = groupsById.get(selectedAccountId) || null;
      const groupKey = group ? normalizeAccountGroupKey(group.name) : null;
      const parents = groupKey ? groupParentsMap.get(groupKey) : null;
      const labels = parents
        ? Array.from(parents)
            .map((key) => resolveGroupLabel(key))
            .filter(Boolean)
        : [];
      if (labels.length) {
        parentLine = `Parent group: ${labels.join(', ')}`;
      }
    } else {
      const match = resolvedAccounts.find((account) => {
        const accountId = resolveAccountKey(account);
        return accountId === selectedAccountId || account?.number === selectedAccountId;
      });
      const parentKey = normalizeAccountGroupKey(match?.accountGroup);
      if (parentKey) {
        parentLine = `Parent group: ${resolveGroupLabel(parentKey)}`;
      }
    }
  }

  const hierarchyLines = [];
  hierarchyLines.push(sectionDivider);
  hierarchyLines.push('Account Hierarchy');
  hierarchyLines.push(sectionDivider);
  hierarchyLines.push('');
  if (parentLine) {
    hierarchyLines.push('');
    hierarchyLines.push(parentLine);
    hierarchyLines.push('');
  }
  hierarchyLines.push(...lines);

  const appendixBlock = appendixLines.length
    ? [
      sectionDivider,
      'SUB-ACCOUNTS',
      sectionDivider,
      '',
      ...appendixLines,
    ].join('\n')
    : null;

  return {
    hierarchy: hierarchyLines.join('\n'),
    appendix: appendixBlock,
    hasSubAccounts: appendixAccounts.size > 0,
  };
}

function buildClipboardSummary({
  selectedAccountId,
  accounts,
  accountGroups,
  groupRelations,
  accountFunding,
  positions,
  allPositions,
  symbolTotalPnlByAccountMap,
  symbolAnnualizedByAccountMap,
  symbolAnnualizedMap,
  planningContext,
}) {
  const sections = [];
  const sectionDivider = '-'.repeat(80);

  if (planningContext && typeof planningContext === 'string') {
    const trimmedContext = planningContext.trim();
    if (trimmedContext) {
      sections.push(`Account context:\n${trimmedContext}`);
    }
  }

  const hierarchy = buildAccountHierarchySummary({
    selectedAccountId,
    accounts,
    accountGroups,
    groupRelations,
    accountFunding,
    positions: allPositions,
    symbolTotalPnlByAccountMap,
    symbolAnnualizedByAccountMap,
    symbolAnnualizedMap,
  });
  if (hierarchy?.hierarchy) {
    sections.push(hierarchy.hierarchy);
  }

  const allocation = buildPositionsAllocationTable(positions, {
    symbolTotalPnlByAccountMap,
    symbolAnnualizedByAccountMap,
    symbolAnnualizedMap,
    accountKey: selectedAccountId,
    includeNotes: !hierarchy?.hasSubAccounts,
    includeTarget: !isAccountGroupSelection(selectedAccountId),
  });
  if (allocation) {
    sections.push([sectionDivider, 'Positions', sectionDivider, '', allocation].join('\n'));
  }

  if (hierarchy?.appendix) {
    sections.push(hierarchy.appendix);
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
          lastDateKey: null,
          lastDateTotals: new Map(),
          lineItems: [],
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
      const entryDateKey = entryTimestamp
        ? entryTimestamp.toISOString().slice(0, 10)
        : typeof entry.lastDate === 'string' && entry.lastDate.trim()
        ? entry.lastDate.trim().slice(0, 10)
        : null;
      const normalizedLastAmount = Number(entry.lastAmount);
      const hasNormalizedAmount = Number.isFinite(normalizedLastAmount);
      const normalizedLastCurrency =
        typeof entry.lastCurrency === 'string' && entry.lastCurrency.trim()
          ? entry.lastCurrency.trim().toUpperCase()
          : null;

      const isLaterTimestamp =
        entryTimestamp && (!aggregateEntry.lastTimestamp || entryTimestamp > aggregateEntry.lastTimestamp);
      const isLaterDateKey =
        !entryTimestamp &&
        entryDateKey &&
        (!aggregateEntry.lastDateKey || entryDateKey > aggregateEntry.lastDateKey);

      if (isLaterTimestamp || isLaterDateKey) {
        if (isLaterTimestamp) {
          aggregateEntry.lastTimestamp = entryTimestamp;
        } else if (!aggregateEntry.lastTimestamp && entryTimestamp) {
          aggregateEntry.lastTimestamp = entryTimestamp;
        }
        const computedDateKey = entryDateKey || (entryTimestamp ? entryTimestamp.toISOString().slice(0, 10) : null);
        const shouldResetTotals =
          !computedDateKey ||
          !(aggregateEntry.lastDateTotals instanceof Map) ||
          aggregateEntry.lastDateKey !== computedDateKey;
        aggregateEntry.lastDateKey = computedDateKey;
        aggregateEntry.lastAmount = hasNormalizedAmount ? normalizedLastAmount : null;
        aggregateEntry.lastCurrency = normalizedLastCurrency || null;
        if (shouldResetTotals) {
          aggregateEntry.lastDateTotals = new Map();
        }
      } else if (!aggregateEntry.lastTimestamp && entryTimestamp) {
        aggregateEntry.lastTimestamp = entryTimestamp;
      }

      if (entryDateKey && aggregateEntry.lastDateKey === entryDateKey && hasNormalizedAmount) {
        if (!(aggregateEntry.lastDateTotals instanceof Map)) {
          aggregateEntry.lastDateTotals = new Map();
        }
        const currencyKey = normalizedLastCurrency || '';
        const current = aggregateEntry.lastDateTotals.get(currencyKey) || 0;
        aggregateEntry.lastDateTotals.set(currencyKey, current + normalizedLastAmount);
        if (!aggregateEntry.lastCurrency && normalizedLastCurrency) {
          aggregateEntry.lastCurrency = normalizedLastCurrency;
        }
        if (!Number.isFinite(aggregateEntry.lastAmount) || aggregateEntry.lastAmount === null) {
          aggregateEntry.lastAmount = normalizedLastAmount;
        }
      }

      const lineItems = Array.isArray(entry.lineItems) ? entry.lineItems : [];
      lineItems.forEach((lineItem, lineIndex) => {
        if (!lineItem || typeof lineItem !== 'object') {
          return;
        }

        const normalizedLineItem = { ...lineItem };
        if (!normalizedLineItem.symbol && canonicalSymbol) {
          normalizedLineItem.symbol = canonicalSymbol;
        }
        if (!normalizedLineItem.displaySymbol && (displaySymbol || canonicalSymbol)) {
          normalizedLineItem.displaySymbol = displaySymbol || canonicalSymbol;
        }
        if (!normalizedLineItem.description && description) {
          normalizedLineItem.description = description;
        }
        if (!normalizedLineItem.lineItemId) {
          normalizedLineItem.lineItemId = `${entryKey}:${lineIndex}`;
        }

        aggregateEntry.lineItems.push(normalizedLineItem);
      });
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

    const lastDateTotalsMap =
      entry.lastDateKey && entry.lastDateTotals instanceof Map ? entry.lastDateTotals : null;
    let lastAmount = Number.isFinite(entry.lastAmount) ? entry.lastAmount : null;
    let lastCurrency = entry.lastCurrency || null;
    if (lastDateTotalsMap && lastDateTotalsMap.size > 0) {
      const preferredKey = lastCurrency || '';
      if (preferredKey && lastDateTotalsMap.has(preferredKey)) {
        const summed = lastDateTotalsMap.get(preferredKey);
        if (Number.isFinite(summed)) {
          lastAmount = summed;
        }
      } else if (!preferredKey && lastDateTotalsMap.has('')) {
        const summed = lastDateTotalsMap.get('');
        if (Number.isFinite(summed)) {
          lastAmount = summed;
        }
      } else if (lastDateTotalsMap.size === 1) {
        const [currencyKey, summed] = lastDateTotalsMap.entries().next().value;
        if (Number.isFinite(summed)) {
          lastAmount = summed;
          lastCurrency = currencyKey || null;
        }
      } else {
        const firstValid = Array.from(lastDateTotalsMap.entries()).find(([, value]) =>
          Number.isFinite(value)
        );
        if (firstValid) {
          const [currencyKey, summed] = firstValid;
          lastAmount = summed;
          if (currencyKey) {
            lastCurrency = currencyKey;
          }
        }
      }
    }

    const normalizedLineItems = Array.isArray(entry.lineItems)
      ? entry.lineItems
          .map((lineItem) => {
            if (!lineItem || typeof lineItem !== 'object') {
              return null;
            }

            const rawLineSymbols = Array.isArray(lineItem.rawSymbols)
              ? lineItem.rawSymbols
                  .map((value) => (typeof value === 'string' ? value.trim() : ''))
                  .filter(Boolean)
              : null;
            const lineCurrencyTotals = {};
            if (lineItem && typeof lineItem.currencyTotals === 'object' && lineItem.currencyTotals) {
              Object.entries(lineItem.currencyTotals).forEach(([currency, value]) => {
                const numeric = Number(value);
                if (!Number.isFinite(numeric)) {
                  return;
                }
                const key = normalizeCurrencyKey(currency);
                lineCurrencyTotals[key] = (lineCurrencyTotals[key] || 0) + numeric;
              });
            }
            if (!Object.keys(lineCurrencyTotals).length) {
              const fallbackAmount = Number(lineItem.amount);
              if (Number.isFinite(fallbackAmount)) {
                const fallbackCurrency = normalizeCurrencyKey(lineItem.currency);
                lineCurrencyTotals[fallbackCurrency] = (lineCurrencyTotals[fallbackCurrency] || 0) + fallbackAmount;
              }
            }

            const firstDate =
              (typeof lineItem.firstDate === 'string' && lineItem.firstDate.trim()) ||
              (typeof lineItem.startDate === 'string' && lineItem.startDate.trim()) ||
              (typeof lineItem.date === 'string' && lineItem.date.trim()) ||
              null;
            const lastDate =
              (typeof lineItem.lastDate === 'string' && lineItem.lastDate.trim()) ||
              (typeof lineItem.endDate === 'string' && lineItem.endDate.trim()) ||
              firstDate;
            const timestamp =
              lineItem.lastTimestamp || lineItem.timestamp ||
              (lastDate ? `${lastDate}T00:00:00.000Z` : null);
            const lastAmount = Number.isFinite(lineItem.lastAmount)
              ? lineItem.lastAmount
              : Number.isFinite(lineItem.amount)
              ? lineItem.amount
              : null;
            const cadAmount = Number.isFinite(lineItem.cadAmount) ? lineItem.cadAmount : null;

            return {
              symbol: lineItem.symbol || entry.symbol || null,
              displaySymbol:
                lineItem.displaySymbol ||
                lineItem.symbol ||
                entry.displaySymbol ||
                entry.symbol ||
                (rawLineSymbols && rawLineSymbols.length ? rawLineSymbols[0] : null) ||
                null,
              rawSymbols: rawLineSymbols && rawLineSymbols.length ? rawLineSymbols : undefined,
              description: lineItem.description || entry.description || null,
              currencyTotals: lineCurrencyTotals,
              cadAmount,
              conversionIncomplete: lineItem.conversionIncomplete ? true : undefined,
              activityCount: Number.isFinite(lineItem.activityCount) ? lineItem.activityCount : 1,
              firstDate,
              lastDate,
              lastTimestamp: typeof timestamp === 'string' ? timestamp : null,
              lastAmount: Number.isFinite(lastAmount) ? lastAmount : null,
              lastCurrency: (function resolveLineItemCurrency() {
                const candidate =
                  (typeof lineItem.lastCurrency === 'string' && lineItem.lastCurrency.trim()) ||
                  (typeof lineItem.currency === 'string' && lineItem.currency.trim()) ||
                  null;
                return candidate ? normalizeCurrencyKey(candidate) : null;
              })(),
              lineItemId:
                (typeof lineItem.lineItemId === 'string' && lineItem.lineItemId.trim()) ||
                (typeof lineItem.id === 'string' && lineItem.id.trim()) ||
                null,
              accountId: lineItem.accountId || null,
              accountLabel: lineItem.accountLabel || null,
            };
          })
          .filter(Boolean)
      : [];

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
      lastAmount: Number.isFinite(lastAmount) ? lastAmount : null,
      lastCurrency: lastCurrency || null,
      _magnitude: magnitude,
      lineItems: normalizedLineItems.length ? normalizedLineItems : undefined,
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

const BALANCE_AGGREGATE_FIELDS = [
  'totalEquity',
  'marketValue',
  'cash',
  'buyingPower',
  'maintenanceExcess',
  'dayPnl',
  'openPnl',
  'totalPnl',
  'totalCost',
  'realizedPnl',
  'unrealizedPnl',
];

function aggregateAccountBalanceSummaries(accountBalances, accountIds) {
  if (!accountBalances || typeof accountBalances !== 'object') {
    return null;
  }

  const normalizedIds = Array.from(
    new Set(
      (Array.isArray(accountIds) ? accountIds : [])
        .map((id) => (id === undefined || id === null ? '' : String(id).trim()))
        .filter(Boolean)
    )
  );

  if (!normalizedIds.length) {
    return null;
  }

  const combinedAccumulators = Object.create(null);
  const perCurrencyAccumulators = Object.create(null);

  const ensureBucket = (container, currency) => {
    const key = currency || '';
    if (!container[key]) {
      container[key] = {
        currency: currency || null,
        isRealTime: false,
        __counts: Object.create(null),
      };
    }
    return container[key];
  };

  normalizedIds.forEach((accountId) => {
    const summary = normalizeAccountBalanceSummary(accountBalances[accountId]);
    if (!summary) {
      return;
    }

    const combine = (source, target) => {
      if (!source || typeof source !== 'object') {
        return;
      }
      Object.entries(source).forEach(([currencyKey, entry]) => {
        if (!entry || typeof entry !== 'object') {
          return;
        }
        const bucket = ensureBucket(target, currencyKey);
        BALANCE_AGGREGATE_FIELDS.forEach((field) => {
          const raw = entry[field];
          const value = typeof raw === 'number' ? raw : Number(raw);
          if (Number.isFinite(value)) {
            const current = typeof bucket[field] === 'number' ? bucket[field] : 0;
            bucket[field] = current + value;
            bucket.__counts[field] = (bucket.__counts[field] || 0) + 1;
          }
        });
        if (entry.isRealTime) {
          bucket.isRealTime = true;
        }
      });
    };

    combine(summary.combined, combinedAccumulators);
    combine(summary.perCurrency, perCurrencyAccumulators);
  });

  const finalize = (container) => {
    const entries = Object.entries(container)
      .map(([currencyKey, entry]) => {
        const result = {};
        if (entry.currency !== undefined) {
          result.currency = entry.currency;
        } else if (currencyKey) {
          result.currency = currencyKey;
        }
        if (entry.isRealTime) {
          result.isRealTime = true;
        }
        BALANCE_AGGREGATE_FIELDS.forEach((field) => {
          if (entry.__counts[field] > 0) {
            result[field] = entry[field];
          }
        });
        return [currencyKey, result];
      })
      .filter(([, value]) => Object.keys(value).length > 0);

    if (!entries.length) {
      return null;
    }

    return entries.reduce((acc, [key, value]) => {
      acc[key] = value;
      return acc;
    }, {});
  };

  const combined = finalize(combinedAccumulators);
  const perCurrency = finalize(perCurrencyAccumulators);

  if (!combined && !perCurrency) {
    return null;
  }

  const summary = {};
  if (combined) {
    summary.combined = combined;
  }
  if (perCurrency) {
    summary.perCurrency = perCurrency;
  }
  return summary;
}

function resolveEarliestCagrStartDate(accountFunding, accountIds) {
  if (!accountFunding || typeof accountFunding !== 'object') {
    return null;
  }
  if (!Array.isArray(accountIds) || !accountIds.length) {
    return null;
  }

  let allHaveCagrStart = true;
  let earliest = null;

  accountIds.forEach((accountId) => {
    const key = accountId === undefined || accountId === null ? '' : String(accountId).trim();
    if (!key) {
      allHaveCagrStart = false;
      return;
    }
    const entry = accountFunding[key];
    if (!entry || typeof entry !== 'object') {
      allHaveCagrStart = false;
      return;
    }
    const raw = entry.cagrStartDate;
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) {
      allHaveCagrStart = false;
      return;
    }
    if (!earliest || trimmed < earliest) {
      earliest = trimmed;
    }
  });

  if (!allHaveCagrStart || !earliest) {
    return null;
  }
  return earliest;
}

function aggregateFundingSummariesForAccounts(accountFunding, accountIds) {
  if (!accountFunding || typeof accountFunding !== 'object') {
    return null;
  }

  const normalizedIds = Array.from(
    new Set(
      (Array.isArray(accountIds) ? accountIds : [])
        .map((id) => (id === undefined || id === null ? '' : String(id).trim()))
        .filter(Boolean)
    )
  );

  if (!normalizedIds.length) {
    return null;
  }

  let netDepositsTotal = 0;
  let netDepositsCount = 0;
  let netDepositsAllTimeTotal = 0;
  let netDepositsAllTimeCount = 0;
  let totalPnlTotal = 0;
  let totalPnlCount = 0;
  let totalPnlAllTimeTotal = 0;
  let totalPnlAllTimeCount = 0;
  let totalEquityTotal = 0;
  let totalEquityCount = 0;

  normalizedIds.forEach((accountId) => {
    const entry = accountFunding[accountId];
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const netDepositsCad = entry?.netDeposits?.combinedCad;
    if (isFiniteNumber(netDepositsCad)) {
      netDepositsTotal += netDepositsCad;
      netDepositsCount += 1;
    }
    const netDepositsAllTimeCad = entry?.netDeposits?.allTimeCad;
    if (isFiniteNumber(netDepositsAllTimeCad)) {
      netDepositsAllTimeTotal += netDepositsAllTimeCad;
      netDepositsAllTimeCount += 1;
    }
    const totalPnlCad = entry?.totalPnl?.combinedCad;
    if (isFiniteNumber(totalPnlCad)) {
      totalPnlTotal += totalPnlCad;
      totalPnlCount += 1;
    }
    const totalPnlAllTimeCad = entry?.totalPnl?.allTimeCad;
    if (isFiniteNumber(totalPnlAllTimeCad)) {
      totalPnlAllTimeTotal += totalPnlAllTimeCad;
      totalPnlAllTimeCount += 1;
    }
    const totalEquityCad = entry?.totalEquityCad;
    if (isFiniteNumber(totalEquityCad)) {
      totalEquityTotal += totalEquityCad;
      totalEquityCount += 1;
    }
  });

  const aggregate = {};
  let hasAggregateData = false;

  if (netDepositsCount > 0 || netDepositsAllTimeCount > 0) {
    aggregate.netDeposits = {};
    if (netDepositsCount > 0) aggregate.netDeposits.combinedCad = netDepositsTotal;
    if (netDepositsAllTimeCount > 0) aggregate.netDeposits.allTimeCad = netDepositsAllTimeTotal;
    hasAggregateData = true;
  }
  if (totalPnlCount > 0 || totalPnlAllTimeCount > 0) {
    aggregate.totalPnl = {};
    if (totalPnlCount > 0) aggregate.totalPnl.combinedCad = totalPnlTotal;
    if (totalPnlAllTimeCount > 0) aggregate.totalPnl.allTimeCad = totalPnlAllTimeTotal;
    hasAggregateData = true;
  } else if ((netDepositsCount > 0 || netDepositsAllTimeCount > 0) && totalEquityCount > 0) {
    const derivedCombined = netDepositsCount > 0 ? totalEquityTotal - netDepositsTotal : null;
    const derivedAllTime = netDepositsAllTimeCount > 0 ? totalEquityTotal - netDepositsAllTimeTotal : null;
    if (isFiniteNumber(derivedCombined) || isFiniteNumber(derivedAllTime)) {
      aggregate.totalPnl = {};
      if (isFiniteNumber(derivedCombined)) aggregate.totalPnl.combinedCad = derivedCombined;
      if (isFiniteNumber(derivedAllTime)) aggregate.totalPnl.allTimeCad = derivedAllTime;
      hasAggregateData = true;
    }
  }
  if (totalEquityCount > 0) {
    aggregate.totalEquityCad = totalEquityTotal;
    hasAggregateData = true;
  }

  const derivedCagrStartDate = resolveEarliestCagrStartDate(accountFunding, normalizedIds);
  if (derivedCagrStartDate) {
    aggregate.cagrStartDate = derivedCagrStartDate;
    hasAggregateData = true;
  }

  return hasAggregateData ? aggregate : null;
}

function aggregateTotalPnlEntries(totalPnlMap, accountIds) {
  if (!totalPnlMap || typeof totalPnlMap !== 'object') {
    return null;
  }

  const normalizedIds = Array.from(
    new Set(
      (Array.isArray(accountIds) ? accountIds : [])
        .map((id) => (id === undefined || id === null ? '' : String(id).trim()))
        .filter(Boolean)
    )
  );

  if (!normalizedIds.length) {
    return null;
  }

  const aggregateEntries = new Map();
  const aggregateEntriesNoFx = new Map();
  let fxEffectTotal = 0;
  let fxEffectHasValue = false;
  let latestAsOf = null;

  const addEntryToMap = (bucket, sourceEntry) => {
    const key =
      typeof sourceEntry?.symbol === 'string' && sourceEntry.symbol.trim()
        ? sourceEntry.symbol.trim().toUpperCase()
        : null;
    if (!key) {
      return;
    }
    const existing = bucket.get(key);
    if (!existing) {
      const clone = {};
      Object.entries(sourceEntry).forEach(([field, value]) => {
        if (value !== undefined) {
          if (typeof value === 'number') {
            clone[field] = Number.isFinite(value) ? value : value;
          } else if (Array.isArray(value)) {
            clone[field] = value.slice();
          } else if (value && typeof value === 'object') {
            clone[field] = { ...value };
          } else {
            clone[field] = value;
          }
        }
      });
      bucket.set(key, clone);
      return;
    }
    Object.entries(sourceEntry).forEach(([field, value]) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        const current = typeof existing[field] === 'number' && Number.isFinite(existing[field]) ? existing[field] : 0;
        existing[field] = current + value;
      } else if (existing[field] === undefined) {
        existing[field] = value;
      }
    });
  };

  normalizedIds.forEach((accountId) => {
    const entry = totalPnlMap[accountId];
    if (!entry || typeof entry !== 'object') {
      return;
    }
    if (Array.isArray(entry.entries)) {
      entry.entries.forEach((symbolEntry) => addEntryToMap(aggregateEntries, symbolEntry));
    }
    if (Array.isArray(entry.entriesNoFx)) {
      entry.entriesNoFx.forEach((symbolEntry) => addEntryToMap(aggregateEntriesNoFx, symbolEntry));
    }
    const fx = entry.fxEffectCad;
    if (Number.isFinite(fx)) {
      fxEffectTotal += fx;
      fxEffectHasValue = true;
    }
    const asOf = typeof entry.asOf === 'string' ? entry.asOf : null;
    if (asOf && (!latestAsOf || asOf > latestAsOf)) {
      latestAsOf = asOf;
    }
  });

  const entries = Array.from(aggregateEntries.values()).sort((a, b) => {
    const aMagnitude = Math.abs(Number(a.totalPnlCad) || 0);
    const bMagnitude = Math.abs(Number(b.totalPnlCad) || 0);
    if (aMagnitude !== bMagnitude) {
      return bMagnitude - aMagnitude;
    }
    const aSymbol = typeof a.symbol === 'string' ? a.symbol : '';
    const bSymbol = typeof b.symbol === 'string' ? b.symbol : '';
    return aSymbol.localeCompare(bSymbol);
  });

  const entriesNoFx = Array.from(aggregateEntriesNoFx.values()).sort((a, b) => {
    const aMagnitude = Math.abs(Number(a.totalPnlCad) || 0);
    const bMagnitude = Math.abs(Number(b.totalPnlCad) || 0);
    if (aMagnitude !== bMagnitude) {
      return bMagnitude - aMagnitude;
    }
    const aSymbol = typeof a.symbol === 'string' ? a.symbol : '';
    const bSymbol = typeof b.symbol === 'string' ? b.symbol : '';
    return aSymbol.localeCompare(bSymbol);
  });

  if (!entries.length && !entriesNoFx.length && !fxEffectHasValue) {
    return null;
  }

  const payload = {};
  if (entries.length) {
    payload.entries = entries;
  }
  if (entriesNoFx.length) {
    payload.entriesNoFx = entriesNoFx;
  }
  if (fxEffectHasValue) {
    payload.fxEffectCad = fxEffectTotal;
  }
  if (latestAsOf) {
    payload.asOf = latestAsOf;
  }
  return payload;
}

function summaryRepresentsAllAccounts(summary) {
  if (!summary || typeof summary !== 'object') {
    return false;
  }

  const resolvedAccountId =
    typeof summary.resolvedAccountId === 'string' ? summary.resolvedAccountId.trim() : '';
  if (resolvedAccountId === 'all') {
    return true;
  }

  const requestedAccountId =
    typeof summary.requestedAccountId === 'string' ? summary.requestedAccountId.trim() : '';
  if (requestedAccountId === 'all') {
    return true;
  }

  const accounts = Array.isArray(summary.accounts) ? summary.accounts : [];
  const filteredAccountIds = Array.isArray(summary.filteredAccountIds)
    ? summary.filteredAccountIds
    : [];

  if (!accounts.length || !filteredAccountIds.length) {
    return false;
  }

  const normalizedAccountIds = accounts
    .map((account) => {
      if (!account || typeof account !== 'object') {
        return '';
      }
      if (account.id !== undefined && account.id !== null) {
        return String(account.id).trim();
      }
      return '';
    })
    .filter(Boolean);

  if (!normalizedAccountIds.length) {
    return false;
  }

  const normalizedFilteredIds = filteredAccountIds
    .map((value) => (value !== undefined && value !== null ? String(value).trim() : ''))
    .filter(Boolean);

  if (normalizedFilteredIds.length < normalizedAccountIds.length) {
    return false;
  }

  const filteredSet = new Set(normalizedFilteredIds);

  return normalizedAccountIds.every((accountId) => filteredSet.has(accountId));
}

function deriveSummaryFromSuperset(baseData, selectionKey) {
  if (!baseData || typeof baseData !== 'object') {
    return null;
  }

  const normalizedKey = typeof selectionKey === 'string' ? selectionKey.trim() : '';
  if (!normalizedKey || normalizedKey === 'default') {
    return null;
  }
  if (normalizedKey === 'all') {
    return baseData;
  }

  const allAccounts = Array.isArray(baseData.accounts) ? baseData.accounts : [];
  const accountIdSet = new Set();
  const accountNumberSet = new Set();

  if (isAccountGroupSelection(normalizedKey)) {
    const groups = Array.isArray(baseData.accountGroups) ? baseData.accountGroups : [];
    const group = groups.find((entry) => entry && entry.id === normalizedKey);
    if (!group) {
      return null;
    }
    (Array.isArray(group.accountIds) ? group.accountIds : []).forEach((value) => {
      if (value !== undefined && value !== null) {
        const key = String(value).trim();
        if (key) {
          accountIdSet.add(key);
        }
      }
    });
    (Array.isArray(group.accountNumbers) ? group.accountNumbers : []).forEach((value) => {
      if (value !== undefined && value !== null) {
        const key = String(value).trim();
        if (key) {
          accountNumberSet.add(key);
        }
      }
    });
  } else {
    accountIdSet.add(normalizedKey);
  }

  allAccounts.forEach((account) => {
    if (!account || typeof account !== 'object') {
      return;
    }
    const id = account.id !== undefined && account.id !== null ? String(account.id) : null;
    const numberRaw =
      account.number !== undefined && account.number !== null
        ? account.number
        : account.accountNumber !== undefined && account.accountNumber !== null
          ? account.accountNumber
          : null;
    const number = numberRaw !== undefined && numberRaw !== null ? String(numberRaw) : null;
    if (normalizedKey === number) {
      if (id) {
        accountIdSet.add(id);
      }
      if (number) {
        accountNumberSet.add(number);
      }
    }
    if (accountNumberSet.has(number) && id) {
      accountIdSet.add(id);
    }
  });

  const normalizedAccountIds = Array.from(accountIdSet);
  const normalizedAccountNumbers = Array.from(accountNumberSet);
  if (!normalizedAccountIds.length && !normalizedAccountNumbers.length) {
    return null;
  }

  const matchesSelection = (idCandidate, numberCandidate) => {
    const idKey = idCandidate !== undefined && idCandidate !== null ? String(idCandidate).trim() : '';
    const numberKey = numberCandidate !== undefined && numberCandidate !== null ? String(numberCandidate).trim() : '';
    if (idKey && normalizedAccountIds.includes(idKey)) {
      return true;
    }
    if (numberKey && normalizedAccountNumbers.includes(numberKey)) {
      return true;
    }
    return false;
  };

  const positions = Array.isArray(baseData.positions)
    ? baseData.positions.filter((position) =>
        matchesSelection(position?.accountId, position?.accountNumber)
      )
    : [];

  const orderedAccountIds = [];
  const seenAccounts = new Set();
  const pushAccountId = (value) => {
    const key = value === undefined || value === null ? '' : String(value).trim();
    if (!key || seenAccounts.has(key)) {
      return;
    }
    seenAccounts.add(key);
    orderedAccountIds.push(key);
  };

  normalizedAccountIds.forEach(pushAccountId);
  positions.forEach((position) => {
    if (position && position.accountId !== undefined && position.accountId !== null) {
      pushAccountId(position.accountId);
    }
  });

  if (!orderedAccountIds.length && normalizedAccountNumbers.length) {
    normalizedAccountNumbers.forEach((numberKey) => {
      const match = allAccounts.find((account) => {
        const accountNumber =
          account && account.number !== undefined && account.number !== null
            ? String(account.number)
            : account && account.accountNumber !== undefined && account.accountNumber !== null
              ? String(account.accountNumber)
              : '';
        return accountNumber === numberKey;
      });
      if (match && match.id !== undefined && match.id !== null) {
        pushAccountId(match.id);
      }
    });
  }

  if (!orderedAccountIds.length) {
    normalizedAccountIds.forEach(pushAccountId);
  }

  if (!orderedAccountIds.length) {
    return null;
  }

  const orders = Array.isArray(baseData.orders)
    ? baseData.orders.filter((order) => matchesSelection(order?.accountId, order?.accountNumber))
    : [];

  let balances = null;
  if (orderedAccountIds.length === 1) {
    const primaryId = orderedAccountIds[0];
    balances = normalizeAccountBalanceSummary(
      baseData.accountBalances && baseData.accountBalances[primaryId]
    );
  }
  if (!balances) {
    balances = aggregateAccountBalanceSummaries(baseData.accountBalances, orderedAccountIds);
  }

  const fundingMap =
    baseData.accountFunding && typeof baseData.accountFunding === 'object'
      ? baseData.accountFunding
      : EMPTY_OBJECT;
  let nextAccountFunding = fundingMap;

  const dividendsMap =
    baseData.accountDividends && typeof baseData.accountDividends === 'object'
      ? baseData.accountDividends
      : EMPTY_OBJECT;
  let nextAccountDividends = dividendsMap;
  if (isAccountGroupSelection(normalizedKey) || orderedAccountIds.length > 1) {
    const aggregateDividends = aggregateDividendSummaries(dividendsMap, orderedAccountIds, 'all');
    if (aggregateDividends && (!dividendsMap[normalizedKey] || isAccountGroupSelection(normalizedKey))) {
      nextAccountDividends = { ...dividendsMap, [normalizedKey]: aggregateDividends };
    }
  }

  const totalPnlMap =
    baseData.accountTotalPnlBySymbol && typeof baseData.accountTotalPnlBySymbol === 'object'
      ? baseData.accountTotalPnlBySymbol
      : null;
  let nextTotalPnlMap = totalPnlMap;
  if (totalPnlMap && (isAccountGroupSelection(normalizedKey) || orderedAccountIds.length > 1)) {
    const aggregate = aggregateTotalPnlEntries(totalPnlMap, orderedAccountIds);
    if (aggregate) {
      nextTotalPnlMap = { ...totalPnlMap, [normalizedKey]: aggregate };
    }
  }

  const totalPnlAllMap =
    baseData.accountTotalPnlBySymbolAll && typeof baseData.accountTotalPnlBySymbolAll === 'object'
      ? baseData.accountTotalPnlBySymbolAll
      : null;
  let nextTotalPnlAllMap = totalPnlAllMap;
  if (totalPnlAllMap && (isAccountGroupSelection(normalizedKey) || orderedAccountIds.length > 1)) {
    const aggregateAll = aggregateTotalPnlEntries(totalPnlAllMap, orderedAccountIds);
    if (aggregateAll) {
      nextTotalPnlAllMap = { ...totalPnlAllMap, [normalizedKey]: aggregateAll };
    }
  }

  const totalPnlSeriesMap =
    baseData.accountTotalPnlSeries && typeof baseData.accountTotalPnlSeries === 'object'
      ? baseData.accountTotalPnlSeries
      : null;
  let nextTotalPnlSeriesMap = null;
  if (totalPnlSeriesMap) {
    nextTotalPnlSeriesMap = {};
    orderedAccountIds.forEach((accountId) => {
      const entry = totalPnlSeriesMap[accountId];
      if (entry && typeof entry === 'object') {
        nextTotalPnlSeriesMap[accountId] = entry;
      }
    });
    // Also include a group/all entry when present so aggregate dialogs can seed instantly
    if (isAccountGroupSelection(normalizedKey)) {
      const groupEntry = totalPnlSeriesMap[normalizedKey];
      if (groupEntry && typeof groupEntry === 'object') {
        nextTotalPnlSeriesMap[normalizedKey] = groupEntry;
      }
    } else if (normalizedKey === 'all' && totalPnlSeriesMap['all']) {
      nextTotalPnlSeriesMap['all'] = totalPnlSeriesMap['all'];
    }
  }

  // Prefer composing group/all funding from per-account series when available so that
  // the summary pod matches the Total P&L dialog and avoids double counting.
  if ((isAccountGroupSelection(normalizedKey) || normalizedKey === 'all') && orderedAccountIds.length) {
    let composed = null;
    const derivedGroupCagrStartDate = resolveEarliestCagrStartDate(fundingMap, orderedAccountIds);
    if (nextTotalPnlSeriesMap) {
      let earliestAllStart = null;
      let latestAllEnd = null;

      const considerAllSeriesWindow = (seriesObj) => {
        if (!seriesObj || typeof seriesObj !== 'object') return;
        const s = typeof seriesObj.periodStartDate === 'string' ? seriesObj.periodStartDate.trim() : '';
        const e = typeof seriesObj.periodEndDate === 'string' ? seriesObj.periodEndDate.trim() : '';
        if (s) {
          if (!earliestAllStart || s < earliestAllStart) earliestAllStart = s;
        }
        if (e) {
          if (!latestAllEnd || e > latestAllEnd) latestAllEnd = e;
        }
      };
      let combinedNetDeposits = 0;
      let combinedNetDepositsCount = 0;
      let combinedTotalPnlSinceDisplay = 0;
      let combinedTotalPnlSinceDisplayCount = 0;
      let combinedEquitySinceDisplay = 0;
      let combinedEquitySinceDisplayCount = 0;

      let allTimeNetDeposits = 0;
      let allTimeNetDepositsCount = 0;
      let allTimeTotalPnl = 0;
      let allTimeTotalPnlCount = 0;
      let allTimeEquity = 0;
      let allTimeEquityCount = 0;

      orderedAccountIds.forEach((id) => {
        const key = id === undefined || id === null ? '' : String(id).trim();
        if (!key) return;
        const container = nextTotalPnlSeriesMap[key] && typeof nextTotalPnlSeriesMap[key] === 'object' ? nextTotalPnlSeriesMap[key] : null;
        const cagr = container && container.cagr ? container.cagr : null;
        const allSeries = container && container.all ? container.all : null;
        considerAllSeriesWindow(allSeries);
        const cagrSummary = cagr && typeof cagr.summary === 'object' ? cagr.summary : null;
        const allSummary = allSeries && typeof allSeries.summary === 'object' ? allSeries.summary : null;
        if (cagrSummary) {
          const nd = Number(cagrSummary.netDepositsCad);
          const tp = Number(cagrSummary.totalPnlSinceDisplayStartCad);
          const eq = Number(cagrSummary.totalEquitySinceDisplayStartCad);
          if (Number.isFinite(nd)) { combinedNetDeposits += nd; combinedNetDepositsCount++; }
          if (Number.isFinite(tp)) { combinedTotalPnlSinceDisplay += tp; combinedTotalPnlSinceDisplayCount++; }
          if (Number.isFinite(eq)) { combinedEquitySinceDisplay += eq; combinedEquitySinceDisplayCount++; }
        }
        if (allSummary) {
          const ndAll = Number(allSummary.netDepositsAllTimeCad);
          const tpAll = Number(allSummary.totalPnlAllTimeCad);
          const eqAll = Number(allSummary.totalEquityCad);
          if (Number.isFinite(ndAll)) { allTimeNetDeposits += ndAll; allTimeNetDepositsCount++; }
          if (Number.isFinite(tpAll)) { allTimeTotalPnl += tpAll; allTimeTotalPnlCount++; }
          if (Number.isFinite(eqAll)) { allTimeEquity += eqAll; allTimeEquityCount++; }
        }
      });

      // If a precomputed group/all series exists, prefer its all-time summary for accuracy
      let overrideAllTime = null;
      let overrideAllTimeNetDeposits = null;
      let overrideAllTimeEquity = null;
      if (isAccountGroupSelection(normalizedKey)) {
        const groupContainer = nextTotalPnlSeriesMap[normalizedKey];
        const groupAll = groupContainer && groupContainer.all ? groupContainer.all : null;
        if (groupAll && groupAll.summary) {
          const s = groupAll.summary;
          if (isFiniteNumber(s.totalPnlAllTimeCad)) overrideAllTime = s.totalPnlAllTimeCad;
          if (isFiniteNumber(s.netDepositsAllTimeCad)) overrideAllTimeNetDeposits = s.netDepositsAllTimeCad;
          if (isFiniteNumber(s.totalEquityCad)) overrideAllTimeEquity = s.totalEquityCad;
        }
        considerAllSeriesWindow(groupAll);
      } else if (normalizedKey === 'all' && nextTotalPnlSeriesMap['all']) {
        const container = nextTotalPnlSeriesMap['all'];
        const seriesAll = container.all || container.cagr;
        if (seriesAll && seriesAll.summary) {
          const s = seriesAll.summary;
          if (isFiniteNumber(s.totalPnlAllTimeCad)) overrideAllTime = s.totalPnlAllTimeCad;
          if (isFiniteNumber(s.netDepositsAllTimeCad)) overrideAllTimeNetDeposits = s.netDepositsAllTimeCad;
          if (isFiniteNumber(s.totalEquityCad)) overrideAllTimeEquity = s.totalEquityCad;
        }
        considerAllSeriesWindow(seriesAll);
      }

      const result = {};
      const netDeposits = {};
      if (combinedNetDepositsCount > 0) netDeposits.combinedCad = combinedNetDeposits;
      if (allTimeNetDepositsCount > 0) netDeposits.allTimeCad = allTimeNetDeposits;
      if (overrideAllTimeNetDeposits !== null) netDeposits.allTimeCad = overrideAllTimeNetDeposits;
      if (Object.keys(netDeposits).length) result.netDeposits = netDeposits;

      if (combinedTotalPnlSinceDisplayCount > 0) result.totalPnlSinceDisplayStartCad = combinedTotalPnlSinceDisplay;
      const totalPnl = {};
      if (combinedTotalPnlSinceDisplayCount > 0) totalPnl.combinedCad = combinedTotalPnlSinceDisplay;
      if (allTimeTotalPnlCount > 0) totalPnl.allTimeCad = allTimeTotalPnl;
      if (overrideAllTime !== null) totalPnl.allTimeCad = overrideAllTime;
      if (Object.keys(totalPnl).length) result.totalPnl = totalPnl;

      if (combinedEquitySinceDisplayCount > 0) result.totalEquitySinceDisplayStartCad = combinedEquitySinceDisplay;
      if (allTimeEquityCount > 0) result.totalEquityCad = allTimeEquity;
      if (overrideAllTimeEquity !== null) result.totalEquityCad = overrideAllTimeEquity;

      if (Object.keys(result).length) {
        if (earliestAllStart) result.periodStartDate = earliestAllStart;
        if (latestAllEnd) result.periodEndDate = latestAllEnd;
        composed = result;
      }
    }

    // Fallback: aggregate directly from funding map if series unavailable
    if (!composed) {
      const aggregateFunding = aggregateFundingSummariesForAccounts(fundingMap, orderedAccountIds);
      if (aggregateFunding) {
        composed = aggregateFunding;
      }
    }

    if (composed) {
      const shouldAttach = isAccountGroupSelection(normalizedKey) || normalizedKey === 'all' || !fundingMap[normalizedKey];
      if (shouldAttach) {
        const base = nextAccountFunding[normalizedKey] || {};
        // Merge, preferring composed values for group accuracy
        const merged = { ...base };
        if (composed.netDeposits) {
          merged.netDeposits = Object.assign({}, base.netDeposits || {}, composed.netDeposits);
        }
        if (composed.totalPnl) {
          merged.totalPnl = Object.assign({}, base.totalPnl || {}, composed.totalPnl);
        }
        if (Number.isFinite(composed.totalPnlSinceDisplayStartCad)) {
          merged.totalPnlSinceDisplayStartCad = composed.totalPnlSinceDisplayStartCad;
        }
        if (Number.isFinite(composed.totalEquitySinceDisplayStartCad)) {
          merged.totalEquitySinceDisplayStartCad = composed.totalEquitySinceDisplayStartCad;
        }
        if (Number.isFinite(composed.totalEquityCad)) {
          merged.totalEquityCad = composed.totalEquityCad;
        }
        if (derivedGroupCagrStartDate) {
          merged.cagrStartDate = derivedGroupCagrStartDate;
        }
        nextAccountFunding = { ...nextAccountFunding, [normalizedKey]: merged };
      }
    }

    if (
      !composed &&
      derivedGroupCagrStartDate &&
      (isAccountGroupSelection(normalizedKey) || normalizedKey === 'all')
    ) {
      const base = nextAccountFunding[normalizedKey] || {};
      if (base.cagrStartDate !== derivedGroupCagrStartDate) {
        nextAccountFunding = {
          ...nextAccountFunding,
          [normalizedKey]: { ...base, cagrStartDate: derivedGroupCagrStartDate },
        };
      }
    }
  }

  const resolvedAccountId = (function resolveAccountId() {
    if (isAccountGroupSelection(normalizedKey)) {
      return normalizedKey;
    }
    if (orderedAccountIds.length === 1) {
      return orderedAccountIds[0];
    }
    return normalizedKey;
  })();

  const resolvedAccountNumber = (function resolveAccountNumber() {
    if (orderedAccountIds.length !== 1) {
      return null;
    }
    const primaryId = orderedAccountIds[0];
    const match = allAccounts.find((account) => String(account?.id) === primaryId);
    if (!match) {
      return null;
    }
    const raw =
      match.number !== undefined && match.number !== null
        ? match.number
        : match.accountNumber !== undefined && match.accountNumber !== null
          ? match.accountNumber
          : null;
    return raw !== undefined && raw !== null ? String(raw) : null;
  })();

  return {
    ...baseData,
    requestedAccountId: normalizedKey,
    resolvedAccountId: resolvedAccountId || null,
    resolvedAccountNumber: resolvedAccountNumber || null,
    filteredAccountIds: orderedAccountIds,
    positions,
    orders,
    balances: balances || null,
    featureFlags: baseData.featureFlags || null,
    otherAssets: baseData.otherAssets || null,
    accountFunding: nextAccountFunding,
    accountDividends: nextAccountDividends,
    accountTotalPnlBySymbol: nextTotalPnlMap ?? baseData.accountTotalPnlBySymbol ?? null,
    accountTotalPnlBySymbolAll: nextTotalPnlAllMap ?? baseData.accountTotalPnlBySymbolAll ?? null,
    accountTotalPnlSeries: nextTotalPnlSeriesMap ?? baseData.accountTotalPnlSeries ?? null,
    accountNorbertJournals: (function resolveNorbertMap() {
      const source = baseData.accountNorbertJournals;
      if (!source || typeof source !== 'object') {
        return source ?? null;
      }
      if (!orderedAccountIds.length) {
        return source;
      }
      const subset = {};
      orderedAccountIds.forEach((id) => {
        const key = id !== undefined && id !== null ? String(id).trim() : '';
        if (!key) {
          return;
        }
        if (Object.prototype.hasOwnProperty.call(source, key)) {
          subset[key] = source[key];
        }
      });
      return Object.keys(subset).length ? subset : source;
    })(),
  };
}

function loadSummary(fetchKey, options = {}) {
  const normalizedRefreshKey =
    options && (options.refreshKey !== undefined && options.refreshKey !== null)
      ? String(options.refreshKey)
      : '';
  const normalizedForce = options && options.force === true;
  const requestKey = `${fetchKey}::${normalizedRefreshKey}::${normalizedForce ? 'force' : ''}`;
  const existing = inflightSummaryRequests.get(requestKey);
  if (existing) {
    return existing;
  }

  const request = getSummary(fetchKey, { force: normalizedForce, refreshKey: normalizedRefreshKey });
  inflightSummaryRequests.set(requestKey, request);
  request.finally(() => {
    if (inflightSummaryRequests.get(requestKey) === request) {
      inflightSummaryRequests.delete(requestKey);
    }
  });
  return request;
}

function useSummaryData(accountNumber, refreshKey) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const cacheRef = useRef(new Map());
  const refreshTrackerRef = useRef(refreshKey);

  useEffect(() => {
    const previousRefreshKey = refreshTrackerRef.current;
    const refreshChanged = refreshKey !== previousRefreshKey;
    refreshTrackerRef.current = refreshKey;

    const normalizedAccount =
      typeof accountNumber === 'string' && accountNumber.trim() ? accountNumber.trim() : 'all';

    const supersetEntry = cacheRef.current.get('all');
    const supersetData = supersetEntry ? supersetEntry.data : null;
    const derivedFromSuperset =
      normalizedAccount !== 'default' && supersetData
        ? deriveSummaryFromSuperset(supersetData, normalizedAccount)
        : null;
    const cachedEntry = cacheRef.current.get(normalizedAccount);
    const cachedData = cachedEntry ? cachedEntry.data : null;
    const initialData = derivedFromSuperset || cachedData || null;

    if (
      derivedFromSuperset &&
      normalizedAccount !== 'default' &&
      normalizedAccount !== 'all'
    ) {
      const existing = cacheRef.current.get(normalizedAccount);
      if (!existing || existing.data !== derivedFromSuperset) {
        cacheRef.current.set(normalizedAccount, { data: derivedFromSuperset, refreshKey });
      }
    }

    setState((prev) => {
      if (initialData) {
        // When a manual refresh is triggered, mark as loading while keeping
        // existing data so the refresh spinner animates.
        if (refreshChanged) {
          if (prev.loading === true && prev.data === initialData && !prev.error) {
            return prev;
          }
          return { loading: true, data: initialData, error: null };
        }
        if (prev.data === initialData && prev.loading === false && !prev.error) {
          return prev;
        }
        return { loading: false, data: initialData, error: null };
      }
      if (!prev.loading || prev.data !== null || prev.error) {
        return { loading: true, data: prev.data, error: null };
      }
      return prev;
    });

    let fetchKey = null;
    let forceFetch = false;
    if (normalizedAccount === 'default') {
      if (refreshChanged || !cachedData) {
        fetchKey = 'default';
      }
    } else if (refreshChanged) {
      fetchKey = 'all';
    } else if (!supersetData) {
      fetchKey = 'all';
    } else if (!initialData && normalizedAccount === 'all') {
      fetchKey = 'all';
    } else if (
      // If viewing a group derived from the superset, fetch the dedicated
      // group summary when key fields are missing (annualized, period dates,
      // or preheated group series). This avoids stale/partial data in the UI.
      isAccountGroupSelection(normalizedAccount)
    ) {
      const target = derivedFromSuperset || cachedData || null;
      const fundingForGroup =
        target && target.accountFunding && typeof target.accountFunding === 'object'
          ? target.accountFunding[normalizedAccount]
          : null;
      const hasAnnualized = Boolean(
        (fundingForGroup && fundingForGroup.annualizedReturn &&
          Number.isFinite(fundingForGroup.annualizedReturn.rate)) ||
          (fundingForGroup && fundingForGroup.annualizedReturnAllTime &&
            Number.isFinite(fundingForGroup.annualizedReturnAllTime.rate))
      );
      const hasPeriodStart = typeof fundingForGroup?.periodStartDate === 'string' && fundingForGroup.periodStartDate.trim();
      const seriesMapCandidate = target && target.accountTotalPnlSeries && typeof target.accountTotalPnlSeries === 'object'
        ? target.accountTotalPnlSeries[normalizedAccount]
        : null;
      const hasGroupSeries = Boolean(seriesMapCandidate && (seriesMapCandidate.all || seriesMapCandidate.cagr));
      if (!hasAnnualized || !hasPeriodStart || !hasGroupSeries) {
        fetchKey = normalizedAccount;
        forceFetch = true; // bypass server cache to hydrate missing fields
      }
    }

    if (!fetchKey) {
      return undefined;
    }

    let cancelled = false;
    loadSummary(fetchKey, { refreshKey, force: refreshChanged || forceFetch })
      .then((summary) => {
        if (cancelled) {
          return;
        }
        const storeEntry = (key, data) => {
          if (!key || !data) {
            return;
          }
          cacheRef.current.set(key, { data, refreshKey });
        };

        const representsAllAccounts = summaryRepresentsAllAccounts(summary);

        if (fetchKey === 'all' || representsAllAccounts) {
          storeEntry(fetchKey, summary);
          if (representsAllAccounts) {
            storeEntry('all', summary);
          }

          if (normalizedAccount === fetchKey || (representsAllAccounts && normalizedAccount === 'default')) {
            setState({ loading: false, data: summary, error: null });
            return;
          }

          if (normalizedAccount === 'all') {
            setState({ loading: false, data: summary, error: null });
            return;
          }

          const derived = deriveSummaryFromSuperset(summary, normalizedAccount);
          if (derived) {
            storeEntry(normalizedAccount, derived);
            setState({ loading: false, data: derived, error: null });
          } else {
            setState({ loading: false, data: summary, error: null });
          }
          return;
        }

        storeEntry(normalizedAccount, summary);
        setState({ loading: false, data: summary, error: null });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const normalizedError =
          error instanceof Error ? error : new Error('Failed to load summary data');
        setState((prev) => ({ loading: false, data: prev.data, error: normalizedError }));
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

function parseCadAmountInput(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/,/g, '').replace(/\s+/g, '').replace(/\$/g, '');
  const match = normalized.match(/^(-?\d*\.?\d+)([kKmM])?$/);
  if (!match) {
    return null;
  }
  const base = Number(match[1]);
  if (!Number.isFinite(base)) {
    return null;
  }
  const suffix = match[2] ? match[2].toLowerCase() : '';
  if (suffix === 'k') {
    return base * 1000;
  }
  if (suffix === 'm') {
    return base * 1000000;
  }
  return base;
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
const OTHER_ASSET_LABELS = Object.freeze({
  homeCad: 'Home',
  vehiclesCad: 'Vehicles',
  otherAssetsCad: 'Other assets',
});

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

function resolveCashForTodo(balances, currency) {
  if (!balances || !currency) {
    return null;
  }

  // Prefer per-currency cash and only fall back to combined balances when they
  // materially reduce the magnitude (i.e., netting cross-currency offsets) so we
  // avoid flagging TODOs for cash that only exists in another currency.
  const perCurrencyOnly = balances.perCurrency ? { perCurrency: balances.perCurrency } : null;
  const combinedOnly = balances.combined ? { combined: balances.combined } : null;

  const perCurrencyEntry = perCurrencyOnly && findBalanceEntryForCurrency(perCurrencyOnly, currency);
  const perCurrencyCash = perCurrencyEntry ? resolveCashForCurrency(perCurrencyOnly, currency) : null;

  const combinedEntry = combinedOnly && findBalanceEntryForCurrency(combinedOnly, currency);
  const combinedCash = combinedEntry ? resolveCashForCurrency(combinedOnly, currency) : null;

  if (!Number.isFinite(perCurrencyCash)) {
    return Number.isFinite(combinedCash) ? combinedCash : null;
  }

  if (
    Number.isFinite(combinedCash) &&
    Math.abs(combinedCash) + TODO_AMOUNT_EPSILON < Math.abs(perCurrencyCash)
  ) {
    return combinedCash;
  }

  return perCurrencyCash;
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

const TODO_CASH_THRESHOLD = 20;
const TODO_AMOUNT_EPSILON = 0.009;
const TODO_AMOUNT_TOLERANCE = 0.01;
const TODO_SHARE_EPSILON = 0.0001;
const TODO_TYPE_ORDER = { rebalance: 0, norbert: 1, cash: 2 };

const RESERVE_FALLBACK_SYMBOL = 'VBIL';
const PRICE_REFRESH_CONCURRENCY = 6;

function normalizeSymbolKey(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : '';
}

function derivePositionDayOpenPrice(position) {
  if (!position) {
    return null;
  }
  const currentPrice = coerceNumber(position.currentPrice);
  const dayPnl = coerceNumber(position.dayPnl);
  const quantity = coerceNumber(position.openQuantity);
  if (
    currentPrice === null ||
    dayPnl === null ||
    quantity === null ||
    !Number.isFinite(quantity) ||
    Math.abs(quantity) < 1e-9
  ) {
    return null;
  }
  return currentPrice - dayPnl / quantity;
}

function applyPriceSnapshotsToPositions(positions, priceSnapshots) {
  if (!Array.isArray(positions) || positions.length === 0) {
    return positions;
  }
  if (!priceSnapshots || !(priceSnapshots instanceof Map) || priceSnapshots.size === 0) {
    return positions;
  }

  let changed = false;
  const updated = positions.map((position) => {
    if (!position || !position.symbol) {
      return position;
    }
    const symbolKey = normalizeSymbolKey(position.symbol);
    if (!symbolKey) {
      return position;
    }
    const snapshot = priceSnapshots.get(symbolKey);
    if (!snapshot) {
      return position;
    }
    const overridePrice = coercePositiveNumber(snapshot.price);
    if (!overridePrice) {
      return position;
    }

    const quantity = coerceNumber(position.openQuantity);
    const startOfDayPrice = derivePositionDayOpenPrice(position);
    const averageEntryPrice = coerceNumber(position.averageEntryPrice);

    let nextMarketValue = position.currentMarketValue;
    if (quantity !== null && Number.isFinite(quantity)) {
      const computed = overridePrice * quantity;
      if (Number.isFinite(computed)) {
        nextMarketValue = computed;
      }
    }

    let nextDayPnl = position.dayPnl;
    if (startOfDayPrice !== null && quantity !== null && Number.isFinite(quantity)) {
      nextDayPnl = (overridePrice - startOfDayPrice) * quantity;
    }

    let nextOpenPnl = position.openPnl;
    if (averageEntryPrice !== null && quantity !== null && Number.isFinite(quantity)) {
      nextOpenPnl = (overridePrice - averageEntryPrice) * quantity;
    }

    const existingPrice = coercePositiveNumber(position.currentPrice);
    const priceChanged = existingPrice === null || Math.abs(existingPrice - overridePrice) > 1e-9;
    const dayChanged = coerceNumber(position.dayPnl) !== nextDayPnl;
    const openChanged = coerceNumber(position.openPnl) !== nextOpenPnl;

    if (!priceChanged && !dayChanged && !openChanged) {
      return position;
    }

    changed = true;
    return {
      ...position,
      currentPrice: overridePrice,
      currentMarketValue: nextMarketValue,
      dayPnl: nextDayPnl,
      openPnl: nextOpenPnl,
      isRealTime: true,
      priceAsOf: snapshot.asOf || null,
    };
  });

  return changed ? updated : positions;
}

function applyPriceSnapshotsToBalances(balances, positions, currencyRates, baseCurrency = 'CAD') {
  if (!balances || !positions || !positions.length) {
    return balances;
  }

  const normalizedBase = (baseCurrency || 'CAD').toUpperCase();
  const perCurrencyTotals = new Map();
  positions.forEach((position) => {
    if (!position) {
      return;
    }
    const currency = (position.currency || normalizedBase).toUpperCase();
    const marketValue = coerceNumber(position.currentMarketValue);
    const dayPnl = coerceNumber(position.dayPnl);
    const openPnl = coerceNumber(position.openPnl);
    let bucket = perCurrencyTotals.get(currency);
    if (!bucket) {
      bucket = { marketValue: 0, dayPnl: 0, openPnl: 0 };
      perCurrencyTotals.set(currency, bucket);
    }
    if (marketValue !== null) {
      bucket.marketValue += marketValue;
    }
    if (dayPnl !== null) {
      bucket.dayPnl += dayPnl;
    }
    if (openPnl !== null) {
      bucket.openPnl += openPnl;
    }
  });

  if (perCurrencyTotals.size === 0) {
    return balances;
  }

  const convertAmount = (amount, sourceCurrency, targetCurrency) => {
    const numeric = coerceNumber(amount);
    if (numeric === null) {
      return 0;
    }
    return normalizeCurrencyAmount(numeric, sourceCurrency, currencyRates, targetCurrency);
  };

  const combinedTotalsCache = new Map();
  const resolveCombinedTotals = (targetCurrency) => {
    const key = (targetCurrency || normalizedBase).toUpperCase();
    if (combinedTotalsCache.has(key)) {
      return combinedTotalsCache.get(key);
    }
    const summary = { marketValue: 0, dayPnl: 0, openPnl: 0 };
    perCurrencyTotals.forEach((values, currency) => {
      summary.marketValue += convertAmount(values.marketValue, currency, key);
      summary.dayPnl += convertAmount(values.dayPnl, currency, key);
      summary.openPnl += convertAmount(values.openPnl, currency, key);
    });
    combinedTotalsCache.set(key, summary);
    return summary;
  };

  let changed = false;
  const nextBalances = { combined: undefined, perCurrency: undefined };

  if (balances.combined) {
    nextBalances.combined = {};
    Object.entries(balances.combined).forEach(([currency, entry]) => {
      const currencyKey = (typeof currency === 'string' && currency.trim()) || '';
      const totals = resolveCombinedTotals(currencyKey || normalizedBase);
      const nextEntry = entry && typeof entry === 'object' ? { ...entry } : {};
      nextEntry.marketValue = totals.marketValue;
      nextEntry.dayPnl = totals.dayPnl;
      nextEntry.openPnl = totals.openPnl;
      const cash = coerceNumber(entry?.cash);
      const equityBase = Number.isFinite(nextEntry.marketValue) ? nextEntry.marketValue : 0;
      nextEntry.totalEquity = (cash !== null ? cash : 0) + equityBase;
      nextBalances.combined[currency] = nextEntry;
      changed = true;
    });
  }

  if (balances.perCurrency) {
    nextBalances.perCurrency = {};
    Object.entries(balances.perCurrency).forEach(([currency, entry]) => {
      const currencyKey = (typeof currency === 'string' && currency.trim()) || '';
      const normalizedCurrency = currencyKey ? currencyKey.toUpperCase() : normalizedBase;
      const totals = perCurrencyTotals.get(normalizedCurrency) || { marketValue: 0, dayPnl: 0, openPnl: 0 };
      const nextEntry = entry && typeof entry === 'object' ? { ...entry } : {};
      nextEntry.marketValue = totals.marketValue;
      nextEntry.dayPnl = totals.dayPnl;
      nextEntry.openPnl = totals.openPnl;
      const cash = coerceNumber(entry?.cash);
      nextEntry.totalEquity = (cash !== null ? cash : 0) + (Number.isFinite(totals.marketValue) ? totals.marketValue : 0);
      nextBalances.perCurrency[currency] = nextEntry;
      changed = true;
    });
  }

  return changed ? nextBalances : balances;
}

async function fetchQuotesForSymbols(symbols) {
  if (!Array.isArray(symbols) || !symbols.length) {
    return { snapshots: new Map(), failures: [] };
  }

  const normalizedSymbols = Array.from(
    new Set(
      symbols
        .map((symbol) => normalizeSymbolKey(symbol))
        .filter(Boolean)
    )
  );

  if (!normalizedSymbols.length) {
    return { snapshots: new Map(), failures: [] };
  }

  const snapshots = new Map();
  const failures = [];
  let cursor = 0;

  const workers = Array.from({ length: Math.min(PRICE_REFRESH_CONCURRENCY, normalizedSymbols.length) }, () =>
    (async () => {
      while (cursor < normalizedSymbols.length) {
        const index = cursor;
        cursor += 1;
        const symbol = normalizedSymbols[index];
        if (!symbol) {
          continue;
        }
        try {
          const quote = await getQuote(symbol);
          const price = coercePositiveNumber(quote?.price);
          if (!price) {
            failures.push({ symbol, error: new Error('Quote did not include a valid price') });
            continue;
          }
          const payload = {
            price,
            currency:
              typeof quote?.currency === 'string' && quote.currency.trim()
                ? quote.currency.trim().toUpperCase()
                : null,
            asOf: typeof quote?.asOf === 'string' && quote.asOf ? quote.asOf : null,
          };
          snapshots.set(symbol, payload);
        } catch (error) {
          failures.push({ symbol, error });
        }
      }
    })()
  );

  await Promise.all(workers);
  return { snapshots, failures };
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

function normalizeDlrVariantSymbol(symbol) {
  if (typeof symbol !== 'string') {
    return null;
  }
  const normalized = symbol.trim().toUpperCase();
  if (!normalized || !normalized.startsWith('DLR')) {
    return null;
  }
  if (normalized.includes('.U')) {
    return normalized.endsWith('.TO') ? 'DLR.U.TO' : 'DLR.U';
  }
  return normalized.endsWith('.TO') ? 'DLR.TO' : 'DLR';
}

function buildNorbertTodoForAccount({
  accountId,
  accountLabel,
  accountNumber,
  positions,
  norbertJournalMap,
}) {
  if (!accountId || !norbertJournalMap || typeof norbertJournalMap !== 'object') {
    return null;
  }
  const entry = norbertJournalMap[accountId];
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const toSymbol = normalizeDlrVariantSymbol(entry.toSymbol || entry.targetSymbol || '');
  if (!toSymbol) {
    return null;
  }
  const fromSymbol = normalizeDlrVariantSymbol(entry.fromSymbol || '');
  const journalDate = typeof entry.journalDate === 'string' ? entry.journalDate.trim() : '';
  const journalTimestamp =
    typeof entry.journalTimestamp === 'string' && entry.journalTimestamp.trim()
      ? entry.journalTimestamp.trim()
      : '';
  const journalQuantity = Number(entry.quantity);
  const directionHint = typeof entry.direction === 'string' ? entry.direction.trim().toLowerCase() : '';
  const direction = directionHint || (toSymbol.includes('.U') ? 'to_usd' : 'to_cad');

  const accountPositions = Array.isArray(positions)
    ? positions.filter((position) => position && String(position.accountId) === String(accountId))
    : [];
  const holdings = accountPositions.reduce(
    (acc, position) => {
      const variant = normalizeDlrVariantSymbol(position.symbol);
      if (variant !== toSymbol) {
        return acc;
      }
      const qty = Number(position.openQuantity);
      const value = Number(position.currentMarketValue);
      return {
        quantity: Number.isFinite(qty) ? acc.quantity + qty : acc.quantity,
        value: Number.isFinite(value) ? acc.value + value : acc.value,
        currency: acc.currency || (typeof position.currency === 'string' ? position.currency.trim().toUpperCase() : null),
      };
    },
    { quantity: 0, value: 0, currency: null }
  );

  if (!(holdings.quantity > TODO_SHARE_EPSILON)) {
    return null;
  }
  if (Number.isFinite(journalQuantity) && journalQuantity > 0 && holdings.quantity > journalQuantity + TODO_SHARE_EPSILON) {
    return null;
  }

  const details = [];
  if (fromSymbol && journalDate) {
    details.push(`Journaled from ${fromSymbol} on ${journalDate}`);
  } else if (journalDate) {
    details.push(`Journaled ${journalDate}`);
  } else if (fromSymbol) {
    details.push(`Journaled from ${fromSymbol}`);
  }
  details.push(`${formatNumber(holdings.quantity, { maximumFractionDigits: 2, minimumFractionDigits: 0 })} shares remaining`);

  return {
    id: `norbert:${accountId}:${journalTimestamp || journalDate || toSymbol}`,
    type: 'norbert',
    accountId,
    accountNumber,
    accountLabel,
    symbol: toSymbol,
    direction,
    journalDate: journalDate || null,
    journalTimestamp: journalTimestamp || null,
    quantity: holdings.quantity,
    details,
    title: `Sell ${toSymbol} for ${direction === 'to_usd' ? 'USD' : 'CAD'} cash`,
  };
}

function buildTodoItems({
  accountIds,
  accountsById,
  accountBalances,
  investmentModelSections,
  positions,
  norbertJournalMap,
}) {
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

    const accountNumber =
      account && account.number !== undefined && account.number !== null
        ? String(account.number).trim()
        : account && account.accountNumber !== undefined && account.accountNumber !== null
          ? String(account.accountNumber).trim()
          : null;

    const norbertTodo = buildNorbertTodoForAccount({
      accountId,
      accountLabel,
      accountNumber,
      positions,
      norbertJournalMap,
    });
    if (norbertTodo) {
      items.push(norbertTodo);
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
        const cashValue = resolveCashForTodo(balanceSummary, currency);
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
    } else if (itemA.type === 'norbert') {
      if ((itemA.symbol || '') !== (itemB.symbol || '')) {
        return false;
      }
      if ((itemA.journalDate || '') !== (itemB.journalDate || '')) {
        return false;
      }
      if (!amountsApproximatelyEqual(itemA.quantity, itemB.quantity, TODO_SHARE_EPSILON * 10)) {
        return false;
      }
      if ((itemA.direction || '') !== (itemB.direction || '')) {
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

  const initialSymbolFromUrl = useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }
    return readSymbolFromLocation(window.location);
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
  const [earningsState, setEarningsState] = useState({ status: 'idle', data: null, error: null });
  const [symbolPriceSnapshots, setSymbolPriceSnapshots] = useState(() => new Map());
  const [priceRefreshState, setPriceRefreshState] = useState({
    status: 'idle',
    error: null,
    refreshedAt: null,
  });
  const [lastRebalanceOverrides, setLastRebalanceOverrides] = useState(() => new Map());
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
  const [positionsSort, setPositionsSort] = usePersistentState('positionsTableSort', DEFAULT_POSITIONS_SORT);
  const [positionsPnlMode, setPositionsPnlMode] = usePersistentState('positionsTablePnlMode', 'currency');
  const [portfolioViewTab, setPortfolioViewTab] = usePersistentState('portfolioViewTab', 'positions');
  const [demoModeEnabled, setDemoModeEnabled] = usePersistentState(DEMO_MODE_STORAGE_KEY, false);
  const [includeUnbilledEarningsInTotalEquityPreference, setIncludeUnbilledEarningsInTotalEquityPreference] =
    usePersistentState('includeUnbilledEarningsInTotalEquity', true);
  const [includeOtherAssetsInTotalEquityPreference, setIncludeOtherAssetsInTotalEquityPreference] =
    usePersistentState('includeOtherAssetsInTotalEquity', true);
  const [ordersFilter, setOrdersFilter] = useState('');
  const [dividendTimeframe, setDividendTimeframe] = useState(DEFAULT_DIVIDEND_TIMEFRAME);
  const [accountPlanningContexts, setAccountPlanningContexts] = usePersistentState(
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
  const [accountMetadataEditor, setAccountMetadataEditor] = useState(null);
  const [accountActionPrompt, setAccountActionPrompt] = useState(null);
  const [loginSetupState, setLoginSetupState] = useState({
    status: 'idle',
    logins: [],
    error: null,
    updatedAt: null,
  });
  const [loginSetupPrompted, setLoginSetupPrompted] = useState(false);
  const [invalidRefreshTokenPrompted, setInvalidRefreshTokenPrompted] = useState(false);
  const [showLoginSetupDialog, setShowLoginSetupDialog] = useState(false);
  const [showRefreshTokenHelpDialog, setShowRefreshTokenHelpDialog] = useState(false);
  const [loginSetupNeedsRefresh, setLoginSetupNeedsRefresh] = useState(false);
  const [showAccountStructureDialog, setShowAccountStructureDialog] = useState(false);
  const accountStructureNeedsRefreshRef = useRef(false);
  const [refreshNotice, setRefreshNotice] = useState({
    open: false,
    targetKey: null,
    started: false,
    message: '',
  });
  const [accountStructureState, setAccountStructureState] = useState({
    status: 'idle',
    entries: [],
    error: null,
  });
  const [accountStructureContext, setAccountStructureContext] = useState({
    status: 'idle',
    accounts: [],
    accountGroups: [],
    groupRelations: {},
    error: null,
  });
  const [accountStructureNeedsRefresh, setAccountStructureNeedsRefresh] = useState(false);
  const [pendingMetadataOverrides, setPendingMetadataOverrides] = useState(() => new Map());
  const [pnlBreakdownMode, setPnlBreakdownMode] = useState(null);
  const [pnlBreakdownInitialAccount, setPnlBreakdownInitialAccount] = useState(null);
  // Capture the Total P&L dialog's range choice when launching the breakdown
  // so it applies even after the dialog closes.
  const [pnlBreakdownUseAllOverride, setPnlBreakdownUseAllOverride] = useState(null);
  const [pnlBreakdownRange, setPnlBreakdownRange] = useState(null);
  const [rangeBreakdownState, setRangeBreakdownState] = useState({
    status: 'idle',
    key: null,
    data: null,
    error: null,
  });
  const rangeBreakdownCacheRef = useRef(new Map());
  const [rangeBreakdownRequestId, setRangeBreakdownRequestId] = useState(0);
  const [totalPnlSelectionResetKey, setTotalPnlSelectionResetKey] = useState(0);
  const [showReturnBreakdown, setShowReturnBreakdown] = useState(false);
  const [showProjectionDialog, setShowProjectionDialog] = useState(false);
  const [showHoldingsPieChart, setShowHoldingsPieChart] = useState(false);
  const [projectionContext, setProjectionContext] = useState({
    accountKey: null,
    label: null,
    cagrStartDate: null,
    parentAccountId: null,
    retireAtAge: null,
  });
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
    const symbol = normalizeQueryValue(initialTodoActionFromUrl.symbol);
    const journalDate = normalizeQueryValue(initialTodoActionFromUrl.journalDate);
    const direction = normalizeQueryValue(initialTodoActionFromUrl.direction);
    const accountNumber = normalizeQueryValue(initialTodoActionFromUrl.accountNumber);
    return {
      type,
      accountId,
      model,
      chartKey,
      symbol,
      journalDate,
      direction,
      accountNumber,
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
    prompt: null,
    rawOutput: null,
    usage: null,
    pricing: null,
    cost: null,
  });
  const [portfolioNewsRetryKey, setPortfolioNewsRetryKey] = useState(0);
  const [showNewsPromptDialog, setShowNewsPromptDialog] = useState(false);
  const [newsTabContextMenuState, setNewsTabContextMenuState] = useState({ open: false, x: 0, y: 0 });
  const newsTabMenuRef = useRef(null);
  const isNewsFeatureEnabled = false;
  const [focusedSymbol, setFocusedSymbol] = useState(null);
  const [focusedSymbolDescription, setFocusedSymbolDescription] = useState(null);
  const [focusedSymbolPriceSymbol, setFocusedSymbolPriceSymbol] = useState(null);
  const [adHocSymbolGroup, setAdHocSymbolGroup] = useState(null);
  const [dynamicSymbolGroups, setDynamicSymbolGroups] = useState(new Map());
  const [pendingSymbolAction, setPendingSymbolAction] = useState(null);
  const [focusedSymbolQuoteState, setFocusedSymbolQuoteState] = useState({
    status: 'idle',
    data: null,
    error: null,
  });
  const [focusedSymbolSummaryFocusVisible, setFocusedSymbolSummaryFocusVisible] = useState(false);
  const [focusedSymbolMenuState, setFocusedSymbolMenuState] = useState({
    open: false,
    x: 0,
    y: 0,
  });
  const focusedSymbolMenuRef = useRef(null);

  const clearFocusedSymbol = useCallback(() => {
    setFocusedSymbol(null);
    setFocusedSymbolDescription(null);
    setFocusedSymbolPriceSymbol(null);
    setAdHocSymbolGroup(null);
  }, []);
  const positionsCardRef = useRef(null);

  const closeFocusedSymbolMenu = useCallback(() => {
    setFocusedSymbolMenuState((state) => (state.open ? { ...state, open: false } : state));
  }, []);

  const closeNewsTabContextMenu = useCallback(() => {
    setNewsTabContextMenuState((state) => (state.open ? { ...state, open: false } : state));
  }, []);

  const handleNewsTabContextMenu = useCallback(
    (event) => {
      if (!isNewsFeatureEnabled) {
        return;
      }
      event.preventDefault();
      setNewsTabContextMenuState({ open: true, x: event.clientX, y: event.clientY });
    },
    [isNewsFeatureEnabled]
  );
  const quoteCacheRef = useRef(new Map());
  const [showTotalPnlDialog, setShowTotalPnlDialog] = useState(false);
  const [totalPnlDialogContext, setTotalPnlDialogContext] = useState({
    accountKey: null,
    label: null,
    supportsCagrToggle: false,
    cagrStartDate: null,
  });
  const [totalPnlSeriesState, setTotalPnlSeriesState] = useState({
    status: 'idle',
    data: null,
    error: null,
    accountKey: null,
    mode: 'cagr',
    symbol: null,
    symbolGroupKey: null,
  });
  const [symbolGroupAnnualizedState, setSymbolGroupAnnualizedState] = useState({
    status: 'idle',
    data: null,
    error: null,
    key: null,
  });
  const [symbolPriceSeriesState, setSymbolPriceSeriesState] = useState({
    symbol: null,
    status: 'idle',
    data: null,
    error: null,
  });
  
  // If a symbol is present in the URL, focus it on load
  const resolveSymbolFocus = useCallback((symbol) => {
    const normalized = normalizeSymbolGroupKey(symbol);
    if (!normalized) {
      return null;
    }
    const adHocMatch =
      adHocSymbolGroup &&
      normalizeSymbolGroupKey(adHocSymbolGroup.key) === normalized
        ? adHocSymbolGroup
        : null;
    if (adHocMatch && Array.isArray(adHocMatch.symbols) && adHocMatch.symbols.length) {
      const defaultPriceSymbol =
        adHocMatch.defaultPriceSymbol || adHocMatch.symbols[0] || normalized;
      return {
        canonical: adHocMatch.key || normalized,
        priceSymbol: defaultPriceSymbol,
      };
    }
    const cryptoPriceOverride = CRYPTO_PRICE_SYMBOL_BY_KEY[normalized] || null;
    const dynamicGroup = dynamicSymbolGroups.get(normalized);
    if (dynamicGroup && Array.isArray(dynamicGroup.symbols) && dynamicGroup.symbols.length) {
      const defaultPriceSymbol = dynamicGroup.defaultPriceSymbol || dynamicGroup.symbols[0] || normalized;
      return {
        canonical: dynamicGroup.key || normalized,
        priceSymbol: defaultPriceSymbol,
      };
    }
    const group =
      getSymbolGroupForSymbol(normalized) || getSymbolGroupByKey(normalized);
    const canonical = group ? group.key : normalized;
    const defaultPrice =
      (group && (group.symbols.includes(normalized) ? normalized : group.defaultPriceSymbol)) ||
      canonical;
    return {
      canonical,
      priceSymbol: cryptoPriceOverride || defaultPrice,
    };
  }, [adHocSymbolGroup, dynamicSymbolGroups]);

  useEffect(() => {
    const s = initialSymbolFromUrl?.symbol || null;
    if (!s) return;
    const resolution = resolveSymbolFocus(s);
    if (!resolution) return;
    setFocusedSymbol(resolution.canonical);
    setFocusedSymbolDescription(initialSymbolFromUrl?.description || null);
    setFocusedSymbolPriceSymbol(resolution.priceSymbol);
    setOrdersFilter(resolution.canonical);
    setPortfolioViewTab('positions');
  }, [initialSymbolFromUrl, resolveSymbolFocus, setOrdersFilter]);

  useEffect(() => {
    setFocusedSymbolSummaryFocusVisible(false);
  }, [focusedSymbol]);

  const normalizedFocusedSymbolKey = focusedSymbol ? normalizeSymbolGroupKey(focusedSymbol) : null;
  const focusedSymbolGroup = useMemo(() => {
    if (!normalizedFocusedSymbolKey) {
      return null;
    }
    if (
      adHocSymbolGroup &&
      normalizeSymbolGroupKey(adHocSymbolGroup.key) === normalizedFocusedSymbolKey
    ) {
      return adHocSymbolGroup;
    }
    return (
      dynamicSymbolGroups.get(normalizedFocusedSymbolKey) ||
      getSymbolGroupByKey(normalizedFocusedSymbolKey) ||
      null
    );
  }, [adHocSymbolGroup, normalizedFocusedSymbolKey, dynamicSymbolGroups]);
  const focusedSymbolCryptoTheme = useMemo(() => {
    if (!normalizedFocusedSymbolKey || !CRYPTO_THEME_KEY_SET.has(normalizedFocusedSymbolKey)) {
      return null;
    }
    const labelOverride = CRYPTO_DISPLAY_LABEL_BY_KEY[normalizedFocusedSymbolKey];
    const matchedTheme = CRYPTO_THEME_DEFINITIONS.find(
      (theme) => normalizeSymbolGroupKey(theme?.key) === normalizedFocusedSymbolKey
    );
    const fallbackLabel =
      (matchedTheme && typeof matchedTheme.label === 'string' && matchedTheme.label.trim()
        ? matchedTheme.label.trim()
        : null) || normalizedFocusedSymbolKey;
    return {
      key: normalizedFocusedSymbolKey,
      label: labelOverride || fallbackLabel,
    };
  }, [normalizedFocusedSymbolKey]);
  const focusedSymbolTitle = useMemo(
    () => {
      if (
        adHocSymbolGroup &&
        normalizeSymbolGroupKey(adHocSymbolGroup.key) === normalizedFocusedSymbolKey
      ) {
        return adHocSymbolGroup.label || adHocSymbolGroup.key || focusedSymbol || '';
      }
      if (focusedSymbolCryptoTheme?.label) {
        return focusedSymbolCryptoTheme.label;
      }
      if (focusedSymbolGroup?.label) {
        return focusedSymbolGroup.label;
      }
      return focusedSymbol || '';
    },
    [adHocSymbolGroup, focusedSymbol, focusedSymbolCryptoTheme, focusedSymbolGroup, normalizedFocusedSymbolKey]
  );
  const focusedSymbolIsCryptoAggregate =
    focusedSymbolCryptoTheme?.key === CRYPTO_AGGREGATE_KEY;
  const isFocusedSymbolDynamicGroup = useMemo(() => {
    if (!normalizedFocusedSymbolKey) {
      return false;
    }
    if (
      adHocSymbolGroup &&
      normalizeSymbolGroupKey(adHocSymbolGroup.key) === normalizedFocusedSymbolKey
    ) {
      return true;
    }
    return dynamicSymbolGroups.has(normalizedFocusedSymbolKey);
  }, [adHocSymbolGroup, dynamicSymbolGroups, normalizedFocusedSymbolKey]);
  const focusedSymbolMembers = useMemo(() => {
    if (!normalizedFocusedSymbolKey) {
      return [];
    }
    if (focusedSymbolGroup) {
      return focusedSymbolGroup.symbols;
    }
    return [normalizedFocusedSymbolKey];
  }, [normalizedFocusedSymbolKey, focusedSymbolGroup]);
  const focusedSymbolGroupKey = useMemo(() => {
    if (focusedSymbolMembers.length) {
      return focusedSymbolMembers.join('|');
    }
    return normalizedFocusedSymbolKey || null;
  }, [focusedSymbolMembers, normalizedFocusedSymbolKey]);
  const focusedSymbolMemberSet = useMemo(
    () => new Set(focusedSymbolMembers),
    [focusedSymbolMembers]
  );
  const matchesFocusedSymbol = useCallback(
    (symbol) => {
      if (!symbol || !focusedSymbolMemberSet.size) {
        return false;
      }
      const normalized = normalizeSymbolGroupKey(symbol);
      if (!normalized) {
        return false;
      }
      return focusedSymbolMemberSet.has(normalized);
    },
    [focusedSymbolMemberSet]
  );
  const focusedSymbolPriceOptions = useMemo(() => {
    if (!focusedSymbolMembers.length) {
      return [];
    }
    return focusedSymbolMembers.map((symbol) => ({
      value: symbol,
      label: symbol,
    }));
  }, [focusedSymbolMembers]);
  useEffect(() => {
    if (!focusedSymbolMembers.length) {
      setFocusedSymbolPriceSymbol(null);
      return;
    }
    setFocusedSymbolPriceSymbol((current) => {
      const normalized = normalizeSymbolGroupKey(current);
      if (normalized && focusedSymbolMembers.includes(normalized)) {
        return normalized;
      }
      if (focusedSymbolGroup && focusedSymbolGroup.defaultPriceSymbol) {
        return focusedSymbolGroup.defaultPriceSymbol;
      }
      return focusedSymbolMembers[0];
    });
  }, [focusedSymbolMembers, focusedSymbolGroup]);
  const normalizedFocusedPriceSymbol = focusedSymbolPriceSymbol
    ? normalizeSymbolGroupKey(focusedSymbolPriceSymbol)
    : null;

  // (moved) Resolve missing symbol description later, once data is available
  const [totalPnlRange, setTotalPnlRange] = useState('all');
  const [totalPnlSelectionRange, setTotalPnlSelectionRange] = useState(null);
  const lastAccountForRange = useRef(null);
  const lastCagrStartDate = useRef(null);
  const { loading, data, error } = useSummaryData(activeAccountId, refreshKey);
  const demoModeFromServer = Boolean(data?.demoMode);
  const demoModeSource =
    typeof data?.demoModeSource === 'string' ? data.demoModeSource.trim() : null;
  const demoModeActive = demoModeEnabled || (demoModeFromServer && demoModeSource === 'env');
  const earningsEnabled = data?.featureFlags?.unbilledEarnings?.enabled === true;

  useEffect(() => {
    if (demoModeSource === 'env' && demoModeFromServer && !demoModeEnabled) {
      setDemoModeEnabled(true);
    }
  }, [demoModeFromServer, demoModeSource, demoModeEnabled, setDemoModeEnabled]);

  const refreshEarnings = useCallback(
    (options = {}) => {
      const { isCancelled } = options;
      if (!earningsEnabled) {
        setEarningsState({ status: 'idle', data: null, error: null });
        return Promise.resolve(null);
      }

      setEarningsState((prev) => {
        const nextStatus = prev.data ? 'refreshing' : 'loading';
        if (prev.status === nextStatus && prev.error === null) {
          return prev;
        }
        return { status: nextStatus, data: prev.data, error: null };
      });

      return getEarnings()
        .then((payload) => {
          if (typeof isCancelled === 'function' && isCancelled()) {
            return null;
          }
          if (!payload || payload.enabled !== true) {
            setEarningsState({ status: 'idle', data: null, error: null });
            return null;
          }
          setEarningsState({ status: 'ready', data: payload, error: null });
          return payload;
        })
        .catch((err) => {
          if (typeof isCancelled === 'function' && isCancelled()) {
            return null;
          }
          const normalizedError = err instanceof Error ? err : new Error('Failed to load earnings data');
          setEarningsState({ status: 'error', data: null, error: normalizedError });
          return null;
        });
    },
    [earningsEnabled, getEarnings]
  );

  useEffect(() => {
    let cancelled = false;
    refreshEarnings({ isCancelled: () => cancelled });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, refreshEarnings]);
  const refreshLoginSetup = useCallback(async () => {
    setLoginSetupState((prev) => ({
      status: 'loading',
      logins: prev.logins || [],
      error: null,
      updatedAt: prev.updatedAt || null,
    }));
    try {
      const payload = await getLogins();
      const logins = Array.isArray(payload?.logins) ? payload.logins : [];
      setLoginSetupState({
        status: 'ready',
        logins,
        error: null,
        updatedAt: payload?.updatedAt || null,
      });
      return { logins, updatedAt: payload?.updatedAt || null };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load logins';
      setLoginSetupState((prev) => ({
        status: 'error',
        logins: prev.logins || [],
        error: message,
        updatedAt: prev.updatedAt || null,
      }));
      return null;
    }
  }, []);

  useEffect(() => {
    refreshLoginSetup();
  }, [refreshLoginSetup]);

  useEffect(() => {
    if (demoModeActive) {
      return;
    }
    if (loginSetupState.status !== 'ready') {
      return;
    }
    if (!loginSetupPrompted && loginSetupState.logins.length === 0) {
      setShowLoginSetupDialog(true);
      setLoginSetupPrompted(true);
    }
  }, [demoModeActive, loginSetupPrompted, loginSetupState]);

  useEffect(() => {
    if (!demoModeActive || !showLoginSetupDialog) {
      return;
    }
    setShowLoginSetupDialog(false);
  }, [demoModeActive, showLoginSetupDialog]);

  const handleOpenLoginSetupDialog = useCallback(() => {
    setShowLoginSetupDialog(true);
    setLoginSetupPrompted(true);
  }, []);

  const handleCloseLoginSetupDialog = useCallback(() => {
    setShowLoginSetupDialog(false);
    if (loginSetupNeedsRefresh) {
      setRefreshKey((value) => value + 1);
      setLoginSetupNeedsRefresh(false);
    }
  }, [loginSetupNeedsRefresh]);

  const handleStartDemoMode = useCallback(() => {
    setDemoModeEnabled(true);
    persistDemoModePreference(true);
    setShowLoginSetupDialog(false);
    setLoginSetupPrompted(true);
    setRefreshKey((value) => value + 1);
  }, [setDemoModeEnabled]);

  const handleExitDemoMode = useCallback(() => {
    setDemoModeEnabled(false);
    persistDemoModePreference(false);
    setLoginSetupPrompted(false);
    setShowLoginSetupDialog(false);
    refreshLoginSetup();
    setRefreshKey((value) => value + 1);
  }, [refreshLoginSetup, setDemoModeEnabled]);

  const handleShowRefreshTokenHelpDialog = useCallback(() => {
    setShowRefreshTokenHelpDialog(true);
  }, []);

  const handleCloseRefreshTokenHelpDialog = useCallback(() => {
    setShowRefreshTokenHelpDialog(false);
  }, []);

  const loadAccountStructureData = useCallback(async () => {
    setAccountStructureState((prev) => ({
      status: 'loading',
      entries: prev.entries || [],
      error: null,
    }));
    setAccountStructureContext((prev) => ({
      status: 'loading',
      accounts: prev.accounts || [],
      accountGroups: prev.accountGroups || [],
      groupRelations: prev.groupRelations || {},
      error: null,
    }));
    try {
      const [overridePayload, accountPayload] = await Promise.all([
        getAccountOverrides(),
        getAccounts(),
      ]);
      const entries = Array.isArray(overridePayload?.entries) ? overridePayload.entries : [];
      const accounts = Array.isArray(accountPayload?.accounts) ? accountPayload.accounts : [];
      const accountGroups = Array.isArray(accountPayload?.accountGroups) ? accountPayload.accountGroups : [];
      const groupRelations = accountPayload?.groupRelations && typeof accountPayload.groupRelations === 'object'
        ? accountPayload.groupRelations
        : {};
      setAccountStructureState({ status: 'ready', entries, error: null });
      setAccountStructureContext({ status: 'ready', accounts, accountGroups, groupRelations, error: null });
      return { entries, accounts, accountGroups, groupRelations };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load account structure data';
      setAccountStructureState((prev) => ({
        status: 'error',
        entries: prev.entries || [],
        error: message,
      }));
      setAccountStructureContext((prev) => ({
        status: 'error',
        accounts: prev.accounts || [],
        accountGroups: prev.accountGroups || [],
        groupRelations: prev.groupRelations || {},
        error: message,
      }));
      return null;
    }
  }, []);

  const handleOpenAccountStructureDialog = useCallback(() => {
    setShowAccountStructureDialog(true);
    loadAccountStructureData();
  }, [loadAccountStructureData]);

  const handleSaveLogin = useCallback(
    async ({ email, refreshToken }) => {
      await addLogin({ email, refreshToken });
      await refreshLoginSetup();
      setLoginSetupNeedsRefresh(true);
    },
    [refreshLoginSetup]
  );

  const handleSaveAccountStructure = useCallback(
    async (entries) => {
      await setAccountOverrides(entries);
      await loadAccountStructureData();
      setAccountStructureNeedsRefresh(true);
      accountStructureNeedsRefreshRef.current = true;
    },
    [loadAccountStructureData]
  );

  const triggerRefreshNotice = useCallback((message) => {
    setRefreshKey((value) => {
      const nextKey = value + 1;
      setRefreshNotice({
        open: true,
        targetKey: nextKey,
        started: false,
        message: message || 'Refreshing data...',
      });
      return nextKey;
    });
  }, []);

  const handleReconnectLogin = useCallback(
    async ({ email, refreshToken }) => {
      await addLogin({ email, refreshToken });
      await refreshLoginSetup();
      setShowLoginSetupDialog(false);
      setLoginSetupNeedsRefresh(false);
      triggerRefreshNotice('Refreshing account data...');
    },
    [refreshLoginSetup, triggerRefreshNotice]
  );

  const handleCloseAccountStructureDialog = useCallback(() => {
    setShowAccountStructureDialog(false);
    const shouldRefresh = loginSetupNeedsRefresh || accountStructureNeedsRefresh || accountStructureNeedsRefreshRef.current;
    if (shouldRefresh) {
      triggerRefreshNotice('Refreshing account data...');
      setLoginSetupNeedsRefresh(false);
      setAccountStructureNeedsRefresh(false);
      accountStructureNeedsRefreshRef.current = false;
    }
  }, [loginSetupNeedsRefresh, accountStructureNeedsRefresh, triggerRefreshNotice]);

  const handleStartAccountStructureFromLogin = useCallback(() => {
    setShowLoginSetupDialog(false);
    setShowAccountStructureDialog(true);
    loadAccountStructureData();
  }, [loadAccountStructureData]);

  useEffect(() => {
    setSymbolPriceSnapshots(new Map());
    setPriceRefreshState({ status: 'idle', error: null, refreshedAt: null });
  }, [data]);
  const priceRefreshInFlight = priceRefreshState.status === 'loading';

  useEffect(() => {
    if (!refreshNotice.open || refreshNotice.targetKey !== refreshKey) {
      return;
    }
    if (!refreshNotice.started && loading) {
      setRefreshNotice((prev) => (prev.open ? { ...prev, started: true } : prev));
      return;
    }
    if (refreshNotice.started && !loading) {
      setRefreshNotice({ open: false, targetKey: null, started: false, message: '' });
    }
  }, [refreshNotice.open, refreshNotice.started, refreshNotice.targetKey, refreshKey, loading]);

  useEffect(() => {
    if (!pendingMetadataOverrides.size) {
      return;
    }
    setPendingMetadataOverrides(new Map());
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const rawAccounts = useMemo(() => data?.accounts ?? [], [data?.accounts]);
  const accounts = useMemo(() => {
    if (!pendingMetadataOverrides.size) {
      return rawAccounts;
    }
    return rawAccounts.map((account) => {
      if (!account || typeof account !== 'object') {
        return account;
      }
      const key = resolveAccountMetadataKey(account);
      if (!key) {
        return account;
      }
      const override = pendingMetadataOverrides.get(String(key));
      if (!override) {
        return account;
      }
      return { ...account, ...override };
    });
  }, [rawAccounts, pendingMetadataOverrides]);
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

        const normalizedRetirementAge =
          Number.isFinite(group.retirementAge) && group.retirementAge > 0
            ? Math.round(group.retirementAge)
            : null;
        const normalizedRetirementIncome =
          Number.isFinite(group.retirementIncome) && group.retirementIncome >= 0
            ? Math.round(group.retirementIncome * 100) / 100
            : null;
        const normalizedRetirementLivingExpenses =
          Number.isFinite(group.retirementLivingExpenses) && group.retirementLivingExpenses >= 0
            ? Math.round(group.retirementLivingExpenses * 100) / 100
            : null;
        const normalizedRetirementBirthDate =
          typeof group.retirementBirthDate === 'string' && group.retirementBirthDate.trim()
            ? group.retirementBirthDate.trim()
            : null;
        const normalizedRetirementYear =
          Number.isFinite(group.retirementYear) ? Math.round(group.retirementYear) : null;
        const normalizedHouseholdType =
          typeof group.retirementHouseholdType === 'string' && group.retirementHouseholdType.trim()
            ? group.retirementHouseholdType.trim()
            : null;
        const normalizedBirthDate1 =
          typeof group.retirementBirthDate1 === 'string' && group.retirementBirthDate1.trim()
            ? group.retirementBirthDate1.trim()
            : null;
        const normalizedBirthDate2 =
          typeof group.retirementBirthDate2 === 'string' && group.retirementBirthDate2.trim()
            ? group.retirementBirthDate2.trim()
            : null;
        const n = (v) => (Number.isFinite(v) ? v : null);

        return {
          id,
          name,
          memberCount: memberCount !== null ? memberCount : accountIds.length,
          accountIds,
          accountNumbers,
          ownerLabels,
          mainRetirementAccount: group.mainRetirementAccount === true,
          retirementAge: normalizedRetirementAge,
          retirementYear: normalizedRetirementYear,
          retirementIncome: normalizedRetirementIncome,
          retirementLivingExpenses: normalizedRetirementLivingExpenses,
          retirementBirthDate: normalizedRetirementBirthDate,
          retirementHouseholdType: normalizedHouseholdType,
          retirementBirthDate1: normalizedBirthDate1,
          retirementBirthDate2: normalizedBirthDate2,
          retirementCppYearsContributed1: n(group.retirementCppYearsContributed1),
          retirementCppAvgEarningsPctOfYMPE1: n(group.retirementCppAvgEarningsPctOfYMPE1),
          retirementOasYearsResident1: n(group.retirementOasYearsResident1),
          retirementCppYearsContributed2: n(group.retirementCppYearsContributed2),
          retirementCppAvgEarningsPctOfYMPE2: n(group.retirementCppAvgEarningsPctOfYMPE2),
          retirementOasYearsResident2: n(group.retirementOasYearsResident2),
          retirementCppMaxAt65Annual: n(group.retirementCppMaxAt65Annual),
          retirementOasFullAt65Annual: n(group.retirementOasFullAt65Annual),
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
  const accountGroupParentsMap = useMemo(() => {
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
        let set = map.get(childKey);
        if (!set) {
          set = new Set();
          map.set(childKey, set);
        }
        set.add(parentKey);
      });
    });
    return map;
  }, [groupRelations]);
  const accountGroupNamesByKey = useMemo(() => {
    const map = new Map();
    accountGroups.forEach((group) => {
      const key = normalizeAccountGroupKey(group?.name);
      if (!key) {
        return;
      }
      const displayName = typeof group.name === 'string' ? group.name.trim() : '';
      if (displayName) {
        map.set(key, displayName);
      }
    });
    Object.keys(groupRelations).forEach((name) => {
      const key = normalizeAccountGroupKey(name);
      if (!key || map.has(key)) {
        return;
      }
      const displayName = typeof name === 'string' ? name.trim() : '';
      if (displayName) {
        map.set(key, displayName);
      }
    });
    return map;
  }, [accountGroups, groupRelations]);
  const accountGroupsByNormalizedName = useMemo(() => {
    const map = new Map();
    accountGroups.forEach((group) => {
      const key = normalizeAccountGroupKey(group?.name);
      if (!key) {
        return;
      }
      if (!map.has(key)) {
        map.set(key, group);
      }
    });
    return map;
  }, [accountGroups]);
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
  const accountsByNumber = useMemo(() => {
    const map = new Map();
    accounts.forEach((account) => {
      if (!account) {
        return;
      }
      const normalized =
        account.number !== undefined && account.number !== null
          ? String(account.number).trim()
          : '';
      if (!normalized) {
        return;
      }
      if (!map.has(normalized)) {
        map.set(normalized, account);
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

  const canEditAccountDetails =
    Boolean(selectedAccountInfo) ||
    (isAccountGroupSelection(selectedAccount) && Boolean(selectedAccountGroup));
  const selectedRetirementSettings = useMemo(() => {
    const normalizeMoneyValue = (value) => {
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    };
    const buildSettings = (source) => {
      if (!source || source.mainRetirementAccount !== true) {
        return null;
      }
      const age = (function () {
        const explicit = normalizePositiveInteger(source.retirementAge);
        if (explicit) return explicit;
        const ry = normalizePositiveInteger(source.retirementYear);
        const bd1 = (typeof source.retirementBirthDate1 === 'string' && source.retirementBirthDate1)
          ? new Date(`${source.retirementBirthDate1}T00:00:00Z`)
          : (typeof source.retirementBirthDate === 'string' && source.retirementBirthDate ? new Date(`${source.retirementBirthDate}T00:00:00Z`) : null);
        if (ry && bd1 && !Number.isNaN(bd1.getTime())) {
          return Math.max(0, ry - bd1.getUTCFullYear());
        }
        return null;
      })();
      const inflNum = Number(source.retirementInflationPercent);
      const inflationPercent = Number.isFinite(inflNum) && inflNum >= 0 ? Math.round(inflNum * 100) / 100 : null;
      return {
        mainRetirementAccount: true,
        retirementAge: age,
        retirementIncome: normalizeMoneyValue(source.retirementIncome),
        retirementLivingExpenses: normalizeMoneyValue(source.retirementLivingExpenses),
        retirementBirthDate:
          typeof source.retirementBirthDate === 'string' && source.retirementBirthDate
            ? source.retirementBirthDate
            : null,
        retirementInflationPercent: inflationPercent,
        retirementYear: normalizePositiveInteger(source.retirementYear),
        retirementBirthDate1:
          typeof source.retirementBirthDate1 === 'string' && source.retirementBirthDate1
            ? source.retirementBirthDate1
            : (typeof source.retirementBirthDate === 'string' && source.retirementBirthDate ? source.retirementBirthDate : null),
        retirementHouseholdType:
          typeof source.retirementHouseholdType === 'string' && source.retirementHouseholdType
            ? source.retirementHouseholdType
            : 'single',
        retirementBirthDate2:
          typeof source.retirementBirthDate2 === 'string' && source.retirementBirthDate2
            ? source.retirementBirthDate2
            : null,
        retirementCppYearsContributed1: normalizePositiveInteger(source.retirementCppYearsContributed1),
        retirementCppAvgEarningsPctOfYMPE1: (function () {
          const n = Number(source.retirementCppAvgEarningsPctOfYMPE1);
          return Number.isFinite(n) ? n : null;
        })(),
        retirementCppStartAge1: normalizePositiveInteger(source.retirementCppStartAge1),
        retirementOasYearsResident1: normalizePositiveInteger(source.retirementOasYearsResident1),
        retirementOasStartAge1: normalizePositiveInteger(source.retirementOasStartAge1),
        retirementCppYearsContributed2: normalizePositiveInteger(source.retirementCppYearsContributed2),
        retirementCppAvgEarningsPctOfYMPE2: (function () {
          const n = Number(source.retirementCppAvgEarningsPctOfYMPE2);
          return Number.isFinite(n) ? n : null;
        })(),
        retirementCppStartAge2: normalizePositiveInteger(source.retirementCppStartAge2),
        retirementOasYearsResident2: normalizePositiveInteger(source.retirementOasYearsResident2),
        retirementOasStartAge2: normalizePositiveInteger(source.retirementOasStartAge2),
        retirementCppMaxAt65Annual: normalizePositiveInteger(source.retirementCppMaxAt65Annual),
        retirementOasFullAt65Annual: normalizePositiveInteger(source.retirementOasFullAt65Annual),
      };
    };
    const resolved = buildSettings(selectedAccountInfo) || buildSettings(selectedAccountGroup);
    if (resolved) return resolved;
    return {
      mainRetirementAccount: false,
      retirementAge: null,
      retirementIncome: null,
      retirementLivingExpenses: null,
      retirementBirthDate: null,
      retirementInflationPercent: null,
    };
  }, [selectedAccountInfo, selectedAccountGroup]);

  const focusedSymbolDividendsCad = useMemo(() => {
    if (!focusedSymbol) {
      return 0;
    }
    const dividendsMap = data?.accountDividends;
    if (!dividendsMap || typeof dividendsMap !== 'object') {
      return 0;
    }
    const collectAccountIds = () => {
      if (isAggregateSelection) {
        if (filteredAccountIds.length) {
          return filteredAccountIds;
        }
        return Object.keys(dividendsMap);
      }
      if (selectedAccountInfo?.id) {
        return [selectedAccountInfo.id];
      }
      return [];
    };
    const accountIds = collectAccountIds();
    if (!accountIds.length) {
      return 0;
    }
    const matchesEntry = (entry) => {
      if (!entry) return false;
      if (matchesFocusedSymbol(entry.symbol)) {
        return true;
      }
      if (Array.isArray(entry.rawSymbols)) {
        return entry.rawSymbols.some((sym) => matchesFocusedSymbol(sym));
      }
      return false;
    };
    let total = 0;
    accountIds.forEach((accountId) => {
      const payload = dividendsMap[accountId];
      if (!payload || typeof payload !== 'object') {
        return;
      }
      const entries = Array.isArray(payload.entries) ? payload.entries : [];
      entries.forEach((entry) => {
        if (!matchesEntry(entry)) {
          return;
        }
        const cadAmount = Number(entry?.cadAmount);
        if (Number.isFinite(cadAmount)) {
          total += cadAmount;
        }
      });
    });
    return total;
  }, [
    focusedSymbol,
    data?.accountDividends,
    isAggregateSelection,
    filteredAccountIds,
    selectedAccountInfo?.id,
    matchesFocusedSymbol,
  ]);

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
    const fallback = typeof stored === 'string' ? stored : '';
    const contextOverrides =
      accountPlanningContexts && typeof accountPlanningContexts === 'object'
        ? accountPlanningContexts
        : EMPTY_OBJECT;
    const keys = [
      selectedAccount ? String(selectedAccount) : null,
      selectedAccountInfo?.id != null ? String(selectedAccountInfo.id) : null,
      selectedAccountInfo?.number != null ? String(selectedAccountInfo.number) : null,
    ].filter(Boolean);
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(contextOverrides, key)) {
        const value = contextOverrides[key];
        return typeof value === 'string' ? value : fallback;
      }
    }
    return fallback;
  }, [accountPlanningContexts, isAggregateSelection, selectedAccount, selectedAccountInfo]);

  // (Note: Selected retirement settings already include inflation above.)

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

  const handleGoToAccountFromSymbol = useCallback(
    (position, account) => {
      let targetAccountId = null;

      if (account && account.id !== null && account.id !== undefined) {
        targetAccountId = String(account.id);
      }

      if (
        !targetAccountId &&
        position &&
        position.accountId !== null &&
        position.accountId !== undefined &&
        accountsById &&
        typeof accountsById.has === 'function'
      ) {
        const candidateId = String(position.accountId);
        if (candidateId && accountsById.has(candidateId)) {
          targetAccountId = candidateId;
        }
      }

      if (
        !targetAccountId &&
        position &&
        position.accountNumber !== null &&
        position.accountNumber !== undefined
      ) {
        const normalizedNumber = String(position.accountNumber).trim();
        if (normalizedNumber && accountsById && typeof accountsById.values === 'function') {
          for (const entry of accountsById.values()) {
            if (!entry) {
              continue;
            }
            const entryNumber =
              entry.number !== null && entry.number !== undefined
                ? String(entry.number).trim()
                : '';
            if (entryNumber && entryNumber === normalizedNumber && entry.id !== null && entry.id !== undefined) {
              targetAccountId = String(entry.id);
              break;
            }
          }
        }
      }

      if (!targetAccountId) {
        return;
      }

      handleAccountChange(targetAccountId);
      clearFocusedSymbol();
      setOrdersFilter('');
      setPortfolioViewTab('positions');
    },
    [
      accountsById,
      handleAccountChange,
      clearFocusedSymbol,
      setOrdersFilter,
      setPortfolioViewTab,
    ]
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

  const symbolGroupAnnualizedSymbols = useMemo(() => {
    if (!focusedSymbolMembers.length) {
      return [];
    }
    const seen = new Set();
    focusedSymbolMembers.forEach((symbol) => {
      const normalized = normalizeSymbolGroupKey(symbol);
      if (normalized) {
        seen.add(normalized);
      }
    });
    return Array.from(seen);
  }, [focusedSymbolMembers]);

  const symbolGroupAnnualizedKey = useMemo(() => {
    if (!focusedSymbol || symbolGroupAnnualizedSymbols.length < 2) {
      return null;
    }
    const accountKey = selectedAccountKey || 'all';
    return `${accountKey}::${symbolGroupAnnualizedSymbols.join(',')}::${refreshKey}`;
  }, [focusedSymbol, selectedAccountKey, symbolGroupAnnualizedSymbols, refreshKey]);

  useEffect(() => {
    if (!symbolGroupAnnualizedKey) {
      setSymbolGroupAnnualizedState((prev) =>
        prev.status === 'idle' && prev.key === null
          ? prev
          : { status: 'idle', data: null, error: null, key: null }
      );
      return;
    }
    let cancelled = false;
    setSymbolGroupAnnualizedState((prev) => ({
      status: 'loading',
      data: prev.key === symbolGroupAnnualizedKey ? prev.data : null,
      error: null,
      key: symbolGroupAnnualizedKey,
    }));
    const accountKey = selectedAccountKey || 'all';
    getSymbolAnnualized({ accountId: accountKey, symbols: symbolGroupAnnualizedSymbols })
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setSymbolGroupAnnualizedState({
          status: 'success',
          data: payload,
          error: null,
          key: symbolGroupAnnualizedKey,
        });
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        const normalized = err instanceof Error ? err : new Error('Failed to load symbol annualized return');
        setSymbolGroupAnnualizedState({
          status: 'error',
          data: null,
          error: normalized,
          key: symbolGroupAnnualizedKey,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [symbolGroupAnnualizedKey, selectedAccountKey, symbolGroupAnnualizedSymbols]);

  useEffect(() => {
    if (!selectedRebalanceReminder) {
      return;
    }
    if (isAggregateSelection) {
      setSelectedRebalanceReminder(null);
      return;
    }
    if (!selectedAccountInfo) {
      if (loading) {
        return;
      }
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
  }, [isAggregateSelection, loading, selectedAccountInfo, selectedRebalanceReminder, setSelectedRebalanceReminder]);

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
  const basePositions = useMemo(() => data?.positions ?? [], [data?.positions]);
  const rawPositions = useMemo(
    () => applyPriceSnapshotsToPositions(basePositions, symbolPriceSnapshots),
    [basePositions, symbolPriceSnapshots]
  );
  const rawOrders = useMemo(() => (Array.isArray(data?.orders) ? data.orders : []), [data?.orders]);
  const ordersFilterInputId = useId();
  const dividendTimeframeSelectId = useId();
  const normalizedDividendTimeframe = useMemo(() => {
    if (DIVIDEND_TIMEFRAME_OPTIONS.some((option) => option.value === dividendTimeframe)) {
      return dividendTimeframe;
    }
    return DEFAULT_DIVIDEND_TIMEFRAME;
  }, [dividendTimeframe]);
  const baseBalances = data?.balances || null;
  const normalizedOrdersFilter = typeof ordersFilter === 'string' ? ordersFilter.trim() : '';
  const ordersFilterQuery = normalizedOrdersFilter.toLowerCase();
  const parsedOrdersFilterTokens = useMemo(() => {
    if (!ordersFilterQuery) {
      return null;
    }
    if (!/\b(?:and|or)\b/i.test(ordersFilterQuery)) {
      return null;
    }
    const parts = ordersFilterQuery
      .split(/\s*\b(and|or)\b\s*/i)
      .map((part) => part.trim())
      .filter(Boolean);
    if (!parts.length) {
      return null;
    }
    const tokens = parts.map((part) => {
      if (/^and$/i.test(part)) {
        return { type: 'and' };
      }
      if (/^or$/i.test(part)) {
        return { type: 'or' };
      }
      return { type: 'term', value: part.toLowerCase() };
    });
    const hasTerm = tokens.some((token) => token.type === 'term' && token.value);
    return hasTerm ? tokens : null;
  }, [ordersFilterQuery]);
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
      const searchable = fields
        .map((value) => {
          if (value === null || value === undefined) {
            return null;
          }
          return String(value).toLowerCase();
        })
        .filter(Boolean);
      const matchesTerm = (term) => {
        if (!term) {
          return false;
        }
        return searchable.some((value) => value.includes(term));
      };
      if (parsedOrdersFilterTokens && parsedOrdersFilterTokens.length) {
        let result = null;
        let op = 'and';
        parsedOrdersFilterTokens.forEach((token) => {
          if (token.type === 'term') {
            const termMatch = matchesTerm(token.value);
            if (result === null) {
              result = termMatch;
            } else if (op === 'or') {
              result = result || termMatch;
            } else {
              result = result && termMatch;
            }
            op = 'and'; // default to AND between implicit terms
          } else if (token.type === 'or') {
            op = 'or';
          } else if (token.type === 'and') {
            op = 'and';
          }
        });
        if (result !== null) {
          return result;
        }
      }
      return matchesTerm(ordersFilterQuery);
    });
  }, [ordersForSelectedAccount, ordersFilterQuery, parsedOrdersFilterTokens]);
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
  const accountNorbertJournalSource = data?.accountNorbertJournals;
  const accountNorbertJournals = useMemo(
    () =>
      accountNorbertJournalSource && typeof accountNorbertJournalSource === 'object'
        ? accountNorbertJournalSource
        : EMPTY_OBJECT,
    [accountNorbertJournalSource]
  );
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

    // Prefer composing group funding from per-account series summaries when available
    const seriesMap = data?.accountTotalPnlSeries && typeof data.accountTotalPnlSeries === 'object'
      ? data.accountTotalPnlSeries
      : null;
    if (seriesMap) {
      let combinedNetDeposits = 0;
      let combinedNetDepositsCount = 0;
      let combinedTotalPnlSinceDisplay = 0;
      let combinedTotalPnlSinceDisplayCount = 0;
      let combinedEquitySinceDisplay = 0;
      let combinedEquitySinceDisplayCount = 0;

      let allTimeNetDeposits = 0;
      let allTimeNetDepositsCount = 0;
      let allTimeTotalPnl = 0;
      let allTimeTotalPnlCount = 0;
      let allTimeEquity = 0;
      let allTimeEquityCount = 0;

      let earliestAllStart = null;
      let latestAllEnd = null;

      memberAccountIds.forEach((id) => {
        const key = id === undefined || id === null ? '' : String(id).trim();
        if (!key) return;
        const container = seriesMap[key] && typeof seriesMap[key] === 'object' ? seriesMap[key] : null;
        const cagr = container && container.cagr ? container.cagr : null;
        const allSeries = container && container.all ? container.all : null;
        const cagrSummary = cagr && typeof cagr.summary === 'object' ? cagr.summary : null;
        const allSummary = allSeries && typeof allSeries.summary === 'object' ? allSeries.summary : null;
        if (allSeries && typeof allSeries.periodStartDate === 'string') {
          const s = allSeries.periodStartDate.trim();
          if (s && (!earliestAllStart || s < earliestAllStart)) earliestAllStart = s;
        }
        if (allSeries && typeof allSeries.periodEndDate === 'string') {
          const e = allSeries.periodEndDate.trim();
          if (e && (!latestAllEnd || e > latestAllEnd)) latestAllEnd = e;
        }
        if (cagrSummary) {
          if (isFiniteNumber(cagrSummary.netDepositsCad)) { combinedNetDeposits += cagrSummary.netDepositsCad; combinedNetDepositsCount++; }
          if (isFiniteNumber(cagrSummary.totalPnlSinceDisplayStartCad)) { combinedTotalPnlSinceDisplay += cagrSummary.totalPnlSinceDisplayStartCad; combinedTotalPnlSinceDisplayCount++; }
          if (isFiniteNumber(cagrSummary.totalEquitySinceDisplayStartCad)) { combinedEquitySinceDisplay += cagrSummary.totalEquitySinceDisplayStartCad; combinedEquitySinceDisplayCount++; }
        }
        if (allSummary) {
          if (isFiniteNumber(allSummary.netDepositsAllTimeCad)) { allTimeNetDeposits += allSummary.netDepositsAllTimeCad; allTimeNetDepositsCount++; }
          if (isFiniteNumber(allSummary.totalPnlAllTimeCad)) { allTimeTotalPnl += allSummary.totalPnlAllTimeCad; allTimeTotalPnlCount++; }
          if (isFiniteNumber(allSummary.totalEquityCad)) { allTimeEquity += allSummary.totalEquityCad; allTimeEquityCount++; }
        }
      });

      const result = {};
      const netDeposits = {};
      if (combinedNetDepositsCount > 0) netDeposits.combinedCad = combinedNetDeposits;
      if (allTimeNetDepositsCount > 0) netDeposits.allTimeCad = allTimeNetDeposits;
      if (Object.keys(netDeposits).length) result.netDeposits = netDeposits;

      if (combinedTotalPnlSinceDisplayCount > 0) result.totalPnlSinceDisplayStartCad = combinedTotalPnlSinceDisplay;
      const totalPnl = {};
      if (combinedTotalPnlSinceDisplayCount > 0) totalPnl.combinedCad = combinedTotalPnlSinceDisplay;
      if (allTimeTotalPnlCount > 0) totalPnl.allTimeCad = allTimeTotalPnl;
      if (Object.keys(totalPnl).length) result.totalPnl = totalPnl;

      if (combinedEquitySinceDisplayCount > 0) result.totalEquitySinceDisplayStartCad = combinedEquitySinceDisplay;
      if (allTimeEquityCount > 0) result.totalEquityCad = allTimeEquity;

      if (earliestAllStart) result.periodStartDate = earliestAllStart;
      if (latestAllEnd) result.periodEndDate = latestAllEnd;

      if (Object.keys(result).length) {
        // Preserve server-computed annualized details when available
        if (directEntry && typeof directEntry === 'object') {
          if (directEntry.annualizedReturn) result.annualizedReturn = directEntry.annualizedReturn;
          if (directEntry.annualizedReturnAllTime) result.annualizedReturnAllTime = directEntry.annualizedReturnAllTime;
        }
        return result;
      }
    }

    if (directEntry && typeof directEntry === 'object') {
      return directEntry;
    }

    let netDepositsTotal = 0;
    let netDepositsCount = 0;
    let netDepositsAllTimeTotal = 0;
    let netDepositsAllTimeCount = 0;
    let totalPnlTotal = 0;
    let totalPnlCount = 0;
    let totalPnlAllTimeTotal = 0;
    let totalPnlAllTimeCount = 0;
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
      const netDepositsAllTimeCad = entry?.netDeposits?.allTimeCad;
      if (isFiniteNumber(netDepositsAllTimeCad)) {
        netDepositsAllTimeTotal += netDepositsAllTimeCad;
        netDepositsAllTimeCount += 1;
      }
      const totalPnlCad = entry?.totalPnl?.combinedCad;
      if (isFiniteNumber(totalPnlCad)) {
        totalPnlTotal += totalPnlCad;
        totalPnlCount += 1;
      }
      const totalPnlAllTimeCad = entry?.totalPnl?.allTimeCad;
      if (isFiniteNumber(totalPnlAllTimeCad)) {
        totalPnlAllTimeTotal += totalPnlAllTimeCad;
        totalPnlAllTimeCount += 1;
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
    if (netDepositsCount > 0 || netDepositsAllTimeCount > 0) {
      aggregate.netDeposits = {};
      if (netDepositsCount > 0) aggregate.netDeposits.combinedCad = netDepositsTotal;
      if (netDepositsAllTimeCount > 0) aggregate.netDeposits.allTimeCad = netDepositsAllTimeTotal;
    }
    if (totalPnlCount > 0 || totalPnlAllTimeCount > 0) {
      aggregate.totalPnl = {};
      if (totalPnlCount > 0) aggregate.totalPnl.combinedCad = totalPnlTotal;
      if (totalPnlAllTimeCount > 0) aggregate.totalPnl.allTimeCad = totalPnlAllTimeTotal;
    } else if ((netDepositsCount > 0 || netDepositsAllTimeCount > 0) && totalEquityCount > 0) {
      const derivedCombined = netDepositsCount > 0 ? totalEquityTotal - netDepositsTotal : null;
      const derivedAllTime = netDepositsAllTimeCount > 0 ? totalEquityTotal - netDepositsAllTimeTotal : null;
      if (isFiniteNumber(derivedCombined) || isFiniteNumber(derivedAllTime)) {
        aggregate.totalPnl = {};
        if (isFiniteNumber(derivedCombined)) aggregate.totalPnl.combinedCad = derivedCombined;
        if (isFiniteNumber(derivedAllTime)) aggregate.totalPnl.allTimeCad = derivedAllTime;
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
    matchesFocusedSymbol,
  ]);
  const hasDividendSummary = Boolean(selectedAccountDividends);
  const selectedAccountDividendsForView = useMemo(() => {
    if (!focusedSymbol) return selectedAccountDividends;
    if (!selectedAccountDividends || typeof selectedAccountDividends !== 'object') return selectedAccountDividends;
    const entries = Array.isArray(selectedAccountDividends.entries) ? selectedAccountDividends.entries : [];
    const matched = entries.filter((e) => {
      if (!e) {
        return false;
      }
      if (matchesFocusedSymbol(e.symbol) || matchesFocusedSymbol(e.displaySymbol)) {
        return true;
      }
      if (Array.isArray(e.rawSymbols)) {
        return e.rawSymbols.some((sym) => matchesFocusedSymbol(sym));
      }
      return false;
    });
    if (!matched.length) {
      return {
        ...selectedAccountDividends,
        entries: [],
        totalsByCurrency: {},
        totalCad: 0,
        totalCount: 0,
        conversionIncomplete: false,
      };
    }
    const normalizeCurrencyKey = (value) =>
      typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : '';
    const shouldExpandLineItems = matched.some(
      (entry) => Array.isArray(entry?.lineItems) && entry.lineItems.length > 0
    );
    if (!shouldExpandLineItems) {
      const totalsByCurrency = {};
      let totalCad = 0;
      let totalCount = 0;
      let startDate = null;
      let endDate = null;
      matched.forEach((e) => {
        if (e?.currencyTotals && typeof e.currencyTotals === 'object') {
          Object.entries(e.currencyTotals).forEach(([cur, val]) => {
            const n = Number(val);
            if (!Number.isFinite(n)) return;
            const key = normalizeCurrencyKey(cur);
            totalsByCurrency[key] = (totalsByCurrency[key] || 0) + n;
          });
        }
        if (Number.isFinite(e?.cadAmount)) totalCad += e.cadAmount;
        if (Number.isFinite(e?.activityCount)) totalCount += Math.round(e.activityCount);
        const s = e?.firstDate || e?.startDate || null;
        const en = e?.lastDate || e?.endDate || null;
        if (s && (!startDate || s < startDate)) startDate = s;
        if (en && (!endDate || en > endDate)) endDate = en;
      });
      return {
        ...selectedAccountDividends,
        entries: matched,
        totalsByCurrency,
        totalCad,
        totalCount,
        startDate: startDate || selectedAccountDividends.startDate || null,
        endDate: endDate || selectedAccountDividends.endDate || null,
      };
    }

    const totalsByCurrency = {};
    let totalCad = 0;
    let totalCadHasValue = false;
    let totalCount = 0;
    let startDate = null;
    let endDate = null;
    let conversionIncomplete = false;
    const aggregatedByDate = new Map();
    const aggregatedWrappers = [];
    let aggregateInsertionIndex = 0;

    const mergeAggregatedEntry = (target, source) => {
      if (source?.currencyTotals && typeof source.currencyTotals === 'object') {
        if (!target.currencyTotals || typeof target.currencyTotals !== 'object') {
          target.currencyTotals = {};
        }
        Object.entries(source.currencyTotals).forEach(([cur, val]) => {
          const numeric = Number(val);
          if (!Number.isFinite(numeric)) {
            return;
          }
          const key = normalizeCurrencyKey(cur);
          const existing = Number(target.currencyTotals[key]);
          target.currencyTotals[key] = (Number.isFinite(existing) ? existing : 0) + numeric;
        });
      }

      if (Number.isFinite(source?.cadAmount)) {
        const existing = Number(target.cadAmount);
        const current = Number.isFinite(existing) ? existing : 0;
        target.cadAmount = current + source.cadAmount;
      }

      if (source?.conversionIncomplete) {
        target.conversionIncomplete = true;
      }

      const sourceCount = Number.isFinite(source?.activityCount) ? Math.round(source.activityCount) : 0;
      const targetCount = Number.isFinite(target.activityCount) ? Math.round(target.activityCount) : 0;
      target.activityCount = targetCount + sourceCount;

      const sourceFirstDate = source?.firstDate || source?.lastDate || null;
      const sourceLastDate = source?.lastDate || source?.firstDate || null;
      if (sourceFirstDate && (!target.firstDate || sourceFirstDate < target.firstDate)) {
        target.firstDate = sourceFirstDate;
      }
      if (sourceLastDate && (!target.lastDate || sourceLastDate > target.lastDate)) {
        target.lastDate = sourceLastDate;
      }

      const sourceTimestamp = source?.lastTimestamp || null;
      const targetTimestamp = target.lastTimestamp || null;
      if (sourceTimestamp && (!targetTimestamp || sourceTimestamp > targetTimestamp)) {
        target.lastTimestamp = sourceTimestamp;
        target.lastAmount = Number.isFinite(source?.lastAmount) ? source.lastAmount : target.lastAmount;
        target.lastCurrency = source?.lastCurrency || target.lastCurrency || null;
      } else if (!targetTimestamp && Number.isFinite(target.lastAmount) === false) {
        if (Number.isFinite(source?.lastAmount)) {
          target.lastAmount = source.lastAmount;
          target.lastCurrency = source?.lastCurrency || target.lastCurrency || null;
        }
      } else if (!Number.isFinite(target.lastAmount) && Number.isFinite(source?.lastAmount)) {
        target.lastAmount = source.lastAmount;
        target.lastCurrency = source?.lastCurrency || target.lastCurrency || null;
      }

      if (!target.description && source?.description) {
        target.description = source.description;
      }
      if (!target.displaySymbol && source?.displaySymbol) {
        target.displaySymbol = source.displaySymbol;
      }
      if (!target.symbol && source?.symbol) {
        target.symbol = source.symbol;
      }
      const targetRawSymbols = Array.isArray(target.rawSymbols) ? target.rawSymbols : null;
      const sourceRawSymbols = Array.isArray(source?.rawSymbols) ? source.rawSymbols : null;
      if ((!targetRawSymbols || !targetRawSymbols.length) && sourceRawSymbols && sourceRawSymbols.length) {
        target.rawSymbols = sourceRawSymbols;
      }

      if (source?.lineItemId) {
        if (!target.lineItemId) {
          target.lineItemId = source.lineItemId;
        } else if (target.lineItemId !== source.lineItemId) {
          const collectIds = (value) =>
            String(value)
              .split('|')
              .map((part) => part.trim())
              .filter(Boolean);
          const existingIds = new Set(collectIds(target.lineItemId));
          collectIds(source.lineItemId).forEach((id) => existingIds.add(id));
          target.lineItemId = Array.from(existingIds).join('|');
        }
      }
    };

    const resolveEntryGroupDate = (entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      if (typeof entry.lastDate === 'string' && entry.lastDate.trim()) {
        return entry.lastDate.trim();
      }
      if (typeof entry.firstDate === 'string' && entry.firstDate.trim()) {
        return entry.firstDate.trim();
      }
      if (typeof entry.lastTimestamp === 'string' && entry.lastTimestamp.trim()) {
        return entry.lastTimestamp.trim().slice(0, 10);
      }
      return null;
    };

    const appendAggregatedEntry = (entry) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }
      const groupDate = resolveEntryGroupDate(entry);
      if (groupDate) {
        let wrapper = aggregatedByDate.get(groupDate);
        if (!wrapper) {
          const aggregatedEntry = { ...entry };
          aggregatedEntry.lineItemId =
            aggregatedEntry.lineItemId || `${groupDate}-${aggregateInsertionIndex}`;
          wrapper = {
            entry: aggregatedEntry,
            sortDate: aggregatedEntry.lastDate || aggregatedEntry.firstDate || groupDate,
            sortTimestamp: aggregatedEntry.lastTimestamp || null,
            firstIndex: aggregateInsertionIndex,
          };
          aggregateInsertionIndex += 1;
          aggregatedByDate.set(groupDate, wrapper);
          aggregatedWrappers.push(wrapper);
        } else {
          mergeAggregatedEntry(wrapper.entry, entry);
          const entrySortDate = entry.lastDate || entry.firstDate || groupDate;
          if (entrySortDate && (!wrapper.sortDate || entrySortDate > wrapper.sortDate)) {
            wrapper.sortDate = entrySortDate;
          }
          const entryTimestamp = entry.lastTimestamp || null;
          if (entryTimestamp && (!wrapper.sortTimestamp || entryTimestamp > wrapper.sortTimestamp)) {
            wrapper.sortTimestamp = entryTimestamp;
          }
        }
      } else {
        const aggregatedEntry = { ...entry };
        aggregatedEntry.lineItemId =
          aggregatedEntry.lineItemId || `dividend-${aggregateInsertionIndex}`;
        aggregatedWrappers.push({
          entry: aggregatedEntry,
          sortDate: null,
          sortTimestamp: aggregatedEntry.lastTimestamp || null,
          firstIndex: aggregateInsertionIndex,
        });
        aggregateInsertionIndex += 1;
      }
    };

    matched.forEach((entry, entryIndex) => {
      const baseSymbol = (entry?.symbol || '').toString();
      const baseDisplay = (entry?.displaySymbol || baseSymbol || '').toString();
      const baseDescription = typeof entry?.description === 'string' ? entry.description : null;
      const baseRawSymbols = Array.isArray(entry?.rawSymbols)
        ? entry.rawSymbols
            .map((value) => (typeof value === 'string' ? value.trim() : ''))
            .filter(Boolean)
        : null;
      const lineItems = Array.isArray(entry?.lineItems) ? entry.lineItems : [];

      lineItems.forEach((item, itemIndex) => {
        if (!item || typeof item !== 'object') {
          return;
        }

        const lineCurrencyTotals = {};
        if (item.currencyTotals && typeof item.currencyTotals === 'object') {
          Object.entries(item.currencyTotals).forEach(([cur, val]) => {
            const n = Number(val);
            if (!Number.isFinite(n)) return;
            const key = normalizeCurrencyKey(cur);
            lineCurrencyTotals[key] = (lineCurrencyTotals[key] || 0) + n;
            totalsByCurrency[key] = (totalsByCurrency[key] || 0) + n;
          });
        }
        if (!Object.keys(lineCurrencyTotals).length) {
          const amount = Number(item.amount);
          if (Number.isFinite(amount)) {
            const currencyKey = normalizeCurrencyKey(item.currency);
            lineCurrencyTotals[currencyKey] = (lineCurrencyTotals[currencyKey] || 0) + amount;
            totalsByCurrency[currencyKey] = (totalsByCurrency[currencyKey] || 0) + amount;
          }
        }

        const cadAmount = Number(item.cadAmount);
        if (Number.isFinite(cadAmount)) {
          totalCad += cadAmount;
          totalCadHasValue = true;
        }
        if (item.conversionIncomplete || entry.conversionIncomplete) {
          conversionIncomplete = true;
        }

        const count = Number(item.activityCount);
        totalCount += Number.isFinite(count) ? Math.round(count) : 1;

        const firstDate =
          (typeof item.firstDate === 'string' && item.firstDate.trim()) ||
          (typeof item.startDate === 'string' && item.startDate.trim()) ||
          (typeof item.date === 'string' && item.date.trim()) ||
          null;
        const lastDate =
          (typeof item.lastDate === 'string' && item.lastDate.trim()) ||
          (typeof item.endDate === 'string' && item.endDate.trim()) ||
          firstDate;
        if (firstDate && (!startDate || firstDate < startDate)) {
          startDate = firstDate;
        }
        if (lastDate && (!endDate || lastDate > endDate)) {
          endDate = lastDate;
        }

        const timestamp =
          (typeof item.lastTimestamp === 'string' && item.lastTimestamp.trim()) ||
          (typeof item.timestamp === 'string' && item.timestamp.trim()) ||
          null;
        const lastAmount = Number.isFinite(item.lastAmount)
          ? item.lastAmount
          : Number.isFinite(item.amount)
          ? item.amount
          : null;
        const lastCurrency =
          (typeof item.lastCurrency === 'string' && item.lastCurrency.trim()) ||
          (typeof item.currency === 'string' && item.currency.trim()) ||
          null;

        const itemRawSymbols = Array.isArray(item.rawSymbols)
          ? item.rawSymbols
              .map((value) => (typeof value === 'string' ? value.trim() : ''))
              .filter(Boolean)
          : baseRawSymbols;

        const expandedEntry = {
          symbol: (typeof item.symbol === 'string' && item.symbol.trim()) || baseSymbol || null,
          displaySymbol:
            (typeof item.displaySymbol === 'string' && item.displaySymbol.trim()) ||
            (typeof item.symbol === 'string' && item.symbol.trim()) ||
            baseDisplay ||
            null,
          rawSymbols: itemRawSymbols && itemRawSymbols.length ? itemRawSymbols : undefined,
          description:
            (typeof item.description === 'string' && item.description.trim()) || baseDescription || null,
          currencyTotals: lineCurrencyTotals,
          cadAmount: Number.isFinite(cadAmount) ? cadAmount : null,
          conversionIncomplete:
            item.conversionIncomplete || (!Number.isFinite(cadAmount) && Object.keys(lineCurrencyTotals).length > 0)
              ? true
              : undefined,
          activityCount: Number.isFinite(count) ? Math.round(count) : 1,
          firstDate: firstDate || lastDate || null,
          lastDate: lastDate || firstDate || null,
          lastTimestamp: timestamp || null,
          lastAmount: Number.isFinite(lastAmount) ? lastAmount : null,
          lastCurrency: lastCurrency ? normalizeCurrencyKey(lastCurrency) : null,
          lineItemId:
            (typeof item.lineItemId === 'string' && item.lineItemId.trim()) ||
            (typeof item.id === 'string' && item.id.trim()) ||
            `${entryIndex}-${itemIndex}`,
        };

        appendAggregatedEntry(expandedEntry);
      });
    });

    aggregatedWrappers.sort((a, b) => {
      const aDate = typeof a.sortDate === 'string' ? a.sortDate : null;
      const bDate = typeof b.sortDate === 'string' ? b.sortDate : null;
      if (aDate && bDate && aDate !== bDate) {
        return bDate.localeCompare(aDate);
      }
      if (aDate && !bDate) {
        return -1;
      }
      if (!aDate && bDate) {
        return 1;
      }
      const aTimestamp = typeof a.sortTimestamp === 'string' ? a.sortTimestamp : null;
      const bTimestamp = typeof b.sortTimestamp === 'string' ? b.sortTimestamp : null;
      if (aTimestamp && bTimestamp && aTimestamp !== bTimestamp) {
        return bTimestamp.localeCompare(aTimestamp);
      }
      if (aTimestamp && !bTimestamp) {
        return -1;
      }
      if (!aTimestamp && bTimestamp) {
        return 1;
      }
      return a.firstIndex - b.firstIndex;
    });

    const groupedEntries = aggregatedWrappers.map((wrapper) => {
      const entry = wrapper.entry;
      if (!Number.isFinite(entry?.cadAmount)) {
        entry.cadAmount = null;
      }
      if (!Number.isFinite(entry?.activityCount)) {
        entry.activityCount = null;
      } else {
        entry.activityCount = Math.round(entry.activityCount);
      }
      return entry;
    });

    return {
      ...selectedAccountDividends,
      entries: groupedEntries,
      totalsByCurrency,
      totalCad: totalCadHasValue ? totalCad : null,
      totalCount,
      conversionIncomplete:
        conversionIncomplete || selectedAccountDividends.conversionIncomplete ? true : undefined,
      startDate: startDate || selectedAccountDividends.startDate || null,
      endDate: endDate || selectedAccountDividends.endDate || null,
      groupingMode: 'date',
    };
  }, [focusedSymbol, selectedAccountDividends]);
  const showDividendsPanel = hasDividendSummary && portfolioViewTab === 'dividends';
  const showOrdersPanel = portfolioViewTab === 'orders';
  const showNewsPanel = isNewsFeatureEnabled && portfolioViewTab === 'news';
  
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

  const scrollDividendsPanelIntoView = useCallback(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const target = document.getElementById(dividendsPanelId);
    if (!target || typeof target.scrollIntoView !== 'function') {
      return;
    }
    try {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      target.scrollIntoView();
    }
  }, [dividendsPanelId]);

  const handleShowDividendsPanel = useCallback(() => {
    setPortfolioViewTab('dividends');
    if (typeof document === 'undefined') {
      return;
    }
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => {
        window.setTimeout(scrollDividendsPanelIntoView, 0);
      });
    } else {
      setTimeout(scrollDividendsPanelIntoView, 0);
    }
  }, [scrollDividendsPanelIntoView, setPortfolioViewTab]);

  

  const handleSearchSelectSymbol = useCallback(
    (symbol, meta) => {
      const normalizeList = (list) =>
        Array.from(
          new Set(
            (Array.isArray(list) ? list : [])
              .map((value) => normalizeSymbolGroupKey(value))
              .filter(Boolean)
          )
        );
      const metaSymbols = normalizeList(meta?.symbols);
      const normalizedPrimary = normalizeSymbolGroupKey(symbol);
      const symbolList = metaSymbols.length
        ? metaSymbols
        : normalizedPrimary
        ? [normalizedPrimary]
        : [];
      if (!symbolList.length) {
        return;
      }

      const adHocGroup = (() => {
        if (symbolList.length <= 1) {
          return null;
        }
        const ordered =
          normalizedPrimary && symbolList.includes(normalizedPrimary)
            ? [normalizedPrimary, ...symbolList.filter((s) => s !== normalizedPrimary)]
            : symbolList;
        const labelOverride =
          typeof meta?.label === 'string' && meta.label.trim() ? meta.label.trim() : null;
        const label = labelOverride || ordered.join(' + ');
        const priceSymbol = ordered[0];
        return {
          key: ordered.join('|'),
          label,
          symbols: ordered,
          defaultPriceSymbol: priceSymbol,
        };
      })();

      const targetSymbol = adHocGroup
        ? adHocGroup.defaultPriceSymbol || adHocGroup.symbols[0]
        : symbolList[0];
      const resolution = resolveSymbolFocus(targetSymbol);
      if (!resolution) {
        setAdHocSymbolGroup(null);
        return;
      }

      const canonical = adHocGroup ? adHocGroup.key : resolution.canonical;
      const priceSymbol = adHocGroup
        ? adHocGroup.defaultPriceSymbol || resolution.priceSymbol
        : resolution.priceSymbol;

      setAdHocSymbolGroup(adHocGroup || null);
      setFocusedSymbol(canonical);
      setFocusedSymbolDescription(meta?.description || null);
      setFocusedSymbolPriceSymbol(priceSymbol);
      const normalizedCanonical = normalizeSymbolGroupKey(canonical);
      const matchedTheme =
        !adHocGroup &&
        normalizedCanonical &&
        CRYPTO_THEME_DEFINITIONS.find(
          (theme) => normalizeSymbolGroupKey(theme?.key) === normalizedCanonical
        );
      let nextOrdersFilter = adHocGroup ? adHocGroup.symbols.join(' OR ') : canonical;
      if (!adHocGroup && matchedTheme) {
        const preferKeyword =
          Array.isArray(matchedTheme.keywords) &&
          matchedTheme.keywords.find((kw) => typeof kw === 'string' && kw.trim());
        if (normalizeSymbolGroupKey(matchedTheme.key) === normalizeSymbolGroupKey('CRYPTO-CURRENCIES')) {
          const childKeywords = [];
          CRYPTO_THEME_DEFINITIONS.forEach((theme) => {
            if (normalizeSymbolGroupKey(theme?.key) === normalizeSymbolGroupKey(matchedTheme.key)) {
              return;
            }
            const normalizedChildKey = normalizeSymbolGroupKey(theme?.key);
            if (normalizedChildKey && dynamicSymbolGroups.has(normalizedChildKey)) {
              const childKeyword =
                Array.isArray(theme.keywords) &&
                theme.keywords.find((kw) => typeof kw === 'string' && kw.trim());
              if (childKeyword) {
                childKeywords.push(childKeyword.trim());
              }
            }
          });
          if (childKeywords.length) {
            nextOrdersFilter = childKeywords.join(' OR ');
          } else if (preferKeyword) {
            nextOrdersFilter = preferKeyword.trim();
          } else if (matchedTheme.label) {
            nextOrdersFilter = matchedTheme.label;
          }
        } else if (preferKeyword) {
          nextOrdersFilter = preferKeyword.trim();
        } else if (matchedTheme.label) {
          nextOrdersFilter = matchedTheme.label;
        }
      } else if (!adHocGroup && normalizedCanonical) {
        const dynamicGroup = dynamicSymbolGroups.get(normalizedCanonical);
        if (dynamicGroup?.label) {
          nextOrdersFilter = dynamicGroup.label;
        }
      }
      setOrdersFilter(nextOrdersFilter);

      const desiredTabRaw = typeof meta?.targetTab === 'string' ? meta.targetTab.trim().toLowerCase() : '';
      if (desiredTabRaw === 'orders') {
        setPortfolioViewTab('orders');
      } else if (desiredTabRaw === 'dividends') {
        handleShowDividendsPanel();
      } else {
        setPortfolioViewTab('positions');
      }

      const intentRaw = typeof meta?.intent === 'string' ? meta.intent.trim().toLowerCase() : '';
      if (intentRaw === 'buy' || intentRaw === 'sell') {
        setPendingSymbolAction({
          symbol: priceSymbol || canonical,
          intent: intentRaw,
        });
      } else {
        setPendingSymbolAction(null);
      }
    },
    [
      handleShowDividendsPanel,
      dynamicSymbolGroups,
      resolveSymbolFocus,
      setOrdersFilter,
      setPendingSymbolAction,
      setPortfolioViewTab,
    ]
  );


  const handleSymbolPriceSymbolChange = useCallback(
    (nextSymbol) => {
      if (!focusedSymbol) {
        return;
      }
      const normalized = normalizeSymbolGroupKey(nextSymbol);
      if (!normalized) {
        return;
      }
      if (!focusedSymbolMembers.includes(normalized)) {
        return;
      }
      setFocusedSymbolPriceSymbol(normalized);
    },
    [focusedSymbol, focusedSymbolMembers]
  );

  const handleSearchNavigate = (key) => {
    const k = (key || '').toString().toLowerCase();
    // Quick intent: retire-at:<age>
    if (k.startsWith('retire-at:')) {
      const raw = k.split(':')[1] || '';
      const ageNum = Number(raw);
      if (Number.isFinite(ageNum) && ageNum > 0) {
        // Prefer the account GROUP marked as the main retirement account
        const primaryGroup = (accountGroups || []).find((g) => g && g.mainRetirementAccount === true);
        const ageOverride = Math.round(ageNum);
        if (primaryGroup && typeof primaryGroup.id === 'string' && primaryGroup.id) {
          const groupId = primaryGroup.id;
          const isAlreadyInGroup = selectedAccount === groupId;
          if (!isAlreadyInGroup) {
            handleAccountChange(groupId);
          }
          const label = aggregateAccountLabel || primaryGroup.name || 'Account';
          const cagrStart = cagrStartDate || null;
          setProjectionContext({
            accountKey: groupId,
            label,
            cagrStartDate: cagrStart,
            parentAccountId: null,
            retireAtAge: ageOverride,
          });
          setShowProjectionDialog(true);
          return;
        }
        // Fallback: open projections on current selection with age override
        setProjectionContext((prev) => ({ ...prev, retireAtAge: ageOverride }));
        handleShowProjections();
        return;
      }
    }
    if (k === 'positions') {
      setPortfolioViewTab('positions');
      const scroll = () => document.getElementById('portfolio-panel-positions')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => setTimeout(scroll, 0));
      } else {
        setTimeout(scroll, 0);
      }
    } else if (k === 'orders') {
      setPortfolioViewTab('orders');
      const scroll = () => document.getElementById('portfolio-panel-orders')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => setTimeout(scroll, 0));
      } else {
        setTimeout(scroll, 0);
      }
    } else if (k === 'dividends') {
      handleShowDividendsPanel();
    } else if (k === 'total-pnl') {
      handleShowTotalPnlDialog();
    } else if (k === 'projections' || k === 'retirement-projections') {
      handleShowProjections();
    } else if (k === 'deployment') {
      // Open the deployment adjustment dialog
      handleOpenDeploymentAdjustment();
    } else if (k === 'models') {
      // Switch to Models tab if available
      if (shouldShowInvestmentModels) {
        setPortfolioViewTab('models');
        const scroll = () => document.getElementById('portfolio-panel-models')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => setTimeout(scroll, 0));
        } else {
          setTimeout(scroll, 0);
        }
      }
    } else if (k === 'people') {
      if (!peopleDisabled) {
        handleOpenPeople();
      }
    } else if (
      k === 'cash-breakdown' ||
      k === 'cash-breakdown-locations' ||
      k === 'cash-breakdown-in-accounts' ||
      k === 'cash-breakdown-breakdown' ||
      k === 'cash-breakdown-locations-alt' ||
      k === 'cash-breakdown-accounts'
    ) {
      if (cashBreakdownAvailable) {
        const activeCurrencyCode =
          typeof activeCurrency?.currency === 'string'
            ? activeCurrency.currency.trim().toUpperCase()
            : null;
        if (activeCurrencyCode === 'CAD' || activeCurrencyCode === 'USD') {
          handleShowCashBreakdown(activeCurrencyCode);
        }
      }
    } else if (k === 'breakdown-day') {
      if (showContent && orderedPositions.length) {
        handleShowPnlBreakdown('day');
      }
    } else if (k === 'breakdown-open') {
      if (showContent && orderedPositions.length) {
        handleShowPnlBreakdown('open');
      }
    } else if (k === 'breakdown-total') {
      if (showContent && orderedPositions.length) {
        handleShowPnlBreakdown('total');
      }
    } else if (k === 'return-breakdown') {
      if (Array.isArray(fundingSummaryForDisplay?.returnBreakdown) && fundingSummaryForDisplay.returnBreakdown.length > 0) {
        handleShowAnnualizedReturnDetails();
      }
    } else if (k === 'investment-model') {
      if (showingAggregateAccounts) {
        handleShowInvestmentModelDialog();
      }
    } else if (k === 'copy-summary') {
      handleCopySummary();
    } else if (k === 'estimate-cagr') {
      handleEstimateFutureCagr();
    } else if (k === 'invest-evenly') {
      handlePlanInvestEvenly();
    } else if (k === 'mark-rebalanced') {
      if (markRebalanceContext) {
        handleMarkAccountAsRebalanced();
      }
    }
  };

  
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

  useEffect(() => {
    if (!isNewsFeatureEnabled) {
      closeNewsTabContextMenu();
      setShowNewsPromptDialog((value) => (value ? false : value));
    }
  }, [closeNewsTabContextMenu, isNewsFeatureEnabled]);

  // Manage the News tab context menu lifecycle
  useEffect(() => {
    if (!isNewsFeatureEnabled) {
      return undefined;
    }
    if (!newsTabContextMenuState.open) {
      return undefined;
    }

    const handlePointer = (event) => {
      if (!newsTabMenuRef.current) {
        closeNewsTabContextMenu();
        return;
      }
      if (newsTabMenuRef.current.contains(event.target)) {
        return;
      }
      closeNewsTabContextMenu();
    };

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        closeNewsTabContextMenu();
      }
    };

    const handleViewportChange = () => {
      closeNewsTabContextMenu();
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
  }, [closeNewsTabContextMenu, isNewsFeatureEnabled, newsTabContextMenuState.open]);

  useEffect(() => {
    if (!isNewsFeatureEnabled) {
      return;
    }
    if (!newsTabContextMenuState.open || !newsTabMenuRef.current) {
      return;
    }
    const { innerWidth, innerHeight } = window;
    const rect = newsTabMenuRef.current.getBoundingClientRect();
    const padding = 12;
    let nextX = newsTabContextMenuState.x;
    let nextY = newsTabContextMenuState.y;
    if (nextX + rect.width > innerWidth - padding) {
      nextX = Math.max(padding, innerWidth - rect.width - padding);
    }
    if (nextY + rect.height > innerHeight - padding) {
      nextY = Math.max(padding, innerHeight - rect.height - padding);
    }
    if (nextX !== newsTabContextMenuState.x || nextY !== newsTabContextMenuState.y) {
      setNewsTabContextMenuState((state) => (state.open ? { ...state, x: nextX, y: nextY } : state));
    }
  }, [
    isNewsFeatureEnabled,
    newsTabContextMenuState.open,
    newsTabContextMenuState.x,
    newsTabContextMenuState.y,
  ]);

  useEffect(() => {
    if (!isNewsFeatureEnabled) {
      return;
    }
    if (!newsTabContextMenuState.open || !newsTabMenuRef.current) {
      return;
    }
    const firstButton = newsTabMenuRef.current.querySelector('button');
    if (firstButton && typeof firstButton.focus === 'function') {
      firstButton.focus({ preventScroll: true });
    }
  }, [isNewsFeatureEnabled, newsTabContextMenuState.open]);

  const baseCurrency = 'CAD';
  const currencyRates = useMemo(
    () => buildCurrencyRateMap(baseBalances, baseCurrency),
    [baseBalances, baseCurrency]
  );

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
  const hasPriceSnapshots = symbolPriceSnapshots.size > 0;
  const balances = useMemo(
    () =>
      hasPriceSnapshots
        ? applyPriceSnapshotsToBalances(baseBalances, rawPositions, currencyRates, baseCurrency)
        : baseBalances,
    [hasPriceSnapshots, baseBalances, rawPositions, currencyRates, baseCurrency, symbolPriceSnapshots]
  );

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

  // Derive filtered positions and market value when a symbol is focused
  const symbolFilteredPositions = useMemo(() => {
    if (!focusedSymbol) {
      return { list: positionsWithShare, total: totalMarketValue };
    }
    // For aggregate selections, show one row per account holding the symbol (including variants)
    const baseList = isAggregateSelection ? rawPositions : positions;
    const subset = baseList.filter((p) => matchesFocusedSymbol(p?.symbol));
    const prepared = preparePositionsForHeatmap(subset, currencyRates, baseCurrency);
    return { list: prepared.positions, total: prepared.totalMarketValue };
  }, [
    focusedSymbol,
    positions,
    rawPositions,
    positionsWithShare,
    isAggregateSelection,
    matchesFocusedSymbol,
    currencyRates,
    baseCurrency,
    totalMarketValue,
  ]);

  const findFocusedSymbolPosition = useCallback(() => {
    if (!focusedSymbol) {
      return null;
    }
    const list = Array.isArray(symbolFilteredPositions.list) ? symbolFilteredPositions.list : [];
    const matchFromList = list.find((entry) => matchesFocusedSymbol(entry?.symbol));
    if (matchFromList) {
      return matchFromList;
    }
    const fallback = Array.isArray(positionsWithShare)
      ? positionsWithShare.find((entry) => matchesFocusedSymbol(entry?.symbol))
      : null;
    return fallback || null;
  }, [focusedSymbol, symbolFilteredPositions, positionsWithShare, matchesFocusedSymbol]);

  const focusedSymbolLogoUrl = useMemo(() => {
    if (!focusedSymbol) {
      return null;
    }
    const logoSymbol = (() => {
      if (
        adHocSymbolGroup &&
        normalizeSymbolGroupKey(adHocSymbolGroup.key) === normalizedFocusedSymbolKey
      ) {
        return adHocSymbolGroup.defaultPriceSymbol || adHocSymbolGroup.symbols?.[0] || focusedSymbol;
      }
      if (focusedSymbolGroup?.defaultPriceSymbol) {
        return focusedSymbolGroup.defaultPriceSymbol;
      }
      return focusedSymbol;
    })();
    const symbol = String(logoSymbol || '').trim().toUpperCase();
    if (!symbol) {
      return null;
    }
    const publishableKey =
      import.meta && import.meta.env && import.meta.env.VITE_LOGO_DEV_PUBLISHABLE_KEY
        ? import.meta.env.VITE_LOGO_DEV_PUBLISHABLE_KEY
        : null;
    if (!publishableKey) {
      return null;
    }
    const base = 'https://img.logo.dev/ticker';
    const params = new URLSearchParams({
      token: publishableKey,
      size: '64',
      format: 'png',
    });
    return `${base}/${encodeURIComponent(symbol)}?${params.toString()}`;
  }, [adHocSymbolGroup, focusedSymbol, focusedSymbolGroup, normalizedFocusedSymbolKey]);

  const focusedSymbolLogoAlt = useMemo(() => {
    if (!focusedSymbol) {
      return null;
    }
    const logoSymbol = (() => {
      if (
        adHocSymbolGroup &&
        normalizeSymbolGroupKey(adHocSymbolGroup.key) === normalizedFocusedSymbolKey
      ) {
        return adHocSymbolGroup.defaultPriceSymbol || adHocSymbolGroup.symbols?.[0] || focusedSymbol;
      }
      if (focusedSymbolGroup?.defaultPriceSymbol) {
        return focusedSymbolGroup.defaultPriceSymbol;
      }
      return focusedSymbol;
    })();
    const symbol = String(logoSymbol || '').trim().toUpperCase();
    if (!symbol) {
      return null;
    }
    if (typeof focusedSymbolDescription === 'string') {
      const trimmed = focusedSymbolDescription.trim();
      if (trimmed) {
        return `${trimmed} logo`;
      }
    }
    return `${symbol} logo`;
  }, [
    adHocSymbolGroup,
    focusedSymbol,
    focusedSymbolDescription,
    focusedSymbolGroup,
    normalizedFocusedSymbolKey,
  ]);

  const handleFocusedSymbolSummaryClick = useCallback(
    (event) => {
      if (!focusedSymbol) {
        return;
      }
      const key = String(focusedSymbol).trim().toUpperCase();
      const quoteSymbol = String(focusedSymbolPriceSymbol || key).trim().toUpperCase();
      if (!quoteSymbol) {
        return;
      }

      if (event.ctrlKey || event.metaKey) {
        const url = buildQuoteUrl(quoteSymbol, 'questrade');
        if (!url) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        openQuote(quoteSymbol, 'questrade');
        return;
      }

      const provider = event.altKey ? 'yahoo' : 'perplexity';
      const url = buildQuoteUrl(quoteSymbol, provider);
      if (!url) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      openQuote(quoteSymbol, provider);
    },
    [focusedSymbol, focusedSymbolPriceSymbol]
  );

  const handleFocusedSymbolSummaryFocus = useCallback((event) => {
    if (!(event?.currentTarget instanceof Element)) {
      setFocusedSymbolSummaryFocusVisible(false);
      return;
    }
    const isFocusVisible = event.currentTarget.matches(':focus-visible');
    setFocusedSymbolSummaryFocusVisible(isFocusVisible);
  }, []);

  const handleFocusedSymbolSummaryBlur = useCallback(() => {
    setFocusedSymbolSummaryFocusVisible(false);
  }, []);

  const handleFocusedSymbolContextMenu = useCallback(
    (event) => {
      if (!focusedSymbol) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      let x = event.clientX ?? 0;
      let y = event.clientY ?? 0;
      if ((!x && !y) || Number.isNaN(x) || Number.isNaN(y)) {
        const target = event.currentTarget instanceof Element ? event.currentTarget : null;
        if (target) {
          const rect = target.getBoundingClientRect();
          x = rect.left + rect.width / 2;
          y = rect.top + rect.height;
        } else {
          x = 0;
          y = 0;
        }
      }
      setFocusedSymbolMenuState({
        open: true,
        x,
        y,
      });
    },
    [focusedSymbol]
  );

  const handleFocusedSymbolSummaryKeyDown = useCallback(
    (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handleFocusedSymbolSummaryClick(event);
        return;
      }
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        event.stopPropagation();
        handleFocusedSymbolContextMenu(event);
      }
    },
    [handleFocusedSymbolContextMenu, handleFocusedSymbolSummaryClick]
  );

  const triggerBuySell = useCallback(
    async ({ symbol, position, accountOptionsOverride } = {}) => {
      const normalizedSymbol =
        typeof symbol === 'string' ? symbol.trim().toUpperCase() : '';
      if (!normalizedSymbol) {
        return;
      }

      const baseOptions =
        Array.isArray(accountOptionsOverride) && accountOptionsOverride.length > 0
          ? accountOptionsOverride
          : position
          ? listAccountsForPosition(position, { accountsById, accountsByNumber })
          : [];

      if (baseOptions.length > 1) {
        const dialogOptions = baseOptions.map((option) => ({
          key: option.key,
          label: option.label,
          description: option.description || null,
          account: option.account || null,
        }));
        setAccountActionPrompt({
          title: 'Select account',
          message: `Multiple accounts hold ${normalizedSymbol}. Select which account to trade.`,
          symbol: normalizedSymbol,
          options: dialogOptions,
          onConfirm: async (account) => {
            if (account) {
              openAccountSummary(account);
            }
            try {
              await copyTextToClipboard(normalizedSymbol);
            } catch (error) {
              console.error('Failed to copy symbol to clipboard', error);
            }
          },
        });
        return;
      }

      const targetAccount =
        baseOptions.length === 1
          ? baseOptions[0].account
          : position
          ? resolveAccountForPosition(position, accountsById)
          : null;

      if (targetAccount) {
        openAccountSummary(targetAccount);
      }

      try {
        await copyTextToClipboard(normalizedSymbol);
      } catch (error) {
        console.error('Failed to copy symbol to clipboard', error);
      }
    },
    [accountsById, accountsByNumber, setAccountActionPrompt]
  );

  const handleBuySellPosition = useCallback(
    (position) => {
      if (!position || position.symbol === undefined || position.symbol === null) {
        return;
      }
      const rawSymbol = String(position.symbol);
      if (!rawSymbol.trim()) {
        return;
      }
      triggerBuySell({ symbol: rawSymbol, position });
    },
    [triggerBuySell]
  );

  const handleAccountActionCancel = useCallback(() => {
    setAccountActionPrompt(null);
  }, []);

  const handleAccountActionSelect = useCallback(
    async (optionKey) => {
      if (!accountActionPrompt) {
        return;
      }
      const { options, onConfirm } = accountActionPrompt;
      const option = Array.isArray(options)
        ? options.find((entry) => entry.key === optionKey)
        : null;
      const confirm = typeof onConfirm === 'function' ? onConfirm : null;
      setAccountActionPrompt(null);
      if (!option || !confirm) {
        return;
      }
      try {
        await confirm(option.account || null);
      } catch (error) {
        console.error('Account action failed', error);
      }
    },
    [accountActionPrompt]
  );

  let handleFocusedSymbolBuySell;

  const handleExplainMovementForSymbol = useCallback(async () => {
    if (!focusedSymbol) {
      return;
    }
    const key = String(
      (focusedSymbolPriceSymbol && focusedSymbolPriceSymbol.trim()) ||
        (focusedSymbolMembers.length ? focusedSymbolMembers[0] : focusedSymbol)
    )
      .trim()
      .toUpperCase();
    if (!key) {
      return;
    }

    const position = findFocusedSymbolPosition();
    const description = (() => {
      if (position && typeof position.description === 'string' && position.description.trim()) {
        return position.description.trim();
      }
      if (typeof focusedSymbolDescription === 'string' && focusedSymbolDescription.trim()) {
        return focusedSymbolDescription.trim();
      }
      if (position && typeof position.symbol === 'string' && position.symbol.trim()) {
        return position.symbol.trim();
      }
      return key;
    })();

    openChatGpt();

    const promptSource = position
      ? { ...position, symbol: key, description }
      : { symbol: key, description };
    const prompt = buildExplainMovementPrompt(promptSource);
    if (!prompt) {
      return;
    }

    try {
      await copyTextToClipboard(prompt);
    } catch (error) {
      console.error('Failed to copy explain movement prompt', error);
    }
  }, [
    focusedSymbol,
    focusedSymbolDescription,
    focusedSymbolMembers,
    focusedSymbolPriceSymbol,
    findFocusedSymbolPosition,
  ]);

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

  useEffect(() => {
    const keywordMatches = CRYPTO_THEME_DEFINITIONS.map(() => new Set());
    const cryptoAggregateKey = normalizeSymbolGroupKey('CRYPTO-CURRENCIES');
    const cryptoAggregateIndex = CRYPTO_THEME_DEFINITIONS.findIndex(
      (theme) => normalizeSymbolGroupKey(theme?.key) === cryptoAggregateKey
    );
    const considerEntry = (symbolCandidate, description, rawSymbols) => {
      const desc =
        typeof description === 'string' && description.trim()
          ? description.toLowerCase()
          : '';
      if (!desc) {
        return;
      }
      const symbols = [];
      const normalizedSymbol = normalizeSymbolGroupKey(symbolCandidate);
      if (normalizedSymbol) {
        symbols.push(normalizedSymbol);
      }
      if (Array.isArray(rawSymbols)) {
        rawSymbols.forEach((rawSymbol) => {
          const normalizedRaw = normalizeSymbolGroupKey(rawSymbol);
          if (normalizedRaw) {
            symbols.push(normalizedRaw);
          }
        });
      }
      CRYPTO_THEME_DEFINITIONS.forEach((theme, index) => {
        if (!theme || !Array.isArray(theme.keywords)) {
          return;
        }
        const hasKeyword = theme.keywords.some((keyword) => desc.includes(keyword));
        if (!hasKeyword) {
          return;
        }
        symbols.forEach((sym) => keywordMatches[index].add(sym));
      });
    };

    positions.forEach((p) => considerEntry(p?.symbol, p?.description, p?.rawSymbols));

    const dividendEntries = Array.isArray(selectedAccountDividends?.entries)
      ? selectedAccountDividends.entries
      : [];
    dividendEntries.forEach((entry) =>
      considerEntry(entry?.symbol || entry?.displaySymbol, entry?.description, entry?.rawSymbols)
    );

    const ordList = Array.isArray(ordersForSelectedAccount) ? ordersForSelectedAccount : [];
    ordList.forEach((order) => considerEntry(order?.symbol, order?.description, order?.rawSymbols));

    // Fold all crypto-related themes into the aggregate "crypto" theme so users can
    // search for "crypto" even if positions only mention Bitcoin/Ethereum.
    if (cryptoAggregateIndex >= 0) {
      const aggregateSet = keywordMatches[cryptoAggregateIndex];
      keywordMatches.forEach((set, index) => {
        if (index === cryptoAggregateIndex) {
          return;
        }
        set.forEach((symbol) => aggregateSet.add(symbol));
      });
    }

    const nextMap = new Map();
    CRYPTO_THEME_DEFINITIONS.forEach((theme, index) => {
      const normalizedKey = normalizeSymbolGroupKey(theme?.key);
      if (!normalizedKey) {
        return;
      }
      const matchedSymbols = Array.from(keywordMatches[index]).filter(Boolean);
      if (!matchedSymbols.length && !CRYPTO_PRICE_SYMBOL_BY_KEY[normalizedKey]) {
        return;
      }
      const overridePriceSymbol = CRYPTO_PRICE_SYMBOL_BY_KEY[normalizedKey] || null;
      const symbols = (() => {
        const base = matchedSymbols.slice().sort();
        if (!overridePriceSymbol) {
          return base;
        }
        return [overridePriceSymbol, ...base.filter((sym) => sym !== overridePriceSymbol)];
      })();
      if (!symbols.length) {
        return;
      }
      const labelOverride = CRYPTO_DISPLAY_LABEL_BY_KEY[normalizedKey];
      nextMap.set(normalizedKey, {
        key: normalizedKey,
        label: labelOverride || theme.label || normalizedKey,
        symbols,
        defaultPriceSymbol: overridePriceSymbol || symbols[0],
      });
    });

    setDynamicSymbolGroups((prev) => {
      if (areSymbolGroupMapsEqual(prev, nextMap)) {
        return prev;
      }
      return nextMap;
    });
  }, [positions, selectedAccountDividends, ordersForSelectedAccount]);

  // Build symbol suggestions for search (after positions are initialized)
  const searchSymbols = useMemo(() => {
    const seen = new Set();
    const list = [];
    positions.forEach((p) => {
      const sym = (p?.symbol || '').toString().trim().toUpperCase();
      if (!sym || seen.has(sym)) return;
      seen.add(sym);
      list.push({ symbol: sym, description: (p?.description || '').toString() });
    });
    const divEntries = Array.isArray(selectedAccountDividends?.entries) ? selectedAccountDividends.entries : [];
    divEntries.forEach((e) => {
      const sym = (e?.symbol || e?.displaySymbol || '').toString().trim().toUpperCase();
      if (!sym || seen.has(sym)) return;
      seen.add(sym);
      list.push({ symbol: sym, description: (e?.description || '').toString() });
    });
    const ordList = Array.isArray(ordersForSelectedAccount) ? ordersForSelectedAccount : [];
    ordList.forEach((o) => {
      const sym = (o?.symbol || '').toString().trim().toUpperCase();
      if (!sym || seen.has(sym)) return;
      seen.add(sym);
      list.push({ symbol: sym, description: (o?.description || '').toString() });
    });
    if (dynamicSymbolGroups && typeof dynamicSymbolGroups.forEach === 'function') {
      const themeEntries = [];
      dynamicSymbolGroups.forEach((group) => {
        if (!group || !group.key || !Array.isArray(group.symbols) || !group.symbols.length) {
          return;
        }
        const preview = group.symbols.slice(0, 3).join(', ');
        const remainingCount = group.symbols.length - Math.min(group.symbols.length, 3);
        const parts = [`${group.label || group.key} theme`, `${group.symbols.length} symbol${group.symbols.length === 1 ? '' : 's'}`];
        if (preview) {
          parts.push(`e.g. ${preview}${remainingCount > 0 ? '...' : ''}`);
        }
        themeEntries.push({
          symbol: group.key,
          label: group.label || group.key,
          description: parts.join(' - '),
        });
      });
      themeEntries
        .sort((a, b) => (a.label || a.symbol).localeCompare(b.label || b.symbol))
        .forEach((entry) => {
          const sym = (entry?.symbol || '').toString().trim().toUpperCase();
          if (!sym || seen.has(sym)) {
            return;
          }
          seen.add(sym);
          list.push(entry);
        });
    }
    return list;
  }, [positions, selectedAccountDividends, ordersForSelectedAccount, dynamicSymbolGroups]);

  const resolveLocalDescriptionForFocusedSymbol = useCallback(() => {
    if (!focusedSymbol) {
      return null;
    }
    for (let i = 0; i < positions.length; i += 1) {
      const p = positions[i];
      if (!matchesFocusedSymbol(p?.symbol)) continue;
      const desc = (p?.description || '').toString().trim();
      if (desc) return desc;
    }
    const divEntries = Array.isArray(selectedAccountDividends?.entries)
      ? selectedAccountDividends.entries
      : [];
    for (let i = 0; i < divEntries.length; i += 1) {
      const e = divEntries[i];
      if (!matchesFocusedSymbol(e?.symbol) && !matchesFocusedSymbol(e?.displaySymbol)) {
        continue;
      }
      const desc = (e?.description || '').toString().trim();
      if (desc) return desc;
    }
    const ordList = Array.isArray(ordersForSelectedAccount) ? ordersForSelectedAccount : [];
    for (let i = 0; i < ordList.length; i += 1) {
      const o = ordList[i];
      if (!matchesFocusedSymbol(o?.symbol)) continue;
      const desc = (o?.description || '').toString().trim();
      if (desc) return desc;
    }
    return null;
  }, [focusedSymbol, matchesFocusedSymbol, positions, selectedAccountDividends, ordersForSelectedAccount]);

  // Keep focused symbol description in sync: prefer local data; fallback to cached quote names
  useEffect(() => {
    if (!focusedSymbol) {
      return;
    }
    const local = resolveLocalDescriptionForFocusedSymbol();
    if (local) {
      if (local !== focusedSymbolDescription) {
        setFocusedSymbolDescription(local);
      }
      return;
    }
    if (!focusedSymbolDescription) {
      const key = String(focusedSymbol).trim().toUpperCase();
      const cached = key ? quoteCacheRef.current.get(key) : null;
      if (
        cached &&
        typeof cached.description === 'string' &&
        cached.description.trim() &&
        cached.description.trim() !== focusedSymbolDescription
      ) {
        setFocusedSymbolDescription(cached.description.trim());
      }
    }
  }, [
    focusedSymbol,
    focusedSymbolDescription,
    resolveLocalDescriptionForFocusedSymbol,
  ]);

  useEffect(() => {
    if (!focusedSymbol) {
      setFocusedSymbolQuoteState({ status: 'idle', data: null, error: null });
      return;
    }
    const key = normalizedFocusedPriceSymbol || normalizedFocusedSymbolKey;
    if (!key) {
      setFocusedSymbolQuoteState({ status: 'idle', data: null, error: null });
      return;
    }

    let cancelled = false;
    const cached = quoteCacheRef.current.get(key) || null;
    setFocusedSymbolQuoteState((prev) => {
      if (cached) {
        if (prev.status === 'success' && prev.data === cached && !prev.error) {
          return prev;
        }
        return { status: 'success', data: cached, error: null };
      }
      if (prev.status === 'loading' && !prev.data) {
        return prev;
      }
      return { status: 'loading', data: null, error: null };
    });

    (async () => {
      try {
        const quote = await getQuote(key);
        if (cancelled) return;
        const normalizedPrice = coercePositiveNumber(quote?.price);
        const normalizedMarketCap = coercePositiveNumber(quote?.marketCap);
        const normalizedPrevClose = coercePositiveNumber(quote?.previousClose);
        const rawPe = Number(quote?.peRatio);
        const normalizedPe = Number.isFinite(rawPe) && rawPe > 0 ? rawPe : null;
        const rawChange = Number(quote?.changePercent);
        const normalizedChange = Number.isFinite(rawChange) ? rawChange : null;
        const rawDividend = Number(quote?.dividendYieldPercent);
        const normalizedDividend = Number.isFinite(rawDividend) && rawDividend > 0 ? rawDividend : null;
        const rawPeg = Number(quote?.pegRatio);
        const normalizedPeg = Number.isFinite(rawPeg) && rawPeg > 0 ? rawPeg : null;
        const normalizedPegDiagnostics = normalizePegDiagnostics(quote?.pegDiagnostics);
        const normalized = {
          price: normalizedPrice,
          currency:
            typeof quote?.currency === 'string' && quote.currency.trim()
              ? quote.currency.trim().toUpperCase()
              : null,
          description:
            typeof quote?.name === 'string' && quote.name.trim() ? quote.name.trim() : null,
          changePercent:
            Number.isFinite(normalizedChange) || normalizedChange === 0 ? normalizedChange : null,
          previousClose: normalizedPrevClose,
          peRatio: normalizedPe,
          pegRatio: normalizedPeg,
          marketCap: normalizedMarketCap,
          dividendYieldPercent: normalizedDividend,
          asOf: typeof quote?.asOf === 'string' && quote.asOf ? quote.asOf : null,
          pegDiagnostics: normalizedPegDiagnostics,
        };
        quoteCacheRef.current.set(key, normalized);
        setFocusedSymbolQuoteState({ status: 'success', data: normalized, error: null });
        if (normalized.description) {
          setFocusedSymbolDescription((prev) => {
            if (prev && prev.trim() && prev.trim().toUpperCase() !== key) {
              return prev;
            }
            const local = resolveLocalDescriptionForFocusedSymbol();
            if (local && local.trim()) {
              return local.trim();
            }
            return normalized.description;
          });
        }
      } catch (error) {
        if (cancelled) return;
        const fallback = quoteCacheRef.current.get(key) || null;
        const normalizedError = error instanceof Error ? error : new Error('Failed to load quote');
        if (!fallback) {
          setFocusedSymbolQuoteState({ status: 'error', data: null, error: normalizedError });
        } else {
          setFocusedSymbolQuoteState({ status: 'success', data: fallback, error: normalizedError });
        }
        console.warn('Failed to fetch quote for symbol', key, error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [focusedSymbol, normalizedFocusedPriceSymbol, normalizedFocusedSymbolKey, resolveLocalDescriptionForFocusedSymbol]);

  useEffect(() => {
    if (focusedSymbol) {
      return;
    }
    closeFocusedSymbolMenu();
    setFocusedSymbolQuoteState({ status: 'idle', data: null, error: null });
  }, [focusedSymbol, closeFocusedSymbolMenu]);

  useEffect(() => {
    if (!focusedSymbolMenuState.open) {
      return undefined;
    }
    const handlePointer = (event) => {
      if (focusedSymbolMenuRef.current && focusedSymbolMenuRef.current.contains(event.target)) {
        return;
      }
      closeFocusedSymbolMenu();
    };
    const handleKey = (event) => {
      if (event.key === 'Escape') {
        closeFocusedSymbolMenu();
      }
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('contextmenu', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('contextmenu', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [focusedSymbolMenuState.open, closeFocusedSymbolMenu]);

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
  const holdingsPieChartAccountLabel = useMemo(() => {
    if (isAggregateSelection) {
      return aggregateAccountLabel || 'All accounts';
    }
    if (selectedAccountInfo) {
      return getAccountLabel(selectedAccountInfo) || null;
    }
    return null;
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
    if (!isNewsFeatureEnabled) {
      return;
    }
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
          prompt: null,
          rawOutput: null,
          usage: null,
          pricing: null,
          cost: null,
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
        prompt: null,
        rawOutput: null,
        usage: null,
        pricing: null,
        cost: null,
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
        const prompt = typeof payload?.prompt === 'string' ? payload.prompt : null;
        const rawOutput = typeof payload?.rawOutput === 'string' ? payload.rawOutput : null;
        const usage = payload?.usage && typeof payload.usage === 'object' ? payload.usage : null;
        const pricing = payload?.pricing && typeof payload.pricing === 'object' ? payload.pricing : null;
        const cost = payload?.cost && typeof payload.cost === 'object' ? payload.cost : null;
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
          prompt,
          rawOutput,
          usage,
          pricing,
          cost,
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
          prompt: null,
          rawOutput: null,
          usage: null,
          pricing: null,
          cost: null,
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    isNewsFeatureEnabled,
    portfolioViewTab,
    newsSymbols,
    newsAccountId,
    newsAccountLabel,
    newsCacheKey,
    portfolioNewsRetryKey,
  ]);

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
  const childAccountSummaryResult = useMemo(() => {
    if (!accounts.length) {
      return { items: [], parentTotal: null, parents: [] };
    }

    const hasGroupDefinitions = (function resolveHasGroups() {
      if (accountGroupsByNormalizedName.size > 0) {
        return true;
      }
      if (accountGroupParentsMap.size > 0 || accountGroupChildrenMap.size > 0) {
        return true;
      }
      for (let index = 0; index < accounts.length; index += 1) {
        const groupKey = normalizeAccountGroupKey(accounts[index]?.accountGroup);
        if (groupKey) {
          return true;
        }
      }
      return false;
    })();

    // When a group is selected, we show its children. For individual accounts,
    // we don't infer children (to avoid showing siblings), but we still want
    // to show that account's parent group(s).
    const parentKeys = new Set();
    let selectedGroupKey = null;

    if (isAccountGroupSelection(selectedAccount) && selectedAccountGroup) {
      const groupKey = normalizeAccountGroupKey(selectedAccountGroup.name);
      if (groupKey) {
        selectedGroupKey = groupKey;
        parentKeys.add(groupKey);
      }
    }

    const excludeAccountIds = new Set();
    if (
      !isAccountGroupSelection(selectedAccount) &&
      selectedAccountInfo?.id !== undefined &&
      selectedAccountInfo?.id !== null
    ) {
      const parentId = String(selectedAccountInfo.id).trim();
      if (parentId) {
        excludeAccountIds.add(parentId);
      }
    }

    const accountMetricsCache = new Map();
    const resolveAccountMetrics = (accountId, account) => {
      const cacheKey = accountId;
      if (accountMetricsCache.has(cacheKey)) {
        return accountMetricsCache.get(cacheKey);
      }
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

      const metrics = {
        totalEquityCad: Number.isFinite(totalEquityCad) ? totalEquityCad : null,
        dayPnlCad: Number.isFinite(dayPnlCad) ? dayPnlCad : null,
        account,
      };
      accountMetricsCache.set(cacheKey, metrics);
      return metrics;
    };

    const collectGroupAccountIds = (rootKey) => {
      const result = new Set();
      const queue = [rootKey];
      const visited = new Set();
      while (queue.length) {
        const currentKey = queue.shift();
        if (!currentKey || visited.has(currentKey)) {
          continue;
        }
        visited.add(currentKey);
        const members = accountsByGroupName.get(currentKey);
        if (members && members.length) {
          members.forEach((account) => {
            if (!account || account.id === undefined || account.id === null) {
              return;
            }
            const accountId = String(account.id).trim();
            if (!accountId) {
              return;
            }
            result.add(accountId);
          });
        }
        const children = accountGroupChildrenMap.get(currentKey);
        if (children && children.size) {
          children.forEach((childKey) => {
            if (childKey && !visited.has(childKey)) {
              queue.push(childKey);
            }
          });
        }
      }
      return result;
    };

    if (showingAllAccounts && hasGroupDefinitions) {
      const items = [];
      const seenAccountIds = new Set();
      const allGroupKeys = new Set();

      accountGroupsByNormalizedName.forEach((_, key) => {
        if (key) {
          allGroupKeys.add(key);
        }
      });
      accountGroupNamesByKey.forEach((_, key) => {
        if (key) {
          allGroupKeys.add(key);
        }
      });
      accountGroupChildrenMap.forEach((_, key) => {
        if (key) {
          allGroupKeys.add(key);
        }
      });
      accountGroupParentsMap.forEach((_, key) => {
        if (key) {
          allGroupKeys.add(key);
        }
      });
      accountsByGroupName.forEach((_, key) => {
        if (key) {
          allGroupKeys.add(key);
        }
      });

      const topLevelGroupKeys = Array.from(allGroupKeys).filter((key) => {
        const parents = accountGroupParentsMap.get(key);
        return !parents || parents.size === 0;
      });

      const seenGroupIds = new Set();
      topLevelGroupKeys.forEach((groupKey) => {
        const group = accountGroupsByNormalizedName.get(groupKey) || null;
        const groupId =
          group && group.id !== undefined && group.id !== null ? String(group.id).trim() : null;
        if (groupId && seenGroupIds.has(groupId)) {
          return;
        }
        if (groupId) {
          seenGroupIds.add(groupId);
        }
        const displayName = accountGroupNamesByKey.get(groupKey) || groupId || groupKey;
        const accountIds = collectGroupAccountIds(groupKey);
        if (!accountIds.size) {
          return;
        }
        let totalEquitySum = 0;
        let hasTotalEquity = false;
        let dayPnlSum = 0;
        let hasDayPnl = false;
        accountIds.forEach((accountId) => {
          const account = accountsById.get(accountId);
          if (!account) {
            return;
          }
          const metrics = resolveAccountMetrics(accountId, account);
          if (metrics.totalEquityCad !== null) {
            totalEquitySum += metrics.totalEquityCad;
            hasTotalEquity = true;
          }
          if (metrics.dayPnlCad !== null) {
            dayPnlSum += metrics.dayPnlCad;
            hasDayPnl = true;
          }
        });
        if (!hasTotalEquity && !hasDayPnl) {
          return;
        }
        const href = groupId ? buildAccountViewUrl(groupId) || null : null;
        const cagrStart =
          groupId && typeof accountFunding[groupId]?.cagrStartDate === 'string'
            ? accountFunding[groupId].cagrStartDate.trim()
            : '';
        let groupProjectedRate = null;
        if (groupId || groupKey) {
          let equitySum = 0;
          let weighted = 0;
          accountIds.forEach((accountId) => {
            const acc = accountsById.get(accountId);
            if (!acc) {
              return;
            }
            const fund = accountFunding[accountId] || null;
            const eq = Number.isFinite(fund?.totalEquityCad) ? fund.totalEquityCad : null;
            const rate = Number.isFinite(acc.projectionGrowthPercent) ? acc.projectionGrowthPercent : null;
            if (Number.isFinite(eq) && eq > 0 && Number.isFinite(rate)) {
              equitySum += eq;
              weighted += eq * rate;
            }
          });
          if (equitySum > 0) {
            groupProjectedRate = weighted / equitySum;
          }
        }

        items.push({
          id: groupId || groupKey,
          label: displayName,
          totalEquityCad: hasTotalEquity ? totalEquitySum : null,
          dayPnlCad: hasDayPnl ? dayPnlSum : null,
          href,
          kind: 'group',
          cagrStartDate: cagrStart || null,
          supportsCagrToggle: Boolean(groupId && cagrStart),
          projectionGrowthPercent: Number.isFinite(groupProjectedRate) ? groupProjectedRate : null,
        });
      });

      accounts.forEach((account) => {
        if (!account || account.id === undefined || account.id === null) {
          return;
        }
        if (shouldHideAccountSummaryEntry(account)) {
          return;
        }
        const accountId = String(account.id).trim();
        if (!accountId || seenAccountIds.has(accountId)) {
          return;
        }
        const groupKey = normalizeAccountGroupKey(account.accountGroup);
        if (groupKey) {
          return;
        }
        seenAccountIds.add(accountId);
        const metrics = resolveAccountMetrics(accountId, account);
        const href = buildAccountViewUrl(accountId) || null;
        const cagrStart =
          typeof accountFunding[accountId]?.cagrStartDate === 'string'
            ? accountFunding[accountId].cagrStartDate.trim()
            : '';
        items.push({
          id: accountId,
          label: getAccountLabel(account) || accountId,
          totalEquityCad: metrics.totalEquityCad,
          dayPnlCad: metrics.dayPnlCad,
          href,
          kind: 'account',
          cagrStartDate: cagrStart || null,
          supportsCagrToggle: Boolean(cagrStart),
          projectionGrowthPercent:
            Number.isFinite(accountsById.get(accountId)?.projectionGrowthPercent)
              ? accountsById.get(accountId).projectionGrowthPercent
              : null,
        });
      });

      if (!items.length) {
        return { items: [], parentTotal: null, parents: [] };
      }

      items.sort((a, b) => {
        const aValue = Number.isFinite(a.totalEquityCad) ? a.totalEquityCad : -Infinity;
        const bValue = Number.isFinite(b.totalEquityCad) ? b.totalEquityCad : -Infinity;
        if (aValue !== bValue) {
          return bValue - aValue;
        }
        return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
      });

      let parentTotal = null;
      if (isFiniteNumber(selectedAccountFunding?.totalEquityCad)) {
        parentTotal = selectedAccountFunding.totalEquityCad;
      } else {
        const sum = items.reduce((accumulator, item) => {
          if (Number.isFinite(item.totalEquityCad)) {
            return accumulator + item.totalEquityCad;
          }
          return accumulator;
        }, 0);
        if (Number.isFinite(sum) && sum > 0) {
          parentTotal = sum;
        }
      }

      return { items, parentTotal, parents: [] };
    }

    const buildParentGroupItems = () => {
      // If a group is selected, show its parent groups (one level up).
      if (selectedGroupKey) {
        const parentSet = accountGroupParentsMap.get(selectedGroupKey);
        if (!parentSet || !parentSet.size) {
          return [];
        }
        const seenParentIds = new Set();
        const parents = [];
        parentSet.forEach((parentKey) => {
          if (!parentKey || parentKey === selectedGroupKey) {
            return;
          }
          const parentGroup = accountGroupsByNormalizedName.get(parentKey) || null;
          const parentId =
            parentGroup && parentGroup.id !== undefined && parentGroup.id !== null
              ? String(parentGroup.id).trim()
              : null;
          if (parentId && seenParentIds.has(parentId)) {
            return;
          }
          if (parentId) {
            seenParentIds.add(parentId);
          }
          const displayName = accountGroupNamesByKey.get(parentKey) || parentId || parentKey;
          const href = parentId ? buildAccountViewUrl(parentId) || null : null;
          parents.push({
            id: parentId || parentKey,
            label: displayName,
            href,
          });
        });
        parents.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
        return parents;
      }

      // If a concrete account is selected, show its immediate parent: the
      // account's own accountGroup from accounts.json (not the group's parent).
      const rawGroup = selectedAccountInfo?.accountGroup;
      const key = normalizeAccountGroupKey(rawGroup);
      if (!key) {
        return [];
      }
      const group = accountGroupsByNormalizedName.get(key) || null;
      const groupId = group && group.id !== undefined && group.id !== null ? String(group.id).trim() : null;
      const displayName = accountGroupNamesByKey.get(key) || groupId || key;
      const href = groupId ? buildAccountViewUrl(groupId) || null : null;
      return [
        {
          id: groupId || key,
          label: displayName,
          href,
        },
      ];
    };

    const items = [];
    const seenAccountIds = new Set();

    parentKeys.forEach((groupKey) => {
      const members = accountsByGroupName.get(groupKey);
      if (!members || !members.length) {
        return;
      }
      members.forEach((account) => {
        if (!account || account.id === undefined || account.id === null) {
          return;
        }
        if (shouldHideAccountSummaryEntry(account)) {
          return;
        }
        const accountId = String(account.id).trim();
        if (!accountId || excludeAccountIds.has(accountId) || seenAccountIds.has(accountId)) {
          return;
        }
        seenAccountIds.add(accountId);
        const metrics = resolveAccountMetrics(accountId, account);
        const href = buildAccountViewUrl(accountId) || null;
        const cagrStart =
          typeof accountFunding[accountId]?.cagrStartDate === 'string'
            ? accountFunding[accountId].cagrStartDate.trim()
            : '';
        items.push({
          id: accountId,
          label: getAccountLabel(account) || accountId,
          totalEquityCad: metrics.totalEquityCad,
          dayPnlCad: metrics.dayPnlCad,
          href,
          kind: 'account',
          cagrStartDate: cagrStart || null,
          supportsCagrToggle: Boolean(cagrStart),
          projectionGrowthPercent:
            Number.isFinite(accountsById.get(accountId)?.projectionGrowthPercent)
              ? accountsById.get(accountId).projectionGrowthPercent
              : null,
        });
      });
    });

    const childGroupKeys = new Set();
    parentKeys.forEach((groupKey) => {
      const children = accountGroupChildrenMap.get(groupKey);
      if (!children || !children.size) {
        return;
      }
      children.forEach((childKey) => {
        if (childKey && childKey !== groupKey) {
          childGroupKeys.add(childKey);
        }
      });
    });

    const seenGroupIds = new Set();
    childGroupKeys.forEach((childKey) => {
      const group = accountGroupsByNormalizedName.get(childKey) || null;
      const groupId =
        group && group.id !== undefined && group.id !== null ? String(group.id).trim() : null;
      if (groupId && seenGroupIds.has(groupId)) {
        return;
      }
      if (groupId) {
        seenGroupIds.add(groupId);
      }
      const displayName = accountGroupNamesByKey.get(childKey) || groupId || childKey;
      const accountIds = collectGroupAccountIds(childKey);
      if (!accountIds.size) {
        return;
      }
      let totalEquitySum = 0;
      let hasTotalEquity = false;
      let dayPnlSum = 0;
      let hasDayPnl = false;
      accountIds.forEach((accountId) => {
        const account = accountsById.get(accountId);
        if (!account) {
          return;
        }
        const metrics = resolveAccountMetrics(accountId, account);
        if (metrics.totalEquityCad !== null) {
          totalEquitySum += metrics.totalEquityCad;
          hasTotalEquity = true;
        }
        if (metrics.dayPnlCad !== null) {
          dayPnlSum += metrics.dayPnlCad;
          hasDayPnl = true;
        }
      });
      if (!hasTotalEquity && !hasDayPnl) {
        return;
      }
      const href = groupId ? buildAccountViewUrl(groupId) || null : null;
      const cagrStart =
        groupId && typeof accountFunding[groupId]?.cagrStartDate === 'string'
          ? accountFunding[groupId].cagrStartDate.trim()
          : '';
      // Compute an approximate projected CAGR for this child group using
      // a value-weighted average of its immediate and nested member accounts.
      let groupProjectedRate = null;
      if (groupId || childKey) {
        const memberIds = collectGroupAccountIds(childKey);
        let equitySum = 0;
        let weighted = 0;
        memberIds.forEach((accountId) => {
          const acc = accountsById.get(accountId);
          if (!acc) {
            return;
          }
          const fund = accountFunding[accountId] || null;
          const eq = Number.isFinite(fund?.totalEquityCad) ? fund.totalEquityCad : null;
          const rate = Number.isFinite(acc.projectionGrowthPercent) ? acc.projectionGrowthPercent : null;
          if (Number.isFinite(eq) && eq > 0 && Number.isFinite(rate)) {
            equitySum += eq;
            weighted += eq * rate;
          }
        });
        if (equitySum > 0) {
          groupProjectedRate = weighted / equitySum;
        }
      }

      items.push({
        id: groupId || childKey,
        label: displayName,
        totalEquityCad: hasTotalEquity ? totalEquitySum : null,
        dayPnlCad: hasDayPnl ? dayPnlSum : null,
        href,
        kind: 'group',
        cagrStartDate: cagrStart || null,
        supportsCagrToggle: Boolean(groupId && cagrStart),
        projectionGrowthPercent: Number.isFinite(groupProjectedRate) ? groupProjectedRate : null,
      });
    });

    // Build parent group list even when there are no child items (e.g. concrete account selected).
    const parentGroupItems = buildParentGroupItems();

    if (!items.length) {
      return { items: [], parentTotal: null, parents: parentGroupItems };
    }

    items.sort((a, b) => {
      const aValue = Number.isFinite(a.totalEquityCad) ? a.totalEquityCad : -Infinity;
      const bValue = Number.isFinite(b.totalEquityCad) ? b.totalEquityCad : -Infinity;
      if (aValue !== bValue) {
        return bValue - aValue;
      }
      return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    });

    let parentTotal = null;
    if (isFiniteNumber(selectedAccountFunding?.totalEquityCad)) {
      parentTotal = selectedAccountFunding.totalEquityCad;
    } else {
      const sum = items.reduce((accumulator, item) => {
        if (Number.isFinite(item.totalEquityCad)) {
          return accumulator + item.totalEquityCad;
        }
        return accumulator;
      }, 0);
      if (Number.isFinite(sum) && sum > 0) {
        parentTotal = sum;
      }
    }

    return { items, parentTotal, parents: parentGroupItems };
  }, [
    accounts,
    accountsById,
    accountsByGroupName,
    accountGroupChildrenMap,
    accountGroupParentsMap,
    accountGroupNamesByKey,
    accountGroupsByNormalizedName,
    normalizedAccountBalances,
    accountPnlTotals,
    accountFunding,
    currencyRates,
    baseCurrency,
    selectedAccount,
    selectedAccountInfo,
    selectedAccountGroup,
    isAggregateSelection,
    selectedAccountFunding,
    buildAccountViewUrl,
  ]);
  const childAccountSummaries = childAccountSummaryResult.items;
  const childAccountParentTotal = childAccountSummaryResult.parentTotal;
  const parentAccountSummaries = childAccountSummaryResult.parents || [];

  const peopleSummary = useMemo(() => {
    if (!accounts.length) {
      return { totals: [], missingAccounts: [], hasBalances: false };
    }
    // In symbol mode, compute using symbol-filtered positions only
    if (focusedSymbol && Array.isArray(symbolFilteredPositions.list)) {
      const accountMap = new Map();
      accounts.forEach((account) => {
        if (account && account.id) {
          accountMap.set(account.id, account);
        }
      });
      const buckets = new Map(); // beneficiary -> { total, dayPnl, openPnl, accounts:set }
      symbolFilteredPositions.list.forEach((p) => {
        const accountId = p?.accountId;
        if (!accountId) return;
        const account = accountMap.get(accountId);
        const beneficiary = account?.beneficiary || 'Unassigned';
        const b = buckets.get(beneficiary) || { total: 0, dayPnl: 0, openPnl: 0, accounts: new Set() };
        b.total += Number(p?.normalizedMarketValue ?? p?.currentMarketValue ?? 0) || 0;
        b.dayPnl += Number(p?.normalizedDayPnl ?? p?.dayPnl ?? 0) || 0;
        b.openPnl += Number(p?.normalizedOpenPnl ?? p?.openPnl ?? 0) || 0;
        b.accounts.add(String(accountId));
        buckets.set(beneficiary, b);
      });
      const totals = Array.from(buckets.entries())
        .map(([beneficiary, agg]) => ({
          beneficiary,
          total: agg.total,
          dayPnl: agg.dayPnl,
          openPnl: agg.openPnl,
          accountCount: agg.accounts.size,
          totalAccounts: agg.accounts.size,
        }))
        .sort((a, b) => (b.total || 0) - (a.total || 0));
      return { totals, missingAccounts: [], hasBalances: totals.length > 0 };
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
    // Ensure People totals recompute when focusing or clearing a symbol
    focusedSymbol,
    symbolFilteredPositions,
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
      autoFixPendingWithdrawls: selectedAccountFunding?.autoFixPendingWithdrawls || null,
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

    // Build all-time annualized details from server-provided values.
    const baseAllTimeAnnualized = {
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
    const allTimeAnnualized = {
      rate: baseAllTimeAnnualized.rate,
      asOf: baseAllTimeAnnualized.asOf,
      incomplete: baseAllTimeAnnualized.incomplete,
      startDate: baseAllTimeAnnualized.startDate,
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
      if (formatted && formatted !== '?') {
        options.push({ value: 'cagr', label: `From ${formatted.replace(',', '')}` });
      }
    }
    // If there is no explicit cagrStartDate, show the concrete
    // all-time start date instead of a generic "From start".
    if (!cagrStartDate) {
      const allStart =
        fundingSummaryVariants?.allTime?.annualizedReturnStartDate ||
        fundingSummaryVariants?.allTime?.periodStartDate ||
        null;
      const allFormatted = allStart ? formatDate(allStart) : null;
      if (allFormatted && allFormatted !== '?') {
        options.push({ value: 'all', label: `From ${allFormatted.replace(',', '')}` });
      } else {
        options.push({ value: 'all', label: 'From start' });
      }
    } else {
      options.push({ value: 'all', label: 'From start' });
    }
    return options;
  }, [fundingSummaryVariants, cagrStartDate]);

  const selectedAccountTotalPnlSeries = useMemo(() => {
    if (!selectedAccountKey) {
      return null;
    }
    const map =
      data?.accountTotalPnlSeries && typeof data.accountTotalPnlSeries === 'object'
        ? data.accountTotalPnlSeries
        : null;
    if (!map) {
      return null;
    }
    const entry = map[selectedAccountKey] && typeof map[selectedAccountKey] === 'object' ? map[selectedAccountKey] : null;
    if (!entry) {
      return null;
    }
    const aggregateMode =
      selectedAccountKey === 'all' || isAccountGroupSelection(selectedAccountKey);
    const desiredMode = aggregateMode ? 'all' : totalPnlRange === 'all' ? 'all' : 'cagr';
    return entry[desiredMode] || entry.cagr || entry.all || null;
  }, [data?.accountTotalPnlSeries, selectedAccountKey, totalPnlRange]);

  const selectedTotalPnlSeriesStatus =
    totalPnlSeriesState.accountKey === selectedAccountKey
      ? totalPnlSeriesState.status
      : selectedAccountTotalPnlSeries
        ? 'success'
        : 'idle';
  const selectedTotalPnlSeriesError =
    totalPnlSeriesState.accountKey === selectedAccountKey && totalPnlSeriesState.status === 'error'
      ? totalPnlSeriesState.error
      : null;

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

    // For single accounts: honor account cagrStartDate
    if (!isAggregateSelection) {
      setTotalPnlRange(normalizedCagrStartDate ? 'cagr' : 'all');
      return;
    }

    // For groups or All: align with dialog behavior (always 'all')
    setTotalPnlRange('all');
  }, [
    selectedAccountKey,
    cagrStartDate,
    isAggregateSelection,
    selectedAccount,
    selectedAccountGroup?.accountIds,
    accountsInView,
    filteredAccountIds,
    accountsById,
    accountFunding,
  ]);

  const handleTotalPnlRangeChange = useCallback(
    (nextValue) => {
      const normalized = nextValue === 'all' ? 'all' : 'cagr';
      if (normalized === 'cagr' && !cagrStartDate) {
        return;
      }
      // When the user changes the main-page range, clear any dialog override.
      setPnlBreakdownUseAllOverride(null);
      setTotalPnlRange((current) => (current === normalized ? current : normalized));
    },
    [cagrStartDate]
  );

  const benchmarkPeriod = useMemo(() => {
    if (!fundingSummaryForDisplay && !totalPnlSelectionRange) {
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

    if (totalPnlSelectionRange?.startDate) {
      const normalizedStart = normalizeDate(totalPnlSelectionRange.startDate);
      if (!normalizedStart) {
        return null;
      }
      const normalizedEnd = normalizeDate(totalPnlSelectionRange.endDate);
      return {
        startDate: normalizedStart,
        endDate: normalizedEnd || null,
      };
    }

    const normalizedStart = normalizeDate(fundingSummaryForDisplay?.periodStartDate);
    if (!normalizedStart) {
      return null;
    }

    const normalizedEnd =
      normalizeDate(fundingSummaryForDisplay?.periodEndDate) ||
      normalizeDate(fundingSummaryForDisplay?.annualizedReturnAsOf) ||
      normalizeDate(asOf);

    return {
      startDate: normalizedStart,
      endDate: normalizedEnd || null,
    };
  }, [fundingSummaryForDisplay, asOf, totalPnlSelectionRange]);

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
  const earningsSummary = useMemo(() => {
    if (!earningsEnabled) {
      return null;
    }
    const payload = earningsState?.data;
    return {
      status: earningsState?.status || 'idle',
      todayCad: Number.isFinite(payload?.todayCad) ? payload.todayCad : null,
      yearlyCad: Number.isFinite(payload?.yearlyCad) ? payload.yearlyCad : null,
      unbilledCad: Number.isFinite(payload?.unbilledCad) ? payload.unbilledCad : null,
      error: earningsState?.error || null,
      updatedAt: typeof payload?.updatedAt === 'string' ? payload.updatedAt : null,
    };
  }, [earningsEnabled, earningsState]);
  const otherAssetsSummary = useMemo(() => {
    if (!showingAllAccounts) {
      return null;
    }
    const payload = data?.otherAssets;
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    const homeCad = coerceNumber(payload.homeCad);
    const vehiclesCad = coerceNumber(payload.vehiclesCad);
    const otherAssetsCad = coerceNumber(payload.otherAssetsCad);
    const totalCadFromPayload = coerceNumber(payload.totalCad);
    const hasAny =
      Number.isFinite(homeCad) ||
      Number.isFinite(vehiclesCad) ||
      Number.isFinite(otherAssetsCad) ||
      Number.isFinite(totalCadFromPayload);
    if (!hasAny) {
      return null;
    }
    const computedTotal = Number.isFinite(totalCadFromPayload)
      ? totalCadFromPayload
      : (Number.isFinite(homeCad) ? homeCad : 0) +
        (Number.isFinite(vehiclesCad) ? vehiclesCad : 0) +
        (Number.isFinite(otherAssetsCad) ? otherAssetsCad : 0);
    return {
      homeCad,
      vehiclesCad,
      otherAssetsCad,
      totalCad: computedTotal,
    };
  }, [data?.otherAssets, showingAllAccounts]);

  const baseDisplayTotalEquity = useMemo(() => {
    const canonical = resolveDisplayTotalEquity(balances);
    if (canonical !== null) {
      return canonical;
    }
    return coerceNumber(activeBalances?.totalEquity);
  }, [balances, activeBalances]);
  const unbilledEarningsCad =
    earningsSummary && Number.isFinite(earningsSummary.unbilledCad)
      ? earningsSummary.unbilledCad
      : null;
  const otherAssetsTotalCad =
    otherAssetsSummary && Number.isFinite(otherAssetsSummary.totalCad)
      ? otherAssetsSummary.totalCad
      : null;
  const canToggleUnbilledInTotalEquity =
    showingAllAccounts &&
    earningsEnabled &&
    Number.isFinite(baseDisplayTotalEquity) &&
    Number.isFinite(unbilledEarningsCad);
  const canToggleOtherAssetsInTotalEquity =
    showingAllAccounts &&
    Number.isFinite(baseDisplayTotalEquity) &&
    Number.isFinite(otherAssetsTotalCad);
  const includeUnbilledInTotalEquity =
    canToggleUnbilledInTotalEquity && includeUnbilledEarningsInTotalEquityPreference;
  const includeOtherAssetsInTotalEquity =
    canToggleOtherAssetsInTotalEquity && includeOtherAssetsInTotalEquityPreference;
  const displayTotalEquity = useMemo(() => {
    if (!Number.isFinite(baseDisplayTotalEquity)) {
      return baseDisplayTotalEquity;
    }
    if (!includeUnbilledInTotalEquity && !includeOtherAssetsInTotalEquity) {
      return baseDisplayTotalEquity;
    }
    let total = baseDisplayTotalEquity;
    if (includeUnbilledInTotalEquity) {
      total += unbilledEarningsCad;
    }
    if (includeOtherAssetsInTotalEquity) {
      total += otherAssetsTotalCad;
    }
    return total;
  }, [
    baseDisplayTotalEquity,
    includeUnbilledInTotalEquity,
    includeOtherAssetsInTotalEquity,
    unbilledEarningsCad,
    otherAssetsTotalCad,
  ]);
  const handleToggleUnbilledInTotalEquity = useCallback(() => {
    setIncludeUnbilledEarningsInTotalEquityPreference((value) => !value);
  }, [setIncludeUnbilledEarningsInTotalEquityPreference]);
  const handleToggleOtherAssetsInTotalEquity = useCallback(() => {
    setIncludeOtherAssetsInTotalEquityPreference((value) => !value);
  }, [setIncludeOtherAssetsInTotalEquityPreference]);
  const handleEditOtherAsset = useCallback(
    async (assetKey) => {
      if (!showingAllAccounts) {
        return;
      }
      const label = OTHER_ASSET_LABELS[assetKey];
      if (!label || typeof window === 'undefined') {
        return;
      }
      const currentValue = Number.isFinite(otherAssetsSummary?.[assetKey])
        ? otherAssetsSummary[assetKey]
        : null;
      const defaultValue = currentValue !== null ? String(Math.round(currentValue)) : '';
      const input = window.prompt(
        `Set ${label} value in CAD (e.g., 820000 or 820k)`,
        defaultValue
      );
      if (input === null) {
        return;
      }
      const trimmedInput = input.trim();
      if (!trimmedInput) {
        return;
      }
      const parsedValue = parseCadAmountInput(trimmedInput);
      if (!Number.isFinite(parsedValue) || parsedValue < 0) {
        window.alert('Enter a non-negative number (examples: 820000 or 820k).');
        return;
      }
      if (Number.isFinite(currentValue) && Math.abs(parsedValue - currentValue) < 0.005) {
        return;
      }
      try {
        await setOtherAssets({ [assetKey]: parsedValue });
        setRefreshKey((value) => value + 1);
      } catch (error) {
        console.error('Failed to update other assets', error);
        const message =
          error instanceof Error && error.message ? error.message : 'Failed to update other assets';
        window.alert(message);
      }
    },
    [otherAssetsSummary, setOtherAssets, setRefreshKey, showingAllAccounts]
  );

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

    const seenValues = new Set(entries.map((entry) => entry.value));

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
      seenValues.add(accountId);
    });

    accountGroups.forEach((group) => {
      if (!group || group.id === undefined || group.id === null) {
        return;
      }
      const groupId = String(group.id).trim();
      if (!groupId || seenValues.has(groupId)) {
        return;
      }
      const memberAccountIds = Array.isArray(group.accountIds)
        ? group.accountIds
            .map((value) => (value === undefined || value === null ? '' : String(value).trim()))
            .filter(Boolean)
        : [];
      if (!memberAccountIds.length) {
        return;
      }
      const memberSet = new Set(memberAccountIds);
      const groupPositions = rawPositions.filter((position) => {
        const rawAccountId = position?.accountId;
        if (rawAccountId === undefined || rawAccountId === null) {
          return false;
        }
        const normalized = String(rawAccountId);
        return normalized && memberSet.has(normalized);
      });
      if (!groupPositions.length) {
        return;
      }
      const prepared = preparePositionsForHeatmap(groupPositions, currencyRates, baseCurrency);
      const name = typeof group.name === 'string' && group.name.trim() ? group.name.trim() : groupId;
      entries.push({
        value: groupId,
        label: name,
        positions: prepared.positions,
        totalMarketValue: prepared.totalMarketValue,
      });
      seenValues.add(groupId);
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
    accountGroups,
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

  const breakdownScopeKey = useMemo(() => {
    if (isAggregateSelection) {
      if (typeof selectedAccount === 'string' && selectedAccount.trim()) {
        return selectedAccount.trim();
      }
      return 'all';
    }
    if (selectedAccountInfo?.id) {
      return String(selectedAccountInfo.id);
    }
    if (selectedAccount && accountsById.has(selectedAccount)) {
      return String(selectedAccount);
    }
    return 'all';
  }, [isAggregateSelection, selectedAccount, selectedAccountInfo, accountsById]);

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
          const overrideKey = buildRebalanceOverrideKey(rawAccountNumber || null, model.model);
          const overrideLast = lastRebalanceOverrides.get(overrideKey);
          accumulator.push({
            ...model,
            lastRebalance: overrideLast || model.lastRebalance,
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
    return resolveAccountModelsForDisplay(selectedAccountInfo).map((model) => {
      const overrideKey = buildRebalanceOverrideKey(rawAccountNumber || null, model.model);
      const overrideLast = lastRebalanceOverrides.get(overrideKey);
      return {
        ...model,
        lastRebalance: overrideLast || model.lastRebalance,
        accountId: selectedAccountInfo.id,
        accountLabel,
        accountNumber: rawAccountNumber || null,
      };
    });
  }, [selectedAccount, selectedAccountInfo, accountsInView, accountsById, lastRebalanceOverrides]);
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
        accountUrl: buildAccountSummaryUrl(accountInfo) || null,
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
  const filteredInvestmentModelSections = useMemo(() => {
    if (!focusedSymbol) {
      return investmentModelSections;
    }
    const key = String(focusedSymbol).trim().toUpperCase();
    return investmentModelSections.filter((section) => {
      const candidates = [section.symbol, section.leveragedSymbol, section.reserveSymbol]
        .map((s) => (typeof s === 'string' ? s.trim().toUpperCase() : ''));
      return candidates.includes(key);
    });
  }, [investmentModelSections, focusedSymbol]);
  const shouldShowInvestmentModels = filteredInvestmentModelSections.length > 0;
  const shouldShowQqqDetails = Boolean(selectedAccountInfo?.showQQQDetails);
  const modelsRequireAttention = useMemo(() => {
    if (!shouldShowInvestmentModels) {
      return false;
    }
    return filteredInvestmentModelSections.some((section) => getModelSectionPriority(section) === 0);
  }, [shouldShowInvestmentModels, filteredInvestmentModelSections]);
  const showModelsPanel = shouldShowInvestmentModels && portfolioViewTab === 'models';

  const investmentModelSymbolMap = useMemo(() => {
    if (!selectedAccountInfo?.id) {
      return null;
    }
    const targetAccountId = String(selectedAccountInfo.id);
    const map = new Map();
    filteredInvestmentModelSections.forEach((section) => {
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
  }, [selectedAccountInfo, filteredInvestmentModelSections]);

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
      filteredInvestmentModelSections.find((section) => {
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
  }, [activeInvestmentModelDialog, filteredInvestmentModelSections]);

  useEffect(() => {
    const allowedTabs = ['positions', 'orders'];
    if (hasDividendSummary) {
      allowedTabs.push('dividends');
    }
    if (shouldShowInvestmentModels) {
      allowedTabs.push('models');
    }
    if (isNewsFeatureEnabled) {
      allowedTabs.push('news');
    }
    if (!allowedTabs.includes(portfolioViewTab)) {
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
    if (portfolioViewTab === 'news' && !isNewsFeatureEnabled) {
      setPortfolioViewTab('positions');
    }
  }, [
    hasDividendSummary,
    isNewsFeatureEnabled,
    portfolioViewTab,
    setPortfolioViewTab,
    shouldShowInvestmentModels,
  ]);

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

    const activeCurrencyCode =
      typeof activeCurrency?.currency === 'string'
        ? activeCurrency.currency.trim().toUpperCase()
        : null;

    if (!activeCurrencyCode || activeCurrencyCode !== cashBreakdownCurrency) {
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
    (accountId, event) => {
      if (!accountId) {
        return;
      }
      const shouldOpenInNewTab = Boolean(
        event && (event.ctrlKey || event.metaKey || event.button === 1)
      );
      if (shouldOpenInNewTab) {
        const targetUrl = buildAccountViewUrl(accountId);
        if (targetUrl && typeof window !== 'undefined' && typeof window.open === 'function') {
          if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
          }
          if (event && typeof event.stopPropagation === 'function') {
            event.stopPropagation();
          }
          window.open(targetUrl, '_blank', 'noopener,noreferrer');
          return;
        }
      }
      setCashBreakdownCurrency(null);
      handleAccountChange(accountId);
    },
    [handleAccountChange, buildAccountViewUrl]
  );

  const activeCurrencyCode =
    typeof activeCurrency?.currency === 'string'
      ? activeCurrency.currency.trim().toUpperCase()
      : null;

  const cashBreakdownAvailable =
    showingAggregateAccounts &&
    activeCurrencyCode &&
    (activeCurrencyCode === 'CAD' || activeCurrencyCode === 'USD');

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

  const fetchQqqTemperature = useCallback((options = {}) => {
    const force = Boolean(options && options.force);
    if (qqqLoading && !force) {
      return;
    }
    setQqqLoading(true);
    setQqqError(null);
    getQqqTemperature(options)
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
    const symbol = typeof options?.symbol === 'string' && options.symbol.trim()
      ? options.symbol.trim().toUpperCase()
      : null;
    const rawGroupKey =
      options && typeof options === 'object' && typeof options.symbolGroupKey === 'string'
        ? options.symbolGroupKey.trim()
        : '';
    const symbolGroupKey = symbol ? (rawGroupKey || symbol) : null;
    const baseOptions = options && typeof options === 'object' ? { ...options } : {};
    const normalizedSymbols =
      symbol && Array.isArray(baseOptions.symbols)
        ? Array.from(
            new Set(
              baseOptions.symbols
                .map((sym) => (typeof sym === 'string' ? sym.trim().toUpperCase() : ''))
                .filter(Boolean)
            )
          )
        : null;
    const normalizedOptions = {
      ...(baseOptions || {}),
      applyAccountCagrStartDate: applyCagr,
      refreshKey,
    };
    if (!symbol) {
      delete normalizedOptions.symbolGroupKey;
      delete normalizedOptions.symbols;
    } else {
      normalizedOptions.symbolGroupKey = symbolGroupKey;
      if (normalizedSymbols && normalizedSymbols.length) {
        normalizedOptions.symbols = normalizedSymbols;
      } else {
        delete normalizedOptions.symbols;
      }
    }
    setTotalPnlSeriesState((prev) => ({
      status: 'loading',
      data:
        prev.accountKey === accountKey &&
        prev.mode === mode &&
        (prev.symbol || null) === (symbol || null) &&
        (prev.symbolGroupKey || null) === (symbolGroupKey || null)
          ? prev.data
          : null,
      error: null,
      accountKey,
      mode,
      symbol,
      symbolGroupKey,
    }));
    try {
      const payload = await getTotalPnlSeries(accountKey, normalizedOptions);
      setTotalPnlSeriesState({
        status: 'success',
        data: payload,
        error: null,
        accountKey,
        mode,
        symbol,
        symbolGroupKey,
      });
    } catch (err) {
      const normalized = err instanceof Error ? err : new Error('Failed to load Total P&L series');
      setTotalPnlSeriesState({
        status: 'error',
        data: null,
        error: normalized,
        accountKey,
        mode,
        symbol,
        symbolGroupKey,
      });
    }
  }, [refreshKey]);

  const doesSeriesMatchFocus = useCallback(
    (state) => {
      if (!focusedSymbol || !selectedAccountKey) return false;
      if (!state || state.accountKey !== selectedAccountKey) return false;
      const desiredGroupKey = focusedSymbolGroupKey || focusedSymbol || null;
      if ((state.symbolGroupKey || null) !== (desiredGroupKey || null)) {
        return false;
      }
      if ((state.symbol || null) === (focusedSymbol || null)) {
        return true;
      }
      if (!isFocusedSymbolDynamicGroup) {
        return false;
      }
      if (normalizedFocusedPriceSymbol && state.symbol === normalizedFocusedPriceSymbol) {
        return true;
      }
      if (focusedSymbolMembers.length && state.symbol === focusedSymbolMembers[0]) {
        return true;
      }
      return false;
    },
    [
      focusedSymbol,
      focusedSymbolGroupKey,
      focusedSymbolMembers,
      isFocusedSymbolDynamicGroup,
      normalizedFocusedPriceSymbol,
      selectedAccountKey,
    ]
  );

  // When a symbol is focused, proactively fetch its Total P&L series for the
  // current selection using earliest-hold start (no account CAGR shift),
  // avoiding extra user actions to see the chart.
  useEffect(() => {
    if (!focusedSymbol) {
      return;
    }
    const targetKey = selectedAccountKey;
    if (!targetKey) {
      return;
    }
    const desiredGroupKey = focusedSymbolGroupKey || focusedSymbol || null;
    const desiredSeriesSymbol = isFocusedSymbolDynamicGroup
      ? normalizedFocusedPriceSymbol ||
        (focusedSymbolMembers.length ? focusedSymbolMembers[0] : null) ||
        focusedSymbol
      : focusedSymbol;
    const alreadyActive =
      doesSeriesMatchFocus(totalPnlSeriesState) &&
      (totalPnlSeriesState.status === 'loading' || totalPnlSeriesState.status === 'success');
    if (alreadyActive) {
      return;
    }
    // For symbol series, start from the first date any relevant account held the symbol.
    fetchTotalPnlSeries(targetKey, {
      symbol: desiredSeriesSymbol,
      applyAccountCagrStartDate: false,
      symbolGroupKey: desiredGroupKey,
      symbols: focusedSymbolMembers,
    });
  }, [
    focusedSymbol,
    focusedSymbolGroupKey,
    selectedAccountKey,
    totalPnlSeriesState.accountKey,
    totalPnlSeriesState.symbol,
    totalPnlSeriesState.symbolGroupKey,
    totalPnlSeriesState.status,
    fetchTotalPnlSeries,
    isFocusedSymbolDynamicGroup,
    normalizedFocusedPriceSymbol,
    focusedSymbolMembers,
    doesSeriesMatchFocus,
  ]);

  useEffect(() => {
    if (!focusedSymbol) {
      setSymbolPriceSeriesState({ symbol: null, status: 'idle', data: null, error: null });
      return;
    }
    const targetSymbol = normalizedFocusedPriceSymbol || normalizedFocusedSymbolKey;
    if (!targetSymbol) {
      setSymbolPriceSeriesState({ symbol: null, status: 'idle', data: null, error: null });
      return;
    }
    let cancelled = false;
    setSymbolPriceSeriesState((prev) => {
      if (prev.symbol === targetSymbol && prev.status === 'loading') {
        return prev;
      }
      if (prev.symbol === targetSymbol && prev.status === 'success') {
        return prev;
      }
      return { symbol: targetSymbol, status: 'loading', data: prev.symbol === targetSymbol ? prev.data : null, error: null };
    });
    (async () => {
      try {
        const payload = await getSymbolPriceHistory(targetSymbol);
        if (cancelled) {
          return;
        }
        setSymbolPriceSeriesState({ symbol: targetSymbol, status: 'success', data: payload, error: null });
      } catch (error) {
        if (cancelled) {
          return;
        }
        const normalized = error instanceof Error ? error : new Error('Failed to load price history');
        setSymbolPriceSeriesState({ symbol: targetSymbol, status: 'error', data: null, error: normalized });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [focusedSymbol, normalizedFocusedPriceSymbol, normalizedFocusedSymbolKey, refreshKey]);

  const resolveAccountLabelByKey = useCallback(
    (accountKey) => {
      if (!accountKey) {
        return null;
      }
      if (accountKey === 'all') {
        return aggregateAccountLabel || 'All accounts';
      }
      const account = accountsById.get(accountKey);
      if (account) {
        const label = getAccountLabel(account);
        if (label) {
          return label;
        }
        const rawNumber =
          account.number !== undefined && account.number !== null
            ? String(account.number).trim()
            : account.accountNumber !== undefined && account.accountNumber !== null
              ? String(account.accountNumber).trim()
              : '';
        if (rawNumber) {
          return rawNumber;
        }
      }
      const group = accountGroupsById.get(accountKey);
      if (group) {
        const name = typeof group.name === 'string' ? group.name.trim() : '';
        if (name) {
          return name;
        }
      }
      return String(accountKey);
    },
    [accountsById, accountGroupsById, aggregateAccountLabel]
  );

  const resolveCagrStartDateForKey = useCallback(
    (accountKey) => {
      if (!accountKey) {
        return null;
      }
      const entry = accountFunding[accountKey];
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const value =
        typeof entry.cagrStartDate === 'string' && entry.cagrStartDate.trim()
          ? entry.cagrStartDate.trim()
          : null;
      return value;
    },
    [accountFunding]
  );

  const openTotalPnlDialogForAccount = useCallback(
    (accountKey, options = {}) => {
      if (accountKey === undefined || accountKey === null) {
        return;
      }
      const normalizedKey = String(accountKey).trim();
      if (!normalizedKey) {
        return;
      }
      const normalizedOptions = options && typeof options === 'object' ? options : {};
      const resolvedLabel =
        normalizedOptions.label ?? resolveAccountLabelByKey(normalizedKey) ?? normalizedKey;
      const resolvedCagrStart =
        normalizedOptions.cagrStartDate ?? resolveCagrStartDateForKey(normalizedKey) ?? null;
      const supportsCagrToggle =
        typeof normalizedOptions.supportsCagrToggle === 'boolean'
          ? normalizedOptions.supportsCagrToggle
          : normalizedKey !== 'all' && Boolean(resolvedCagrStart);
      const preferredMode =
        normalizedOptions.mode === 'all' || normalizedOptions.mode === 'cagr'
          ? normalizedOptions.mode
          : null;
      const desiredMode = supportsCagrToggle ? preferredMode ?? 'cagr' : 'all';
      const desiredGroupKey = focusedSymbol ? focusedSymbolGroupKey || focusedSymbol : null;
      const desiredSeriesSymbol =
        focusedSymbol && isFocusedSymbolDynamicGroup
          ? normalizedFocusedPriceSymbol || (focusedSymbolMembers.length ? focusedSymbolMembers[0] : null) || focusedSymbol
          : focusedSymbol;
      setTotalPnlDialogContext({
        accountKey: normalizedKey,
        label: resolvedLabel,
        supportsCagrToggle: Boolean(supportsCagrToggle),
        cagrStartDate: resolvedCagrStart,
      });
      setShowTotalPnlDialog(true);
      const needsFetch =
        totalPnlSeriesState.accountKey !== normalizedKey ||
        totalPnlSeriesState.mode !== desiredMode ||
        (focusedSymbol ? !doesSeriesMatchFocus(totalPnlSeriesState) : Boolean(totalPnlSeriesState.symbol)) ||
        totalPnlSeriesState.status === 'error' ||
        totalPnlSeriesState.status === 'idle';
      if (needsFetch) {
        const fetchOpts = { applyAccountCagrStartDate: focusedSymbol ? false : desiredMode !== 'all' };
        if (focusedSymbol) {
          fetchOpts.symbol = desiredSeriesSymbol || focusedSymbol;
          fetchOpts.symbolGroupKey = desiredGroupKey;
          fetchOpts.symbols = focusedSymbolMembers;
        }
        fetchTotalPnlSeries(normalizedKey, fetchOpts);
      }
    },
    [
      fetchTotalPnlSeries,
      resolveAccountLabelByKey,
      resolveCagrStartDateForKey,
      totalPnlSeriesState,
      focusedSymbol,
      focusedSymbolGroupKey,
      focusedSymbolMembers,
      isFocusedSymbolDynamicGroup,
      normalizedFocusedPriceSymbol,
      doesSeriesMatchFocus,
    ]
  );

  const handleShowTotalPnlDialog = useCallback(() => {
    if (!selectedAccountKey) {
      return;
    }
    openTotalPnlDialogForAccount(selectedAccountKey, { mode: totalPnlRange });
  }, [selectedAccountKey, totalPnlRange, openTotalPnlDialogForAccount]);

  const handleRetryTotalPnlSeries = useCallback(() => {
    const targetKey = totalPnlDialogContext.accountKey || selectedAccountKey;
    if (!targetKey) {
      return;
    }
    const applyCagr = totalPnlSeriesState.mode !== 'all';
    const desiredGroupKey = focusedSymbol ? focusedSymbolGroupKey || focusedSymbol : null;
    const desiredSeriesSymbol =
      focusedSymbol && isFocusedSymbolDynamicGroup
        ? normalizedFocusedPriceSymbol ||
          (focusedSymbolMembers.length ? focusedSymbolMembers[0] : null) ||
          focusedSymbol
        : focusedSymbol;
    const opts = { applyAccountCagrStartDate: focusedSymbol ? false : applyCagr };
    if (focusedSymbol) {
      opts.symbol = desiredSeriesSymbol || focusedSymbol;
      opts.symbolGroupKey = desiredGroupKey;
      opts.symbols = focusedSymbolMembers;
    }
    fetchTotalPnlSeries(targetKey, opts);
  }, [
    fetchTotalPnlSeries,
    selectedAccountKey,
    totalPnlDialogContext.accountKey,
    totalPnlSeriesState.mode,
    focusedSymbol,
    focusedSymbolGroupKey,
    focusedSymbolMembers,
    isFocusedSymbolDynamicGroup,
    normalizedFocusedPriceSymbol,
  ]);

  const handleCloseTotalPnlDialog = useCallback(() => {
    setShowTotalPnlDialog(false);
    setTotalPnlDialogContext({
      accountKey: null,
      label: null,
      supportsCagrToggle: false,
      cagrStartDate: null,
    });
  }, [setTotalPnlDialogContext]);

  const handleChangeTotalPnlSeriesMode = useCallback(
    (mode) => {
      const targetKey = totalPnlDialogContext.accountKey || selectedAccountKey;
      if (!targetKey) {
        return;
      }
      if (targetKey === 'all' && mode !== 'all') {
        return;
      }
      const normalizedMode = mode === 'all' ? 'all' : 'cagr';
      if (
        totalPnlSeriesState.accountKey === targetKey &&
        totalPnlSeriesState.mode === normalizedMode &&
        totalPnlSeriesState.status === 'success'
      ) {
        return;
      }
      const applyCagr = normalizedMode !== 'all';
      const desiredGroupKey = focusedSymbol ? focusedSymbolGroupKey || focusedSymbol : null;
      const desiredSeriesSymbol =
        focusedSymbol && isFocusedSymbolDynamicGroup
          ? normalizedFocusedPriceSymbol ||
            (focusedSymbolMembers.length ? focusedSymbolMembers[0] : null) ||
            focusedSymbol
          : focusedSymbol;
      const opts = { applyAccountCagrStartDate: applyCagr };
      if (focusedSymbol) {
        opts.symbol = desiredSeriesSymbol || focusedSymbol;
        opts.symbolGroupKey = desiredGroupKey;
        opts.symbols = focusedSymbolMembers;
      }
      fetchTotalPnlSeries(targetKey, opts);
    },
    [
      totalPnlDialogContext.accountKey,
      selectedAccountKey,
      totalPnlSeriesState.accountKey,
      totalPnlSeriesState.mode,
      totalPnlSeriesState.status,
      fetchTotalPnlSeries,
      focusedSymbol,
      focusedSymbolGroupKey,
      focusedSymbolMembers,
      isFocusedSymbolDynamicGroup,
      normalizedFocusedPriceSymbol,
    ]
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
  const isRefreshing = (loading && hasData) || priceRefreshInFlight;
  const showContent = hasData;
  const isMissingLoginsError =
    !demoModeActive &&
    Boolean(
      error &&
        (error.code === 'NO_LOGINS' ||
          (typeof error.message === 'string' && /no questrade logins configured yet/i.test(error.message)))
    );
  const isInvalidRefreshTokenError =
    !demoModeActive && Boolean(error && error.code === 'INVALID_REFRESH_TOKEN');
  const invalidRefreshLogin =
    isInvalidRefreshTokenError && error && error.login && typeof error.login === 'object'
      ? error.login
      : null;
  const invalidRefreshLoginLabel = invalidRefreshLogin
    ? invalidRefreshLogin.label || invalidRefreshLogin.email || invalidRefreshLogin.id || null
    : null;
  const loginSetupNotice = isInvalidRefreshTokenError
    ? `Your Questrade refresh token${invalidRefreshLoginLabel ? ' for ' + invalidRefreshLoginLabel : ''} is no longer valid. Generate a new token and paste it below to reconnect.`
    : null;
  const loginSetupPrefillEmail = (() => {
    if (!isInvalidRefreshTokenError || !invalidRefreshLogin) {
      return '';
    }
    const candidate = invalidRefreshLogin.email || invalidRefreshLogin.id || '';
    return typeof candidate === 'string' ? candidate.trim() : '';
  })();
  const loginDialogMode = isInvalidRefreshTokenError ? 'reconnect' : 'setup';

  useEffect(() => {
    if (!isMissingLoginsError) {
      return;
    }
    setShowLoginSetupDialog(true);
    setLoginSetupPrompted(true);
  }, [isMissingLoginsError]);

  useEffect(() => {
    if (!isInvalidRefreshTokenError) {
      if (invalidRefreshTokenPrompted) {
        setInvalidRefreshTokenPrompted(false);
      }
      return;
    }
    if (invalidRefreshTokenPrompted) {
      return;
    }
    setShowLoginSetupDialog(true);
    setLoginSetupPrompted(true);
    setInvalidRefreshTokenPrompted(true);
  }, [isInvalidRefreshTokenError, invalidRefreshTokenPrompted]);

  const handleShowPnlBreakdown = useCallback(
    (mode, accountKey = null, options = {}) => {
      if (!showContent || !orderedPositions.length) {
        return;
      }
      if (mode !== 'day' && mode !== 'open' && mode !== 'total') {
        return;
      }
      // Clear any dialog-based override unless the caller asks to preserve it
      const preserveOverride = Boolean(options && options.preserveOverride);
      if (!preserveOverride) {
        setPnlBreakdownUseAllOverride(null);
      }
       const rangeOption =
        options && options.range && typeof options.range === 'object' ? options.range : null;
      if (
        mode === 'total' &&
        rangeOption &&
        typeof rangeOption.startDate === 'string' &&
        typeof rangeOption.endDate === 'string'
      ) {
        setPnlBreakdownRange({
          startDate: rangeOption.startDate,
          endDate: rangeOption.endDate,
          startLabel: rangeOption.startLabel || null,
          endLabel: rangeOption.endLabel || null,
          startValueLabel: rangeOption.startValueLabel || null,
          endValueLabel: rangeOption.endValueLabel || null,
          changeLabel: rangeOption.changeLabel || null,
          deltaValue: Number.isFinite(rangeOption.deltaValue) ? rangeOption.deltaValue : null,
        });
      } else if (mode === 'total') {
        setPnlBreakdownRange(null);
      } else {
        setPnlBreakdownRange(null);
      }
      const normalizedAccountKey =
        accountKey === undefined || accountKey === null ? null : String(accountKey).trim();
      if (normalizedAccountKey) {
        setPnlBreakdownInitialAccount(normalizedAccountKey);
      } else {
        setPnlBreakdownInitialAccount(null);
      }
      setPnlBreakdownMode(mode);
    },
    [showContent, orderedPositions.length]
  );

  const handleShowChildPnlBreakdown = useCallback(
    (accountKey, mode) => {
      if (!accountKey || (mode !== 'day' && mode !== 'open')) {
        return;
      }
      handleShowPnlBreakdown(mode, accountKey);
    },
    [handleShowPnlBreakdown]
  );

  const handleShowRangePnlBreakdown = useCallback(
    (rangeInfo) => {
      if (!rangeInfo || typeof rangeInfo.startDate !== 'string' || typeof rangeInfo.endDate !== 'string') {
        return;
      }
      handleShowPnlBreakdown('total', null, { range: rangeInfo });
    },
    [handleShowPnlBreakdown]
  );

  const handleTotalPnlRangeSelectionChange = useCallback((rangeInfo) => {
    if (!rangeInfo || typeof rangeInfo.startDate !== 'string' || typeof rangeInfo.endDate !== 'string') {
      setTotalPnlSelectionRange(null);
      return;
    }
    setTotalPnlSelectionRange({
      startDate: rangeInfo.startDate,
      endDate: rangeInfo.endDate,
    });
  }, []);

  const handleClearPnlBreakdownRange = useCallback(() => {
    setPnlBreakdownRange(null);
    setRangeBreakdownState({ status: 'idle', key: null, data: null, error: null });
    setTotalPnlSelectionResetKey((value) => value + 1);
  }, []);

  const handleRetryRangeBreakdown = useCallback(() => {
    if (rangeBreakdownState?.key) {
      rangeBreakdownCacheRef.current.delete(rangeBreakdownState.key);
    }
    setRangeBreakdownRequestId((value) => value + 1);
  }, [rangeBreakdownState?.key]);

  const handleTotalPnlSelectionCleared = useCallback(() => {
    setPnlBreakdownRange(null);
    setTotalPnlSelectionRange(null);
  }, []);

  const handleShowChildTotalPnl = useCallback(
    (accountKey, child) => {
      if (accountKey === undefined || accountKey === null) {
        return;
      }
      const normalizedKey = String(accountKey).trim();
      if (!normalizedKey) {
        return;
      }
      const label = child?.label || resolveAccountLabelByKey(normalizedKey);
      const cagrStart = child?.cagrStartDate || resolveCagrStartDateForKey(normalizedKey);
      const supportsCagr =
        typeof child?.supportsCagrToggle === 'boolean'
          ? child.supportsCagrToggle
          : normalizedKey !== 'all' && Boolean(cagrStart);
      openTotalPnlDialogForAccount(normalizedKey, {
        label,
        cagrStartDate: cagrStart,
        supportsCagrToggle: supportsCagr,
        mode: totalPnlRange,
      });
    },
    [
      openTotalPnlDialogForAccount,
      resolveAccountLabelByKey,
      resolveCagrStartDateForKey,
      totalPnlRange,
    ]
  );

  const handleShowTotalPnlBreakdownFromDialog = useCallback(() => {
    const accountKey = totalPnlDialogContext.accountKey || selectedAccountKey;
    if (!accountKey) {
      return;
    }
    // Capture the dialog's current mode before closing it so the
    // breakdown reflects that exact choice.
    setPnlBreakdownUseAllOverride(totalPnlSeriesState.mode === 'all');
    handleCloseTotalPnlDialog();
    handleShowPnlBreakdown('total', accountKey, { preserveOverride: true });
  }, [
    totalPnlDialogContext.accountKey,
    selectedAccountKey,
    handleCloseTotalPnlDialog,
    handleShowPnlBreakdown,
    totalPnlSeriesState.mode,
  ]);

  useEffect(() => {
    if (pnlBreakdownMode !== 'total' || !pnlBreakdownRange) {
      setRangeBreakdownState({ status: 'idle', key: null, data: null, error: null });
      return;
    }
    if (!breakdownScopeKey) {
      setRangeBreakdownState({
        status: 'error',
        key: null,
        data: null,
        error: new Error('Unable to determine account scope for range breakdown.'),
      });
      return;
    }
    const normalizedScope = breakdownScopeKey;
    const fetchKey = `${normalizedScope}|${pnlBreakdownRange.startDate}|${pnlBreakdownRange.endDate}`;
    const cached = rangeBreakdownCacheRef.current.get(fetchKey);
    if (cached) {
      setRangeBreakdownState({ status: 'ready', key: fetchKey, data: cached, error: null });
      return;
    }
    let cancelled = false;
    setRangeBreakdownState({ status: 'loading', key: fetchKey, data: null, error: null });
    getRangeTotalPnlBreakdown({
      scope: normalizedScope,
      startDate: pnlBreakdownRange.startDate,
      endDate: pnlBreakdownRange.endDate,
    })
      .then((payload) => {
        if (cancelled) {
          return;
        }
        rangeBreakdownCacheRef.current.set(fetchKey, payload);
        setRangeBreakdownState({ status: 'ready', key: fetchKey, data: payload, error: null });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const normalizedError =
          error instanceof Error ? error : new Error('Failed to load Total P&L breakdown for range');
        setRangeBreakdownState({ status: 'error', key: fetchKey, data: null, error: normalizedError });
      });
    return () => {
      cancelled = true;
    };
  }, [pnlBreakdownMode, pnlBreakdownRange, breakdownScopeKey, rangeBreakdownRequestId]);

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
      positions: rawPositions,
      norbertJournalMap: accountNorbertJournals,
    });
  }, [todoAccountIds, accountsById, accountBalances, investmentModelSections, rawPositions, accountNorbertJournals]);

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
    const items = computeTodos();
    setTodoState((prev) => {
      if (prev.scopeKey === todoScopeKey && prev.checked && areTodoListsEqual(prev.items, items)) {
        return prev;
      }
      return { items, checked: true, scopeKey: todoScopeKey };
    });
  }, [showContent, todoScopeKey, computeTodos]);

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
        todoSymbol:
          normalizedType === 'norbert' && item.symbol ? String(item.symbol).toUpperCase() : null,
        todoJournalDate:
          normalizedType === 'norbert' && item.journalDate ? String(item.journalDate) : null,
        todoDirection:
          normalizedType === 'norbert' && item.direction ? String(item.direction) : null,
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
      return;
    }

    if (normalizedType === 'norbert') {
      const symbol = typeof item.symbol === 'string' ? item.symbol.trim().toUpperCase() : null;
      const journalDate = typeof item.journalDate === 'string' ? item.journalDate.trim() : null;
      const direction = typeof item.direction === 'string' ? item.direction.trim().toLowerCase() : null;
      const targetAccountNumber =
        item.accountNumber !== undefined && item.accountNumber !== null
          ? String(item.accountNumber).trim()
          : null;
      setPendingTodoAction({
        type: 'norbert',
        accountId,
        symbol,
        journalDate,
        direction,
        accountNumber: targetAccountNumber,
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
      // Optimistically update the UI immediately
      const todayIso = new Date().toISOString().slice(0, 10);
      const key = buildRebalanceOverrideKey(markRebalanceContext.accountNumber, markRebalanceContext.model);
      setLastRebalanceOverrides((prev) => {
        const next = new Map(prev);
        next.set(key, todayIso);
        return next;
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
        // Optimistically update the UI immediately
        const todayIso = new Date().toISOString().slice(0, 10);
        const key = buildRebalanceOverrideKey(rawAccountNumber, modelName);
        setLastRebalanceOverrides((prev) => {
          const next = new Map(prev);
          next.set(key, todayIso);
          return next;
        });
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
        accountKey: selectedAccountKey || null,
      };
    },
    [selectedAccountInfo, isAggregateSelection, aggregateAccountLabel, selectedAccountKey]
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
      return;
    }

    if (pendingTodoAction.type === 'norbert') {
      if (
        targetAccountId &&
        !positionsAlignedWithAccount(orderedPositions, targetAccountId)
      ) {
        return;
      }

      const targetSymbol = pendingTodoAction.symbol
        ? pendingTodoAction.symbol.toUpperCase()
        : null;
      if (targetSymbol) {
        handleSearchSelectSymbol(targetSymbol);
      }
      setPortfolioViewTab('portfolio');

      if (targetAccountId) {
        const targetAccount = accountsById.get(targetAccountId);
        if (targetAccount) {
          openAccountSummary(targetAccount);
        }
      }

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
    handleSearchSelectSymbol,
    setPortfolioViewTab,
    openAccountSummary,
  ]);


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

  const scrollPositionsCardIntoView = useCallback(() => {
    const target = positionsCardRef.current;
    if (!target || typeof target.scrollIntoView !== 'function') {
      return;
    }
    try {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      target.scrollIntoView();
    }
  }, [positionsCardRef]);

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
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => {
          scrollPositionsCardIntoView();
        });
      } else {
        scrollPositionsCardIntoView();
      }
    },
    [scrollPositionsCardIntoView, setOrdersFilter, setPortfolioViewTab]
  );

  const focusedSymbolAccountOptions = useMemo(() => {
    if (!focusedSymbol) {
      return [];
    }
    const source = Array.isArray(symbolFilteredPositions?.list)
      ? symbolFilteredPositions.list
      : [];
    if (!source.length) {
      return [];
    }
    const unique = new Map();
    source.forEach((position) => {
      const candidates = listAccountsForPosition(position, { accountsById, accountsByNumber });
      candidates.forEach((candidate) => {
        if (!candidate || !candidate.key) {
          return;
        }
        if (!unique.has(candidate.key)) {
          unique.set(candidate.key, candidate);
          return;
        }
        const existing = unique.get(candidate.key);
        const existingScore =
          (existing.description ? 1 : 0) + (existing.ownerLabel ? 1 : 0);
        const candidateScore =
          (candidate.description ? 1 : 0) + (candidate.ownerLabel ? 1 : 0);
        if (candidateScore > existingScore) {
          unique.set(candidate.key, candidate);
        }
      });
    });
    if (!unique.size) {
      return [];
    }
    return Array.from(unique.values()).sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
    );
  }, [focusedSymbol, symbolFilteredPositions, accountsById, accountsByNumber]);

  const focusedSymbolAccountCount = focusedSymbolAccountOptions.length;
  const focusedSymbolHasMultipleAccounts = focusedSymbolAccountCount > 1;
  const focusedSymbolHasPosition = Boolean(findFocusedSymbolPosition());
  const showFocusedSymbolGoToAccount = focusedSymbolHasPosition && !focusedSymbolHasMultipleAccounts;

  handleFocusedSymbolBuySell = useCallback(async () => {
    if (!focusedSymbol) {
      return;
    }
    const symbolForTrade =
      (focusedSymbolPriceSymbol && String(focusedSymbolPriceSymbol).trim()) ||
      (focusedSymbolMembers.length ? focusedSymbolMembers[0] : null) ||
      focusedSymbol;
    const position = findFocusedSymbolPosition();
    await triggerBuySell({
      symbol: symbolForTrade,
      position,
      accountOptionsOverride: focusedSymbolAccountOptions,
    });
  }, [
    focusedSymbol,
    focusedSymbolMembers,
    focusedSymbolPriceSymbol,
    findFocusedSymbolPosition,
    triggerBuySell,
    focusedSymbolAccountOptions,
  ]);

  const handleFocusedSymbolMenuBuySell = useCallback(() => {
    closeFocusedSymbolMenu();
    handleFocusedSymbolBuySell();
  }, [closeFocusedSymbolMenu, handleFocusedSymbolBuySell]);

  const handleFocusedSymbolMenuGoToAccount = useCallback(() => {
    const position = findFocusedSymbolPosition();
    closeFocusedSymbolMenu();
    if (!position || focusedSymbolHasMultipleAccounts) {
      return;
    }
    const account =
      (focusedSymbolAccountOptions.length === 1 && focusedSymbolAccountOptions[0]?.account)
        ? focusedSymbolAccountOptions[0].account
        : resolveAccountForPosition(position, accountsById);
    if (!account) {
      return;
    }
    handleGoToAccountFromSymbol(position, account);
  }, [
    accountsById,
    closeFocusedSymbolMenu,
    focusedSymbolAccountOptions,
    focusedSymbolHasMultipleAccounts,
    findFocusedSymbolPosition,
    handleGoToAccountFromSymbol,
  ]);

  const handleFocusedSymbolMenuOrders = useCallback(() => {
    const position = findFocusedSymbolPosition();
    closeFocusedSymbolMenu();
    if (position) {
      handleShowSymbolOrders(position);
    }
  }, [closeFocusedSymbolMenu, findFocusedSymbolPosition, handleShowSymbolOrders]);

  const handleFocusedSymbolMenuNotes = useCallback(() => {
    const position = findFocusedSymbolPosition();
    closeFocusedSymbolMenu();
    if (position) {
      handleShowSymbolNotes(position);
    }
  }, [closeFocusedSymbolMenu, findFocusedSymbolPosition, handleShowSymbolNotes]);

  const handleFocusedSymbolMenuExplain = useCallback(() => {
    closeFocusedSymbolMenu();
    handleExplainMovementForSymbol();
  }, [closeFocusedSymbolMenu, handleExplainMovementForSymbol]);

  useEffect(() => {
    if (!pendingSymbolAction || !pendingSymbolAction.symbol) {
      return;
    }
    const { symbol, intent } = pendingSymbolAction;
    if (!symbol || symbol !== focusedSymbol) {
      return;
    }
    if (intent === 'buy' || intent === 'sell') {
      handleFocusedSymbolBuySell();
    }
    setPendingSymbolAction(null);
  }, [pendingSymbolAction, focusedSymbol, handleFocusedSymbolBuySell, setPendingSymbolAction]);

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

      setAccountPlanningContexts((prev) => {
        const next = { ...(prev && typeof prev === 'object' ? prev : {}) };
        const normalizedKey = String(accountKey);
        next[normalizedKey] = trimmed;
        return next;
      });
      setPlanningContextEditor(null);
      setRefreshKey((value) => value + 1);
    },
    [activePlanningContext, setAccountPlanningContexts, setPlanningContextEditor, setRefreshKey]
  );

  const handleOpenAccountMetadata = useCallback(() => {
    if (selectedAccountInfo) {
      const accountLabel = getAccountLabel(selectedAccountInfo) || 'Selected account';
      const models = resolveAccountModelsForDisplay(selectedAccountInfo);
      const accountKey = resolveAccountMetadataKey(selectedAccountInfo);
      const pendingOverride = accountKey ? pendingMetadataOverrides.get(accountKey) : null;
      const initialBase = {
        displayName:
          (selectedAccountInfo.displayName && selectedAccountInfo.displayName.trim()) ||
          (selectedAccountInfo.name && selectedAccountInfo.name.trim()) ||
          '',
        accountGroup: (selectedAccountInfo.accountGroup && selectedAccountInfo.accountGroup) || '',
        portalAccountId: (selectedAccountInfo.portalAccountId && selectedAccountInfo.portalAccountId) || '',
        chatURL: (selectedAccountInfo.chatURL && selectedAccountInfo.chatURL) || '',
        cagrStartDate: (selectedAccountInfo.cagrStartDate && selectedAccountInfo.cagrStartDate) || '',
        rebalancePeriod:
          selectedAccountInfo.rebalancePeriod !== undefined && selectedAccountInfo.rebalancePeriod !== null
            ? selectedAccountInfo.rebalancePeriod
            : '',
        ignoreSittingCash:
          selectedAccountInfo.ignoreSittingCash !== undefined && selectedAccountInfo.ignoreSittingCash !== null
            ? selectedAccountInfo.ignoreSittingCash
            : '',
        mainRetirementAccount: selectedAccountInfo.mainRetirementAccount === true,
        retirementAge:
          selectedAccountInfo.retirementAge !== undefined && selectedAccountInfo.retirementAge !== null
            ? selectedAccountInfo.retirementAge
            : '',
        retirementYear:
          selectedAccountInfo.retirementYear !== undefined && selectedAccountInfo.retirementYear !== null
            ? selectedAccountInfo.retirementYear
            : '',
        retirementIncome:
          selectedAccountInfo.retirementIncome !== undefined && selectedAccountInfo.retirementIncome !== null
            ? selectedAccountInfo.retirementIncome
            : '',
        retirementLivingExpenses:
          selectedAccountInfo.retirementLivingExpenses !== undefined && selectedAccountInfo.retirementLivingExpenses !== null
            ? selectedAccountInfo.retirementLivingExpenses
            : '',
        retirementBirthDate:
          (selectedAccountInfo.retirementBirthDate && selectedAccountInfo.retirementBirthDate) || '',
        retirementInflationPercent:
          selectedAccountInfo.retirementInflationPercent !== undefined && selectedAccountInfo.retirementInflationPercent !== null
            ? selectedAccountInfo.retirementInflationPercent
            : '',
        retirementHouseholdType:
          (selectedAccountInfo.retirementHouseholdType && selectedAccountInfo.retirementHouseholdType) || 'single',
        retirementBirthDate1:
          (selectedAccountInfo.retirementBirthDate1 && selectedAccountInfo.retirementBirthDate1) || (selectedAccountInfo.retirementBirthDate || ''),
        retirementBirthDate2:
          (selectedAccountInfo.retirementBirthDate2 && selectedAccountInfo.retirementBirthDate2) || '',
        retirementCppYearsContributed1:
          selectedAccountInfo.retirementCppYearsContributed1 !== undefined && selectedAccountInfo.retirementCppYearsContributed1 !== null
            ? selectedAccountInfo.retirementCppYearsContributed1
            : '',
        retirementCppAvgEarningsPctOfYMPE1:
          selectedAccountInfo.retirementCppAvgEarningsPctOfYMPE1 !== undefined && selectedAccountInfo.retirementCppAvgEarningsPctOfYMPE1 !== null
            ? selectedAccountInfo.retirementCppAvgEarningsPctOfYMPE1
            : '',
        retirementCppStartAge1:
          selectedAccountInfo.retirementCppStartAge1 !== undefined && selectedAccountInfo.retirementCppStartAge1 !== null
            ? selectedAccountInfo.retirementCppStartAge1
            : '',
        retirementOasYearsResident1:
          selectedAccountInfo.retirementOasYearsResident1 !== undefined && selectedAccountInfo.retirementOasYearsResident1 !== null
            ? selectedAccountInfo.retirementOasYearsResident1
            : '',
        retirementOasStartAge1:
          selectedAccountInfo.retirementOasStartAge1 !== undefined && selectedAccountInfo.retirementOasStartAge1 !== null
            ? selectedAccountInfo.retirementOasStartAge1
            : '',
        retirementCppYearsContributed2:
          selectedAccountInfo.retirementCppYearsContributed2 !== undefined && selectedAccountInfo.retirementCppYearsContributed2 !== null
            ? selectedAccountInfo.retirementCppYearsContributed2
            : '',
        retirementCppAvgEarningsPctOfYMPE2:
          selectedAccountInfo.retirementCppAvgEarningsPctOfYMPE2 !== undefined && selectedAccountInfo.retirementCppAvgEarningsPctOfYMPE2 !== null
            ? selectedAccountInfo.retirementCppAvgEarningsPctOfYMPE2
            : '',
        retirementCppStartAge2:
          selectedAccountInfo.retirementCppStartAge2 !== undefined && selectedAccountInfo.retirementCppStartAge2 !== null
            ? selectedAccountInfo.retirementCppStartAge2
            : '',
        retirementOasYearsResident2:
          selectedAccountInfo.retirementOasYearsResident2 !== undefined && selectedAccountInfo.retirementOasYearsResident2 !== null
            ? selectedAccountInfo.retirementOasYearsResident2
            : '',
        retirementOasStartAge2:
          selectedAccountInfo.retirementOasStartAge2 !== undefined && selectedAccountInfo.retirementOasStartAge2 !== null
            ? selectedAccountInfo.retirementOasStartAge2
            : '',
        retirementCppMaxAt65Annual:
          selectedAccountInfo.retirementCppMaxAt65Annual !== undefined && selectedAccountInfo.retirementCppMaxAt65Annual !== null
            ? selectedAccountInfo.retirementCppMaxAt65Annual
            : '',
        retirementOasFullAt65Annual:
          selectedAccountInfo.retirementOasFullAt65Annual !== undefined && selectedAccountInfo.retirementOasFullAt65Annual !== null
            ? selectedAccountInfo.retirementOasFullAt65Annual
            : '',
      };
      const initial = pendingOverride ? { ...initialBase, ...pendingOverride } : initialBase;
      setAccountMetadataEditor({
        accountKey,
        accountLabel,
        targetType: 'account',
        initial,
        models,
      });
      return;
    }
    if (isAccountGroupSelection(selectedAccount) && selectedAccountGroup) {
      const groupLabel = selectedAccountGroup.name || 'Selected group';
      const accountKey = resolveGroupMetadataKey(selectedAccountGroup);
      const pendingOverride = accountKey ? pendingMetadataOverrides.get(accountKey) : null;
      const initialBase = {
        displayName: groupLabel,
        accountGroup: '',
        portalAccountId: '',
        chatURL: '',
        cagrStartDate: '',
        rebalancePeriod: '',
        ignoreSittingCash: '',
        mainRetirementAccount: selectedAccountGroup.mainRetirementAccount === true,
        retirementAge:
          selectedAccountGroup.retirementAge !== undefined && selectedAccountGroup.retirementAge !== null
            ? selectedAccountGroup.retirementAge
            : '',
        retirementYear:
          selectedAccountGroup.retirementYear !== undefined && selectedAccountGroup.retirementYear !== null
            ? selectedAccountGroup.retirementYear
            : '',
        retirementIncome:
          selectedAccountGroup.retirementIncome !== undefined && selectedAccountGroup.retirementIncome !== null
            ? selectedAccountGroup.retirementIncome
            : '',
        retirementLivingExpenses:
          selectedAccountGroup.retirementLivingExpenses !== undefined &&
          selectedAccountGroup.retirementLivingExpenses !== null
            ? selectedAccountGroup.retirementLivingExpenses
            : '',
        retirementBirthDate:
          (selectedAccountGroup.retirementBirthDate && selectedAccountGroup.retirementBirthDate) || '',
        retirementInflationPercent:
          selectedAccountGroup.retirementInflationPercent !== undefined &&
          selectedAccountGroup.retirementInflationPercent !== null
            ? selectedAccountGroup.retirementInflationPercent
            : '',
        retirementHouseholdType:
          (selectedAccountGroup.retirementHouseholdType && selectedAccountGroup.retirementHouseholdType) || 'single',
        retirementBirthDate1:
          (selectedAccountGroup.retirementBirthDate1 && selectedAccountGroup.retirementBirthDate1) || (selectedAccountGroup.retirementBirthDate || ''),
        retirementBirthDate2:
          (selectedAccountGroup.retirementBirthDate2 && selectedAccountGroup.retirementBirthDate2) || '',
        retirementCppYearsContributed1:
          selectedAccountGroup.retirementCppYearsContributed1 !== undefined && selectedAccountGroup.retirementCppYearsContributed1 !== null
            ? selectedAccountGroup.retirementCppYearsContributed1
            : '',
        retirementCppAvgEarningsPctOfYMPE1:
          selectedAccountGroup.retirementCppAvgEarningsPctOfYMPE1 !== undefined && selectedAccountGroup.retirementCppAvgEarningsPctOfYMPE1 !== null
            ? selectedAccountGroup.retirementCppAvgEarningsPctOfYMPE1
            : '',
        retirementCppStartAge1:
          selectedAccountGroup.retirementCppStartAge1 !== undefined && selectedAccountGroup.retirementCppStartAge1 !== null
            ? selectedAccountGroup.retirementCppStartAge1
            : '',
        retirementOasYearsResident1:
          selectedAccountGroup.retirementOasYearsResident1 !== undefined && selectedAccountGroup.retirementOasYearsResident1 !== null
            ? selectedAccountGroup.retirementOasYearsResident1
            : '',
        retirementOasStartAge1:
          selectedAccountGroup.retirementOasStartAge1 !== undefined && selectedAccountGroup.retirementOasStartAge1 !== null
            ? selectedAccountGroup.retirementOasStartAge1
            : '',
        retirementCppYearsContributed2:
          selectedAccountGroup.retirementCppYearsContributed2 !== undefined && selectedAccountGroup.retirementCppYearsContributed2 !== null
            ? selectedAccountGroup.retirementCppYearsContributed2
            : '',
        retirementCppAvgEarningsPctOfYMPE2:
          selectedAccountGroup.retirementCppAvgEarningsPctOfYMPE2 !== undefined && selectedAccountGroup.retirementCppAvgEarningsPctOfYMPE2 !== null
            ? selectedAccountGroup.retirementCppAvgEarningsPctOfYMPE2
            : '',
        retirementCppStartAge2:
          selectedAccountGroup.retirementCppStartAge2 !== undefined && selectedAccountGroup.retirementCppStartAge2 !== null
            ? selectedAccountGroup.retirementCppStartAge2
            : '',
        retirementOasYearsResident2:
          selectedAccountGroup.retirementOasYearsResident2 !== undefined && selectedAccountGroup.retirementOasYearsResident2 !== null
            ? selectedAccountGroup.retirementOasYearsResident2
            : '',
        retirementOasStartAge2:
          selectedAccountGroup.retirementOasStartAge2 !== undefined && selectedAccountGroup.retirementOasStartAge2 !== null
            ? selectedAccountGroup.retirementOasStartAge2
            : '',
        retirementCppMaxAt65Annual:
          selectedAccountGroup.retirementCppMaxAt65Annual !== undefined && selectedAccountGroup.retirementCppMaxAt65Annual !== null
            ? selectedAccountGroup.retirementCppMaxAt65Annual
            : '',
        retirementOasFullAt65Annual:
          selectedAccountGroup.retirementOasFullAt65Annual !== undefined && selectedAccountGroup.retirementOasFullAt65Annual !== null
            ? selectedAccountGroup.retirementOasFullAt65Annual
            : '',
      };
      const initial = pendingOverride ? { ...initialBase, ...pendingOverride } : initialBase;
      setAccountMetadataEditor({
        accountKey,
        accountLabel: groupLabel,
        targetType: 'group',
        initial,
        models: [],
      });
    }
  }, [selectedAccountInfo, selectedAccountGroup, isAccountGroupSelection, pendingMetadataOverrides]);


  const handleCloseAccountMetadata = useCallback(() => {
    setAccountMetadataEditor(null);
  }, []);

  const handleSaveAccountMetadata = useCallback(
    async (payload) => {
      if (!accountMetadataEditor || !accountMetadataEditor.accountKey) {
        setAccountMetadataEditor(null);
        return;
      }
      try {
        await setAccountMetadata(accountMetadataEditor.accountKey, payload);
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : 'Failed to save account details.';
        throw new Error(message);
      }
      // Optimistically reflect latest edits when reopening the dialog before the refresh completes
      setPendingMetadataOverrides((prev) => {
        const next = new Map(prev);
        const key = String(accountMetadataEditor.accountKey);
        // Only keep fields that the editor can show; this prevents unexpected values from leaking in
        const safe = {};
        [
          'displayName',
          'accountGroup',
          'portalAccountId',
          'chatURL',
          'cagrStartDate',
          'rebalancePeriod',
          'ignoreSittingCash',
          'projectionGrowthPercent',
          'mainRetirementAccount',
          'retirementAge',
          'retirementYear',
          'retirementIncome',
          'retirementLivingExpenses',
          'retirementBirthDate',
          'retirementInflationPercent',
          // New retirement modeling fields
          'retirementHouseholdType',
          'retirementBirthDate1',
          'retirementBirthDate2',
          'retirementCppYearsContributed1',
          'retirementCppAvgEarningsPctOfYMPE1',
          'retirementOasYearsResident1',
          'retirementCppYearsContributed2',
          'retirementCppAvgEarningsPctOfYMPE2',
          'retirementOasYearsResident2',
          'retirementCppMaxAt65Annual',
          'retirementOasFullAt65Annual',
        ].forEach((k) => {
          if (Object.prototype.hasOwnProperty.call(payload, k)) {
            safe[k] = payload[k];
          }
        });
        next.set(key, safe);
        return next;
      });
      setAccountMetadataEditor(null);
      setRefreshKey((value) => value + 1);
    },
    [accountMetadataEditor, setRefreshKey, setPendingMetadataOverrides]
  );

  useEffect(() => {
    if (isAggregateSelection) {
      setPlanningContextEditor(null);
    }
  }, [isAggregateSelection, setPlanningContextEditor]);

  const handleProjectionGrowthPersisted = useCallback(
    (accountKey, percent) => {
      const rawKey = typeof accountKey === 'string' ? accountKey.trim() : '';
      if (!rawKey) {
        return;
      }

      let canonicalKey = rawKey;
      if (accountsById.has(rawKey)) {
        const account = accountsById.get(rawKey);
        const resolved = resolveAccountMetadataKey(account);
        if (resolved) {
          canonicalKey = resolved;
        }
      } else {
        for (const account of accountsById.values()) {
          if (!account || typeof account !== 'object') {
            continue;
          }
          const number =
            account.number !== undefined && account.number !== null
              ? String(account.number).trim()
              : '';
          if (number && number === rawKey) {
            const resolved = resolveAccountMetadataKey(account);
            if (resolved) {
              canonicalKey = resolved;
            }
            break;
          }
        }
      }

      const normalizedKey = canonicalKey.trim();
      if (!normalizedKey) {
        return;
      }

      const normalizedPercent = Number.isFinite(percent) ? Number(percent) : null;

      setPendingMetadataOverrides((prev) => {
        const next = new Map(prev);
        const existing = next.get(normalizedKey) || {};
        const updated = { ...existing, projectionGrowthPercent: normalizedPercent };
        next.set(normalizedKey, updated);
        return next;
      });
    },
    [accountsById, setPendingMetadataOverrides]
  );


  const handleShowProjections = useCallback(() => {
    if (!selectedAccountKey) {
      return;
    }
    const label = resolveAccountLabelByKey(selectedAccountKey) || 'Account';
    const cagrStart = cagrStartDate || null;
    let parentAccountId = null;
    // If current selection is a leaf account, try to resolve its parent group id
    if (selectedAccountInfo && typeof selectedAccountInfo.accountGroup === 'string') {
      const key = selectedAccountInfo.accountGroup.trim().toLowerCase();
      if (key) {
        const group = accountGroupsByNormalizedName.get(key) || null;
        if (group && group.id !== undefined && group.id !== null) {
          parentAccountId = String(group.id);
        }
      }
    }
    setProjectionContext({ accountKey: selectedAccountKey, label, cagrStartDate: cagrStart, parentAccountId, retireAtAge: null });
    setShowProjectionDialog(true);
  }, [
    selectedAccountKey,
    selectedAccountInfo,
    resolveAccountLabelByKey,
    cagrStartDate,
    accountGroupsByNormalizedName,
  ]);

  const handleCloseProjections = useCallback(() => {
    setShowProjectionDialog(false);
    setProjectionContext({ accountKey: null, label: null, cagrStartDate: null, parentAccountId: null, retireAtAge: null });
  }, []);

  const handleShowHoldingsPieChart = useCallback(() => {
    setShowHoldingsPieChart(true);
  }, []);

  const handleCloseHoldingsPieChart = useCallback(() => {
    setShowHoldingsPieChart(false);
  }, []);

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
      setPnlBreakdownInitialAccount(null);
    }
  }, [hasData, pnlBreakdownMode]);

  useEffect(() => {
    if (!showReturnBreakdown) {
      return;
    }
    if (!Array.isArray(fundingSummaryForDisplay?.returnBreakdown)) {
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
    fetchQqqTemperature({ force: true, includeLivePrice: true });
  }, [fetchQqqTemperature]);

  const handleRefreshQqqTemperature = useCallback(() => {
    fetchQqqTemperature({ force: true, includeLivePrice: true });
  }, [fetchQqqTemperature]);

  const handlePriceOnlyRefresh = useCallback(async () => {
    if (priceRefreshInFlight) {
      return;
    }
    if (!rawPositions.length) {
      return;
    }
    const symbols = rawPositions
      .map((position) => (typeof position?.symbol === 'string' ? position.symbol : ''))
      .filter(Boolean);
    if (!symbols.length) {
      return;
    }
    setPriceRefreshState((prev) => ({
      status: 'loading',
      error: null,
      refreshedAt: prev.refreshedAt,
    }));
    try {
      const { snapshots, failures } = await fetchQuotesForSymbols(symbols);
      if (!snapshots.size) {
        const failureMessage =
          failures.length && failures[0]?.error && failures[0].error.message
            ? failures[0].error.message
            : 'Failed to refresh prices';
        setPriceRefreshState((prev) => ({
          status: 'error',
          error: new Error(failureMessage),
          refreshedAt: prev.refreshedAt,
        }));
        return;
      }
      setSymbolPriceSnapshots((prev) => {
        const next = new Map(prev);
        snapshots.forEach((value, key) => {
          next.set(key, value);
        });
        return next;
      });
      if (failures.length) {
        console.warn('Some symbols failed to refresh during price update', failures);
      }
      setPriceRefreshState({
        status: 'success',
        error: null,
        refreshedAt: new Date().toISOString(),
      });
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error('Failed to refresh prices');
      setPriceRefreshState((prev) => ({
        status: 'error',
        error: normalizedError,
        refreshedAt: prev.refreshedAt,
      }));
    }
  }, [priceRefreshInFlight, rawPositions]);

  const handleRefresh = (event) => {
    if (event?.altKey) {
      event.preventDefault();
      handlePriceOnlyRefresh();
      return;
    }
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

  const handleRefreshEarnings = useCallback(() => {
    refreshEarnings();
  }, [refreshEarnings]);

  const handleClosePnlBreakdown = () => {
    setPnlBreakdownMode(null);
    setPnlBreakdownInitialAccount(null);
    setPnlBreakdownUseAllOverride(null);
    setRangeBreakdownState({ status: 'idle', key: null, data: null, error: null });
  };

  const handleShowAnnualizedReturnDetails = useCallback(() => {
    if (!Array.isArray(fundingSummaryForDisplay?.returnBreakdown)) {
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
  let investmentModelDialogAccountUrl = null;

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
    investmentModelDialogAccountUrl = activeAccountModelSection?.accountUrl || null;
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

  const activeTotalPnlAccountKey = totalPnlDialogContext.accountKey || selectedAccountKey;
  const totalPnlDialogDataBase =
    totalPnlSeriesState.accountKey === activeTotalPnlAccountKey ? totalPnlSeriesState.data : null;
  const totalPnlDialogLoading =
    totalPnlSeriesState.accountKey === activeTotalPnlAccountKey && totalPnlSeriesState.status === 'loading';
  const totalPnlDialogError =
    totalPnlSeriesState.accountKey === activeTotalPnlAccountKey && totalPnlSeriesState.status === 'error'
      ? totalPnlSeriesState.error
      : null;

  useEffect(() => {
    if (!activeTotalPnlAccountKey) {
      return;
    }
    const seriesMap = data?.accountTotalPnlSeries;
    const entry = seriesMap && typeof seriesMap === 'object' ? seriesMap[activeTotalPnlAccountKey] : null;
    const isAggregateSelectionMode =
      activeTotalPnlAccountKey === 'all' || isAccountGroupSelection(activeTotalPnlAccountKey);
    const desiredMode = isAggregateSelectionMode ? 'all' : 'cagr';
    const cachedSeries =
      entry && typeof entry === 'object'
        ? entry[desiredMode] || entry.cagr || entry.all || null
        : null;
    if (!cachedSeries) {
      return;
    }
    setTotalPnlSeriesState((prev) => {
      if (
        prev.accountKey === activeTotalPnlAccountKey &&
        prev.mode === desiredMode &&
        prev.status === 'success' &&
        prev.data === cachedSeries
      ) {
        return prev;
      }
      return {
        status: 'success',
        data: cachedSeries,
        error: null,
        accountKey: activeTotalPnlAccountKey,
        mode: desiredMode,
        symbol: null,
      };
    });
  }, [activeTotalPnlAccountKey, data?.accountTotalPnlSeries]);

  const resolveSymbolTotalsContainer = useCallback(
    (map) => {
      if (!map || typeof map !== 'object') {
        return null;
      }
      if (isAggregateSelection) {
        const key =
          typeof selectedAccount === 'string' && selectedAccount.trim()
            ? selectedAccount.trim()
            : 'all';
        return map[key] || map.all || map['all'] || null;
      }
      if (selectedAccountInfo?.id) {
        return map[selectedAccountInfo.id] || null;
      }
      return null;
    },
    [isAggregateSelection, selectedAccount, selectedAccountInfo?.id]
  );

  const focusedSymbolTotalsEntry = useMemo(() => {
    if (!focusedSymbol) {
      return { current: null, allTime: null };
    }
    const aggregateMatchingEntries = (container) => {
      if (!container || !Array.isArray(container.entries)) {
        return null;
      }
      const matching = container.entries.filter((entry) => {
        if (matchesFocusedSymbol(entry?.symbol)) {
          return true;
        }
        if (Array.isArray(entry?.components)) {
          return entry.components.some((component) => matchesFocusedSymbol(component?.symbol));
        }
        return false;
      });
      if (!matching.length) {
        return null;
      }
      const sumField = (field) => {
        let total = 0;
        let count = 0;
        matching.forEach((entry) => {
          const value = Number(entry?.[field]);
          if (Number.isFinite(value)) {
            total += value;
            count += 1;
          }
        });
        return count ? total : null;
      };
      const summedTotalPnl = sumField('totalPnlCad');
      const summedMarketValue = sumField('marketValueCad');
      const summedInvested = sumField('investedCad');
      // Derive a consistent net deposit from equity minus P&L so the identity holds
      // even when investedCad omits baseline positions (e.g., crypto group themes).
      const derivedInvested =
        Number.isFinite(summedMarketValue) && Number.isFinite(summedTotalPnl)
          ? summedMarketValue - summedTotalPnl
          : null;
      const mergedInvested =
        derivedInvested !== null && (summedInvested === null || Number.isNaN(summedInvested))
          ? derivedInvested
          : derivedInvested !== null && Number.isFinite(summedInvested)
            ? derivedInvested
            : summedInvested;
      const mergedComponents = (() => {
        const map = new Map();
        matching.forEach((entry) => {
          if (!Array.isArray(entry?.components)) {
            return;
          }
          entry.components.forEach((component) => {
            const key = component?.symbol ? normalizeSymbolGroupKey(component.symbol) || component.symbol : null;
            if (!key) {
              return;
            }
            const add = (v) => (Number.isFinite(v) ? v : 0);
            if (!map.has(key)) {
              map.set(key, {
                symbol: component.symbol || key,
                totalPnlCad: add(component.totalPnlCad),
                totalPnlWithFxCad: add(component.totalPnlWithFxCad),
                totalPnlNoFxCad: add(component.totalPnlNoFxCad),
                investedCad: add(component.investedCad),
                openQuantity: add(component.openQuantity),
                marketValueCad: add(component.marketValueCad),
              });
            } else {
              const existing = map.get(key);
              existing.totalPnlCad += add(component.totalPnlCad);
              existing.totalPnlWithFxCad += add(component.totalPnlWithFxCad);
              existing.totalPnlNoFxCad += add(component.totalPnlNoFxCad);
              existing.investedCad += add(component.investedCad);
              existing.openQuantity += add(component.openQuantity);
              existing.marketValueCad += add(component.marketValueCad);
              if (!existing.symbol && component.symbol) {
                existing.symbol = component.symbol;
              }
            }
          });
        });
        return map.size ? Array.from(map.values()) : undefined;
      })();
      const firstWithAnnualized = matching.find((entry) => entry?.annualizedReturn);
      const firstWithAnnualizedNoFx = matching.find((entry) => entry?.annualizedReturnNoFx);
      return {
        symbol: focusedSymbol,
        totalPnlCad: summedTotalPnl,
        investedCad: mergedInvested,
        openQuantity: sumField('openQuantity'),
        marketValueCad: summedMarketValue,
        currency: null,
        components: mergedComponents,
        annualizedReturn: firstWithAnnualized?.annualizedReturn || null,
        annualizedReturnNoFx: firstWithAnnualizedNoFx?.annualizedReturnNoFx || null,
      };
    };
    const currentContainer = resolveSymbolTotalsContainer(data?.accountTotalPnlBySymbol);
    const allContainer = resolveSymbolTotalsContainer(data?.accountTotalPnlBySymbolAll);
    return {
      current: aggregateMatchingEntries(currentContainer),
      allTime: aggregateMatchingEntries(allContainer),
    };
  }, [
    focusedSymbol,
    matchesFocusedSymbol,
    resolveSymbolTotalsContainer,
    data?.accountTotalPnlBySymbol,
    data?.accountTotalPnlBySymbolAll,
  ]);

  const symbolAnnualizedMapForPositions = useMemo(() => {
    const map = new Map();
    const preferAllTime = isAggregateSelection;
    const container = preferAllTime
      ? resolveSymbolTotalsContainer(data?.accountTotalPnlBySymbolAll) ||
        resolveSymbolTotalsContainer(data?.accountTotalPnlBySymbol)
      : resolveSymbolTotalsContainer(data?.accountTotalPnlBySymbol) ||
        resolveSymbolTotalsContainer(data?.accountTotalPnlBySymbolAll);
    const normalizeKey = (value) => normalizeSymbolGroupKey(value || '');
    if (!container || !Array.isArray(container.entries)) {
      return map;
    }
    container.entries.forEach((entry) => {
      const annualized = entry?.annualizedReturn || null;
      const annualizedNoFx = entry?.annualizedReturnNoFx || null;
      if (!annualized) {
        return;
      }
      const payload = {
        rate: Number.isFinite(Number(annualized.rate)) ? Number(annualized.rate) : null,
        rateNoFx: Number.isFinite(Number(annualizedNoFx?.rate)) ? Number(annualizedNoFx.rate) : null,
        startDate:
          typeof annualized.startDate === 'string' && annualized.startDate.trim()
            ? annualized.startDate.trim()
            : null,
        incomplete: annualized.incomplete === true,
      };
      const entryKey = normalizeKey(entry.symbol);
      if (entryKey) {
        map.set(entryKey, payload);
      }
      if (Array.isArray(entry.components)) {
        entry.components.forEach((component) => {
          const compKey = normalizeKey(component?.symbol);
          if (compKey && !map.has(compKey)) {
            map.set(compKey, payload);
          }
        });
      }
    });
    return map;
  }, [data?.accountTotalPnlBySymbolAll, data?.accountTotalPnlBySymbol, resolveSymbolTotalsContainer, isAggregateSelection]);

  const symbolAnnualizedByAccountMapForPositions = useMemo(() => {
    const mapByAccount = new Map();
    const source =
      data?.accountTotalPnlBySymbolAll && Object.keys(data.accountTotalPnlBySymbolAll).length
        ? data.accountTotalPnlBySymbolAll
        : data?.accountTotalPnlBySymbol;
    if (!source || typeof source !== 'object') {
      return mapByAccount;
    }
    const normalizeKey = (value) => normalizeSymbolGroupKey(value || '');
    const buildPayload = (annualized, annualizedNoFx) => {
      if (!annualized) {
        return null;
      }
      return {
        rate: Number.isFinite(Number(annualized.rate)) ? Number(annualized.rate) : null,
        rateNoFx: Number.isFinite(Number(annualizedNoFx?.rate)) ? Number(annualizedNoFx.rate) : null,
        startDate:
          typeof annualized.startDate === 'string' && annualized.startDate.trim()
            ? annualized.startDate.trim()
            : null,
        incomplete: annualized.incomplete === true,
      };
    };
    Object.entries(source).forEach(([accountKey, container]) => {
      if (!container || !Array.isArray(container.entries)) {
        return;
      }
      const accountMap = new Map();
      container.entries.forEach((entry) => {
        const payload = buildPayload(entry?.annualizedReturn || null, entry?.annualizedReturnNoFx || null);
        if (!payload) {
          return;
        }
        const entryKey = normalizeKey(entry?.symbol);
        if (entryKey) {
          accountMap.set(entryKey, payload);
        }
        if (Array.isArray(entry?.components)) {
          entry.components.forEach((component) => {
            const compKey = normalizeKey(component?.symbol);
            if (compKey && !accountMap.has(compKey)) {
              accountMap.set(compKey, payload);
            }
          });
        }
      });
      mapByAccount.set(String(accountKey), accountMap);
    });
    return mapByAccount;
  }, [data?.accountTotalPnlBySymbol, data?.accountTotalPnlBySymbolAll]);


  const symbolTotalPnlByAccountMapForPositions = useMemo(() => {
    const mapByAccount = new Map();
    const source =
      data?.accountTotalPnlBySymbolAll && Object.keys(data.accountTotalPnlBySymbolAll).length
        ? data.accountTotalPnlBySymbolAll
        : data?.accountTotalPnlBySymbol;
    if (!source || typeof source !== 'object') {
      return mapByAccount;
    }
    const addEntry = (target, symbol, value) => {
      const key = normalizeSymbolGroupKey(symbol || '');
      if (!key) {
        return;
      }
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        return;
      }
      const existing = target.get(key);
      target.set(key, Number.isFinite(existing) ? existing + numeric : numeric);
    };
    Object.entries(source).forEach(([accountKey, container]) => {
      if (!container || !Array.isArray(container.entries)) {
        return;
      }
      const accountMap = new Map();
      container.entries.forEach((entry) => {
        const entryKey = normalizeSymbolGroupKey(entry?.symbol || '');
        addEntry(accountMap, entry?.symbol, entry?.totalPnlCad);
        if (Array.isArray(entry?.components)) {
          entry.components.forEach((component) => {
            const componentKey = normalizeSymbolGroupKey(component?.symbol || '');
            if (componentKey && componentKey !== entryKey) {
              addEntry(accountMap, component?.symbol, component?.totalPnlCad);
            }
          });
        }
      });
      mapByAccount.set(String(accountKey), accountMap);
    });
    return mapByAccount;
  }, [data?.accountTotalPnlBySymbol, data?.accountTotalPnlBySymbolAll]);
  const getSummaryText = useCallback(() => {
    if (!showContent) {
      return null;
    }

    return buildClipboardSummary({
      selectedAccountId: selectedAccount,
      accounts,
      accountGroups,
      groupRelations,
      accountFunding,
      balances: activeBalances,
      displayTotalEquity,
      usdToCadRate,
      pnl: activePnl,
      positions: orderedPositions,
      allPositions: rawPositions,
      symbolTotalPnlByAccountMap: symbolTotalPnlByAccountMapForPositions,
      symbolAnnualizedByAccountMap: symbolAnnualizedByAccountMapForPositions,
      symbolAnnualizedMap: symbolAnnualizedMapForPositions,
      asOf,
      currencyOption: activeCurrency,
      planningContext: activePlanningContext,
    });
  }, [
    showContent,
    selectedAccount,
    accounts,
    accountGroups,
    groupRelations,
    accountFunding,
    activeBalances,
    displayTotalEquity,
    usdToCadRate,
    activePnl,
    orderedPositions,
    rawPositions,
    symbolTotalPnlByAccountMapForPositions,
    symbolAnnualizedByAccountMapForPositions,
    symbolAnnualizedMapForPositions,
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

  // Resolve symbol Total P&L series for header chart (when focusing a symbol)
  const selectedSymbolTotalPnlSeries = useMemo(() => {
    if (!focusedSymbol || !selectedAccountKey) return null;
    if (doesSeriesMatchFocus(totalPnlSeriesState) && totalPnlSeriesState.status === 'success') {
      return totalPnlSeriesState.data || null;
    }
    return null;
  }, [
    focusedSymbol,
    selectedAccountKey,
    totalPnlSeriesState,
    doesSeriesMatchFocus,
  ]);

  // For symbol charts, start on the first date the symbol is actually held
  const selectedSymbolTotalPnlSeriesForChart = useMemo(() => {
    const series = selectedSymbolTotalPnlSeries;
    if (!series || !Array.isArray(series.points) || !series.points.length) return series;
    try {
      const findFirstActiveDate = () => {
        for (let i = 0; i < series.points.length; i += 1) {
          const p = series.points[i] || {};
          const e = Number(p.equityCad);
          const n = Number(p.cumulativeNetDepositsCad);
          const t = Number(p.totalPnlCad);
          const has = (Number.isFinite(e) && Math.abs(e) > 1e-6) || (Number.isFinite(n) && Math.abs(n) > 1e-6) || (Number.isFinite(t) && Math.abs(t) > 1e-6);
          if (has && typeof p.date === 'string' && p.date) {
            return i;
          }
        }
        return null;
      };
      const startIndex = findFirstActiveDate();
      if (startIndex !== null && startIndex > 0 && startIndex < series.points.length) {
        return { ...series, points: series.points.slice(startIndex) };
      }
    } catch (e) {
      // ignore
    }
    return series;
  }, [selectedSymbolTotalPnlSeries]);

  const selectedSymbolTotalPnlSeriesStatus = useMemo(() => {
    if (!focusedSymbol || !selectedAccountKey) return 'idle';
    if (doesSeriesMatchFocus(totalPnlSeriesState)) {
      return totalPnlSeriesState.status;
    }
    return 'idle';
  }, [
    focusedSymbol,
    selectedAccountKey,
    totalPnlSeriesState,
    doesSeriesMatchFocus,
  ]);

  const selectedSymbolTotalPnlSeriesError = useMemo(() => {
    if (!focusedSymbol || !selectedAccountKey) return null;
    if (doesSeriesMatchFocus(totalPnlSeriesState) && totalPnlSeriesState.status === 'error') {
      return totalPnlSeriesState.error || null;
    }
    return null;
  }, [
    focusedSymbol,
    selectedAccountKey,
    totalPnlSeriesState,
    doesSeriesMatchFocus,
  ]);
  // Compute quick symbol-level P&L summary for the focused symbol.
  // Prefer the chart series so totals always match the header sparkline.
  const focusedSymbolPnl = useMemo(() => {
    if (!focusedSymbol) return null;
    let day = 0;
    let open = 0;
    positionsWithShare.forEach((p) => {
      if (!matchesFocusedSymbol(p?.symbol)) {
        return;
      }
      const d = Number(p?.normalizedDayPnl ?? p?.dayPnl);
      const o = Number(p?.normalizedOpenPnl ?? p?.openPnl);
      if (Number.isFinite(d)) day += d;
      if (Number.isFinite(o)) open += o;
    });
    let total = null;
    let usedFallback = false;
    if (
      selectedSymbolTotalPnlSeries &&
      Array.isArray(selectedSymbolTotalPnlSeries.points) &&
      selectedSymbolTotalPnlSeries.points.length
    ) {
      const lastPoint = selectedSymbolTotalPnlSeries.points[selectedSymbolTotalPnlSeries.points.length - 1];
      const seriesTotal = Number(lastPoint?.totalPnlCad);
      if (Number.isFinite(seriesTotal)) {
        total = seriesTotal;
      }
    }
    if (!Number.isFinite(total)) {
      const map =
        data?.accountTotalPnlBySymbolAll ||
        data?.accountTotalPnlBySymbol ||
        null;
      const accumulate = (entries) => {
        if (!Array.isArray(entries)) {
          return;
        }
        entries.forEach((entry) => {
          if (!matchesFocusedSymbol(entry?.symbol)) {
            return;
          }
          const value = Number(entry?.totalPnlCad);
          if (!Number.isFinite(value)) {
            return;
          }
          usedFallback = true;
          total = Number.isFinite(total) ? total + value : value;
        });
      };
      if (map && typeof map === 'object') {
        if (isAggregateSelection) {
          const key =
            typeof selectedAccount === 'string' && selectedAccount.trim() ? selectedAccount.trim() : 'all';
          const entry = map[key] || map['all'];
          accumulate(entry?.entries);
        } else if (selectedAccountInfo?.id) {
          const entry = map[selectedAccountInfo.id];
          accumulate(entry?.entries);
        }
      }
    }
    if (usedFallback && Number.isFinite(total) && Number.isFinite(focusedSymbolDividendsCad)) {
      total -= focusedSymbolDividendsCad;
    }
    // Approximate symbol Total P&L as-of now by
    // adjusting the series/fallback baseline with today's intraday P&L.
    if (Number.isFinite(total) && Number.isFinite(day) && Math.abs(day) > 1e-6) {
      total += day;
    }
    return { dayPnl: day, openPnl: open, totalPnl: Number.isFinite(total) ? total : null };
  }, [
    focusedSymbol,
    matchesFocusedSymbol,
    positionsWithShare,
    selectedSymbolTotalPnlSeries,
    data?.accountTotalPnlBySymbol,
    data?.accountTotalPnlBySymbolAll,
    isAggregateSelection,
    selectedAccount,
    selectedAccountInfo?.id,
    focusedSymbolDividendsCad,
  ]);

  const focusedSymbolTotalPnlOverride = useMemo(() => {
    if (!focusedSymbol || isAggregateSelection) {
      return null;
    }
    const value = Number(focusedSymbolPnl?.totalPnl);
    return Number.isFinite(value) ? value : null;
  }, [focusedSymbol, focusedSymbolPnl?.totalPnl, isAggregateSelection]);

  const focusedSymbolKeyForPositions = useMemo(
    () => (focusedSymbol ? normalizeSymbolGroupKey(focusedSymbol) : null),
    [focusedSymbol]
  );

  const focusedSymbolFundingSummary = useMemo(() => {
    if (!focusedSymbol) {
      return null;
    }
    const preferAllTime = isAggregateSelection;
    const entry = preferAllTime
      ? focusedSymbolTotalsEntry.allTime || focusedSymbolTotalsEntry.current || null
      : focusedSymbolTotalsEntry.current || focusedSymbolTotalsEntry.allTime || null;
    if (!entry) {
      return null;
    }
    const annualized = preferAllTime
      ? entry.annualizedReturn || focusedSymbolTotalsEntry.allTime?.annualizedReturn || null
      : entry.annualizedReturn ||
        focusedSymbolTotalsEntry.current?.annualizedReturn ||
        focusedSymbolTotalsEntry.allTime?.annualizedReturn ||
        null;
    const groupAnnualized =
      symbolGroupAnnualizedState.status === 'success' &&
      symbolGroupAnnualizedState.key === symbolGroupAnnualizedKey
        ? symbolGroupAnnualizedState.data?.annualizedReturn || null
        : null;
    const resolvedAnnualized =
      focusedSymbolMembers.length > 1 && groupAnnualized ? groupAnnualized : annualized;
    const annualizedRate = Number.isFinite(Number(resolvedAnnualized?.rate))
      ? Number(resolvedAnnualized.rate)
      : null;
    const annualizedAsOf =
      typeof resolvedAnnualized?.asOf === 'string' && resolvedAnnualized.asOf.trim()
        ? resolvedAnnualized.asOf.trim()
        : asOf;
    const annualizedStart =
      typeof resolvedAnnualized?.startDate === 'string' && resolvedAnnualized.startDate.trim()
        ? resolvedAnnualized.startDate.trim()
        : null;
    const annualizedIncomplete = resolvedAnnualized?.incomplete === true;
    const positionsTotalPnl = Number(focusedSymbolPnl?.totalPnl);
    const entryTotalPnl = Number(entry.totalPnlCad);
    const totalPnlCad = preferAllTime
      ? Number.isFinite(entryTotalPnl)
        ? entryTotalPnl
        : Number.isFinite(positionsTotalPnl)
          ? positionsTotalPnl
          : null
      : Number.isFinite(positionsTotalPnl)
        ? positionsTotalPnl
        : Number.isFinite(entryTotalPnl)
          ? entryTotalPnl
          : null;
    const equityFromPositions = Number(symbolFilteredPositions.total);
    const totalEquityCad = Number.isFinite(equityFromPositions)
      ? equityFromPositions
      : Number.isFinite(entry.marketValueCad)
        ? entry.marketValueCad
        : null;
    const netDepositsCad = Number.isFinite(entry.investedCad) ? entry.investedCad : null;
    return {
      netDepositsCad,
      totalPnlCad,
      totalEquityCad,
      periodStartDate: annualizedStart || null,
      periodEndDate: annualizedAsOf ? annualizedAsOf.slice(0, 10) : null,
      annualizedReturnRate: annualizedRate,
      annualizedReturnAsOf: annualizedAsOf,
      annualizedReturnStartDate: annualizedStart || null,
      annualizedReturnIncomplete: annualizedIncomplete,
    };
  }, [
    focusedSymbol,
    focusedSymbolTotalsEntry,
    focusedSymbolPnl?.totalPnl,
    symbolFilteredPositions.total,
    asOf,
    isAggregateSelection,
    focusedSymbolMembers,
    symbolGroupAnnualizedKey,
    symbolGroupAnnualizedState,
  ]);

  // If focusing a symbol, synthesize a lightweight per-symbol series for the dialog
  const totalPnlDialogData = useMemo(() => {
    if (!focusedSymbol) {
      return totalPnlDialogDataBase;
    }
    // Prefer server-provided series when available
    if (totalPnlDialogDataBase && Array.isArray(totalPnlDialogDataBase.points) && totalPnlDialogDataBase.points.length) {
      return totalPnlDialogDataBase;
    }
    // Resolve symbol totals for current view (all/group/account) and range mode
    const useAll = totalPnlSeriesState.mode === 'all';
    const map = useAll
      ? (data?.accountTotalPnlBySymbolAll || data?.accountTotalPnlBySymbol || null)
      : (data?.accountTotalPnlBySymbol || null);
    if (!map || typeof map !== 'object') return totalPnlDialogDataBase;
    let container = null;
    if (isAggregateSelection) {
      const key = typeof selectedAccount === 'string' && selectedAccount.trim() ? selectedAccount.trim() : 'all';
      container = map[key] || map['all'] || null;
    } else if (selectedAccountInfo?.id) {
      container = map[selectedAccountInfo.id] || null;
    }
    if (!container || !Array.isArray(container.entries)) return totalPnlDialogDataBase;
    let totalPnl = null;
    let equity = null;
    container.entries.forEach((entry) => {
      if (!matchesFocusedSymbol(entry?.symbol) && !matchesFocusedSymbol(entry?.displaySymbol)) {
        return;
      }
      const pnlValue = Number(entry?.totalPnlCad);
      if (Number.isFinite(pnlValue)) {
        totalPnl = Number.isFinite(totalPnl) ? totalPnl + pnlValue : pnlValue;
      }
      const mvValue = Number(entry?.marketValueCad);
      if (Number.isFinite(mvValue)) {
        equity = Number.isFinite(equity) ? equity + mvValue : mvValue;
      }
    });
    if (!Number.isFinite(totalPnl) && !Number.isFinite(equity)) {
      return totalPnlDialogDataBase;
    }
    if (Number.isFinite(totalPnl) && Number.isFinite(focusedSymbolDividendsCad)) {
      totalPnl -= focusedSymbolDividendsCad;
    }
    const asOfKey = typeof container.asOf === 'string' && container.asOf.trim() ? container.asOf.trim() : (asOf || new Date().toISOString()).slice(0,10);
    const startKey = (function resolveStart(){
      if (typeof cagrStartDate === 'string' && cagrStartDate) return cagrStartDate;
      const fs = fundingSummaryForDisplay?.annualizedReturnStartDate || fundingSummaryForDisplay?.periodStartDate;
      return typeof fs === 'string' ? fs : null;
    })();
    const cost = Number.isFinite(totalPnl) && Number.isFinite(equity) ? equity - totalPnl : null;
    const points = [];
    if (startKey) {
      points.push({ date: startKey, equityCad: Number.isFinite(cost) ? cost : 0, cumulativeNetDepositsCad: Number.isFinite(cost) ? cost : 0, totalPnlCad: 0 });
    }
    points.push({ date: asOfKey, equityCad: Number.isFinite(equity) ? equity : 0, cumulativeNetDepositsCad: Number.isFinite(cost) ? cost : 0, totalPnlCad: Number.isFinite(totalPnl) ? totalPnl : 0 });
    const summary = {
      netDepositsCad: Number.isFinite(cost) ? cost : null,
      totalEquityCad: Number.isFinite(equity) ? equity : null,
      totalPnlCad: Number.isFinite(totalPnl) ? totalPnl : null,
      totalPnlAllTimeCad: Number.isFinite(totalPnl) ? totalPnl : null,
    };
    return { accountId: activeTotalPnlAccountKey, periodStartDate: startKey, periodEndDate: asOfKey, points, summary };
  }, [
    focusedSymbol,
    totalPnlDialogDataBase,
    totalPnlSeriesState.mode,
    data?.accountTotalPnlBySymbol,
    data?.accountTotalPnlBySymbolAll,
    isAggregateSelection,
    selectedAccount,
    selectedAccountInfo?.id,
    cagrStartDate,
    fundingSummaryForDisplay?.annualizedReturnStartDate,
    fundingSummaryForDisplay?.periodStartDate,
    asOf,
    activeTotalPnlAccountKey,
    matchesFocusedSymbol,
    focusedSymbolDividendsCad,
  ]);

  const summaryMainClassName =
    !showTargetColumnForSelection && orderedPositions.length > 0
      ? 'summary-main summary-main--compact'
      : 'summary-main';

  const focusedSymbolQuote = focusedSymbolQuoteState.data || null;
  const focusedSymbolQuoteStatus = focusedSymbolQuoteState.status;
  const focusedSymbolQuoteError = focusedSymbolQuoteState.error;
  const focusedSymbolQuoteCurrency =
    focusedSymbolQuote && typeof focusedSymbolQuote.currency === 'string'
      ? focusedSymbolQuote.currency.trim().toUpperCase()
      : null;

  const formatQuoteMoney = (value, digitOptions) => {
    const formatted = formatMoney(value, digitOptions);
    if (formatted === '—') {
      return formatted;
    }
    return focusedSymbolQuoteCurrency ? `${formatted} ${focusedSymbolQuoteCurrency}` : formatted;
  };

  const quotePriceDisplay = formatQuoteMoney(focusedSymbolQuote?.price, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const quoteChangePercent =
    focusedSymbolQuote && Number.isFinite(focusedSymbolQuote.changePercent)
      ? Number(focusedSymbolQuote.changePercent)
      : null;
  const quoteChangeDisplay =
    quoteChangePercent !== null ? formatSignedPercent(quoteChangePercent, 2) : null;
  const quoteChangeTone = quoteChangePercent > 0 ? 'positive' : quoteChangePercent < 0 ? 'negative' : 'neutral';
  const rawMarketCap =
    focusedSymbolQuote && Number.isFinite(focusedSymbolQuote.marketCap)
      ? Number(focusedSymbolQuote.marketCap)
      : null;
  const quoteHasMarketCap = rawMarketCap !== null && rawMarketCap > 0;
  const hideFocusedSymbolFundamentals = focusedSymbolIsCryptoAggregate;
  const quotePeValue =
    focusedSymbolQuote && Number.isFinite(focusedSymbolQuote.peRatio)
      ? formatNumber(focusedSymbolQuote.peRatio, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
      : null;
  const rawPegRatio =
    focusedSymbolQuote && Number.isFinite(focusedSymbolQuote.pegRatio) && focusedSymbolQuote.pegRatio > 0
      ? Number(focusedSymbolQuote.pegRatio)
      : null;
  const formattedPegRatio =
    rawPegRatio !== null
      ? formatNumber(rawPegRatio, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : null;
  const quotePegDiagnostics = normalizePegDiagnostics(focusedSymbolQuote?.pegDiagnostics);
  const shouldShowPeg =
    !focusedSymbolCryptoTheme &&
    quoteHasMarketCap &&
    (formattedPegRatio !== null || quotePegDiagnostics !== null);
  const quotePegValue =
    formattedPegRatio !== null
      ? formattedPegRatio
      : shouldShowPeg
        ? '?'
        : null;
  const quotePegValueClassName =
    shouldShowPeg && formattedPegRatio === null
      ? 'symbol-view__detail-value symbol-view__detail-value--muted'
      : 'symbol-view__detail-value';
  const quotePegTooltip = shouldShowPeg
    ? buildPegTooltip(quotePegDiagnostics, {
        formattedPegValue: formattedPegRatio,
        fallbackDisplay: '?',
      })
    : null;
  const quoteMarketCapValue = (() => {
    if (!quoteHasMarketCap) {
      return null;
    }

    const marketCap = rawMarketCap;
    const currencySuffix = focusedSymbolQuoteCurrency ? ` ${focusedSymbolQuoteCurrency}` : '';
    const magnitudeFormats = [
      { threshold: 1e12, suffix: 'T' },
      { threshold: 1e9, suffix: 'B' },
      { threshold: 1e6, suffix: 'M' },
    ];

    for (const { threshold, suffix } of magnitudeFormats) {
      if (marketCap >= threshold) {
        const scaled = marketCap / threshold;
        const digitOptions = scaled >= 100
          ? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
          : { minimumFractionDigits: 1, maximumFractionDigits: 1 };
        const magnitude = formatNumber(scaled, digitOptions);
        if (magnitude === '—') {
          return null;
        }
        return `$${magnitude} ${suffix}${currencySuffix}`;
      }
    }

    const formatted = formatQuoteMoney(marketCap, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    return formatted === '—' ? null : formatted;
  })();
  const quoteMarketCapHistoryUrl = (() => {
    if (!quoteHasMarketCap) {
      return null;
    }
    if (focusedSymbolCryptoTheme) {
      return null;
    }

    const base = (focusedSymbol || '').toString().trim();
    if (!base) {
      return null;
    }

    const normalized = base.replace(/\s+/g, '-').toLowerCase();
    if (!normalized || /[^a-z0-9.-]/i.test(normalized)) {
      return null;
    }

    return `https://stockanalysis.com/stocks/${encodeURIComponent(normalized)}/market-cap/`;
  })();
  const quoteDividendValue =
    focusedSymbolQuote && Number.isFinite(focusedSymbolQuote.dividendYieldPercent) && focusedSymbolQuote.dividendYieldPercent > 0
      ? formatPercent(focusedSymbolQuote.dividendYieldPercent, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : null;
  const quoteDividendTooltip = useMemo(() => {
    if (!focusedSymbol || !quoteDividendValue) {
      return null;
    }
    if (!selectedAccountDividendsForView || typeof selectedAccountDividendsForView !== 'object') {
      return null;
    }
    const summary = selectedAccountDividendsForView;
    const totalCadValue = Number.isFinite(summary.totalCad) ? summary.totalCad : null;
    const lines = [];
    if (totalCadValue !== null) {
      lines.push(`Total received: ${formatMoney(totalCadValue)} CAD`);
    } else {
      lines.push('Total received: —');
    }
    const nativeTotalsLabel = formatDividendCurrencyTotals(summary.totalsByCurrency);
    if (nativeTotalsLabel) {
      lines.push(`Native totals: ${nativeTotalsLabel}`);
    }
    if (summary.conversionIncomplete) {
      lines.push('CAD total excludes payouts without FX rates.');
    }
    return lines.join('\n');
  }, [focusedSymbol, quoteDividendValue, selectedAccountDividendsForView]);
  const quoteMessage = (() => {
    if (focusedSymbolQuoteStatus === 'loading' && !focusedSymbolQuote) {
      return 'Loading quote…';
    }
    if (focusedSymbolQuoteStatus === 'error' && focusedSymbolQuoteError) {
      return focusedSymbolQuoteError.message || 'Quote unavailable.';
    }
    return null;
  })();
  const showFocusedSymbolDescription =
    typeof focusedSymbolDescription === 'string' &&
    focusedSymbolDescription.trim() &&
    !focusedSymbolCryptoTheme;
  const summaryButtonTitleBase =
    'Open quote (Perplexity). Ctrl-click for Questrade, Alt-click for Yahoo Finance.';
  const summaryButtonTitle = focusedSymbolQuoteError
    ? `${summaryButtonTitleBase} Quote status: ${focusedSymbolQuoteError.message || 'Failed to refresh quote.'}`
    : summaryButtonTitleBase;

  if (loading && !data) {
    return (
      <div className="summary-page summary-page--initial-loading">
        <div className="initial-loading" role="status" aria-live="polite">
          <span className="visually-hidden">Loading latest account data...</span>
          <span className="initial-loading__spinner" aria-hidden="true" />
        </div>
      </div>
    );
  }

  return (
    <div className="summary-page">
      {refreshNotice.open ? (
        <div className="refresh-notice-overlay" role="presentation">
          <div className="refresh-notice" role="status" aria-live="polite">
            <span className="refresh-notice__spinner" aria-hidden="true" />
            <span className="refresh-notice__text">{refreshNotice.message || 'Refreshing data...'}</span>
          </div>
        </div>
      ) : null}
      {demoModeActive ? (
        <div className="demo-mode-banner" role="status" aria-live="polite">
          <span className="demo-mode-banner__badge">DEMO MODE</span>
          <span className="demo-mode-banner__text">
            You are viewing offline demo data. Changes are not saved.
          </span>
          <button
            type="button"
            className="demo-mode-banner__exit"
            onClick={handleExitDemoMode}
          >
            Exit demo
          </button>
        </div>
      ) : null}
      <main className={summaryMainClassName}>
        <header className="page-header">
          <GlobalSearch
            symbols={searchSymbols}
            accounts={accounts}
            accountGroups={accountGroups}
            navItems={(() => {
              // Build dynamic search commands, skipping disabled features
              const items = [
                { key: 'positions', label: 'Positions' },
                { key: 'orders', label: 'Orders' },
                { key: 'dividends', label: 'Dividends' },
                { key: 'total-pnl', label: 'Total P&L' },
                { key: 'projections', label: 'Projections' },
                { key: 'retirement-projections', label: 'Retirement Projections' },
                { key: 'deployment', label: 'Deployment' },
              ];

              // Models tab (only if available)
              if (shouldShowInvestmentModels) {
                items.push({ key: 'models', label: 'Models' });
              }

              // People (only if household totals available)
              if (!peopleDisabled) {
                items.push({ key: 'people', label: 'People' });
              }

              // Cash breakdown (only in aggregate view with CAD/USD)
              if (cashBreakdownAvailable) {
                items.push({ key: 'cash-breakdown', label: 'Cash Breakdown', target: 'cash-breakdown' });
                items.push({
                  key: 'cash-breakdown-locations',
                  label: 'Cash Locations',
                  target: 'cash-breakdown',
                });
                items.push({
                  key: 'cash-breakdown-in-accounts',
                  label: 'Cash in Accounts',
                  target: 'cash-breakdown',
                });
                items.push({
                  key: 'cash-breakdown-breakdown',
                  label: 'Breakdown of Cash',
                  target: 'cash-breakdown',
                });
                items.push({
                  key: 'cash-breakdown-locations-alt',
                  label: 'Locations of Cash',
                  target: 'cash-breakdown',
                });
                items.push({
                  key: 'cash-breakdown-accounts',
                  label: 'Accounts with Cash',
                  target: 'cash-breakdown',
                });
              }

              // P&L breakdowns (only when we have positions content)
              if (showContent && orderedPositions.length) {
                items.push({ key: 'breakdown-day', label: "P&L Breakdown — Today" });
                items.push({ key: 'breakdown-open', label: 'P&L Breakdown — Open' });
                items.push({ key: 'breakdown-total', label: 'P&L Breakdown — Total' });
              }

              // Return breakdown dialog (only if data available)
              if (Array.isArray(fundingSummaryForDisplay?.returnBreakdown) && fundingSummaryForDisplay.returnBreakdown.length > 0) {
                items.push({ key: 'return-breakdown', label: 'Return Breakdown' });
              }

              // Investment model (global). Show when aggregate accounts.
              if (showingAggregateAccounts) {
                items.push({ key: 'investment-model', label: 'Investment Model' });
              }

              // Quick actions
              items.push({ key: 'copy-summary', label: 'Copy account summary' });
              items.push({ key: 'estimate-cagr', label: 'Estimate future CAGR' });
              items.push({ key: 'invest-evenly', label: 'Invest cash evenly' });
              if (markRebalanceContext) {
                items.push({ key: 'mark-rebalanced', label: 'Mark as rebalanced' });
              }

              return items;
            })()}
            onSelectSymbol={handleSearchSelectSymbol}
            onSelectAccount={handleAccountChange}
            onNavigate={handleSearchNavigate}
          />
          <AccountSelector
            accounts={accounts}
            accountGroups={accountGroups}
            groupRelations={groupRelations}
            selected={selectedAccount}
            onChange={handleAccountChange}
            disabled={loading && !data}
          />
        </header>
        {focusedSymbol ? (
          <section className="symbol-view" aria-label="Symbol focus">
            <div className="symbol-view__row">
              <div className="symbol-view__summary">
                <div
                  className="symbol-view__summary-content"
                  data-focus-visible={focusedSymbolSummaryFocusVisible ? 'true' : undefined}
                >
                  <div className="symbol-view__primary">
                    <div
                      className="symbol-view__summary-main"
                      role="button"
                      tabIndex={0}
                      onClick={handleFocusedSymbolSummaryClick}
                      onKeyDown={handleFocusedSymbolSummaryKeyDown}
                      onContextMenu={handleFocusedSymbolContextMenu}
                      onFocus={handleFocusedSymbolSummaryFocus}
                      onBlur={handleFocusedSymbolSummaryBlur}
                      title={summaryButtonTitle}
                    >
                      <span className="symbol-view__title">
                        <span className="symbol-view__icon" aria-hidden="true">
                          {focusedSymbolLogoUrl ? (
                            <img
                              className="symbol-view__icon-image"
                              src={focusedSymbolLogoUrl}
                              alt={focusedSymbolLogoAlt || undefined}
                              width={28}
                              height={28}
                              loading="lazy"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <svg
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              xmlns="http://www.w3.org/2000/svg"
                            >
                              <path
                                d="M4 4V20H20"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                              <path
                                d="M7 14L11.5 9.5L14.5 12.5L20 7"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </span>
                        <span className="symbol-view__text">
                          <strong>{focusedSymbolTitle}</strong>
                          {showFocusedSymbolDescription ? (
                            <span className="symbol-view__desc">- {focusedSymbolDescription.trim()}</span>
                          ) : null}
                        </span>
                      </span>
                    </div>
                    <div className="symbol-view__primary-actions">
                      <button
                        type="button"
                        className="symbol-view__action"
                        onClick={handleFocusedSymbolBuySell}
                      >
                        Buy/sell
                      </button>
                      <button
                        type="button"
                        className="symbol-view__clear"
                        onClick={() => {
                          clearFocusedSymbol();
                          setOrdersFilter('');
                        }}
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                  {!focusedSymbolIsCryptoAggregate ? (
                    <div className="symbol-view__details">
                      {quoteMessage ? (
                        <span className="symbol-view__detail symbol-view__detail--message">{quoteMessage}</span>
                      ) : (
                        <>
                          <span className="symbol-view__detail symbol-view__detail--price">
                            <span className="symbol-view__detail-price">{quotePriceDisplay}</span>
                            {quoteChangeDisplay ? (
                              <span
                                className={`symbol-view__detail-change symbol-view__detail-change--${quoteChangeTone}`}
                              >
                                ({quoteChangeDisplay})
                              </span>
                            ) : null}
                          </span>
                          {!hideFocusedSymbolFundamentals && quotePeValue ? (
                            <span className="symbol-view__detail">
                              <span className="symbol-view__detail-label">P/E</span>
                              <span className="symbol-view__detail-value">{quotePeValue}</span>
                            </span>
                          ) : null}
                          {!hideFocusedSymbolFundamentals && quotePegValue ? (
                            <span
                              className="symbol-view__detail"
                              title={quotePegTooltip || undefined}
                            >
                              <span className="symbol-view__detail-label">PEG</span>
                              <span className={quotePegValueClassName}>{quotePegValue}</span>
                            </span>
                          ) : null}
                          {quoteMarketCapValue ? (
                            quoteMarketCapHistoryUrl ? (
                              <a
                                className="symbol-view__detail symbol-view__detail-link"
                                href={quoteMarketCapHistoryUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                <span className="symbol-view__detail-label">Market cap</span>
                                <span className="symbol-view__detail-value">{quoteMarketCapValue}</span>
                              </a>
                            ) : (
                              <span className="symbol-view__detail">
                                <span className="symbol-view__detail-label">Market cap</span>
                                <span className="symbol-view__detail-value">{quoteMarketCapValue}</span>
                              </span>
                            )
                          ) : null}
                          {!hideFocusedSymbolFundamentals && quoteDividendValue ? (
                            <button
                              type="button"
                              className="symbol-view__detail symbol-view__detail-button symbol-view__detail-link"
                              onClick={handleShowDividendsPanel}
                              title={quoteDividendTooltip || undefined}
                            >
                              <span className="symbol-view__detail-label">Dividend yield</span>
                              <span className="symbol-view__detail-value">{quoteDividendValue}</span>
                            </button>
                          ) : null}
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
            {focusedSymbolMenuState.open ? (
              <div
                className="positions-table__context-menu"
                ref={focusedSymbolMenuRef}
                style={{ top: `${focusedSymbolMenuState.y}px`, left: `${focusedSymbolMenuState.x}px` }}
              >
                <ul className="positions-table__context-menu-list" role="menu">
                  <li role="none">
                    <button
                      type="button"
                      className="positions-table__context-menu-item"
                      role="menuitem"
                      onClick={handleFocusedSymbolMenuBuySell}
                    >
                      Buy/sell
                    </button>
                  </li>
                  {showFocusedSymbolGoToAccount ? (
                    <li role="none">
                      <button
                        type="button"
                        className="positions-table__context-menu-item"
                        role="menuitem"
                        onClick={handleFocusedSymbolMenuGoToAccount}
                        disabled={!focusedSymbolHasPosition}
                      >
                        Go to account
                      </button>
                    </li>
                  ) : null}
                  <li role="none">
                    <button
                      type="button"
                      className="positions-table__context-menu-item"
                      role="menuitem"
                      onClick={handleFocusedSymbolMenuOrders}
                      disabled={!focusedSymbolHasPosition}
                    >
                      Orders
                    </button>
                  </li>
                  <li role="none">
                    <button
                      type="button"
                      className="positions-table__context-menu-item"
                      role="menuitem"
                      onClick={handleFocusedSymbolMenuNotes}
                      disabled={!focusedSymbolHasPosition}
                    >
                      Notes
                    </button>
                  </li>
                  <li role="none">
                    <button
                      type="button"
                      className="positions-table__context-menu-item"
                      role="menuitem"
                      onClick={handleFocusedSymbolMenuExplain}
                    >
                      Explain movement
                    </button>
                  </li>
                </ul>
              </div>
            ) : null}
          </section>
        ) : null}

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

        {error && !isMissingLoginsError && (
          <div className="status-message error">
            <strong>{isInvalidRefreshTokenError ? 'Questrade login needs attention.' : 'Unable to load data.'}</strong>
            <p>{error.message}</p>
            {isInvalidRefreshTokenError ? (
              <div className="status-message__actions">
                <button
                  type="button"
                  className="pnl-dialog__link-button"
                  onClick={handleOpenLoginSetupDialog}
                >
                  Update refresh token
                </button>
              </div>
            ) : null}
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
            balances={focusedSymbol ? { totalEquity: symbolFilteredPositions.total, marketValue: symbolFilteredPositions.total, cash: null } : activeBalances}
            deploymentSummary={focusedSymbol ? null : activeDeploymentSummary}
            pnl={focusedSymbol ? { dayPnl: focusedSymbolPnl?.dayPnl ?? 0, openPnl: focusedSymbolPnl?.openPnl ?? 0, totalPnl: focusedSymbolPnl?.totalPnl ?? null } : activePnl}
            fundingSummary={focusedSymbol ? (function buildSymbolFunding(){
              if (focusedSymbolFundingSummary) {
                return focusedSymbolFundingSummary;
              }
              const mv = Number(symbolFilteredPositions.total) || 0;
              const totalP = Number(focusedSymbolPnl?.totalPnl);
              const cost = Number.isFinite(totalP) ? mv - totalP : null;
              let rate = null;
              const startKey = (function resolveStart(){
                // Prefer the symbol's own Total P&L series start so the
                // annualized return matches the symbol chart timeframe.
                if (
                  selectedSymbolTotalPnlSeriesForChart &&
                  Array.isArray(selectedSymbolTotalPnlSeriesForChart.points) &&
                  selectedSymbolTotalPnlSeriesForChart.points.length > 0
                ) {
                  const firstPoint = selectedSymbolTotalPnlSeriesForChart.points[0] || {};
                  const rawDate = typeof firstPoint.date === 'string' ? firstPoint.date.trim() : '';
                  if (rawDate) {
                    return rawDate.slice(0, 10);
                  }
                }
                if (typeof cagrStartDate === 'string' && cagrStartDate) return cagrStartDate;
                const s1 = fundingSummaryForDisplay?.annualizedReturnStartDate;
                if (typeof s1 === 'string' && s1) return s1;
                const s2 = fundingSummaryForDisplay?.periodStartDate;
                if (typeof s2 === 'string' && s2) return s2;
                return null;
              })();
              if (cost && cost > 0 && typeof startKey === 'string' && startKey) {
                const start = new Date(`${startKey}T00:00:00Z`);
                const end = new Date(asOf || new Date().toISOString());
                const years = (end - start) / (1000 * 60 * 60 * 24) / 365.25;
                if (Number.isFinite(years) && years > 0) {
                  const growth = mv / cost;
                  if (Number.isFinite(growth) && growth > 0) {
                    rate = Math.pow(growth, 1 / years) - 1;
                  }
                }
              }
              return {
                netDepositsCad: Number.isFinite(cost) ? cost : null,
                totalPnlCad: Number.isFinite(totalP) ? totalP : null,
                totalEquityCad: Number.isFinite(mv) ? mv : null,
                annualizedReturnRate: Number.isFinite(rate) ? rate : null,
                annualizedReturnAsOf: asOf,
                annualizedReturnStartDate: startKey,
                periodStartDate: startKey,
                periodEndDate: asOf,
              };
            })() : fundingSummaryForDisplay}
            asOf={asOf}
            onRefresh={handleRefresh}
            displayTotalEquity={focusedSymbol ? symbolFilteredPositions.total : displayTotalEquity}
            investedEquityCad={baseDisplayTotalEquity}
            earningsSummary={showingAllAccounts ? earningsSummary : null}
            showUnbilledInTotalEquity={includeUnbilledInTotalEquity}
            otherAssetsSummary={otherAssetsSummary}
            showOtherAssetsInTotalEquity={includeOtherAssetsInTotalEquity}
            canToggleUnbilledInTotalEquity={canToggleUnbilledInTotalEquity}
            canToggleOtherAssetsInTotalEquity={canToggleOtherAssetsInTotalEquity}
            onToggleUnbilledInTotalEquity={handleToggleUnbilledInTotalEquity}
            onToggleOtherAssetsInTotalEquity={handleToggleOtherAssetsInTotalEquity}
            onEditOtherAsset={handleEditOtherAsset}
            onRefreshEarnings={handleRefreshEarnings}
            usdToCadRate={usdToCadRate}
            onShowPeople={handleOpenPeople}
            peopleDisabled={peopleDisabled}
            onShowCashBreakdown={focusedSymbol ? null : (cashBreakdownAvailable && activeCurrencyCode ? () => handleShowCashBreakdown(activeCurrencyCode) : null)}
            onShowPnlBreakdown={focusedSymbol ? null : (orderedPositions.length ? handleShowPnlBreakdown : null)}
            onShowTotalPnl={handleShowTotalPnlDialog}
            onShowAnnualizedReturn={handleShowAnnualizedReturnDetails}
            isRefreshing={isRefreshing}
            isAutoRefreshing={autoRefreshEnabled}
            onCopySummary={handleCopySummary}
            onEstimateFutureCagr={handleEstimateFutureCagr}
            onShowProjections={handleShowProjections}
            onShowHoldingsPieChart={orderedPositions.length ? handleShowHoldingsPieChart : null}
            onMarkRebalanced={markRebalanceContext ? handleMarkAccountAsRebalanced : null}
            onPlanInvestEvenly={handlePlanInvestEvenly}
            onExplainMovement={focusedSymbol ? handleExplainMovementForSymbol : null}
            onSetPlanningContext={isAggregateSelection ? null : handleSetPlanningContext}
            onEditAccountDetails={canEditAccountDetails ? handleOpenAccountMetadata : null}
            onEditTargetProportions={
              !isAggregateSelection && selectedAccountInfo ? handleEditTargetProportions : null
            }
            onManageLogins={handleOpenLoginSetupDialog}
            onManageAccounts={handleOpenAccountStructureDialog}
            chatUrl={selectedAccountChatUrl}
            showQqqTemperature={showingAggregateAccounts}
            qqqSummary={qqqSummary}
            onRefreshQqqTemperature={handleRefreshQqqTemperature}
            onShowInvestmentModel={
              showingAggregateAccounts ? handleShowInvestmentModelDialog : null
            }
            benchmarkComparison={benchmarkSummary}
            totalPnlRangeOptions={focusedSymbol ? [] : totalPnlRangeOptions}
            selectedTotalPnlRange={focusedSymbol ? null : totalPnlRange}
            onTotalPnlRangeChange={focusedSymbol ? null : handleTotalPnlRangeChange}
            totalPnlSeries={focusedSymbol ? selectedSymbolTotalPnlSeriesForChart : selectedAccountTotalPnlSeries}
            totalPnlSeriesStatus={focusedSymbol ? selectedSymbolTotalPnlSeriesStatus : selectedTotalPnlSeriesStatus}
            totalPnlSeriesError={focusedSymbol ? selectedSymbolTotalPnlSeriesError : selectedTotalPnlSeriesError}
            symbolPriceSeries={
              focusedSymbol && normalizedFocusedPriceSymbol === symbolPriceSeriesState.symbol
                ? symbolPriceSeriesState.data
                : null
            }
            symbolPriceSeriesStatus={
              focusedSymbol && normalizedFocusedPriceSymbol === symbolPriceSeriesState.symbol
                ? symbolPriceSeriesState.status
                : 'idle'
            }
            symbolPriceSeriesError={
              focusedSymbol && normalizedFocusedPriceSymbol === symbolPriceSeriesState.symbol
                ? symbolPriceSeriesState.error
                : null
            }
            symbolPriceSymbol={focusedSymbolPriceSymbol}
            symbolPriceOptions={focusedSymbolPriceOptions}
            onSymbolPriceSymbolChange={handleSymbolPriceSymbolChange}
            onAdjustDeployment={focusedSymbol ? null : handleOpenDeploymentAdjustment}
            symbolMode={Boolean(focusedSymbol)}
            childAccounts={focusedSymbol ? [] : childAccountSummaries}
            parentGroups={focusedSymbol ? [] : parentAccountSummaries}
            childAccountParentTotal={focusedSymbol ? null : childAccountParentTotal}
            onSelectAccount={handleAccountChange}
            onShowChildPnlBreakdown={handleShowChildPnlBreakdown}
            onShowChildTotalPnl={handleShowChildTotalPnl}
            onShowRangePnlBreakdown={handleShowRangePnlBreakdown}
            totalPnlSelectionResetKey={totalPnlSelectionResetKey}
            onTotalPnlRangeSelectionChange={handleTotalPnlRangeSelectionChange}
            onTotalPnlSelectionCleared={handleTotalPnlSelectionCleared}
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
          <section className="positions-card" ref={positionsCardRef}>
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
                {isNewsFeatureEnabled ? (
                  <button
                    type="button"
                    id={newsTabId}
                    role="tab"
                    aria-selected={portfolioViewTab === 'news'}
                    aria-controls={newsPanelId}
                    className={portfolioViewTab === 'news' ? 'active' : ''}
                    onClick={() => setPortfolioViewTab('news')}
                    onContextMenu={handleNewsTabContextMenu}
                  >
                    News
                  </button>
                ) : null}
              </div>
            </header>

            <div
              id={positionsPanelId}
              role="tabpanel"
              aria-labelledby={positionsTabId}
              hidden={portfolioViewTab !== 'positions'}
            >
              <PositionsTable
                positions={symbolFilteredPositions.list}
                totalMarketValue={symbolFilteredPositions.total}
                sortColumn={resolvedSortColumn}
                sortDirection={resolvedSortDirection}
                onSortChange={setPositionsSort}
                pnlMode={positionsPnlMode}
                onPnlModeChange={setPositionsPnlMode}
                currencyRates={currencyRates}
                baseCurrency={baseCurrency}
                embedded
                investmentModelSymbolMap={investmentModelSymbolMap}
                onShowInvestmentModel={selectedAccountInfo ? handleShowAccountInvestmentModel : null}
                onShowNotes={handleShowSymbolNotes}
                onShowOrders={handleShowSymbolOrders}
                onBuySell={handleBuySellPosition}
                onFocusSymbol={handleSearchSelectSymbol}
                onGoToAccount={focusedSymbol ? handleGoToAccountFromSymbol : null}
                forceShowTargetColumn={forcedTargetForSelectedAccount}
                showPortfolioShare={!focusedSymbol}
                showAccountColumn={Boolean(focusedSymbol) && isAggregateSelection}
                hideTargetColumn={Boolean(focusedSymbol)}
                hideDetailsOption={Boolean(focusedSymbol)}
                accountsById={accountsById}
                symbolAnnualizedMap={symbolAnnualizedMapForPositions}
                symbolAnnualizedByAccountMap={symbolAnnualizedByAccountMapForPositions}
                symbolTotalPnlByAccountMap={symbolTotalPnlByAccountMapForPositions}
                focusedSymbolTotalPnlOverride={focusedSymbolTotalPnlOverride}
                focusedSymbolKey={focusedSymbolKeyForPositions}
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
                  ? filteredInvestmentModelSections.map((section, index) => {
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
                        accountUrl={section.accountUrl || null}
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
                <DividendBreakdown summary={selectedAccountDividendsForView} variant="panel" />
              </div>
            ) : null}
            {isNewsFeatureEnabled ? (
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
                  onSeePrompt={() => setShowNewsPromptDialog(true)}
                  prompt={portfolioNewsState.prompt}
                />
            </div>
            ) : null}
          </section>
        )}

        {portfolioViewTab === 'positions' && (
          <div className="positions-card__attribution positions-card__attribution--below">
            <span>Logos by </span>
            <a
              href="https://logo.dev/?utm_source=investments-view&utm_medium=app&utm_campaign=attribution"
              target="_blank"
              rel="noopener noreferrer"
            >
              Logo.dev
            </a>
          </div>
        )}

      </main>
      {isNewsFeatureEnabled && newsTabContextMenuState.open ? (
        <div
          ref={newsTabMenuRef}
          className="positions-table__context-menu"
          style={{ position: 'fixed', left: newsTabContextMenuState.x, top: newsTabContextMenuState.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <ul className="positions-table__context-menu-list" role="menu">
            <li>
              <button
                type="button"
                className="positions-table__context-menu-item"
                onClick={() => {
                  setShowNewsPromptDialog(true);
                  closeNewsTabContextMenu();
                }}
                disabled={!portfolioNewsState.prompt}
                role="menuitem"
              >
                See prompt
              </button>
            </li>
          </ul>
        </div>
      ) : null}
      {showReturnBreakdown && Array.isArray(fundingSummaryForDisplay?.returnBreakdown) && (
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
      {showHoldingsPieChart && (
        <HoldingsPieChartDialog
          positions={orderedPositions}
          accountLabel={holdingsPieChartAccountLabel}
          asOf={asOf}
          baseCurrency={baseCurrency}
          onClose={handleCloseHoldingsPieChart}
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
          accountUrl={investmentModelDialogAccountUrl}
        />
      )}
      {isNewsFeatureEnabled && showNewsPromptDialog && (
        <NewsPromptDialog
          onClose={() => setShowNewsPromptDialog(false)}
          prompt={portfolioNewsState.prompt}
          rawOutput={portfolioNewsState.rawOutput}
          usage={portfolioNewsState.usage}
          pricing={portfolioNewsState.pricing}
          cost={portfolioNewsState.cost}
        />
      )}
      {showTotalPnlDialog && (
        <TotalPnlDialog
          onClose={handleCloseTotalPnlDialog}
          data={totalPnlDialogData}
          loading={totalPnlDialogLoading}
          error={totalPnlDialogError}
          onRetry={handleRetryTotalPnlSeries}
          accountLabel={totalPnlDialogContext.label}
          symbolLabel={focusedSymbolTitle || focusedSymbol || null}
          supportsCagrToggle={Boolean(totalPnlDialogContext.supportsCagrToggle)}
          mode={totalPnlSeriesState.mode}
          onModeChange={handleChangeTotalPnlSeriesMode}
          cagrStartDate={totalPnlDialogContext.cagrStartDate}
          onShowBreakdown={
            showContent && orderedPositions.length ? handleShowTotalPnlBreakdownFromDialog : null
          }
        />
      )}

      {showProjectionDialog && (
        <ProjectionDialog
          onClose={handleCloseProjections}
          accountKey={projectionContext.accountKey}
          accountLabel={projectionContext.label}
          todayTotalEquity={fundingSummaryForDisplay?.totalEquityCad ?? null}
          todayDate={fundingSummaryForDisplay?.periodEndDate ?? asOf}
          cagrStartDate={projectionContext.cagrStartDate}
          prefillRetirementAge={projectionContext.retireAtAge}
          onEstimateFutureCagr={handleEstimateFutureCagr}
          childAccounts={childAccountSummaries}
          onSelectAccount={handleAccountChange}
          parentAccountId={projectionContext.parentAccountId}
          initialGrowthPercent={selectedAccountInfo?.projectionGrowthPercent ?? null}
          isGroupView={isAggregateSelection}
          retirementSettings={selectedRetirementSettings}
          groupProjectionAccounts={(function buildGroupProj() {
            if (!isAggregateSelection) return [];
            if (selectedAccount === 'all') {
              const proj = [];
              accountsById.forEach((acc, rawId) => {
                if (!acc) return;
                const accountId = rawId && String(rawId).trim();
                if (!accountId) return;
                const fund = accountFunding[accountId] || null;
                const equity = Number.isFinite(fund?.totalEquityCad) ? fund.totalEquityCad : 0;
                const rate = Number.isFinite(acc?.projectionGrowthPercent) ? acc.projectionGrowthPercent / 100 : 0;
                if (equity > 0) proj.push({ equity, rate });
              });
              return proj;
            }
            const group = accountGroupsById.get(selectedAccount) || null;
            const gKey = group ? normalizeAccountGroupKey(group.name) : null;
            if (!gKey) return [];
            const members = new Set();
            const queue = [gKey];
            const visited = new Set();
            while (queue.length) {
              const cur = queue.shift();
              if (!cur || visited.has(cur)) continue;
              visited.add(cur);
              const accountsForGroup = accountsByGroupName.get(cur) || [];
              accountsForGroup.forEach((acc) => {
                if (acc && acc.id) members.add(String(acc.id));
              });
              const children = accountGroupChildrenMap.get(cur);
              if (children && children.size) {
                children.forEach((child) => {
                  if (child && !visited.has(child)) queue.push(child);
                });
              }
            }
            const proj = [];
            members.forEach((accountId) => {
              const fund = accountFunding[accountId] || null;
              const equity = Number.isFinite(fund?.totalEquityCad) ? fund.totalEquityCad : 0;
              const acc = accountsById.get(accountId) || null;
              const rate = Number.isFinite(acc?.projectionGrowthPercent) ? acc.projectionGrowthPercent / 100 : 0;
              if (equity > 0) proj.push({ equity, rate });
            });
            return proj;
          })()}
          projectionTree={(function buildProjectionTree() {
            if (!isAggregateSelection) return null;
            if (selectedAccount === 'all') {
              const accountNodes = [];
              accountsById.forEach((account, rawId) => {
                if (!account) return;
                const accountId = rawId && String(rawId).trim();
                if (!accountId) return;
                const fund = accountFunding[accountId] || null;
                const equity = Number.isFinite(fund?.totalEquityCad) ? fund.totalEquityCad : 0;
                const ratePercent = Number.isFinite(account?.projectionGrowthPercent)
                  ? account.projectionGrowthPercent
                  : null;
                accountNodes.push({
                  kind: 'account',
                  id: accountId,
                  label: getAccountLabel(account) || accountId,
                  equity,
                  ratePercent,
                });
              });
              if (!accountNodes.length) return null;
              return {
                kind: 'group',
                id: 'all',
                groupKey: 'all',
                label: aggregateAccountLabel || 'All accounts',
                children: accountNodes,
              };
            }
            const rootGroup = accountGroupsById.get(selectedAccount) || null;
            const rootKey = rootGroup ? normalizeAccountGroupKey(rootGroup.name) : null;
            if (!rootKey) return null;

            const visited = new Set();

            const buildGroupNode = (groupKey) => {
              if (!groupKey || visited.has(groupKey)) return null;
              visited.add(groupKey);

              const group = accountGroupsByNormalizedName.get(groupKey) || null;
              const groupId = group && group.id !== undefined && group.id !== null ? String(group.id).trim() : null;
              const label = accountGroupNamesByKey.get(groupKey) || groupId || groupKey;

              // Direct account members of this group
              const accounts = (accountsByGroupName.get(groupKey) || [])
                .map((acc) => {
                  if (!acc || acc.id === undefined || acc.id === null) return null;
                  const id = String(acc.id).trim();
                  const fund = accountFunding[id] || null;
                  const equity = Number.isFinite(fund?.totalEquityCad) ? fund.totalEquityCad : 0;
                  const metaAcc = accountsById.get(id) || null;
                  const ratePercent = Number.isFinite(metaAcc?.projectionGrowthPercent)
                    ? metaAcc.projectionGrowthPercent
                    : null;
                  return { kind: 'account', id, label: getAccountLabel(acc) || id, equity, ratePercent };
                })
                .filter(Boolean);

              // Child groups
              const groupChildren = [];
              const childrenKeys = accountGroupChildrenMap.get(groupKey);
              if (childrenKeys && childrenKeys.size) {
                childrenKeys.forEach((childKey) => {
                  if (childKey && childKey !== groupKey) {
                    const node = buildGroupNode(childKey);
                    if (node && Array.isArray(node.children) && node.children.length) {
                      groupChildren.push(node);
                    }
                  }
                });
              }

              const children = [...accounts, ...groupChildren];
              if (!children.length) return null;
              return { kind: 'group', id: groupId || groupKey, groupKey, label, children };
            };

            return buildGroupNode(rootKey);
          })()}
          onPersistGrowthPercent={handleProjectionGrowthPersisted}
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
      {accountActionPrompt && (
        <AccountActionDialog
          title={accountActionPrompt.title}
          message={accountActionPrompt.message}
          options={accountActionPrompt.options || []}
          onSelect={handleAccountActionSelect}
          onCancel={handleAccountActionCancel}
        />
      )}
      {accountMetadataEditor && (
        <AccountMetadataDialog
          accountLabel={accountMetadataEditor.accountLabel}
          initial={accountMetadataEditor.initial}
          models={accountMetadataEditor.models}
          targetType={accountMetadataEditor.targetType || 'account'}
          onClose={handleCloseAccountMetadata}
          onSave={handleSaveAccountMetadata}
        />
      )}
      {showLoginSetupDialog && (
        <QuestradeLoginDialog
          logins={loginSetupState.logins}
          notice={loginSetupNotice}
          prefillEmail={loginSetupPrefillEmail}
          mode={loginDialogMode}
          onClose={handleCloseLoginSetupDialog}
          onSave={isInvalidRefreshTokenError ? handleReconnectLogin : handleSaveLogin}
          onShowInstructions={handleShowRefreshTokenHelpDialog}
          onStartAccountStructure={handleStartAccountStructureFromLogin}
          onStartDemoMode={handleStartDemoMode}
        />
      )}
      {showRefreshTokenHelpDialog && (
        <QuestradeRefreshTokenDialog onClose={handleCloseRefreshTokenHelpDialog} />
      )}
      {showAccountStructureDialog && (
        <AccountStructureDialog
          accounts={accountStructureContext.accounts}
          accountGroups={accountStructureContext.accountGroups}
          groupRelations={accountStructureContext.groupRelations}
          initialEntries={accountStructureState.entries}
          onSave={handleSaveAccountStructure}
          onClose={handleCloseAccountStructureDialog}
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
          initialAccount={pnlBreakdownInitialAccount ?? heatmapDefaultAccount}
          rangeSummary={pnlBreakdownRange}
          rangeBreakdownState={rangeBreakdownState}
          onClearRange={pnlBreakdownRange ? handleClearPnlBreakdownRange : null}
          onRetryRange={handleRetryRangeBreakdown}
          totalPnlBySymbol={(function resolveTotalPnlBySymbol() {
            const useAll = (function decideVariant() {
              if (isAggregateSelection && selectedAccount === 'all') {
                return true; // All accounts: always from start
              }
              // If launching from the dialog, honor the captured override.
              if (pnlBreakdownUseAllOverride !== null) {
                return !!pnlBreakdownUseAllOverride;
              }
              // Only honor the dialog's mode while the dialog is open.
              if (showTotalPnlDialog && totalPnlSeriesState.mode === 'all') {
                return true;
              }
              // Otherwise use the main page selection.
              return fundingSummaryForDisplay?.mode === 'all';
            })();
            const map = useAll
              ? (data?.accountTotalPnlBySymbolAll || data?.accountTotalPnlBySymbol || null)
              : (data?.accountTotalPnlBySymbol || null);
            if (!map || typeof map !== 'object') return {};
            // Aggregate views: 'all' or group:<slug>
            if (isAggregateSelection) {
              const key = typeof selectedAccount === 'string' && selectedAccount.trim() ? selectedAccount.trim() : 'all';
              const entry = map[key] || map['all'];
              return entry || {};
            }
            // Single account
            const accountId = selectedAccountInfo?.id || null;
            if (!accountId) return {};
            const entry = map[accountId];
            return entry || {};
          })()}
          totalPnlAsOf={(function resolveTotalPnlAsOf() {
            const useAll = (function decideVariant() {
              if (isAggregateSelection && selectedAccount === 'all') {
                return true;
              }
              if (pnlBreakdownUseAllOverride !== null) {
                return !!pnlBreakdownUseAllOverride;
              }
              if (showTotalPnlDialog && totalPnlSeriesState.mode === 'all') {
                return true;
              }
              return fundingSummaryForDisplay?.mode === 'all';
            })();
            const map = useAll
              ? (data?.accountTotalPnlBySymbolAll || data?.accountTotalPnlBySymbol || null)
              : (data?.accountTotalPnlBySymbol || null);
            if (!map || typeof map !== 'object') return null;
            if (isAggregateSelection) {
              const key = typeof selectedAccount === 'string' && selectedAccount.trim() ? selectedAccount.trim() : 'all';
              const entry = map[key] || map['all'];
              const asOfKey = typeof entry?.asOf === 'string' && entry.asOf.trim() ? entry.asOf.trim() : null;
              return asOfKey;
            }
            const accountId = selectedAccountInfo?.id || null;
            if (!accountId) return null;
            const entry = map[accountId];
            const asOfKey = typeof entry?.asOf === 'string' && entry.asOf.trim() ? entry.asOf.trim() : null;
            return asOfKey;
          })()}
          onBuySell={handleBuySellPosition}
          onGoToAccount={handleGoToAccountFromSymbol}
          onShowOrders={handleShowSymbolOrders}
          onShowNotes={handleShowSymbolNotes}
          onFocusSymbol={handleSearchSelectSymbol}
          accountsById={accountsById}
        />
      )}
    </div>
  );
}
