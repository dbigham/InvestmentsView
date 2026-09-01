export function resolveAccountMetadataKey(account) {
  if (!account || typeof account !== 'object') {
    return null;
  }

  const id = account.id !== undefined && account.id !== null ? String(account.id).trim() : '';
  if (id) {
    return id;
  }

  const number =
    account.number !== undefined && account.number !== null ? String(account.number).trim() : '';
  if (number) {
    return number;
  }

  return null;
}
