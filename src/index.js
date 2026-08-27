import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { MemoryStore } from './memory.js';
import { SkillCatalog } from './skills.js';
export { buildLearnPrompt } from './learn.js';
export { resolveOptions } from './options.js';
export { MemoryStore } from './memory.js';
export { SkillCatalog } from './skills.js';

export const name = 'dsh/hermes-bridge';
export const inject = ['tools', 'systemPrompt', 'commands', 'subagents', 'agents'];

export async function apply(ctx, config = {}) {
  const options = resolveOptions(config);
  if (!options.enabled) {
    ctx.logger.info('dsh-hermes-bridge is installed but disabled.');
    return;
  }
  const store = new MemoryStore({
    root: options.memoryRoot,
    memoryCharLimit: options.memoryCharLimit,
    userCharLimit: options.userCharLimit,
  });
  const catalog = new SkillCatalog({ root: options.skillsRoot });

  const snapshots = new Map();

  ctx.systemPrompt.section({
    name: 'dsh/hermes-bridge:memory',
    order: 145,
    text: ({ agent }) => snapshots.get(String(agent?.id || 'default')) || '',
  });

  ctx.systemPrompt.section({
    name: 'dsh/hermes-bridge:skills',
    order: 140,
    text: async () => buildSkillsGuidance(catalog),
  });

  ctx.systemPrompt.section({
    name: 'dsh/hermes-bridge:capabilities',
    order: 146,
    text: () => 'Hermes adaptive intelligence: memory, skills, and /hermes-learn are natively available.',
  });

  ctx.tools.register(createMemoryTool(store, options, ctx.logger, snapshots));
  ctx.tools.register(createSkillListTool(catalog, options));
  ctx.tools.register(createSkillViewTool(catalog, options));
  ctx.tools.register(createSkillManageTool(catalog, options, ctx.logger));
  ctx.tools.register(createStatusTool(options));

  installLearnCommand(ctx, options);

  ctx.on('agent/session-start', ({ agent }) => {
    const sessionId = String(agent?.id || 'default');
    snapshots.set(sessionId, `${store.formatForPrompt('memory')}\n${store.formatForPrompt('user')}`);
  });
  ctx.on('agent/disposed', ({ agent }) => {
    snapshots.delete(String(agent?.id || 'default'));
  });

  if (options.backgroundReview || options.curator) {
    installBackgroundReview(ctx, options, store, catalog);
  }

  ctx.logger.info('dsh-hermes-bridge native adaptive intelligence mounted.');
}

function buildSkillsGuidance(catalog) {
  const skills = catalog._cache || [];
  if (skills.length === 0) return 'No skills installed yet. Use /hermes-learn to create one.';
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return `Available skills:\n${lines.join('\n')}`;
}

function createMemoryTool(store, options, logger, snapshots) {
  return {
    name: `${options.namespace}_memory`,
    description: 'Read or modify persistent agent memory (MEMORY.md/USER.md).',
    parameters: {
      action: { type: 'string', enum: ['add', 'replace', 'remove', 'write', 'batch'], required: true },
      target: { type: 'string', enum: ['memory', 'user'], default: 'memory' },
      content: { type: 'string' },
      old_text: { type: 'string' },
      new_text: { type: 'string' },
      operations: { type: 'array' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const { action, target = 'memory', content, old_text, new_text, operations } = args;
      if (action === 'write') await store.write(target, content);
      else if (action === 'add') await store.add(target, content);
      else if (action === 'replace') await store.replace(target, old_text, new_text);
      else if (action === 'remove') await store.remove(target, old_text);
      else if (action === 'batch') await store.batch(target, operations);
      else throw new Error(`Unknown action: ${action}`);
      store.invalidate();
      snapshots.clear();
      return { success: true };
    },
  };
}

function createSkillListTool(catalog, options) {
  return {
    name: `${options.namespace}_skills_list`,
    description: 'List all installed skills.',
    parameters: { category: { type: 'string' } },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      await catalog.refresh();
      return { success: true, skills: catalog.list(args.category) };
    },
  };
}

function createSkillViewTool(catalog, options) {
  return {
    name: `${options.namespace}_skill_view`,
    description: 'View a skill\'s SKILL.md content.',
    parameters: { name: { type: 'string', required: true } },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      return catalog.view(args.name);
    },
  };
}

function createSkillManageTool(catalog, options, logger) {
  return {
    name: `${options.namespace}_skill_manage`,
    description: 'Create, patch, or delete a skill.',
    parameters: {
      action: { type: 'string', enum: ['create', 'patch', 'delete'], required: true },
      name: { type: 'string', required: true },
      content: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
      category: { type: 'string' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      if (args.action === 'create') return catalog.create({ name: args.name, content: args.content, category: args.category });
      if (args.action === 'patch') return catalog.patch(args.name, args.old_string, args.new_string, args.replace_all);
      if (args.action === 'delete') return catalog.delete(args.name);
      throw new Error(`Unknown action: ${args.action}`);
    },
  };
}

function createStatusTool(options) {
  return {
    name: `${options.namespace}_status`,
    description: 'Inspect the Hermes adaptive intelligence surface.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      return {
        implementation: 'native-dsh-plugin',
        sharedState: { memory: 'native', skills: 'native', backgroundReview: options.backgroundReview ? 'native' : 'disabled' },
        agentDelegation: 'native-dsh',
        hermesDependency: 'none',
      };
    },
  };
}

function installLearnCommand(ctx, options) {
  ctx.commands.register({
    name: 'hermes-learn',
    description: 'Learn or improve a reusable skill.',
    input: { hint: '[what to learn]' },
    async handler(invocation) {
      const prompt = buildLearnPrompt(invocation.rawInput.trim());
      invocation.agent.steer({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      });
      return { kind: 'success', text: 'Learning a new skill.' };
    },
  });
}

function installBackgroundReview(ctx, options, store, catalog) {
  const states = new Map();
  let curatorRunning = false;

  const initialize = (agent) => {
    if (agent?.session?.header?.origin === 'subagent') return;
    states.set(String(agent.id), {
      turnsSinceMemory: 0,
      itersSinceSkill: 0,
      pendingMemoryTurns: new Set(),
    });
  };

  for (const agent of ctx.agents.list()) initialize(agent);
  ctx.on('agent/created', ({ agent }) => initialize(agent));
  ctx.on('agent/disposed', ({ agent }) => states.delete(String(agent.id)));

  ctx.on('session/event', (session, event) => {
    const agent = ctx.agents.get(session.id);
    if (!agent || agent.session.header.origin === 'subagent') return;
    const state = states.get(String(agent.id));
    if (!state) return;

    if (event.type === 'turn/start') {
      if (options.memoryNudgeInterval > 0 && ++state.turnsSinceMemory >= options.memoryNudgeInterval) {
        state.turnsSinceMemory = 0;
        state.pendingMemoryTurns.add(event.data.turn);
      }
      return;
    }
    if (event.type === 'step/start') {
      if (options.skillNudgeInterval > 0) state.itersSinceSkill += 1;
      return;
    }
    if (event.type === 'tool/call') {
      if (event.data.name === `${options.namespace}_memory`) state.turnsSinceMemory = 0;
      if (event.data.name === `${options.namespace}_skill_manage`) state.itersSinceSkill = 0;
      return;
    }
    if (event.type !== 'turn/end') return;

    const reviewMemory = state.pendingMemoryTurns.delete(event.data.turn);
    const reviewSkills = options.skillNudgeInterval > 0 && state.itersSinceSkill >= options.skillNudgeInterval;
    if (reviewSkills) state.itersSinceSkill = 0;
    if (reviewMemory || reviewSkills) {
      queueMicrotask(() => void runReview(ctx, state, agent, reviewMemory, reviewSkills, options));
    }
    if (options.curator && !curatorRunning) {
      curatorRunning = true;
      queueMicrotask(async () => {
        try {
          ctx.logger.info('Hermes curator check: due interval polled.');
        } finally {
          curatorRunning = false;
        }
      });
    }
  });
}

async function runReview(ctx, state, parent, reviewMemory, reviewSkills, options) {
  const prompt = reviewMemory && reviewSkills
    ? 'Review the recent conversation. Suggest improvements to memory and skills.'
    : reviewMemory
      ? 'Review the recent conversation. Suggest improvements to memory.'
      : 'Review the recent conversation. Suggest improvements to skills.';
  try {
    const run = await ctx.subagents.start('fork', {
      label: 'hermes-background-review',
      prompt: [{ type: 'text', text: prompt }],
      parent,
    });
    await run.result;
    await run.dispose();
  } catch (error) {
    ctx.logger.warn(`Hermes background review failed: ${error.message}`);
  }
}
