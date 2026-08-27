import assert from 'node:assert/strict';
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../src/index.js';

const installedRoot = process.env.HERMES_AGENT_ROOT
  || join(process.env.HERMES_HOME || join(process.env.HOME, '.hermes'), 'hermes-agent');
const hasHermes = await exists(join(installedRoot, 'run_agent.py'));
const integration = hasHermes ? test : test.skip;

function fakeAgent(id) {
  return {
    id,
    session: {
      header: { origin: 'user', parentSession: undefined },
      events: [{ type: 'turn/start', data: { turn: 1 } }],
    },
    steer() {},
  };
}

function harness() {
  const tools = new Map();
  const sections = new Map();
  const commands = new Map();
  const effects = [];
  const events = new Map();
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    systemPrompt: {
      section(definition) {
        sections.set(definition.name, definition);
        return () => sections.delete(definition.name);
      },
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition);
        return () => commands.delete(definition.name);
      },
    },
    agents: { get() { return undefined; }, list() { return []; } },
    subagents: { start() { throw new Error('background review disabled in test'); } },
    effect(factory) {
      const dispose = factory();
      effects.push(dispose);
      return dispose;
    },
    on(name, listener) {
      events.set(name, listener);
      return () => events.delete(name);
    },
  };
  return {
    ctx,
    tools,
    sections,
    commands,
    events,
    close() {
      for (const dispose of effects.reverse()) if (typeof dispose === 'function') dispose();
    },
  };
}

integration('plugin mounts shared Hermes state, mirrored tools, delegation, status, and learn command', async () => {
  const hermesHome = await mkdtemp(join(tmpdir(), 'dsh-hermes-plugin-'));
  const dshHome = join(hermesHome, 'dsh');
  const sharedSkill = join(hermesHome, 'skills', 'bridge-fixture');
  await mkdir(sharedSkill, { recursive: true });
  await writeFile(join(sharedSkill, 'SKILL.md'), `---\nname: bridge-fixture\ndescription: Shared skill fixture.\n---\n\n# Bridge Fixture\n`);
  const mounted = harness();
  try {
    await apply(mounted.ctx, {
      enabled: true,
      hermesHome,
      hermesAgentRoot: installedRoot,
      dshHome,
      toolsets: ['skills', 'file'],
      backgroundReview: false,
      curator: false,
      syncSkills: true,
      requireApproval: true,
    });

    for (const name of [
      'hermes_memory',
      'hermes_skills_list',
      'hermes_skill_view',
      'hermes_skill_manage',
      'hermes_status',
      'hermes_delegate',
    ]) assert.ok(mounted.tools.has(name), `missing ${name}`);
    assert.ok([...mounted.tools.keys()].some((name) => name.startsWith('hermes_read_file')));
    assert.ok(mounted.commands.has('hermes-learn'));
    assert.ok(mounted.sections.has('dsh/hermes-bridge:guidance'));
    assert.ok(mounted.sections.has('dsh/hermes-bridge:memory'));
    assert.ok(mounted.sections.has('dsh/hermes-bridge:capabilities'));
    const sharedLink = join(dshHome, 'skills', 'bridge-fixture');
    assert.equal((await lstat(sharedLink)).isSymbolicLink(), true);
    assert.match(await readFile(join(sharedLink, 'SKILL.md'), 'utf8'), /Bridge Fixture/);
    const approvalGate = mounted.events.get('tools/pre-execute');
    assert.deepEqual(await approvalGate({ name: 'hermes_delegate' }, async () => ({ kind: 'allow' })), {
      kind: 'ask',
      reason: 'Hermes delegated and mirrored tools can access external systems and durable state.',
    });
    assert.deepEqual(await approvalGate({ name: 'hermes_status' }, async () => ({ kind: 'allow' })), { kind: 'allow' });

    const agent = fakeAgent('plugin-session');
    const memorySection = mounted.sections.get('dsh/hermes-bridge:memory');
    assert.equal(memorySection.text({ agent }), '');
    const added = await mounted.tools.get('hermes_memory').execute({
      action: 'add',
      target: 'memory',
      content: 'The public bridge shares one Hermes memory store.',
    }, { agent, signal: new AbortController().signal });
    assert.equal(added.success, true);
    assert.equal(memorySection.text({ agent }), '');
    assert.match(
      mounted.sections.get('dsh/hermes-bridge:memory').text({ agent: fakeAgent('next-session') }),
      /shares one Hermes memory store/,
    );
    assert.match(await readFile(join(hermesHome, 'memories', 'MEMORY.md'), 'utf8'), /public bridge/);

    const skillManage = mounted.tools.get('hermes_skill_manage');
    const skillView = mounted.tools.get('hermes_skill_view');
    const reviewAgent = fakeAgent('review-session');
    reviewAgent.session.events.push({ type: 'subagent/descriptor', data: { label: 'hermes-background-review' } });
    const created = await skillManage.execute({
      action: 'create',
      name: 'review-provenance-fixture',
      content: '---\nname: review-provenance-fixture\ndescription: Review provenance fixture.\n---\n\n# Original Review Fixture\n',
    }, { agent: reviewAgent, signal: new AbortController().signal });
    assert.equal(created.success, true);
    const viewed = await skillView.execute({ name: 'review-provenance-fixture' }, {
      agent: reviewAgent,
      signal: new AbortController().signal,
    });
    assert.equal(viewed.success, true);
    assert.equal(viewed._source_path, undefined);
    const patched = await skillManage.execute({
      action: 'patch',
      name: 'review-provenance-fixture',
      old_string: '# Original Review Fixture',
      new_string: '# Reviewed Fixture',
    }, { agent: reviewAgent, signal: new AbortController().signal });
    assert.equal(patched.success, true, JSON.stringify(patched));

    const status = await mounted.tools.get('hermes_status').execute({}, {
      agent,
      signal: new AbortController().signal,
    });
    assert.equal(status.sharedState.memory, 'native');
    assert.equal(status.agentDelegation, 'available');
    assert.ok(status.mirroredToolCount > 0);

    const steered = [];
    const command = await mounted.commands.get('hermes-learn').handler({
      agent: { ...agent, steer: (message) => steered.push(message) },
      rawInput: 'the release verification workflow',
      signal: new AbortController().signal,
    });
    assert.equal(command.kind, 'success');
    assert.match(steered[0].content[0].text, /^\[\/learn\]/);
  } finally {
    mounted.close();
    await rm(hermesHome, { recursive: true, force: true });
  }
});

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
