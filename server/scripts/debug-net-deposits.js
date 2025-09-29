#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ROOT_DIR = path.join(__dirname, '..');
const TOKEN_STORE_PATH = path.join(ROOT_DIR, 'token-store.json');
const DOTENV_PATH = path.join(ROOT_DIR, '.env');

try {
  require('dotenv').config({ path: DOTENV_PATH });
} catch (error) {
  // optional
}

function parseArgs(argv) {
  const options = { positional: [] };
  argv.forEach((arg) => {
    if (!arg.startsWith('--')) {
      options.positional.push(arg);
      return;
    }
    const trimmed = arg.slice(2);
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      options[trimmed] = true;
      return;
    }
    const key = trimmed.slice(0, eqIndex);
    const value = trimmed.slice(eqIndex + 1);
    options[key] = value;
  });
  return options;
}

function normalizeLogin(login, fallbackId) {
  if (!login || typeof login !== 'object') {
    return null;
  }
  const normalized = Object.assign({}, login);
  if (normalized.refresh_token && !normalized.refreshToken) {
    normalized.refreshToken = normalized.refresh_token;
  }
  if (normalized.ownerLabel && !normalized.label) {
    normalized.label = normalized.ownerLabel;
  }
  if (normalized.ownerEmail && !normalized.email) {
    normalized.email = normalized.ownerEmail;
  }
  const resolvedId = normalized.id || fallbackId;
  if (!resolvedId) {
    return null;
  }
  normalized.id = String(resolvedId);
  if (!normalized.refreshToken) {
    return null;
  }
  delete normalized.refresh_token;
  delete normalized.ownerLabel;
  delete normalized.ownerEmail;
  return normalized;
}

function loadTokenStore() {
  if (!fs.existsSync(TOKEN_STORE_PATH)) {
    throw new Error('token-store.json is missing. Seed tokens before running this script.');
  }
  const content = fs.readFileSync(TOKEN_STORE_PATH, 'utf-8').replace(/^\uFEFF/, '');
  if (!content.trim()) {
    throw new Error('token-store.json is empty. Seed tokens before running this script.');
  }
  const parsed = JSON.parse(content);
  if (Array.isArray(parsed.logins)) {
    const logins = parsed.logins
      .map((login, index) => normalizeLogin(login, 'login-' + (index + 1)))
      .filter(Boolean);
    return logins;
  }
  if (parsed.refreshToken) {
    const legacyLogin = normalizeLogin(
      {
        id: parsed.id || parsed.loginId || 'primary',
        label: parsed.label || parsed.ownerLabel || null,
        email: parsed.email || parsed.ownerEmail || null,
        refreshToken: parsed.refreshToken,
        updatedAt: parsed.updatedAt || null,
      },
      'primary'
    );
    return legacyLogin ? [legacyLogin] : [];
  }
  return [];
}

function resolveLoginDisplay(login) {
  if (!login) {
    return 'unknown login';
  }
  return login.label || login.email || login.id;
}

async function refreshAccessToken(login) {
  const tokenUrl = 'https://login.questrade.com/oauth2/token';
  const params = {
    grant_type: 'refresh_token',
    refresh_token: login.refreshToken,
  };

  let response;
  try {
    response = await axios.get(tokenUrl, { params });
  } catch (error) {
    const status = error.response ? error.response.status : 'NO_RESPONSE';
    const payload = error.response ? error.response.data : error.message;
    throw new Error(
      'Token refresh failed for ' + resolveLoginDisplay(login) + ' -> ' + status + ' ' + JSON.stringify(payload)
    );
  }

  const tokenData = response.data;
  if (!tokenData || !tokenData.access_token || !tokenData.api_server) {
    throw new Error('Unexpected token payload: ' + JSON.stringify(tokenData));
  }

  return {
    accessToken: tokenData.access_token,
    apiServer: tokenData.api_server,
  };
}

async function questradeGet(context, pathSegment, params) {
  const url = new URL(pathSegment, context.apiServer).toString();
  return axios.get(url, {
    params,
    headers: {
      Authorization: 'Bearer ' + context.accessToken,
    },
  });
}

function formatDate(input) {
  if (!input) {
    return null;
  }
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid date provided: ' + input);
  }
  return date.toISOString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const logins = loadTokenStore();
  if (!logins.length) {
    throw new Error('No Questrade logins available in token-store.json.');
  }

  let login = null;
  if (args.login) {
    login = logins.find((entry) => entry.id === args.login);
    if (!login) {
      throw new Error('No login with id "' + args.login + '" found. Available: ' + logins.map((l) => l.id).join(', '));
    }
  } else if (logins.length === 1) {
    login = logins[0];
  } else {
    throw new Error('Multiple logins available. Provide --login=<id> (options: ' + logins.map((l) => l.id).join(', ') + ').');
  }

  const tokenContext = await refreshAccessToken(login);

  const accountsResponse = await questradeGet(tokenContext, '/v1/accounts');
  const accounts = accountsResponse.data && Array.isArray(accountsResponse.data.accounts)
    ? accountsResponse.data.accounts
    : [];
  if (!accounts.length) {
    throw new Error('No accounts returned for login ' + resolveLoginDisplay(login));
  }

  let account = null;
  if (args.account) {
    account = accounts.find((entry) => String(entry.number) === String(args.account) || String(entry.id) === String(args.account));
    if (!account) {
      throw new Error(
        'Account "' +
          args.account +
          '" not found. Available numbers: ' +
          accounts.map((entry) => entry.number || entry.id).join(', ')
      );
    }
  } else if (accounts.length === 1) {
    account = accounts[0];
  } else {
    throw new Error(
      'Multiple accounts detected. Provide --account=<accountNumber>. Options: ' +
        accounts.map((entry) => entry.number || entry.id).join(', ')
    );
  }

  const params = {};
  const startTime = formatDate(args.start);
  const endTime = formatDate(args.end);
  if (startTime) {
    params.startTime = startTime;
  }
  if (endTime) {
    params.endTime = endTime;
  }

  console.log('Requesting net deposits for account', account.number || account.id, 'using login', resolveLoginDisplay(login));
  if (params.startTime || params.endTime) {
    console.log('  with params', params);
  }

  try {
    const response = await questradeGet(
      tokenContext,
      '/v1/accounts/' + (account.number || account.id) + '/netDeposits',
      params
    );
    console.log('Status:', response.status);
    console.log('Payload:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    if (error.response) {
      console.error('Request failed with status', error.response.status);
      console.error('Headers:', JSON.stringify(error.response.headers, null, 2));
      console.error('Body:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error('Request failed:', error.message);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
