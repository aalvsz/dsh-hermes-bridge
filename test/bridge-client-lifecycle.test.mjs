import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BridgeClient } from '../src/bridge-client.js';
import { resolveOptions } from '../src/index.js';

const python = process.platform === 'win32' ? 'python' : 'python3';

async function fixture(source) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hermes-client-'));
  const script = join(root, 'bridge.py');
  await writeFile(script, source);
  return { root, script };
}

function options(root, overrides = {}) {
  return resolveOptions({
    pythonPath: python,
    hermesAgentRoot: root,
    hermesHome: join(root, 'home'),
    operationTimeoutMs: 2_000,
    maxResponseBytes: 1024 * 1024,
    ...overrides,
  });
}

test('cancelling one request cannot reject an unrelated concurrent request', async () => {
  const fx = await fixture(`
import argparse, json, sys, time
p=argparse.ArgumentParser(); p.add_argument('--agent-root'); p.add_argument('--hermes-home'); p.add_argument('--once', action='store_true'); p.parse_args()
r=json.loads(sys.stdin.read()); time.sleep(r.get('delay', 0)); print(json.dumps({'id': r['id'], 'ok': True, 'result': r['value']}))
`);
  const client = new BridgeClient(options(fx.root), { bridgePath: fx.script });
  const abort = new AbortController();
  try {
    const slow = client.request({ value: 'slow', delay: 1 }, abort.signal);
    const fast = client.request({ value: 'fast', delay: 0.15 });
    setTimeout(() => abort.abort(new Error('cancel only slow')), 30);
    await assert.rejects(slow, /cancel only slow/);
    assert.equal(await fast, 'fast');
  } finally {
    client.close();
    await rm(fx.root, { recursive: true, force: true });
  }
});

test('timeout escalates to SIGKILL when a child ignores SIGTERM', { skip: process.platform === 'win32' }, async () => {
  const fx = await fixture(`
import argparse, json, os, signal, sys, time
p=argparse.ArgumentParser(); p.add_argument('--agent-root'); p.add_argument('--hermes-home'); p.add_argument('--once', action='store_true'); a=p.parse_args()
signal.signal(signal.SIGTERM, signal.SIG_IGN)
open(a.hermes_home + '.pid', 'w').write(str(os.getpid()))
r=json.loads(sys.stdin.read()); time.sleep(30); print(json.dumps({'id': r['id'], 'ok': True, 'result': None}))
`);
  const client = new BridgeClient(options(fx.root, { operationTimeoutMs: 80 }), { bridgePath: fx.script, killGraceMs: 80 });
  try {
    await assert.rejects(client.request({ value: 'never' }), /timed out/);
    const pid = Number(await readFile(join(fx.root, 'home.pid'), 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    client.close();
    await rm(fx.root, { recursive: true, force: true });
  }
});

test('protocol validates response identity and forwards only allowlisted environment', async () => {
  const fx = await fixture(`
import argparse, json, os, sys
p=argparse.ArgumentParser(); p.add_argument('--agent-root'); p.add_argument('--hermes-home'); p.add_argument('--once', action='store_true'); p.parse_args()
r=json.loads(sys.stdin.read())
if r.get('badId'): print(json.dumps({'id': 999, 'ok': True, 'result': None}))
elif r.get('error'): print(json.dumps({'id': r['id'], 'ok': False, 'error': 'OPENROUTER_API_KEY=sk-super-secret-value api_key=lower-case-secret https://user:pass@example.test'}))
else: print(json.dumps({'id': r['id'], 'ok': True, 'result': {'ambient': 'BRIDGE_AMBIENT_SECRET' in os.environ, 'allowed': os.environ.get('BRIDGE_ALLOWED_SECRET')}}))
`);
  process.env.BRIDGE_AMBIENT_SECRET = 'must-not-cross';
  process.env.BRIDGE_ALLOWED_SECRET = 'explicitly-crosses';
  const client = new BridgeClient(options(fx.root, { envAllowlist: ['BRIDGE_ALLOWED_SECRET'] }), { bridgePath: fx.script });
  try {
    assert.deepEqual(await client.request({}), { ambient: false, allowed: 'explicitly-crosses' });
    await assert.rejects(client.request({ badId: true }), /response id/);
    await assert.rejects(client.request({ error: true }), (error) => {
      assert.doesNotMatch(error.message, /super-secret|lower-case-secret|user:pass/);
      assert.match(error.message, /redacted/);
      return true;
    });
  } finally {
    delete process.env.BRIDGE_AMBIENT_SECRET;
    delete process.env.BRIDGE_ALLOWED_SECRET;
    client.close();
    await rm(fx.root, { recursive: true, force: true });
  }
});
