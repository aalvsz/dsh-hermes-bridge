import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultBridgePath = join(packageRoot, 'bridge', 'hermes_bridge.py');
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_KILL_GRACE_MS = 2_000;
const BASE_ENVIRONMENT = [
  'COMSPEC', 'HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'PATH', 'PATHEXT', 'SHELL',
  'SYSTEMROOT', 'TEMP', 'TERM', 'TMP', 'TMPDIR', 'TZ', 'USER', 'WINDIR',
];

export async function discoverPython(options) {
  const candidates = (options.pythonPath ? [options.pythonPath] : options.pythonCandidates || []).filter(Boolean);
  const failures = [];
  for (const candidate of [...new Set(candidates)]) {
    if (isAbsolute(candidate)) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch (error) {
        failures.push(`${candidate}: ${error.code || error.message}`);
        continue;
      }
    }
    const probeArgs = candidate === 'py' ? ['-3', '--version'] : ['--version'];
    const result = spawnSync(candidate, probeArgs, {
      encoding: 'utf8',
      timeout: 5_000,
      env: bridgeEnvironment(options),
    });
    if (!result.error && result.status === 0) return candidate;
    failures.push(`${candidate}: ${result.error?.code || result.status || 'unavailable'}`);
  }
  throw new Error(
    `Hermes Python runtime was not found. Install Hermes Agent or set HERMES_PYTHON. Tried: ${failures.join('; ')}`,
  );
}

/**
 * Request-isolated subprocess client. Each call owns its child, timeout, parser,
 * cancellation, and kill escalation; one failed Hermes tool can never reject a
 * sibling request or contaminate a later protocol frame.
 */
export class BridgeClient {
  constructor(options, dependencies = {}) {
    if (!options.pythonPath) throw new Error('BridgeClient requires a resolved pythonPath');
    this.options = options;
    this.bridgePath = dependencies.bridgePath || defaultBridgePath;
    this.killGraceMs = dependencies.killGraceMs || DEFAULT_KILL_GRACE_MS;
    this.operations = new Set();
    this.closed = false;
  }

  request(payload, signal) {
    if (this.closed) return Promise.reject(new Error('Hermes bridge is closed'));
    signal?.throwIfAborted();
    return runIsolatedRequest(this, payload, signal);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const operation of [...this.operations]) {
      operation.cancel(new Error('Hermes bridge closed'));
    }
  }
}

export function runBridgeOnce(options, payload, dependencies = {}) {
  if (!options.pythonPath) throw new Error('runBridgeOnce requires a resolved pythonPath');
  const request = { ...payload, id: 1 };
  const input = `${serializeRequest(request, options.maxResponseBytes)}\n`;
  const bridgePath = dependencies.bridgePath || defaultBridgePath;
  const commandArgs = bridgeArguments(options, bridgePath, ['--once']);
  const command = options.pythonPath;
  const args = command === 'py' ? ['-3', ...commandArgs] : commandArgs;
  const result = spawnSync(command, args, {
    cwd: bridgeWorkingDirectory(options),
    env: bridgeEnvironment(options),
    input,
    encoding: 'utf8',
    timeout: options.operationTimeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: options.maxResponseBytes,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Hermes bridge failed with status ${result.status}${diagnosticSuffix(result.stderr)}`);
  }
  return unwrapResponse(result.stdout, 1);
}

function runIsolatedRequest(client, payload, signal) {
  const options = client.options;
  const request = { ...payload, id: 1 };
  const input = `${serializeRequest(request, options.maxResponseBytes)}\n`;
  const commandArgs = bridgeArguments(options, client.bridgePath, ['--once']);
  const command = options.pythonPath;
  const args = command === 'py' ? ['-3', ...commandArgs] : commandArgs;

  return new Promise((resolveRequest, rejectRequest) => {
    const child = spawn(command, args, {
      cwd: bridgeWorkingDirectory(options),
      env: bridgeEnvironment(options),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let exited = false;
    let timeout;
    let killTimer;

    const cleanupRequest = () => {
      signal?.removeEventListener('abort', onAbort);
      if (timeout) clearTimeout(timeout);
    };
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      cleanupRequest();
      rejectRequest(error);
    };
    const terminate = () => {
      if (exited) return;
      child.kill('SIGTERM');
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        if (!exited) child.kill('SIGKILL');
      }, client.killGraceMs);
      killTimer.unref?.();
    };
    const cancel = (error) => {
      settleReject(error);
      terminate();
    };
    const operation = { child, cancel };
    client.operations.add(operation);
    const onAbort = () => {
      const reason = signal?.reason instanceof Error ? signal.reason : new Error('Hermes bridge request was aborted');
      cancel(reason);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (options.operationTimeoutMs) {
      timeout = setTimeout(() => {
        cancel(new Error(`Hermes bridge request timed out after ${options.operationTimeoutMs}ms`));
      }, options.operationTimeoutMs);
      timeout.unref?.();
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > options.maxResponseBytes) {
        cancel(new Error('Hermes bridge response exceeded maxResponseBytes'));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-DEFAULT_MAX_STDERR_BYTES);
    });
    child.on('error', (error) => {
      settleReject(error);
      terminate();
    });
    child.on('exit', () => {
      exited = true;
      if (killTimer) clearTimeout(killTimer);
    });
    child.on('close', (code, exitSignal) => {
      exited = true;
      if (killTimer) clearTimeout(killTimer);
      client.operations.delete(operation);
      if (settled) return;
      cleanupRequest();
      if (code !== 0) {
        settled = true;
        rejectRequest(new Error(`Hermes bridge exited (${exitSignal || code})${diagnosticSuffix(stderr)}`));
        return;
      }
      try {
        const value = unwrapResponse(stdout, 1);
        settled = true;
        resolveRequest(value);
      } catch (error) {
        settled = true;
        rejectRequest(error);
      }
    });
    child.stdin.end(input, (error) => {
      if (error) cancel(error);
    });
  });
}

function bridgeArguments(options, bridgePath, extraArgs) {
  return [
    bridgePath,
    '--agent-root', options.hermesAgentRoot,
    '--hermes-home', options.hermesHome,
    ...extraArgs,
  ];
}

function bridgeWorkingDirectory(options) {
  return options.delegateRoots?.[0] || process.cwd();
}

function bridgeEnvironment(options) {
  const env = {};
  for (const name of [...BASE_ENVIRONMENT, ...(options.envAllowlist || [])]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.HERMES_HOME = options.hermesHome;
  env.PYTHONUNBUFFERED = '1';
  env.DSH_HERMES_BRIDGE = '1';
  return env;
}

function serializeRequest(payload, maxBytes) {
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > maxBytes) {
    throw new Error(`Hermes bridge request exceeded maxResponseBytes (${maxBytes})`);
  }
  return serialized;
}

function unwrapResponse(stdout, expectedId) {
  const lines = String(stdout || '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length !== 1) throw new Error(`Hermes bridge emitted ${lines.length} protocol responses; expected exactly one`);
  let response;
  try {
    response = JSON.parse(lines[0]);
  } catch {
    throw new Error('Hermes bridge emitted invalid JSON');
  }
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('Hermes bridge emitted an invalid response envelope');
  }
  if (response.id !== expectedId) throw new Error(`Hermes bridge response id ${response.id} did not match ${expectedId}`);
  if (typeof response.ok !== 'boolean') throw new Error('Hermes bridge response omitted boolean ok');
  if (!response.ok) throw new Error(sanitizeDiagnosticText(response.error || 'Hermes bridge operation failed'));
  if (!Object.hasOwn(response, 'result')) throw new Error('Hermes bridge response omitted result');
  return response.result;
}

function sanitizeDiagnosticText(value) {
  return String(value || '')
    .replace(/\b(?:xox[baprs]-|gh[pousr]_|sk-|AKIA)[A-Za-z0-9_\-]{8,}\b/g, '[redacted]')
    .replace(/([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[redacted]@')
    .trim()
    .slice(-2_000);
}

function diagnosticSuffix(value) {
  const sanitized = sanitizeDiagnosticText(value);
  return sanitized ? `: ${sanitized}` : '';
}
