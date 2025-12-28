export function resolveSymbolAnnualizedEntry(symbolKey, accountId, symbolAnnualizedByAccountMap, symbolAnnualizedMap) {
  if (!symbolKey) {
    return null;
  }
  const accountKey =
    accountId !== null && accountId !== undefined && accountId !== '' ? String(accountId) : '';
  if (symbolAnnualizedByAccountMap instanceof Map) {
    if (accountKey && symbolAnnualizedByAccountMap.has(accountKey)) {
      const accountMap = symbolAnnualizedByAccountMap.get(accountKey);
      const match = accountMap?.get(symbolKey) ?? null;
      if (match) {
        return match;
      }
    }
    if (symbolAnnualizedByAccountMap.has('all')) {
      const aggregateMap = symbolAnnualizedByAccountMap.get('all');
      const match = aggregateMap?.get(symbolKey) ?? null;
      if (match) {
        return match;
      }
    }
  }
  if (symbolAnnualizedMap instanceof Map) {
    return symbolAnnualizedMap.get(symbolKey) || null;
  }
  return null;
}
