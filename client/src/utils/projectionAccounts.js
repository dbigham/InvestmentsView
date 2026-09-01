export function isCurrentProjectionAccount(account) {
  return Boolean(
    account &&
      typeof account === 'object' &&
      account.closed !== true &&
      account.archived !== true
  );
}

export function isProjectableEquity(value) {
  return Number.isFinite(Number(value)) && Number(value) !== 0;
}
