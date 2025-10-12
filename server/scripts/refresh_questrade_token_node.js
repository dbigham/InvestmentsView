#!/usr/bin/env node
const axios = require('axios');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { CookieJar } = require('tough-cookie');
const { request: undiciRequest, Agent: UndiciAgent, ProxyAgent: UndiciProxyAgent } = require('undici');
const { getProxyForUrl } = require('proxy-from-env');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');

const MAX_REDIRECTS = 5;
const DEFAULT_HEADERS = {
  'User-Agent': 'python-requests/2.32.5',
  Accept: 'application/json, text/plain, */*',
  'Accept-Encoding': 'gzip, compress, deflate, br',
};
const TOKEN_URL = 'https://login.questrade.com/oauth2/token';

function maskToken(token) {
  if (!token || typeof token !== 'string') {
    return '<missing>';
  }
  if (token.length <= 8) {
    return token;
  }
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function sanitizeParams(params) {
  if (!params) {
    return null;
  }
  const output = {};
  Object.entries(params).forEach(([key, value]) => {
    if (key === 'refresh_token' && typeof value === 'string') {
      output[key] = maskToken(value);
    } else {
      output[key] = value;
    }
  });
  return output;
}

function sanitizeHeaders(headers) {
  const output = {};
  Object.entries(headers || {}).forEach(([key, value]) => {
    if (!value) {
      output[key] = value;
      return;
    }
    if (typeof value === 'string' && value.toLowerCase().includes('refresh_token=')) {
      output[key] = value.replace(/refresh_token=([^&]+)/gi, 'refresh_token=<masked>');
    } else {
      output[key] = value;
    }
  });
  return output;
}

function sanitizeLocation(location) {
  if (!location || typeof location !== 'string') {
    return location;
  }
  return location.replace(/refresh_token=([^&]+)/gi, 'refresh_token=<masked>');
}

function ensureDirectoryExists(targetPath) {
  const directory = path.dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true });
}

function writeTrace(trace, result) {
  if (!trace || !trace.path) {
    return;
  }

  const payload = {
    createdAt: new Date().toISOString(),
    iterations: trace.iterations,
    request: trace.request,
    connection: trace.connection,
    tls: trace.tls,
    events: trace.events,
    result: result.success
      ? {
          success: true,
          iterations: trace.iterations,
          finalRefreshToken: maskToken(result.finalRefreshToken || ''),
        }
      : {
          success: false,
          status: result.status || null,
          error: result.error || null,
        },
  };

  try {
    ensureDirectoryExists(trace.path);
    fs.writeFileSync(trace.path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.error('[node-refresh] failed to write trace', { message: err.message, path: trace.path });
  }
}

function buildTransportAgents(agentOptions, proxyUri) {
  if (proxyUri) {
    const httpsAgent = new HttpsProxyAgent(proxyUri, agentOptions);
    const httpAgent = new HttpProxyAgent(proxyUri, { keepAlive: agentOptions.keepAlive });
    return { httpsAgent, httpAgent };
  }

  const httpsAgent = new https.Agent(agentOptions);
  const httpAgent = new http.Agent({ keepAlive: agentOptions.keepAlive });
  return { httpsAgent, httpAgent };
}

function decodeBody(buffer, encoding) {
  const normalized = (encoding || '').toLowerCase();
  if (!normalized || normalized === 'identity') {
    return buffer.toString('utf8');
  }
  try {
    if (normalized.includes('br')) {
      return zlib.brotliDecompressSync(buffer).toString('utf8');
    }
    if (normalized.includes('gzip')) {
      return zlib.gunzipSync(buffer).toString('utf8');
    }
    if (normalized.includes('deflate')) {
      return zlib.inflateSync(buffer).toString('utf8');
    }
  } catch (err) {
    console.error('[node-refresh] failed to decode body', { message: err.message, encoding: normalized });
  }
  return buffer.toString('utf8');
}

function createAxiosClient(agentOptions, proxyUri) {
  const { httpsAgent, httpAgent } = buildTransportAgents(agentOptions, proxyUri);
  const instance = axios.create({
    maxRedirects: 0,
    validateStatus: () => true,
    httpsAgent,
    httpAgent,
    proxy: false,
  });
  return {
    type: 'axios',
    request: (config) => instance.request(config),
    async cleanup() {
      httpsAgent.destroy();
      httpAgent.destroy();
    },
  };
}

function createHttpsClient(agentOptions, proxyUri) {
  const { httpsAgent, httpAgent } = buildTransportAgents(agentOptions, proxyUri);

  const execute = async (config) => {
    const urlObj = new URL(config.url);
    const isHttps = urlObj.protocol === 'https:';
    const transport = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;

    if (config.method === 'GET' && config.params) {
      Object.entries(config.params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          urlObj.searchParams.set(key, value);
        }
      });
    }

    const requestOptions = {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: `${urlObj.pathname}${urlObj.search}`,
      method: config.method,
      headers: config.headers,
      agent,
    };

    return new Promise((resolve, reject) => {
      const req = transport.request(requestOptions, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks);
          const headers = res.headers || {};
          const contentEncoding = headers['content-encoding'] || '';
          const decodedBody = decodeBody(bodyBuffer, contentEncoding);
          let data = decodedBody;
          const contentType = headers['content-type'] || '';
          if (contentType.includes('application/json')) {
            try {
              data = JSON.parse(decodedBody || '{}');
            } catch (err) {
              data = decodedBody;
            }
          }
          resolve({
            status: res.statusCode,
            headers,
            data,
          });
        });
      });

      req.on('error', reject);

      if (config.method === 'POST' && config.data) {
        req.write(config.data);
      }
      req.end();
    });
  };

  return {
    type: 'https',
    request: execute,
    async cleanup() {
      httpsAgent.destroy();
      httpAgent.destroy();
    },
  };
}

function createUndiciClient(agentOptions, proxyUri) {
  const connect = {};
  if (agentOptions.minVersion || agentOptions.maxVersion || agentOptions.ciphers) {
    connect.tls = {
      minVersion: agentOptions.minVersion,
      maxVersion: agentOptions.maxVersion,
      ciphers: agentOptions.ciphers,
      honorCipherOrder: agentOptions.honorCipherOrder,
    };
  }

  let dispatcher;
  if (proxyUri) {
    dispatcher = new UndiciProxyAgent({
      uri: proxyUri,
      keepAliveTimeout: agentOptions.keepAlive === false ? 1 : undefined,
      keepAliveMaxTimeout: agentOptions.keepAlive === false ? 1 : undefined,
      connect,
    });
  } else {
    dispatcher = new UndiciAgent({
      keepAliveTimeout: agentOptions.keepAlive === false ? 1 : undefined,
      keepAliveMaxTimeout: agentOptions.keepAlive === false ? 1 : undefined,
      connect,
    });
  }

  const execute = async (config) => {
    const urlObj = new URL(config.url);
    if (config.method === 'GET' && config.params) {
      Object.entries(config.params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          urlObj.searchParams.set(key, value);
        }
      });
    }

    const requestOptions = {
      method: config.method,
      headers: config.headers,
      body: config.method === 'POST' ? config.data || null : null,
      dispatcher,
    };

    const response = await undiciRequest(urlObj, requestOptions);
    const arrayBuffer = await response.body.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const headers = {};
    Object.entries(response.headers).forEach(([key, value]) => {
      headers[key.toLowerCase()] = value;
    });
    const contentEncoding = headers['content-encoding'] || '';
    const decoded = decodeBody(buffer, contentEncoding);
    let data = decoded;
    const contentType = headers['content-type'] || '';
    if (contentType.includes('application/json')) {
      try {
        data = JSON.parse(decoded || '{}');
      } catch (err) {
        data = decoded;
      }
    }
    return {
      status: response.statusCode,
      headers,
      data,
    };
  };

  return {
    type: 'undici',
    request: execute,
    async cleanup() {
      await dispatcher.close();
    },
  };
}

function buildHttpClient(clientType, agentOptions, proxyUri) {
  switch (clientType) {
    case 'https':
      return createHttpsClient(agentOptions, proxyUri);
    case 'undici':
      return createUndiciClient(agentOptions, proxyUri);
    case 'axios':
    default:
      return createAxiosClient(agentOptions, proxyUri);
  }
}

async function refreshOnce(client, jar, initialConfig, trace) {
  let currentUrl = initialConfig.url;
  let method = (initialConfig.method || 'GET').toUpperCase();
  let getParams = method === 'GET' ? { ...initialConfig.params } : undefined;
  let bodyParams = method === 'POST' ? { ...initialConfig.params } : undefined;

  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
    const headers = { ...initialConfig.headers };

    const cookieHeader = await jar.getCookieString(currentUrl);
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }
    if (initialConfig.connectionClose) {
      headers.Connection = 'close';
    }

    const cookieNames = cookieHeader
      ? cookieHeader.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean)
      : [];

    trace.events.push({
      type: 'request',
      attempt: attempt + 1,
      url: currentUrl,
      method,
      params: sanitizeParams(method === 'GET' ? getParams : bodyParams),
      headers: sanitizeHeaders(headers),
      cookies: cookieNames,
    });

    const requestConfig = {
      url: currentUrl,
      method,
      headers,
    };

    if (method === 'GET' && getParams) {
      requestConfig.params = getParams;
    }

    if (method === 'POST' && bodyParams) {
      const payload = new URLSearchParams();
      Object.entries(bodyParams).forEach(([key, value]) => {
        payload.append(key, value);
      });
      requestConfig.data = payload.toString();
      if (!requestConfig.headers['Content-Type']) {
        requestConfig.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    }

    let response;
    try {
      response = await client.request(requestConfig);
    } catch (err) {
      trace.events.push({
        type: 'error',
        attempt: attempt + 1,
        message: err.message,
        code: err.code || null,
      });
      throw err;
    }

    const setCookieHeader = response.headers['set-cookie'];
    if (Array.isArray(setCookieHeader)) {
      for (const cookieString of setCookieHeader) {
        try {
          await jar.setCookie(cookieString, currentUrl);
        } catch (err) {
          trace.events.push({
            type: 'cookieError',
            attempt: attempt + 1,
            message: err.message,
          });
        }
      }
    }

    const setCookieNames = Array.isArray(setCookieHeader)
      ? setCookieHeader.map((cookie) => cookie.split('=')[0])
      : [];

    trace.events.push({
      type: 'response',
      attempt: attempt + 1,
      status: response.status,
      location: sanitizeLocation(response.headers.location || null),
      setCookies: setCookieNames,
    });

    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      const nextUrl = new URL(response.headers.location, currentUrl).toString();
      trace.events.push({
        type: 'redirect',
        attempt: attempt + 1,
        nextUrl: sanitizeLocation(nextUrl),
        status: response.status,
      });
      currentUrl = nextUrl;
      method = 'GET';
      getParams = undefined;
      bodyParams = undefined;
      continue;
    }

    return response;
  }

  throw new Error('Exceeded maximum redirects');
}

let globalTrace = null;

async function main() {
  const trace = {
    path: null,
    iterations: 0,
    request: {},
    connection: {},
    tls: {},
    events: [],
  };
  globalTrace = trace;

  const exitWith = (result, code) => {
    writeTrace(trace, result);
    console.log(JSON.stringify(result));
    process.exit(code);
  };

  const inputRaw = process.argv[2];
  if (!inputRaw) {
    exitWith({ success: false, error: 'Missing JSON payload argument' }, 1);
  }

  let input;
  try {
    input = JSON.parse(inputRaw);
  } catch (err) {
    exitWith({ success: false, error: 'Invalid JSON payload', detail: err.message }, 1);
  }

  const refreshToken = input.refreshToken;
  const iterations = Number.isFinite(input.iterations) && input.iterations > 0 ? input.iterations : 1;

  if (!refreshToken) {
    exitWith({ success: false, error: 'Missing refresh token' }, 1);
  }

  const config = input.config || {};
  const method = (config.method || input.method || 'GET').toUpperCase();
  const tracePath = config.tracePath || input.tracePath || null;
  const headers = { ...DEFAULT_HEADERS, ...(config.headers || input.headers || {}) };
  const connection = config.connection || {};
  const tls = config.tls || {};
  const clientType = (config.client || input.client || 'axios').toLowerCase();

  const keepAlive =
    connection.keepAlive !== undefined
      ? Boolean(connection.keepAlive)
      : input.keepAlive !== undefined
      ? Boolean(input.keepAlive)
      : true;
  const connectionClose =
    connection.connectionClose !== undefined
      ? Boolean(connection.connectionClose)
      : Boolean(input.connectionClose);

  const agentOptions = {
    keepAlive,
  };
  if (tls.minVersion) {
    agentOptions.minVersion = tls.minVersion;
  }
  if (tls.maxVersion) {
    agentOptions.maxVersion = tls.maxVersion;
  }
  if (tls.ciphers) {
    agentOptions.ciphers = tls.ciphers;
    agentOptions.honorCipherOrder = true;
  }

  const tracePathResolved = tracePath ? path.resolve(tracePath) : null;
  trace.path = tracePathResolved;
  trace.iterations = iterations;
  trace.request = {
    url: TOKEN_URL,
    method,
    headers: sanitizeHeaders(headers),
  };
  const url = TOKEN_URL;
  const proxyUri = getProxyForUrl(url) || null;
  trace.connection = { keepAlive, connectionClose, client: clientType, proxy: proxyUri };
  trace.tls = agentOptions;

  const jar = new CookieJar();
  const results = [];
  let token = refreshToken;

  console.error('[node-refresh] starting', {
    token: maskToken(token),
    iterations,
    method,
    keepAlive,
    connectionClose,
    proxy: proxyUri,
  });

  const client = buildHttpClient(clientType, agentOptions, proxyUri);

  for (let index = 0; index < iterations; index += 1) {
    trace.events.push({ type: 'cycle', index: index + 1 });
    console.error('[node-refresh]', { step: 'cycle', index: index + 1 });

    const requestConfig = {
      url,
      method,
      params: {
        grant_type: 'refresh_token',
        refresh_token: token,
      },
      headers: { ...headers },
      connectionClose,
    };

    let response;
    try {
      response = await refreshOnce(client, jar, requestConfig, trace);
    } catch (err) {
      trace.events.push({ type: 'failure', message: err.message });
      exitWith({ success: false, error: err.message }, 1);
    }

    if (!response || response.status < 200 || response.status >= 300) {
      const failureResult = {
        success: false,
        status: response ? response.status : null,
        body: response ? response.data : null,
      };
      trace.events.push({ type: 'failure', status: failureResult.status });
      exitWith(failureResult, 1);
    }

    const payload = response.data || {};
    token = payload.refresh_token || token;
    results.push({
      status: response.status,
      apiServer: payload.api_server,
      expiresIn: payload.expires_in,
      refreshToken: payload.refresh_token,
    });

    console.error('[node-refresh] success', {
      status: response.status,
      apiServer: payload.api_server,
      expiresIn: payload.expires_in,
      newToken: maskToken(token),
    });
  }

  const successResult = {
    success: true,
    results,
    finalRefreshToken: token,
  };
  await client.cleanup?.();
  exitWith(successResult, 0);
}

main().catch((err) => {
  const result = { success: false, error: err.message, stack: err.stack };
  console.error('[node-refresh] unexpected error', { message: err.message });
  writeTrace(globalTrace, result);
  console.log(JSON.stringify(result));
  process.exit(1);
});
