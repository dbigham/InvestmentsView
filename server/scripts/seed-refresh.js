const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { CookieJar } = require('tough-cookie');
const { request, Agent, ProxyAgent } = require('undici');
const { getProxyForUrl } = require('proxy-from-env');

const tokenUrl = 'https://login.questrade.com/oauth2/token';
const MAX_REDIRECTS = 5;
const BASE_HEADERS = {
  'User-Agent': 'python-requests/2.32.5',
  Accept: 'application/json, text/plain, */*',
  'Accept-Encoding': 'gzip, compress, deflate, br',
};

function parseArgs(argv) {
  const options = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      const trimmed = arg.slice(2);
      if (trimmed.includes('=')) {
        const [key, value] = trimmed.split('=');
        options[key] = value;
      } else {
        const next = argv[index + 1];
        if (next && !next.startsWith('--')) {
          options[trimmed] = next;
          index += 1;
        } else {
          options[trimmed] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }

  return { options, positional };
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

function loadTokenStore(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { logins: [] };
    }
    const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
    if (!content.trim()) {
      return { logins: [] };
    }
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed.logins)) {
      const logins = parsed.logins
        .map((login, index) => normalizeLogin(login, 'login-' + (index + 1)))
        .filter(Boolean);
      const store = { logins };
      if (parsed.updatedAt) {
        store.updatedAt = parsed.updatedAt;
      }
      return store;
    }
    if (parsed.refreshToken) {
      const login = normalizeLogin(
        {
          id: parsed.id || parsed.loginId || 'primary',
          label: parsed.label || parsed.ownerLabel || null,
          email: parsed.email || parsed.ownerEmail || null,
          refreshToken: parsed.refreshToken,
          updatedAt: parsed.updatedAt || null,
        },
        'primary'
      );
      const store = { logins: login ? [login] : [] };
      if (parsed.updatedAt) {
        store.updatedAt = parsed.updatedAt;
      }
      return store;
    }
    return { logins: [] };
  } catch (error) {
    console.warn('Failed to read token store:', error.message);
    return { logins: [] };
  }
}

function writeTokenStore(filePath, store) {
  const sanitizedLogins = (store.logins || []).map((login) => {
    const base = {
      id: login.id,
      label: login.label || null,
      email: login.email || null,
      refreshToken: login.refreshToken,
      updatedAt: login.updatedAt || null,
    };
    Object.keys(login).forEach((key) => {
      if (['id', 'label', 'email', 'refreshToken', 'updatedAt'].includes(key)) {
        return;
      }
      base[key] = login[key];
    });
    return base;
  });
  const payload = {
    logins: sanitizedLogins,
    updatedAt: store.updatedAt || new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
}

function collectSetCookieValues(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [value];
}

function decodeResponseBody(buffer, encoding) {
  if (!buffer) {
    return '';
  }
  const normalized = String(encoding || '').toLowerCase();
  try {
    if (!normalized || normalized === 'identity') {
      return buffer.toString('utf8');
    }
    if (normalized.includes('br')) {
      return zlib.brotliDecompressSync(buffer).toString('utf8');
    }
    if (normalized.includes('gzip')) {
      return zlib.gunzipSync(buffer).toString('utf8');
    }
    if (normalized.includes('deflate')) {
      return zlib.inflateSync(buffer).toString('utf8');
    }
  } catch (error) {
    console.warn('[seed-refresh] Failed to decode response body', {
      message: error.message,
      encoding: normalized,
    });
  }
  return buffer.toString('utf8');
}

function createDispatcher(targetUrl) {
  const proxyUri = getProxyForUrl(targetUrl);
  const dispatcher = proxyUri ? new ProxyAgent({ uri: proxyUri }) : new Agent();
  return {
    dispatcher,
    proxyUri,
  };
}

async function exchangeRefreshToken(refreshTokenInput) {
  const jar = new CookieJar();
  let currentUrl = tokenUrl;
  let includeParams = true;

  const { dispatcher } = createDispatcher(tokenUrl);

  try {
    for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
      const urlObj = new URL(currentUrl);
      if (includeParams) {
        urlObj.searchParams.set('grant_type', 'refresh_token');
        urlObj.searchParams.set('refresh_token', refreshTokenInput);
      }
      const requestUrl = urlObj.toString();
      const headers = { ...BASE_HEADERS };
      const cookieHeader = await jar.getCookieString(requestUrl);
      if (cookieHeader) {
        headers.Cookie = cookieHeader;
      }

      const response = await request(requestUrl, {
        method: 'GET',
        headers,
        dispatcher,
      });

      const headersObject = {};
      Object.entries(response.headers || {}).forEach(([key, value]) => {
        headersObject[key.toLowerCase()] = value;
      });

      for (const cookie of collectSetCookieValues(headersObject['set-cookie'])) {
        try {
          await jar.setCookie(cookie, requestUrl);
        } catch (error) {
          console.warn('[seed-refresh] Failed to persist response cookie', { message: error.message });
        }
      }

      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        headersObject.location
      ) {
        currentUrl = new URL(headersObject.location, requestUrl).toString();
        includeParams = false;
        continue;
      }

      const buffer = Buffer.from(await response.body.arrayBuffer());
      const decoded = decodeResponseBody(buffer, headersObject['content-encoding']);
      let data = decoded;
      const contentType = headersObject['content-type'] || '';
      if (contentType.includes('application/json')) {
        try {
          data = JSON.parse(decoded || '{}');
        } catch (error) {
          console.warn('[seed-refresh] Failed to parse JSON response', { message: error.message });
        }
      }

      return {
        status: response.statusCode,
        data,
        headers: headersObject,
      };
    }
  } finally {
    if (dispatcher && typeof dispatcher.close === 'function') {
      try {
        await dispatcher.close();
      } catch (error) {
        console.warn('[seed-refresh] Failed to close dispatcher', { message: error.message });
      }
    }
  }

  throw new Error('Exceeded maximum redirects during refresh exchange');
}

function maskTokenForLog(token) {
  if (!token || typeof token !== 'string') {
    return '<missing>';
  }
  if (token.length <= 8) {
    return token;
  }
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

(async () => {
  const { options, positional } = parseArgs(process.argv.slice(2));

  const refreshTokenInput = positional[0] || process.env.QUESTRADE_REFRESH_TOKEN;
  const loginId =
    options.id || options.login || process.env.QUESTRADE_LOGIN_ID || process.env.QUESTRADE_LOGIN || 'primary';
  const loginLabel = options.label || process.env.QUESTRADE_LOGIN_LABEL || null;
  const loginEmail = options.email || process.env.QUESTRADE_LOGIN_EMAIL || null;

  if (!refreshTokenInput) {
    console.error('Usage: npm run seed-token -- <refreshToken> [--id=<loginId>] [--label="Display Name"] [--email=<email>]');
    process.exit(1);
  }

  console.log('[seed-refresh] Exchanging refresh token', maskTokenForLog(refreshTokenInput));

  try {
    const exchange = await exchangeRefreshToken(refreshTokenInput);
    if (!exchange || exchange.status < 200 || exchange.status >= 300) {
      const status = exchange ? exchange.status : null;
      const payload = exchange ? exchange.data : null;
      console.error('[seed-refresh] Failed to exchange token', { status, payload });
      process.exit(1);
    }

    const data = exchange.data || {};
    if (!data.refresh_token) {
      console.error('[seed-refresh] Response did not include refresh_token:', data);
      process.exit(1);
    }
    console.log('Access token acquired. Questrade response:');
    console.log(JSON.stringify(data, null, 2));

    const tokenPath = path.join(process.cwd(), 'token-store.json');
    const currentStore = loadTokenStore(tokenPath);
    const logins = currentStore.logins || [];

    let targetLogin = logins.find((login) => login.id === String(loginId));
    const nowIso = new Date().toISOString();

    if (!targetLogin) {
      targetLogin = {
        id: String(loginId),
        refreshToken: data.refresh_token,
        updatedAt: nowIso,
        label: loginLabel || loginEmail || null,
        email: loginEmail || null,
      };
      logins.push(targetLogin);
      console.log('Created new login entry:', targetLogin.id);
    } else {
      targetLogin.refreshToken = data.refresh_token;
      targetLogin.updatedAt = nowIso;
      if (loginLabel) {
        targetLogin.label = loginLabel;
      }
      if (loginEmail) {
        targetLogin.email = loginEmail;
      }
      console.log('Updated existing login entry:', targetLogin.id);
    }

    currentStore.logins = logins;
    currentStore.updatedAt = nowIso;
    writeTokenStore(tokenPath, currentStore);

    console.log('token-store.json updated successfully.');
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) {
      console.error('[seed-refresh] Questrade response:', error.status, error.body);
    } else {
      console.error('[seed-refresh] Error:', error.message);
    }
    process.exit(1);
  }
})();
