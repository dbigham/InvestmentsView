const FALSE_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled']);
const TRUE_VALUES = new Set(['1', 'true', 'on', 'yes', 'enabled']);
const STORAGE_KEY = 'performanceDebug';
const GLOBAL_KEY = '__INVESTMENTS_PERFORMANCE_DEBUG__';

let debugEnabled;
let nextTraceId = 0;

function parseBooleanFlag(value, fallback) {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  return fallback;
}

function readQueryFlag() {
  if (typeof window === 'undefined' || !window.location || !window.location.search) {
    return null;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('performanceDebug')) {
      return null;
    }
    return parseBooleanFlag(params.get('performanceDebug'), null);
  } catch (error) {
    console.warn('[Performance debug] Failed to read query flag', error);
    return null;
  }
}

function readStorageFlag() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return null;
    }
    return parseBooleanFlag(raw, null);
  } catch (error) {
    console.warn('[Performance debug] Failed to read storage flag', error);
    return null;
  }
}

function writeStorageFlag(value) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch (error) {
    console.warn('[Performance debug] Failed to persist storage flag', error);
  }
}

function ensureInitialized() {
  if (debugEnabled !== undefined) {
    return;
  }
  let enabled = true;
  if (typeof import.meta !== 'undefined' && import.meta.env) {
    const envValue = import.meta.env.VITE_PERFORMANCE_DEBUG;
    const parsed = parseBooleanFlag(envValue, null);
    if (parsed !== null) {
      enabled = parsed;
    }
  }
  const queryFlag = readQueryFlag();
  if (queryFlag !== null) {
    enabled = queryFlag;
  } else {
    const storedFlag = readStorageFlag();
    if (storedFlag !== null) {
      enabled = storedFlag;
    }
  }
  debugEnabled = enabled;
  exposeGlobalInterface();
}

function exposeGlobalInterface() {
  if (typeof window === 'undefined') {
    return;
  }
  const globalObject = window[GLOBAL_KEY] || {};
  Object.defineProperty(globalObject, 'enabled', {
    configurable: true,
    enumerable: true,
    get() {
      return debugEnabled;
    },
    set(value) {
      setPerformanceDebugEnabled(value);
    },
  });
  globalObject.setEnabled = setPerformanceDebugEnabled;
  globalObject.beginTrace = beginPerformanceTrace;
  globalObject.log = logPerformanceDebug;
  window[GLOBAL_KEY] = globalObject;
}

export function isPerformanceDebugEnabled() {
  ensureInitialized();
  return Boolean(debugEnabled);
}

export function setPerformanceDebugEnabled(value) {
  ensureInitialized();
  const parsed = parseBooleanFlag(value, debugEnabled);
  debugEnabled = parsed;
  writeStorageFlag(debugEnabled);
  exposeGlobalInterface();
}

export function logPerformanceDebug(message, ...details) {
  if (!isPerformanceDebugEnabled()) {
    return;
  }
  const prefix = '[Performance debug]';
  if (details.length) {
    console.debug(prefix, message, ...details);
  } else {
    console.debug(prefix, message);
  }
}

export function beginPerformanceTrace(label, context) {
  ensureInitialized();
  const traceId = ++nextTraceId;
  if (!debugEnabled) {
    return { id: traceId, log: () => {}, info: () => {}, warn: () => {}, error: () => {}, end: () => {} };
  }
  const prefix = `[Performance trace #${traceId}]`;
  const groupLabel = label ? `${prefix} ${label}` : prefix;
  if (typeof console.groupCollapsed === 'function') {
    console.groupCollapsed(groupLabel);
  } else if (typeof console.group === 'function') {
    console.group(groupLabel);
  } else {
    console.log(groupLabel);
  }
  if (context !== undefined) {
    console.log(`${prefix} context:`, context);
  }
  let step = 0;
  const makeLogger = (method) => (message, ...args) => {
    const formatted = `${prefix} [${++step}] ${message}`;
    const logger = typeof console[method] === 'function' ? console[method] : console.log;
    logger(formatted, ...args);
  };
  const trace = {
    id: traceId,
    log: makeLogger('log'),
    info: makeLogger('info'),
    warn: makeLogger('warn'),
    error: makeLogger('error'),
    end(message, ...args) {
      if (message) {
        trace.log(message, ...args);
      }
      if (typeof console.groupEnd === 'function') {
        console.groupEnd();
      }
    },
  };
  return trace;
}

ensureInitialized();
