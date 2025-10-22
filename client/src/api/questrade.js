const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

function buildUrl(accountId) {
  const base = API_BASE_URL.replace(/\/$/, '');
  const url = new URL('/api/summary', base);
  if (accountId && accountId !== 'all') {
    url.searchParams.set('accountId', accountId);
  }
  return url.toString();
}

function buildQqqTemperatureUrl() {
  const base = API_BASE_URL.replace(/\/$/, '');
  const url = new URL('/api/qqq-temperature', base);
  return url.toString();
}

function buildInvestmentModelTemperatureUrl(params) {
  const base = API_BASE_URL.replace(/\/$/, '');
  const url = new URL('/api/investment-model-temperature', base);
  if (params && typeof params.model === 'string' && params.model.trim()) {
    url.searchParams.set('model', params.model.trim());
  }
  if (params && typeof params.startDate === 'string' && params.startDate.trim()) {
    url.searchParams.set('startDate', params.startDate.trim());
  }
  if (params && typeof params.endDate === 'string' && params.endDate.trim()) {
    url.searchParams.set('endDate', params.endDate.trim());
  }
  if (params && typeof params.symbol === 'string' && params.symbol.trim()) {
    url.searchParams.set('symbol', params.symbol.trim());
  }
  if (params && typeof params.leveragedSymbol === 'string' && params.leveragedSymbol.trim()) {
    url.searchParams.set('leveragedSymbol', params.leveragedSymbol.trim());
  }
  if (params && typeof params.reserveSymbol === 'string' && params.reserveSymbol.trim()) {
    url.searchParams.set('reserveSymbol', params.reserveSymbol.trim());
  }
  return url.toString();
}

function buildBenchmarkReturnsUrl(params) {
  const base = API_BASE_URL.replace(/\/$/, '');
  const url = new URL('/api/benchmark-returns', base);
  if (params && typeof params.startDate === 'string' && params.startDate.trim()) {
    url.searchParams.set('startDate', params.startDate.trim());
  }
  if (params && typeof params.endDate === 'string' && params.endDate.trim()) {
    url.searchParams.set('endDate', params.endDate.trim());
  }
  return url.toString();
}

function buildQuoteUrl(symbol) {
  const base = API_BASE_URL.replace(/\/$/, '');
  const url = new URL('/api/quote', base);
  if (symbol) {
    url.searchParams.set('symbol', symbol);
  }
  return url.toString();
}

function buildMarkRebalancedUrl(accountKey) {
  const base = API_BASE_URL.replace(/\/$/, '');
  const trimmedKey = typeof accountKey === 'string' ? accountKey.trim() : '';
  const encodedKey = encodeURIComponent(trimmedKey);
  const path = `/api/accounts/${encodedKey}/mark-rebalanced`;
  const url = new URL(path, base);
  return url.toString();
}

function buildTargetProportionsUrl(accountKey) {
  const base = API_BASE_URL.replace(/\/$/, '');
  const trimmedKey = typeof accountKey === 'string' ? accountKey.trim() : '';
  if (!trimmedKey) {
    throw new Error('accountKey is required');
  }
  const encodedKey = encodeURIComponent(trimmedKey);
  const path = `/api/accounts/${encodedKey}/target-proportions`;
  const url = new URL(path, base);
  return url.toString();
}

function buildSymbolNotesUrl(accountKey) {
  const base = API_BASE_URL.replace(/\/$/, '');
  const trimmedKey = typeof accountKey === 'string' ? accountKey.trim() : '';
  if (!trimmedKey) {
    throw new Error('accountKey is required');
  }
  const encodedKey = encodeURIComponent(trimmedKey);
  const path = `/api/accounts/${encodedKey}/symbol-notes`;
  const url = new URL(path, base);
  return url.toString();
}

function buildPlanningContextUrl(accountKey) {
  const base = API_BASE_URL.replace(/\/$/, '');
  const trimmedKey = typeof accountKey === 'string' ? accountKey.trim() : '';
  if (!trimmedKey) {
    throw new Error('accountKey is required');
  }
  const encodedKey = encodeURIComponent(trimmedKey);
  const path = `/api/accounts/${encodedKey}/planning-context`;
  const url = new URL(path, base);
  return url.toString();
}

function buildTotalPnlSeriesUrl(accountKey, params = {}) {
  const base = API_BASE_URL.replace(/\/$/, '');
  const trimmedKey = typeof accountKey === 'string' ? accountKey.trim() : '';
  if (!trimmedKey) {
    throw new Error('accountKey is required');
  }
  const encodedKey = encodeURIComponent(trimmedKey);
  const path = `/api/accounts/${encodedKey}/total-pnl-series`;
  const url = new URL(path, base);
  if (params && typeof params.startDate === 'string' && params.startDate.trim()) {
    url.searchParams.set('startDate', params.startDate.trim());
  }
  if (params && typeof params.endDate === 'string' && params.endDate.trim()) {
    url.searchParams.set('endDate', params.endDate.trim());
  }
  if (params && params.applyAccountCagrStartDate === false) {
    url.searchParams.set('applyAccountCagrStartDate', 'false');
  }
  return url.toString();
}

function buildPortfolioNewsUrl() {
  const base = API_BASE_URL.replace(/\/$/, '');
  const url = new URL('/api/news', base);
  return url.toString();
}

export async function getSummary(accountId) {
  const response = await fetch(buildUrl(accountId));
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Failed to load summary data');
  }
  return response.json();
}

export async function getQqqTemperature() {
  const response = await fetch(buildQqqTemperatureUrl());
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Failed to load QQQ temperature data');
  }
  return response.json();
}

export async function getInvestmentModelTemperature(params) {
  const model = params && typeof params.model === 'string' ? params.model.trim() : '';
  if (!model) {
    throw new Error('Model is required');
  }

  const response = await fetch(buildInvestmentModelTemperatureUrl({ ...params, model }));
  if (!response.ok) {
    let message = 'Failed to load investment model chart';
    try {
      const payload = await response.json();
      message = payload?.message || payload?.details || message;
    } catch (parseError) {
      console.warn('Failed to parse investment model chart error response', parseError);
      try {
        const text = await response.text();
        if (text && text.trim()) {
          message = text.trim();
        }
      } catch (nestedError) {
        console.warn('Failed to read investment model chart error response', nestedError);
      }
    }
    throw new Error(message);
  }

  return response.json();
}

export async function getQuote(symbol) {
  const normalizedSymbol = typeof symbol === 'string' ? symbol.trim() : '';
  if (!normalizedSymbol) {
    throw new Error('Symbol is required');
  }

  const response = await fetch(buildQuoteUrl(normalizedSymbol));
  if (!response.ok) {
    let message = 'Failed to load quote data';
    try {
      const payload = await response.json();
      message = payload?.message || payload?.details || message;
    } catch (parseError) {
      console.warn('Failed to parse quote error response as JSON', parseError);
      try {
        const text = await response.text();
        if (text && text.trim()) {
          message = text.trim();
        }
      } catch (nestedError) {
        console.warn('Failed to read quote error response', nestedError);
      }
    }
    throw new Error(message);
  }

  return response.json();
}

export async function getBenchmarkReturns(params) {
  const startDate = params && typeof params.startDate === 'string' ? params.startDate.trim() : '';
  if (!startDate) {
    throw new Error('startDate is required');
  }

  const endDate = params && typeof params.endDate === 'string' ? params.endDate.trim() : '';
  const response = await fetch(buildBenchmarkReturnsUrl({ startDate, endDate }));
  if (!response.ok) {
    let message = 'Failed to load benchmark returns';
    try {
      const payload = await response.json();
      message = payload?.message || payload?.details || message;
    } catch (parseError) {
      console.warn('Failed to parse benchmark returns error response as JSON', parseError);
      try {
        const text = await response.text();
        if (text && text.trim()) {
          message = text.trim();
        }
      } catch (nestedError) {
        console.warn('Failed to read benchmark returns error response', nestedError);
      }
    }
    throw new Error(message);
  }

  return response.json();
}

export async function getPortfolioNews(payload, options = {}) {
  const accountId = payload && typeof payload.accountId === 'string' ? payload.accountId.trim() : '';
  const accountLabel = payload && typeof payload.accountLabel === 'string' ? payload.accountLabel.trim() : '';
  const symbols = Array.isArray(payload?.symbols)
    ? payload.symbols
        .map((symbol) => (typeof symbol === 'string' ? symbol.trim() : ''))
        .filter(Boolean)
    : [];

  const requestBody = {};
  if (accountId) {
    requestBody.accountId = accountId;
  }
  if (accountLabel) {
    requestBody.accountLabel = accountLabel;
  }
  requestBody.symbols = symbols;

  const response = await fetch(buildPortfolioNewsUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal: options?.signal,
  });

  if (!response.ok) {
    let message = 'Failed to load portfolio news';
    try {
      const payloadData = await response.json();
      message = payloadData?.message || payloadData?.details || message;
    } catch (_parseError) {
      try {
        const text = await response.text();
        if (text && text.trim()) {
          message = text.trim();
        }
      } catch (_readError) {
        // Ignore read errors and fall back to the default message.
      }
    }
    throw new Error(message);
  }

  return response.json();
}

export async function markAccountRebalanced(accountKey, options = {}) {
  const trimmedKey = typeof accountKey === 'string' ? accountKey.trim() : '';
  if (!trimmedKey) {
    throw new Error('accountKey is required');
  }

  const model = options && typeof options.model === 'string' ? options.model.trim() : '';
  const payload = model ? { model } : {};

  const response = await fetch(buildMarkRebalancedUrl(trimmedKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let message = 'Failed to update rebalance date';
    try {
      const errorPayload = await response.json();
      message = errorPayload?.message || errorPayload?.details || message;
    } catch (parseError) {
      console.warn('Failed to parse markAccountRebalanced error response as JSON', parseError);
      try {
        const text = await response.text();
        if (text && text.trim()) {
          message = text.trim();
        }
      } catch (nestedError) {
        console.warn('Failed to read markAccountRebalanced error response body', nestedError);
      }
    }
    throw new Error(message);
  }

  return response.json();
}

export async function setAccountTargetProportions(accountKey, proportions) {
  const trimmedKey = typeof accountKey === 'string' ? accountKey.trim() : '';
  if (!trimmedKey) {
    throw new Error('accountKey is required');
  }

  const payload = { proportions: proportions ?? null };

  const response = await fetch(buildTargetProportionsUrl(trimmedKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let message = 'Failed to update target proportions';
    try {
      const data = await response.json();
      message = data?.message || data?.details || message;
    } catch {
      try {
        const text = await response.text();
        if (text && text.trim()) {
          message = text.trim();
        }
      } catch {
        // ignore
      }
    }
    throw new Error(message);
  }

  return response.json();
}

export async function setAccountSymbolNotes(accountKey, symbol, notes) {
  const trimmedKey = typeof accountKey === 'string' ? accountKey.trim() : '';
  if (!trimmedKey) {
    throw new Error('accountKey is required');
  }

  const normalizedSymbol = typeof symbol === 'string' ? symbol.trim().toUpperCase() : '';
  if (!normalizedSymbol) {
    throw new Error('symbol is required');
  }

  const payload = {
    symbol: normalizedSymbol,
    notes: typeof notes === 'string' ? notes : '',
  };

  const response = await fetch(buildSymbolNotesUrl(trimmedKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let message = 'Failed to update symbol notes';
    try {
      const data = await response.json();
      message = data?.message || data?.details || message;
    } catch {
      try {
        const text = await response.text();
        if (text && text.trim()) {
          message = text.trim();
        }
      } catch {
        // ignore
      }
    }
    throw new Error(message);
  }

  return response.json();
}

export async function setAccountPlanningContext(accountKey, planningContext) {
  const trimmedKey = typeof accountKey === 'string' ? accountKey.trim() : '';
  if (!trimmedKey) {
    throw new Error('accountKey is required');
  }

  const payload = {
    planningContext: typeof planningContext === 'string' ? planningContext : '',
  };

  const response = await fetch(buildPlanningContextUrl(trimmedKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let message = 'Failed to update planning context';
    try {
      const data = await response.json();
      message = data?.message || data?.details || message;
    } catch {
      try {
        const text = await response.text();
        if (text && text.trim()) {
          message = text.trim();
        }
      } catch {
        // ignore
      }
    }
    throw new Error(message);
  }

  return response.json();
}

export async function getTotalPnlSeries(accountKey, params = {}) {
  const trimmedKey = typeof accountKey === 'string' ? accountKey.trim() : '';
  if (!trimmedKey) {
    throw new Error('accountKey is required');
  }

  const response = await fetch(buildTotalPnlSeriesUrl(trimmedKey, params));
  if (!response.ok) {
    let message = 'Failed to load Total P&L series';
    try {
      const payload = await response.json();
      message = payload?.message || payload?.details || message;
    } catch (parseError) {
      console.warn('Failed to parse total P&L series error response as JSON', parseError);
      try {
        const text = await response.text();
        if (text && text.trim()) {
          message = text.trim();
        }
      } catch (nestedError) {
        console.warn('Failed to read total P&L series error response', nestedError);
      }
    }
    throw new Error(message);
  }

  return response.json();
}
