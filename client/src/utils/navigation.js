export function readAccountIdFromLocation(location) {
  const targetLocation =
    location || (typeof window !== 'undefined' && window.location ? window.location : null);
  if (!targetLocation || typeof targetLocation.search !== 'string') {
    return null;
  }

  try {
    const params = new URLSearchParams(targetLocation.search);
    const rawValue = params.get('accountId');
    if (typeof rawValue !== 'string') {
      return null;
    }
    const trimmed = rawValue.trim();
    return trimmed ? trimmed : null;
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
    if (!accountId || accountId === 'default') {
      url.searchParams.delete('accountId');
    } else {
      url.searchParams.set('accountId', String(accountId));
    }

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
