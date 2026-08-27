import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BridgeClient,
  discoverPython,
  runBridgeOnce,
} from '../src/bridge-client.js';
import { resolveOptions } from '../src/index.js';

const installedRoot = process.env.HERMES_AGENT_ROOT
  || join(process.env.HERMES_HOME || join(process.env.HOME, '.hermes'), 'hermes-agent');
const hasHermes = await exists(join(installedRoot, 'run_agent.py'));

const integration = hasHermes ? test : test.skip;

integration('bootstrap discovers shared state, dynamic tools, toolsets, and delegation', async () => {
  const hermesHome = await mkdtemp(join(tmpdir(), 'dsh-hermes-bridge-'));
  try {
    const options = resolveOptions({
      hermesHome,
      hermesAgentRoot: installedRoot,
      toolsets: ['memory', 'skills', 'web', 'cronjob'],
    });
    options.pythonPath = await discoverPython(options);
    const result = runBridgeOnce(options, {
      op: 'bootstrap',
      toolsets: options.toolsets,
      disabledToolsets: [],
    });

    assert.equal(result.health.implementation, 'installed-hermes-python-runtime');
    assert.match(result.health.version, /^\d+\.\d+\.\d+/);
    assert.match(result.health.commit, /^[0-9a-f]{7,40}$|^unknown$/);
    assert.equal(result.health.agentRoot, undefined);
    assert.equal(result.health.hermesHome, undefined);
    assert.ok(result.schemas.memory);
    assert.ok(result.schemas.skill_manage);
    assert.ok(result.tools.some((item) => item.function.name === 'skills_list'));
    assert.equal(result.native.memory, true);
    assert.equal(result.native.skills, true);
    assert.equal(result.delegate.available, true);
    assert.ok(result.toolsets.skills);
  } finally {
    await rm(hermesHome, { recursive: true, force: true });
  }
});

integration('isolated protocol calls real Hermes skill tools and closes cleanly', async () => {
  const hermesHome = await mkdtemp(join(tmpdir(), 'dsh-hermes-bridge-'));
  const options = resolveOptions({
    hermesHome,
    hermesAgentRoot: installedRoot,
    toolsets: ['skills'],
    operationTimeoutMs: 30_000,
  });
  options.pythonPath = await discoverPython(options);
  const bridge = new BridgeClient(options);
  try {
    const listed = await bridge.request({
      op: 'skills_list',
      sessionId: 'contract-session',
      arguments: {},
    });
    assert.equal(listed.success, true);

    const catalogCall = await bridge.request({
      op: 'tool_call',
      sessionId: 'contract-session',
      toolsets: ['skills'],
      name: 'skills_list',
      arguments: {},
    });
    assert.match(JSON.stringify(catalogCall), /success/);
  } finally {
    bridge.close();
    await rm(hermesHome, { recursive: true, force: true });
  }
});

integration('delegation cwd and mirrored JSON Schema validation fail closed', async () => {
  const hermesHome = await mkdtemp(join(tmpdir(), 'dsh-hermes-bridge-'));
  const options = resolveOptions({
    hermesHome,
    hermesAgentRoot: installedRoot,
    toolsets: ['file'],
    operationTimeoutMs: 30_000,
  });
  options.pythonPath = await discoverPython(options);
  const bridge = new BridgeClient(options);
  try {
    await assert.rejects(bridge.request({
      op: 'delegate',
      prompt: 'This must not start.',
      cwd: '/',
      allowedCwds: [hermesHome],
      sessionId: 'cwd-denied',
    }), /outside the configured delegateRoots/);
    await assert.rejects(bridge.request({
      op: 'tool_call',
      name: 'read_file',
      arguments: {},
      toolsets: ['file'],
      disabledToolsets: [],
      sessionId: 'schema-denied',
    }), /invalid arguments.*read_file/i);
  } finally {
    bridge.close();
    await rm(hermesHome, { recursive: true, force: true });
  }
});

test('python discovery fails with an actionable error instead of guessing silently', async () => {
  const options = resolveOptions({
    hermesAgentRoot: '/definitely/missing/hermes-agent',
    pythonPath: '/definitely/missing/python',
  });
  await assert.rejects(discoverPython(options), /Hermes Python runtime was not found/);
});

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
