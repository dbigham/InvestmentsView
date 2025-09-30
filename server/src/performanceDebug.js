const FALSE_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled']);
const TRUE_VALUES = new Set(['1', 'true', 'on', 'yes', 'enabled']);

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

const PERFORMANCE_DEBUG_ENABLED = parseBooleanFlag(process.env.PERFORMANCE_DEBUG, true);

let nextTraceId = 0;

function isPerformanceDebugEnabled() {
  return PERFORMANCE_DEBUG_ENABLED;
}

function beginPerformanceTrace(label, context) {
  const traceId = ++nextTraceId;
  if (!PERFORMANCE_DEBUG_ENABLED) {
    return { id: traceId, log: () => {}, info: () => {}, warn: () => {}, error: () => {}, end: () => {} };
  }
  const prefix = `[Account performance #${traceId}]`;
  const heading = label ? `${prefix} ${label}` : prefix;
  console.log(heading);
  if (context !== undefined) {
    console.log(`${prefix} context:`, context);
  }
  let step = 0;
  const makeLogger = (method) => (message, ...args) => {
    const formatted = `${prefix} [${++step}] ${message}`;
    const logger = typeof console[method] === 'function' ? console[method] : console.log;
    logger(formatted, ...args);
  };
  const trace = { id: traceId };
  trace.log = makeLogger('log');
  trace.info = makeLogger('info');
  trace.warn = makeLogger('warn');
  trace.error = makeLogger('error');
  trace.end = (message, ...args) => {
    if (message) {
      trace.log(message, ...args);
    }
  };
  return trace;
}

module.exports = {
  isPerformanceDebugEnabled,
  beginPerformanceTrace,
};
