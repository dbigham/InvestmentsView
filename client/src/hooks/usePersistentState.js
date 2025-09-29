import { useCallback, useEffect, useState } from 'react';

function readStoredValue(key, defaultValue) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return defaultValue;
  }

  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) {
      return defaultValue;
    }
    const parsed = JSON.parse(stored);
    if (parsed === undefined || parsed === null) {
      return defaultValue;
    }
    return parsed;
  } catch (error) {
    console.error('Unable to read persistent state', error);
    return defaultValue;
  }
}

function writeStoredValue(key, value) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error('Unable to persist state', error);
  }
}

export default function usePersistentState(key, defaultValue) {
  const [value, setValue] = useState(() => readStoredValue(key, defaultValue));

  useEffect(() => {
    writeStoredValue(key, value);
  }, [key, value]);

  const setPersistedValue = useCallback((updater) => {
    setValue((prev) => {
      const nextValue = typeof updater === 'function' ? updater(prev) : updater;
      return Object.is(nextValue, prev) ? prev : nextValue;
    });
  }, []);

  return [value, setPersistedValue];
}
