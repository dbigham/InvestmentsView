const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const vm = require('vm');

class InvestmentModelError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'InvestmentModelError';
    if (options.code) {
      this.code = options.code;
    }
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

const SCRIPT_NAME = 'strategy_tqqq_reserve.py';
const DEFAULT_REPOSITORY_PATH = path.join(__dirname, '..', '..', 'vendor', 'TQQQ');

function normalizePath(input) {
  if (!input || typeof input !== 'string') {
    return null;
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(trimmed);
}


function stripWrappingQuotes(value) {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}


function commandLooksLikePath(value) {
  if (typeof value !== 'string') {
    return false;
  }
  return path.isAbsolute(value) || value.includes('/') || value.includes('\\');
}

function normalizePythonCommandCandidate(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const stripped = stripWrappingQuotes(value);
  if (!stripped) {
    return null;
  }
  if (commandLooksLikePath(stripped)) {
    return normalizePath(stripped);
  }
  return stripped;
}


function sanitizeBridgeJsonString(raw) {
  if (typeof raw !== 'string' || !raw) {
    return raw;
  }
  // Replace non-standard JSON tokens emitted by Python's json.dumps (NaN/Infinity)
  return raw
    .replace(/-?Infinity/g, 'null')
    .replace(/NaN/g, 'null');
}

function buildPythonCandidates(bridgeRoot) {
  const seen = new Set();
  const results = [];

  function addCandidate(command, argsPrefix = []) {
    if (!command) {
      return;
    }
    const normalizedCommand = normalizePythonCommandCandidate(command);
    if (!normalizedCommand) {
      return;
    }
    const normalizedArgs = Array.isArray(argsPrefix)
      ? argsPrefix
          .filter((part) => typeof part === 'string' && part.trim())
          .map((part) => part.trim())
      : [];
    const key = normalizedCommand + '|' + normalizedArgs.join('\u0000');
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    results.push({
      command: normalizedCommand,
      argsPrefix: normalizedArgs,
    });
  }

  const envCandidates = [process.env.INVESTMENT_MODEL_PYTHON, process.env.PYTHON, process.env.PYTHON3];
  envCandidates.forEach((candidate) => addCandidate(candidate));

  if (bridgeRoot) {
    const venvPaths = [
      path.join(bridgeRoot, '.venv', 'bin', 'python3'),
      path.join(bridgeRoot, '.venv', 'bin', 'python'),
      path.join(bridgeRoot, '.venv', 'Scripts', 'python.exe'),
      path.join(bridgeRoot, 'venv', 'bin', 'python3'),
      path.join(bridgeRoot, 'venv', 'bin', 'python'),
      path.join(bridgeRoot, 'venv', 'Scripts', 'python.exe'),
    ];
    venvPaths.forEach((candidate) => addCandidate(candidate));
  }

  if (process.platform === 'win32') {
    addCandidate('python');
    addCandidate('python3');
    addCandidate('py', ['-3']);
    addCandidate('py');
  } else {
    addCandidate('python3');
    addCandidate('python');
  }

  return results;
}

let cachedPythonInvocation = null;

function resolvePythonInvocation(bridgeRoot) {
  if (cachedPythonInvocation) {
    return cachedPythonInvocation;
  }

  const candidates = buildPythonCandidates(bridgeRoot);
  const errors = [];

  for (const candidate of candidates) {
    const { command, argsPrefix } = candidate;
    if (!command) {
      continue;
    }

    if (commandLooksLikePath(command) && !fs.existsSync(command)) {
      errors.push(command + ': not found');
      continue;
    }

    try {
      const result = spawnSync(command, [...argsPrefix, '--version'], {
        cwd: bridgeRoot || process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 3000,
      });

      if (result.error) {
        errors.push(command + ': ' + result.error.message);
        continue;
      }

      if (typeof result.status === 'number' && result.status !== 0) {
        const output = [result.stderr, result.stdout].filter(Boolean).join(' ').trim();
        if (result.status === 9009 || result.status === 127) {
          errors.push(command + ': command not available' + (output ? ' (' + output + ')' : ''));
          continue;
        }
        errors.push(command + ': exited with status ' + result.status + (output ? ' (' + output + ')' : ''));
        continue;
      }

      cachedPythonInvocation = { command, argsPrefix };
      return cachedPythonInvocation;
    } catch (error) {
      errors.push(command + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  const detail = errors.length ? ' Tried: ' + errors.join('; ') : '';
  throw new InvestmentModelError(
    'Python interpreter not found. Install Python 3 and ensure it is available on PATH, or set INVESTMENT_MODEL_PYTHON to the interpreter location.' +
      detail,
    { code: 'PYTHON_NOT_FOUND' }
  );
}

function resolveBridgeLocation() {
  const candidates = [];
  const configured = normalizePath(process.env.INVESTMENT_MODEL_REPO);
  if (configured) {
    candidates.push(configured);
  }
  candidates.push(DEFAULT_REPOSITORY_PATH);

  for (const root of candidates) {
    const scriptPath = path.join(root, SCRIPT_NAME);
    if (fs.existsSync(scriptPath)) {
      return {
        root,
        scriptPath,
        exists: true,
        candidates,
      };
    }
  }

  const fallbackRoot = candidates[0];
  return {
    root: fallbackRoot,
    scriptPath: path.join(fallbackRoot, SCRIPT_NAME),
    exists: false,
    candidates,
  };
}

function ensureBridgeAvailable() {
  const location = resolveBridgeLocation();
  if (location.exists) {
    return location;
  }
  const instructions =
    'Investment model bridge not found. Clone https://github.com/dbigham/TQQQ ' +
    'into vendor/TQQQ or set INVESTMENT_MODEL_REPO to the checkout path.';
  throw new InvestmentModelError(instructions, { code: 'BRIDGE_NOT_FOUND' });
}

function executeBridgeRequest(payload, options) {
  const contextLabel = options && options.contextLabel ? options.contextLabel : 'Investment model';

  return new Promise((resolve, reject) => {
    let location;
    try {
      location = ensureBridgeAvailable();
    } catch (error) {
      reject(error);
      return;
    }

    let serialized;
    try {
      serialized = JSON.stringify(payload);
    } catch (error) {
      reject(
        new InvestmentModelError('Failed to serialize investment model payload.', {
          code: 'SERIALIZATION_FAILED',
          cause: error instanceof Error ? error : new Error(String(error)),
        })
      );
      return;
    }

    let pythonInvocation;
    try {
      pythonInvocation = resolvePythonInvocation(location.root);
    } catch (error) {
      reject(error);
      return;
    }

    let args;
    try {
      const builtArgs =
        options && typeof options.buildArgs === 'function'
          ? options.buildArgs({ location, pythonInvocation })
          : [];
      if (!Array.isArray(builtArgs)) {
        throw new InvestmentModelError('Bridge configuration must return an argument array.', {
          code: 'INVALID_CONFIGURATION',
        });
      }
      args = [].concat(pythonInvocation.argsPrefix || [], builtArgs);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const child = spawn(pythonInvocation.command, args, {
      cwd: location.root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(
        new InvestmentModelError('Failed to execute investment model bridge.', {
          code: 'EXECUTION_FAILED',
          cause: error instanceof Error ? error : new Error(String(error)),
        })
      );
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const trimmedStdout = stdout.trim();
        const trimmedStderr = stderr.trim();
        const details = trimmedStderr || trimmedStdout;
        const payloadForLog = serialized.length > 5000 ? serialized.slice(0, 5000) + '... (truncated)' : serialized;
        const fredKey = process.env.FRED_API_KEY || '';
        const fredSummary = fredKey ? 'present (ends ' + fredKey.slice(-4) + ')' : 'missing';
        console.error(contextLabel + ' request payload:', payloadForLog);
        console.error('FRED_API_KEY:', fredSummary);
        reject(
          new InvestmentModelError(
            contextLabel + ' bridge exited with status ' + code + (details ? ': ' + details : ''),
            { code: 'NON_ZERO_EXIT' }
          )
        );
        return;
      }

      const output = stdout.trim();
      if (!output) {
        reject(
          new InvestmentModelError(contextLabel + ' bridge produced no output.', {
            code: 'EMPTY_RESPONSE',
          })
        );
        return;
      }

      const sanitized = sanitizeBridgeJsonString(output);
      let primaryParseError = null;
      try {
        const parsed = JSON.parse(sanitized);
        resolve(parsed);
        return;
      } catch (error) {
        primaryParseError = error instanceof Error ? error : new Error(String(error));
        try {
          const fallback = vm.runInNewContext('(' + sanitized + ')', {}, { timeout: 500 });
          resolve(fallback);
          return;
        } catch (fallbackError) {
          const secondaryError = fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
          const responseForLog = output.length > 5000 ? output.slice(0, 5000) + '... (truncated)' : output;
          const sanitizedForLog = sanitized.length > 5000 ? sanitized.slice(0, 5000) + '... (truncated)' : sanitized;
          console.error(contextLabel + ' sanitized response:', sanitizedForLog);
          console.error(contextLabel + ' raw response:', responseForLog);
          reject(
            new InvestmentModelError('Failed to parse ' + contextLabel.toLowerCase() + ' response. Raw output: ' + responseForLog, {
              code: 'PARSE_ERROR',
              cause: secondaryError,
              rawOutput: output,
              sanitizedOutput: sanitized,
              primaryParseError,
            })
          );
        }
      }
    });

    child.stdin.end(serialized);
  });
}

function evaluateInvestmentModel(payload) {
  return executeBridgeRequest(payload, {
    contextLabel: 'Investment model',
    buildArgs: () => [SCRIPT_NAME, '--integration-request', '-'],
  });
}

const TEMPERATURE_CHART_SCRIPT = [
  'import json',
  'import sys',
  'from strategy_tqqq_reserve import evaluate_temperature_chart_request',
  'payload = json.load(sys.stdin)',
  'response = evaluate_temperature_chart_request(payload)',
  'json.dump(response, sys.stdout)',
  'sys.stdout.write("\\n")',
].join('; ');

function evaluateInvestmentModelTemperatureChart(payload) {
  return executeBridgeRequest(payload, {
    contextLabel: 'Investment model temperature',
    buildArgs: () => ['-c', TEMPERATURE_CHART_SCRIPT],
  });
}

module.exports = {
  evaluateInvestmentModel,
  evaluateInvestmentModelTemperatureChart,
  InvestmentModelError,
  resolveBridgeLocation,
  resolvePythonInvocation,
  DEFAULT_REPOSITORY_PATH,
  SCRIPT_NAME,
};



