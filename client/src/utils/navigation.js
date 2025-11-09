function parsePathParts(pathname) {
  const parts = typeof pathname === 'string' ? pathname.split('/').filter(Boolean) : [];
  const result = { accountId: null, symbol: null };
  for (let i = 0; i < parts.length; i += 1) {
    const seg = parts[i];
    if (seg === 'account' && i + 1 < parts.length) {
      try {
        result.accountId = decodeURIComponent(parts[i + 1]);
      } catch (e) {
        result.accountId = parts[i + 1];
      }
      i += 1;
      continue;
    }
    if (seg === 'symbol' && i + 1 < parts.length) {
      try {
        result.symbol = decodeURIComponent(parts[i + 1]).toUpperCase();
      } catch (e) {
        result.symbol = parts[i + 1].toUpperCase();
      }
      i += 1;
      continue;
    }
  }
  return result;
}

function buildPathWithParts(currentPathname, nextParts) {
  // Preserve no extra segments for now; create canonical /account/:id[/symbol/:sym]
  const segments = [];
  if (nextParts.accountId) {
    segments.push('account', encodeURIComponent(String(nextParts.accountId)));
  }
  if (nextParts.symbol) {
    segments.push('symbol', encodeURIComponent(String(nextParts.symbol).toUpperCase()));
  }
  return `/${segments.join('/')}`;
}

export function readAccountIdFromLocation(location) {
  const targetLocation =
    location || (typeof window !== 'undefined' && window.location ? window.location : null);
  if (!targetLocation) {
    return null;
  }

  try {
    // Prefer path-based routing: /account/:id
    const fromPath = parsePathParts(targetLocation.pathname).accountId;
    if (typeof fromPath === 'string' && fromPath.trim()) {
      return fromPath.trim();
    }
    // Fallback: query param ?accountId=
    if (typeof targetLocation.search === 'string') {
      const params = new URLSearchParams(targetLocation.search);
      const rawValue = params.get('accountId');
      if (typeof rawValue === 'string') {
        const trimmed = rawValue.trim();
        return trimmed ? trimmed : null;
      }
    }
    return null;
  } catch (error) {
    console.warn('Failed to read accountId from location', error);
    return null;
  }
}

export function buildAccountViewUrl(accountId, location, extraSearchParams) {
  const targetLocation =
    location || (typeof window !== 'undefined' && window.location ? window.location : null);
  if (!targetLocation) {
    return null;
  }

  try {
    let href = typeof targetLocation.href === 'string' ? targetLocation.href : null;
    if (!href) {
      const origin =
        typeof targetLocation.origin === 'string'
          ? targetLocation.origin
          : targetLocation.protocol && targetLocation.host
          ? `${targetLocation.protocol}//${targetLocation.host}`
          : '';
      href = `${origin}${targetLocation.pathname || ''}${targetLocation.search || ''}${
        targetLocation.hash || ''
      }`;
    }

    const url = new URL(href);

    // Build canonical path /account/:id[/symbol/:sym]
    const current = parsePathParts(url.pathname);
    const next = { ...current };
    if (!accountId || accountId === 'default') {
      next.accountId = null;
    } else {
      next.accountId = String(accountId);
    }
    url.pathname = buildPathWithParts(url.pathname, next);

    // Remove legacy query param
    url.searchParams.delete('accountId');

    if (extraSearchParams && typeof extraSearchParams === 'object') {
      Object.entries(extraSearchParams).forEach(([key, value]) => {
        if (typeof key !== 'string' || !key) {
          return;
        }
        if (value === undefined || value === null || value === '') {
          url.searchParams.delete(key);
          return;
        }
        url.searchParams.set(key, String(value));
      });
    }
    return url.toString();
  } catch (error) {
    console.warn('Failed to build account view URL', error);
    return null;
  }
}

export function readTodoActionFromLocation(location) {
  const targetLocation =
    location || (typeof window !== 'undefined' && window.location ? window.location : null);
  if (!targetLocation || typeof targetLocation.search !== 'string') {
    return null;
  }

  try {
    const params = new URLSearchParams(targetLocation.search);
    const actionParam = params.get('todoAction');
    if (typeof actionParam !== 'string') {
      return null;
    }
    const normalizedAction = actionParam.trim().toLowerCase();
    if (normalizedAction !== 'cash' && normalizedAction !== 'rebalance') {
      return null;
    }

    const accountParam = params.get('accountId');
    const accountId =
      typeof accountParam === 'string' && accountParam.trim() ? accountParam.trim() : null;

    const modelParam = params.get('todoModel');
    const model = typeof modelParam === 'string' && modelParam.trim() ? modelParam.trim() : null;

    const chartParam = params.get('todoChart');
    const chartKey = typeof chartParam === 'string' && chartParam.trim() ? chartParam.trim() : null;

    const accountNumberParam = params.get('todoAccountNumber');
    const accountNumber =
      typeof accountNumberParam === 'string' && accountNumberParam.trim()
        ? accountNumberParam.trim()
        : null;

    return {
      type: normalizedAction,
      accountId,
      model,
      chartKey,
      accountNumber,
    };
  } catch (error) {
    console.warn('Failed to read TODO action from location', error);
    return null;
  }
}

export function readTodoReminderFromLocation(location) {
  const targetLocation =
    location || (typeof window !== 'undefined' && window.location ? window.location : null);
  if (!targetLocation || typeof targetLocation.search !== 'string') {
    return null;
  }

  try {
    const params = new URLSearchParams(targetLocation.search);
    const accountParam = params.get('accountId');
    const accountId =
      typeof accountParam === 'string' && accountParam.trim() ? accountParam.trim() : null;

    const accountNumberParam = params.get('todoAccountNumber');
    const accountNumber =
      typeof accountNumberParam === 'string' && accountNumberParam.trim()
        ? accountNumberParam.trim()
        : null;

    const modelParam = params.get('todoModel');
    const modelKey = typeof modelParam === 'string' && modelParam.trim() ? modelParam.trim() : null;

    if (!modelKey) {
      return null;
    }

    return {
      accountId,
      accountNumber,
      modelKey,
    };
  } catch (error) {
    console.warn('Failed to read TODO reminder from location', error);
    return null;
  }
}

export function readSymbolFromLocation(location) {
  const targetLocation =
    location || (typeof window !== 'undefined' && window.location ? window.location : null);
  if (!targetLocation) {
    return null;
  }

  try {
    // Prefer path /symbol/:sym
    const fromPath = parsePathParts(targetLocation.pathname).symbol;
    if (typeof fromPath === 'string' && fromPath.trim()) {
      return { symbol: fromPath.trim().toUpperCase() };
    }
    if (typeof targetLocation.search === 'string') {
      const params = new URLSearchParams(targetLocation.search);
      const symbolParam = params.get('symbol');
      const symbol =
        typeof symbolParam === 'string' && symbolParam.trim()
          ? symbolParam.trim().toUpperCase()
          : null;
      if (symbol) {
        return { symbol };
      }
    }
    return null;
  } catch (error) {
    console.warn('Failed to read symbol from location', error);
    return null;
  }
}

export function buildSymbolViewUrl(symbol, location, extraSearchParams) {
  const targetLocation =
    location || (typeof window !== 'undefined' && window.location ? window.location : null);
  if (!targetLocation) {
    return null;
  }

  try {
    let href = typeof targetLocation.href === 'string' ? targetLocation.href : null;
    if (!href) {
      const origin =
        typeof targetLocation.origin === 'string'
          ? targetLocation.origin
          : targetLocation.protocol && targetLocation.host
          ? `${targetLocation.protocol}//${targetLocation.host}`
          : '';
      href = `${origin}${targetLocation.pathname || ''}${targetLocation.search || ''}${
        targetLocation.hash || ''
      }`;
    }

    const url = new URL(href);
    const normalizedSymbol = typeof symbol === 'string' ? symbol.trim().toUpperCase() : '';

    // Build canonical path /account/:id[/symbol/:sym]
    const current = parsePathParts(url.pathname);
    const next = { ...current, symbol: normalizedSymbol || null };
    url.pathname = buildPathWithParts(url.pathname, next);

    // Remove legacy query params
    url.searchParams.delete('symbol');
    url.searchParams.delete('symbolDesc');

    if (extraSearchParams && typeof extraSearchParams === 'object') {
      Object.entries(extraSearchParams).forEach(([key, value]) => {
        if (typeof key !== 'string' || !key) {
          return;
        }
        if (value === undefined || value === null || value === '') {
          url.searchParams.delete(key);
          return;
        }
        url.searchParams.set(key, String(value));
      });
    }
    return url.toString();
  } catch (error) {
    console.warn('Failed to build symbol view URL', error);
    return null;
  }
}
