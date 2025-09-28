const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const PORT = process.env.PORT || 4000;
const ALLOWED_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const tokenCache = new NodeCache();
const tokenFilePath = path.join(process.cwd(), 'token-store.json');

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

const MIN_REQUEST_INTERVAL_MS = 50;
const requestQueue = [];
let isProcessingQueue = false;
let nextAvailableTime = Date.now();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateRateLimitFromHeaders(headers) {
  if (!headers) {
    return;
  }
  const remaining = parseInt(headers['x-ratelimit-remaining'], 10);
  const reset = parseInt(headers['x-ratelimit-reset'], 10);
  if (!Number.isNaN(remaining) && remaining <= 1 && !Number.isNaN(reset)) {
    const resetMs = reset * 1000;
    if (resetMs > nextAvailableTime) {
      nextAvailableTime = resetMs;
    }
  }
}

function enqueueRequest(executor) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ executor, resolve, reject, attempt: 0 });
    processQueue();
  });
}

function processQueue() {
  if (isProcessingQueue) {
    return;
  }
  const job = requestQueue.shift();
  if (!job) {
    return;
  }
  isProcessingQueue = true;
  const now = Date.now();
  const wait = Math.max(0, nextAvailableTime - now);
  setTimeout(async () => {
    try {
      const response = await job.executor();
      updateRateLimitFromHeaders(response.headers);
      nextAvailableTime = Math.max(Date.now() + MIN_REQUEST_INTERVAL_MS, nextAvailableTime + MIN_REQUEST_INTERVAL_MS);
      job.resolve(response);
      isProcessingQueue = false;
      processQueue();
    } catch (error) {
      updateRateLimitFromHeaders(error.response && error.response.headers);
      nextAvailableTime = Math.max(Date.now() + MIN_REQUEST_INTERVAL_MS, nextAvailableTime + MIN_REQUEST_INTERVAL_MS);
      const status = error.response && error.response.status;
      const code = error.response && error.response.data && error.response.data.code;
      if ((status === 429 || code === 1011 || code === 1006) && job.attempt < 3) {
        job.attempt += 1;
        const backoff = 200 * Math.pow(2, job.attempt);
        setTimeout(() => {
          requestQueue.unshift(job);
          isProcessingQueue = false;
          processQueue();
        }, backoff);
        return;
      }
      job.reject(error);
      isProcessingQueue = false;
      processQueue();
    }
  }, wait);
}

function readPersistedRefreshToken() {
  try {
    if (!fs.existsSync(tokenFilePath)) {
      return null;
    }
    const content = fs.readFileSync(tokenFilePath, 'utf-8');
    if (!content.trim()) {
      return null;
    }
    const parsed = JSON.parse(content);
    return parsed.refreshToken || null;
  } catch (error) {
    console.warn('Failed to read token store:', error.message);
    return null;
  }
}

function persistRefreshToken(nextRefreshToken) {
  try {
    fs.writeFileSync(
      tokenFilePath,
      JSON.stringify({ refreshToken: nextRefreshToken, updatedAt: new Date().toISOString() }, null, 2),
      'utf-8'
    );
  } catch (error) {
    console.warn('Failed to persist token store:', error.message);
  }
}

let refreshToken = readPersistedRefreshToken();

if (!refreshToken) {
  console.error('Missing Questrade refresh token. Run npm run seed-token -- <refreshToken> to initialize token-store.json.');
  process.exit(1);
}

async function refreshAccessToken() {
  const tokenUrl = 'https://login.questrade.com/oauth2/token';
  const params = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  };

  let response;
  try {
    response = await axios.get(tokenUrl, { params });
  } catch (error) {
    const status = error.response ? error.response.status : 'NO_RESPONSE';
    const payload = error.response ? error.response.data : error.message;
    console.error('Failed to refresh Questrade token', status, payload);
    throw error;
  }

  const tokenData = response.data;
  const cacheTtl = Math.max((tokenData.expires_in || 1800) - 60, 60);
  const tokenContext = {
    accessToken: tokenData.access_token,
    apiServer: tokenData.api_server,
    expiresIn: tokenData.expires_in,
    acquiredAt: Date.now(),
  };
  tokenCache.set('tokenContext', tokenContext, cacheTtl);

  if (tokenData.refresh_token && tokenData.refresh_token !== refreshToken) {
    refreshToken = tokenData.refresh_token;
    persistRefreshToken(refreshToken);
  }

  return tokenContext;
}

async function getTokenContext() {
  const cached = tokenCache.get('tokenContext');
  if (cached) {
    return cached;
  }
  return refreshAccessToken();
}

async function questradeRequest(pathSegment, options = {}) {
  const { method = 'GET', params, data, headers = {} } = options;
  const tokenContext = await getTokenContext();
  const url = new URL(pathSegment, tokenContext.apiServer).toString();

  const baseConfig = {
    method,
    url,
    params,
    data,
    headers: Object.assign(
      {
        Authorization: 'Bearer ' + tokenContext.accessToken,
      },
      headers
    ),
  };

  try {
    const response = await enqueueRequest(() => axios(baseConfig));
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 401) {
      tokenCache.del('tokenContext');
      const freshContext = await refreshAccessToken();
      const retryConfig = {
        method,
        url: new URL(pathSegment, freshContext.apiServer).toString(),
        params,
        data,
        headers: Object.assign(
          {
            Authorization: 'Bearer ' + freshContext.accessToken,
          },
          headers
        ),
      };
      const retryResponse = await enqueueRequest(() => axios(retryConfig));
      return retryResponse.data;
    }
    console.error('Questrade API error:', error.response ? error.response.data : error.message);
    throw error;
  }
}

async function fetchAccounts() {
  const data = await questradeRequest('/v1/accounts');
  return data.accounts || [];
}

async function fetchPositions(accountId) {
  const data = await questradeRequest('/v1/accounts/' + accountId + '/positions');
  return data.positions || [];
}

async function fetchBalances(accountId) {
  const data = await questradeRequest('/v1/accounts/' + accountId + '/balances');
  return data || {};
}

async function fetchSymbolsDetails(symbolIds) {
  if (!symbolIds.length) {
    return {};
  }

  const batches = [];
  const BATCH_SIZE = 50;
  for (let i = 0; i < symbolIds.length; i += BATCH_SIZE) {
    batches.push(symbolIds.slice(i, i + BATCH_SIZE));
  }

  const results = {};
  for (const batch of batches) {
    const idsParam = batch.join(',');
    const data = await questradeRequest('/v1/symbols', { params: { ids: idsParam } });
    (data.symbols || []).forEach(function (symbol) {
      results[symbol.symbolId] = symbol;
    });
  }
  return results;
}

function mergeBalances(allBalances) {
  const summary = {
    combined: {},
    perCurrency: {},
  };

  allBalances.forEach(function (balanceEntry) {
    const combinedBalances = balanceEntry.combinedBalances || [];
    const perCurrencyBalances = balanceEntry.perCurrencyBalances || [];

    combinedBalances.forEach(function (balance) {
      const currency = balance.currency;
      if (!summary.combined[currency]) {
        summary.combined[currency] = {
          totalEquity: 0,
          marketValue: 0,
          cash: 0,
          buyingPower: 0,
          maintenanceExcess: 0,
          netDeposits: 0,
        };
      }
      const target = summary.combined[currency];
      target.totalEquity += balance.totalEquity || 0;
      target.marketValue += balance.marketValue || 0;
      target.cash += balance.cash || 0;
      target.buyingPower += balance.buyingPower || 0;
      target.maintenanceExcess += balance.maintenanceExcess || 0;
      target.netDeposits += balance.netDeposits || 0;
    });

    perCurrencyBalances.forEach(function (balance) {
      const currency = balance.currency;
      if (!summary.perCurrency[currency]) {
        summary.perCurrency[currency] = {
          totalEquity: 0,
          marketValue: 0,
          cash: 0,
          buyingPower: 0,
          maintenanceExcess: 0,
          netDeposits: 0,
        };
      }
      const target = summary.perCurrency[currency];
      target.totalEquity += balance.totalEquity || 0;
      target.marketValue += balance.marketValue || 0;
      target.cash += balance.cash || 0;
      target.buyingPower += balance.buyingPower || 0;
      target.maintenanceExcess += balance.maintenanceExcess || 0;
      target.netDeposits += balance.netDeposits || 0;
    });
  });

  return summary;
}

function mergePnL(positions) {
  return positions.reduce(
    function (acc, position) {
      acc.dayPnl += position.dayPnl || 0;
      acc.openPnl += position.openPnl || 0;
      return acc;
    },
    { dayPnl: 0, openPnl: 0 }
  );
}

function decoratePositions(positions, symbolsMap, accountsMap) {
  return positions.map(function (position) {
    const symbolInfo = symbolsMap[position.symbolId];
    const accountInfo = accountsMap[position.accountNumber || position.accountId];
    return {
      accountId: position.accountNumber || position.accountId,
      accountNumber: position.accountNumber || (accountInfo ? accountInfo.number : null),
      accountType: accountInfo ? accountInfo.type : null,
      accountPrimary: accountInfo ? accountInfo.isPrimary : null,
      symbol: position.symbol,
      symbolId: position.symbolId,
      description: symbolInfo ? symbolInfo.description : null,
      currency: position.currency || (symbolInfo ? symbolInfo.currency : null),
      openQuantity: position.openQuantity,
      currentPrice: position.currentPrice,
      currentMarketValue: position.currentMarketValue,
      averageEntryPrice: position.averageEntryPrice,
      dayPnl: position.dayPnl,
      openPnl: position.openPnl,
      totalCost: position.totalCost,
      isRealTime: position.isRealTime,
    };
  });
}

app.get('/api/summary', async function (req, res) {
  const accountIdFilter = req.query.accountId && req.query.accountId !== 'all' ? Number(req.query.accountId) : null;

  try {
    const accounts = await fetchAccounts();
    const accountNumberFilter = req.query.accountId && req.query.accountId !== 'all' ? String(req.query.accountId) : null;

    const accountsToUse = accountNumberFilter
      ? accounts.filter(function (acct) {
          return acct.number === accountNumberFilter;
        })
      : accounts;

    if (!accountsToUse.length) {
      return res.status(404).json({ message: 'No accounts found for the provided filter.' });
    }

    const accountsMap = {};
    accounts.forEach(function (account) {
      accountsMap[account.number] = account;
    });

    const positionsResults = [];
    const balancesResults = [];
    for (const account of accountsToUse) {
      positionsResults.push(await fetchPositions(account.number));
      balancesResults.push(await fetchBalances(account.number));
    }

    const flattenedPositions = positionsResults
      .map(function (positions, index) {
        return positions.map(function (position) {
          return Object.assign({}, position, {
            accountId: accountsToUse[index].number,
            accountNumber: accountsToUse[index].number,
          });
        });
      })
      .flat();

    const symbolIds = Array.from(
      new Set(
        flattenedPositions
          .map(function (position) {
            return position.symbolId;
          })
          .filter(Boolean)
      )
    );
    const symbolsMap = await fetchSymbolsDetails(symbolIds);

    const decoratedPositions = decoratePositions(flattenedPositions, symbolsMap, accountsMap);
    const pnl = mergePnL(flattenedPositions);
    const balancesSummary = mergeBalances(balancesResults);

    res.json({
      accounts: accounts.map(function (account) {
        return {
          id: account.number,
          number: account.number,
          type: account.type,
          status: account.status,
          isPrimary: account.isPrimary,
          isBilling: account.isBilling,
          clientAccountType: account.clientAccountType,
        };
      }),
      filteredAccountIds: accountsToUse.map(function (acct) {
        return acct.number;
      }),
      positions: decoratedPositions,
      pnl: pnl,
      balances: balancesSummary,
      asOf: new Date().toISOString(),
    });
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status).json({ message: 'Questrade API error', details: error.response.data });
    }
    res.status(500).json({ message: 'Unexpected server error', details: error.message });
  }
});

app.get('/health', function (req, res) {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, function () {
  console.log('Server listening on port ' + PORT);
});

























