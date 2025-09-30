const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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

function resolvePythonExecutable() {
  const candidates = [
    process.env.INVESTMENT_MODEL_PYTHON,
    process.env.PYTHON,
    process.env.PYTHON3,
    'python3',
    'python',
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return 'python3';
}

function evaluateInvestmentModel(payload) {
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

    const pythonExecutable = resolvePythonExecutable();
    const args = [SCRIPT_NAME, '--integration-request', '-'];
    const child = spawn(pythonExecutable, args, {
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
        reject(
          new InvestmentModelError(
            'Investment model bridge exited with status ' + code + (details ? ': ' + details : ''),
            { code: 'NON_ZERO_EXIT' }
          )
        );
        return;
      }

      const output = stdout.trim();
      if (!output) {
        reject(
          new InvestmentModelError('Investment model bridge produced no output.', {
            code: 'EMPTY_RESPONSE',
          })
        );
        return;
      }

      try {
        const parsed = JSON.parse(output);
        resolve(parsed);
      } catch (error) {
        reject(
          new InvestmentModelError('Failed to parse investment model response.', {
            code: 'PARSE_ERROR',
            cause: error instanceof Error ? error : new Error(String(error)),
          })
        );
      }
    });

    child.stdin.end(serialized);
  });
}

module.exports = {
  evaluateInvestmentModel,
  InvestmentModelError,
  resolveBridgeLocation,
  DEFAULT_REPOSITORY_PATH,
  SCRIPT_NAME,
};
