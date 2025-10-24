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

export function buildAccountViewUrl(accountId, location) {
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
    return url.toString();
  } catch (error) {
    console.warn('Failed to build account view URL', error);
    return null;
  }
}
