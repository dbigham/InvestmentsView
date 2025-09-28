const axios = require('axios');
const fs = require('fs');
const path = require('path');

const tokenUrl = 'https://login.questrade.com/oauth2/token';

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

(async () => {
  try {
    const response = await axios.get(tokenUrl, {
      params: {
        grant_type: 'refresh_token',
        refresh_token: refreshTokenInput,
      },
    });

    const data = response.data;
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
    if (error.response) {
      console.error('Questrade response:', error.response.status, error.response.data);
    } else {
      console.error(error.message);
    }
    process.exit(1);
  }
})();
