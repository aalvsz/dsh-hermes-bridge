import { lstat, mkdir, readdir, readlink, realpath, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { BridgeClient, discoverPython, runBridgeOnce } from './bridge-client.js';

export const name = 'dsh/hermes-bridge';
export const inject = ['tools', 'systemPrompt', 'agents', 'subagents', 'commands'];
export const Config = z.object({
  enabled: z.boolean().default(true),
  dshHome: z.string(),
  hermesHome: z.string(),
  hermesAgentRoot: z.string(),
  pythonPath: z.string(),
  namespace: z.string().default('hermes'),
  toolsets: z.array(z.string()).default(['all']),
  disabledToolsets: z.array(z.string()).default([]),
  mirrorTools: z.boolean().default(true),
  delegateAgent: z.boolean().default(true),
  requireApproval: z.boolean().default(true),
  envAllowlist: z.array(z.string()).default([]),
  delegateRoots: z.array(z.string()).default([]),
  syncSkills: z.boolean().default(false),
  backgroundReview: z.boolean().default(false),
  curator: z.boolean().default(false),
  operationTimeoutMs: z.number().default(120_000),
  delegateTimeoutMs: z.number().default(900_000),
  maxResponseBytes: z.number().default(8 * 1024 * 1024),
});

const REVIEW_LABEL = 'hermes-background-review';
const NATIVE_SOURCE_TOOLS = new Set(['memory', 'skills_list', 'skill_view', 'skill_manage']);
export const AGENT_LOOP_TOOLS = new Set([
  'clarify',
  'delegate_task',
  'memory',
  'session_search',
  'todo',
]);

const TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;
const NAMESPACE = /^[a-z][a-z0-9_]*$/;
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);

export function resolveOptions(config = {}, runtime = {}) {
  const env = runtime.env ?? process.env;
  const home = runtime.home ?? homedir();
  const platform = runtime.platform ?? process.platform;
  const cwd = runtime.cwd ?? (runtime.home ? runtime.home : process.cwd());
  const hermesHome = resolve(config.hermesHome || env.HERMES_HOME || join(home, '.hermes'));
  const hermesAgentRoot = resolve(
    config.hermesAgentRoot
      || env.HERMES_AGENT_ROOT
      || join(hermesHome, 'hermes-agent'),
  );
  const configuredPython = config.pythonPath || env.HERMES_PYTHON;
  const pythonCandidates = platform === 'win32'
    ? [join(hermesAgentRoot, 'venv', 'Scripts', 'python.exe'), 'py', 'python']
    : [join(hermesAgentRoot, 'venv', 'bin', 'python'), 'python3', 'python'];
  return {
    enabled: config.enabled !== false,
    dshHome: resolve(config.dshHome || env.DSH_HOME || join(home, '.dsh')),
    hermesHome,
    hermesAgentRoot,
    pythonPath: configuredPython ? resolveCommandOrPath(configuredPython) : undefined,
    pythonCandidates,
    namespace: config.namespace || 'hermes',
    toolsets: normalizeStringList(config.toolsets, ['all']),
    disabledToolsets: normalizeStringList(config.disabledToolsets, []),
    mirrorTools: config.mirrorTools !== false,
    delegateAgent: config.delegateAgent !== false,
    requireApproval: config.requireApproval !== false,
    envAllowlist: normalizeEnvironmentNames(config.envAllowlist),
    delegateRoots: normalizeDelegateRoots(config.delegateRoots, cwd),
    syncSkills: config.syncSkills === true,
    backgroundReview: config.backgroundReview === true,
    curator: config.curator === true,
    operationTimeoutMs: positiveInteger(config.operationTimeoutMs, 120_000),
    delegateTimeoutMs: positiveInteger(config.delegateTimeoutMs, 900_000),
    maxResponseBytes: positiveInteger(config.maxResponseBytes, 8 * 1024 * 1024),
  };
}

export function mirrorToolName(toolName, namespace = 'hermes') {
  if (!TOOL_NAME.test(toolName)) {
    throw new Error(`Invalid Hermes tool name: ${JSON.stringify(toolName)}`);
  }
  if (!NAMESPACE.test(namespace)) {
    throw new Error(`Invalid namespace: ${JSON.stringify(namespace)}`);
  }
  const normalized = toolName
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  if (!normalized) throw new Error(`Invalid Hermes tool name: ${JSON.stringify(toolName)}`);
  return `${namespace}_${normalized}`;
}

export function parameterSpecFromJsonSchema(schema) {
  const properties = isRecord(schema?.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  return Object.fromEntries(Object.entries(properties).map(([key, node]) => [
    key,
    valueSpecFromJsonSchema(node, required.has(key)),
  ]));
}

export function dshParameterSchemaFromJsonSchema(schema) {
  const converted = parameterSpecToJsonSchema(parameterSpecFromJsonSchema(schema));
  converted.additionalProperties = schema?.additionalProperties !== false;
  return converted;
}

export function selectMirroredTools(definitions, excluded = AGENT_LOOP_TOOLS) {
  return definitions
    .filter((definition) => {
      const functionSchema = definition?.function;
      return functionSchema
        && typeof functionSchema.name === 'string'
        && !excluded.has(functionSchema.name);
    })
    .sort((left, right) => left.function.name.localeCompare(right.function.name));
}

export function capabilityMatrix(bootstrap) {
  const toolsets = Object.fromEntries(Object.entries(bootstrap.toolsets || {}).map(([key, value]) => [
    key,
    {
      status: value?.available ? 'available' : 'unavailable',
      ...(value?.reason ? { reason: value.reason } : {}),
    },
  ]));
  return {
    hermes: {
      version: bootstrap.health?.version || 'unknown',
      commit: bootstrap.health?.commit || 'unknown',
    },
    sharedState: {
      memory: bootstrap.native?.memory ? 'native' : 'unavailable',
      skills: bootstrap.native?.skills ? 'native' : 'unavailable',
      backgroundReview: bootstrap.native?.backgroundReview ? 'native' : 'disabled',
    },
    catalogToolCount: Array.isArray(bootstrap.tools) ? bootstrap.tools.length : 0,
    mirroredToolCount: selectMirroredTools(
      Array.isArray(bootstrap.tools) ? bootstrap.tools : [],
      new Set([...AGENT_LOOP_TOOLS, ...NATIVE_SOURCE_TOOLS]),
    ).length,
    agentLoopTools: [...AGENT_LOOP_TOOLS].sort(),
    agentDelegation: bootstrap.delegate?.available ? 'available' : 'unavailable',
    toolsets,
  };
}

export async function apply(ctx, config = {}) {
  const options = resolveOptions(config);
  if (!options.enabled) {
    ctx.logger.info('dsh-hermes-bridge is installed but disabled.');
    return;
  }
  options.pythonPath = await discoverPython(options);
  const bootstrapRequest = {
    op: 'bootstrap',
    toolsets: options.toolsets,
    disabledToolsets: options.disabledToolsets,
  };
  const bootstrap = runBridgeOnce(options, bootstrapRequest);
  await validatePrivateDirectory(options.hermesHome, 'HERMES_HOME');
  if (options.syncSkills) {
    const skillSync = await synchronizeHermesSkills(options);
    for (const warning of skillSync.warnings) ctx.logger.warn(warning);
  }
  const bridge = new BridgeClient(options);
  ctx.effect(() => () => bridge.close(), 'dsh/hermes-bridge process');

  const snapshots = new Map();
  const reviewReadPaths = new Map();
  ctx.systemPrompt.section({
    name: 'dsh/hermes-bridge:guidance',
    order: 140,
    text: namespaceGuidance(bootstrap.guidance || '', options.namespace),
  });
  ctx.systemPrompt.section({
    name: 'dsh/hermes-bridge:memory',
    order: 145,
    text: ({ agent }) => frozenSnapshotFor(agent, ctx, options, snapshots),
  });
  const initialMatrix = capabilityMatrix(bootstrap);
  ctx.systemPrompt.section({
    name: 'dsh/hermes-bridge:capabilities',
    order: 146,
    text: capabilityPrompt(initialMatrix, options),
  });

  const approvalTools = new Set();
  for (const [sourceName, schema] of Object.entries(bootstrap.schemas || {})) {
    const tool = createNativeHermesTool(bridge, schema, sourceName, options, ctx.logger, reviewReadPaths);
    ctx.tools.register(tool);
    if (!['skills_list', 'skill_view'].includes(sourceName)) approvalTools.add(tool.name);
  }

  if (options.mirrorTools) {
    const excluded = new Set([...AGENT_LOOP_TOOLS, ...NATIVE_SOURCE_TOOLS]);
    for (const definition of selectMirroredTools(bootstrap.tools || [], excluded)) {
      const tool = createMirroredHermesTool(bridge, definition, options);
      ctx.tools.register(tool);
      approvalTools.add(tool.name);
    }
  }
  ctx.tools.register(createStatusTool(bridge, options));
  if (options.delegateAgent) {
    const delegate = createDelegateTool(bridge, options);
    ctx.tools.register(delegate);
    approvalTools.add(delegate.name);
  }
  if (options.requireApproval) installApprovalGate(ctx, approvalTools);
  installLearnCommand(ctx, bridge, options);

  ctx.on('agent/session-start', ({ agent }) => snapshots.delete(String(agent.id)));
  ctx.on('agent/disposed', ({ agent }) => {
    snapshots.delete(String(agent.id));
    reviewReadPaths.delete(String(agent.id));
  });
  if (options.backgroundReview) installBackgroundReview(ctx, options, bridge, bootstrap);
  ctx.logger.info(
    `dsh-hermes-bridge mounted Hermes ${bootstrap.health.version} (${bootstrap.tools.length} available tools).`,
  );
}

function defineBridgeTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.sourceParameters
      ? dshParameterSchemaFromJsonSchema(options.sourceParameters)
      : parameterSpecToJsonSchema(options.parameters),
    output: {
      schema: {},
      render: options.output.render,
      ...(options.output.presentationMeta ? { presentationMeta: options.output.presentationMeta } : {}),
    },
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.isConcurrencySafe ? { isConcurrencySafe: options.isConcurrencySafe } : {}),
    execute: options.execute,
    ...(options.presentCall ? { presentCall: options.presentCall } : {}),
    ...(options.presentResult ? { presentResult: options.presentResult } : {}),
  };
}

function parameterSpecToJsonSchema(spec) {
  const properties = {};
  const required = [];
  for (const [name, node] of Object.entries(spec || {})) {
    const { required: isRequired, ...value } = node;
    properties[name] = valueSpecToJsonSchema(value);
    if (isRequired) required.push(name);
  }
  return {
    type: 'object',
    properties,
    additionalProperties: false,
    ...(required.length ? { required } : {}),
  };
}

function valueSpecToJsonSchema(spec) {
  const annotations = copyAnnotations(spec);
  if (Array.isArray(spec.oneOf)) {
    return { ...annotations, oneOf: spec.oneOf.map(valueSpecToJsonSchema) };
  }
  if (spec.type === 'json') return annotations;
  if (spec.type === 'array') {
    return { ...annotations, type: 'array', ...(spec.items ? { items: valueSpecToJsonSchema(spec.items) } : {}) };
  }
  if (spec.type === 'object') {
    const nested = parameterSpecToJsonSchema(spec.properties || {});
    return {
      ...annotations,
      type: 'object',
      properties: nested.properties,
      ...(nested.required ? { required: nested.required } : {}),
      additionalProperties: spec.additionalProperties,
    };
  }
  return copyLiteralConstraints({ ...annotations, type: spec.type }, spec);
}

function createNativeHermesTool(bridge, schema, operation, options, logger, reviewReadPaths) {
  const sourceName = schema.name || operation;
  const toolName = mirrorToolName(sourceName, options.namespace);
  return defineBridgeTool({
    name: toolName,
    description: `[Hermes Agent] ${schema.description || sourceName}`,
    sourceParameters: schema.parameters || { type: 'object', properties: {} },
    parameters: parameterSpecFromJsonSchema(schema.parameters || { type: 'object', properties: {} }),
    output: jsonOutput(),
    timeoutMs: options.operationTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = exec.agent;
      const sessionId = String(agent?.id || 'tool-without-agent');
      const review = isHermesReviewAgent(agent);
      const result = await bridge.request({
        op: operation,
        arguments: args,
        sessionId,
        turn: currentTurn(agent),
        origin: review ? 'background_review' : 'foreground',
        reviewReadPaths: review ? [...(reviewReadPaths.get(sessionId) || [])] : [],
      }, exec.signal);
      if (operation === 'skill_view' && isRecord(result)) {
        const { _source_path: sourcePath, ...publicResult } = result;
        if (review && result.success && typeof sourcePath === 'string') {
          const paths = reviewReadPaths.get(sessionId) || new Set();
          paths.add(sourcePath);
          reviewReadPaths.set(sessionId, paths);
        }
        return publicResult;
      }
      if (operation !== 'skill_manage') return result;
      const warning = await synchronizeDshSkillLink(options, args, result);
      if (!warning) return result;
      logger.warn(warning);
      return { ...result, dshCatalogWarning: warning };
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `${toolName}: ${args.name || args.action || args.target || sourceName}`,
        rawInput: args.name || args.action || args.target || sourceName,
      };
    },
  });
}

function createMirroredHermesTool(bridge, definition, options) {
  const schema = definition.function;
  const toolName = mirrorToolName(schema.name, options.namespace);
  return defineBridgeTool({
    name: toolName,
    description: `[Hermes Agent tool: ${schema.name}] ${schema.description || ''}`.trim(),
    sourceParameters: schema.parameters || { type: 'object', properties: {} },
    parameters: parameterSpecFromJsonSchema(schema.parameters || { type: 'object', properties: {} }),
    output: jsonOutput(),
    timeoutMs: options.operationTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return bridge.request({
        op: 'tool_call',
        name: schema.name,
        arguments: args,
        sessionId: String(exec.agent?.id || 'tool-without-agent'),
        toolsets: options.toolsets,
        disabledToolsets: options.disabledToolsets,
      }, exec.signal);
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `Hermes: ${schema.name}`,
        rawInput: compactJson(args),
      };
    },
  });
}

function createStatusTool(bridge, options) {
  return defineBridgeTool({
    name: mirrorToolName('status', options.namespace),
    description: 'Inspect the live Hermes Agent compatibility surface exposed inside DeepSeek Harness.',
    parameters: {},
    output: jsonOutput(),
    timeoutMs: options.operationTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const bootstrap = await bridge.request({
        op: 'bootstrap',
        toolsets: options.toolsets,
        disabledToolsets: options.disabledToolsets,
      }, exec.signal);
      return capabilityMatrix(bootstrap);
    },
  });
}

function createDelegateTool(bridge, options) {
  return defineBridgeTool({
    name: mirrorToolName('delegate', options.namespace),
    description: 'Run a complete embedded Hermes Agent task with Hermes models, tools, memory, skills, MCP, and automation.',
    parameters: {
      prompt: { type: 'string', description: 'Complete task for Hermes Agent.', required: true },
      cwd: { type: 'string', description: 'Optional working directory.' },
      model: { type: 'string', description: 'Optional Hermes model override.' },
      provider: { type: 'string', description: 'Optional Hermes provider override.' },
      systemPrompt: { type: 'string', description: 'Optional ephemeral Hermes system prompt.' },
      maxIterations: { type: 'integer', default: 100 },
      runBudgetSeconds: { type: 'number', default: Math.floor(options.delegateTimeoutMs / 1000) },
      skipContextFiles: { type: 'boolean', default: false },
      skipMemory: { type: 'boolean', default: false },
    },
    output: jsonOutput(),
    timeoutMs: options.delegateTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return bridge.request({
        op: 'delegate',
        ...args,
        sessionId: `dsh:${String(exec.agent?.id || 'delegate')}:${exec.executionId || 'run'}`,
        toolsets: options.toolsets,
        disabledToolsets: options.disabledToolsets,
        allowedCwds: options.delegateRoots,
      }, exec.signal);
    },
    presentCall(args) {
      return { card: 'generic', title: 'Delegate to Hermes Agent', rawInput: args.prompt };
    },
  });
}

function installApprovalGate(ctx, approvalTools) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!approvalTools.has(exec.name)) return next();
    return {
      kind: 'ask',
      reason: 'Hermes delegated and mirrored tools can access external systems and durable state.',
    };
  });
}

function installLearnCommand(ctx, bridge, options) {
  ctx.commands.register({
    name: 'hermes-learn',
    description: 'Learn or improve a reusable skill through Hermes Agent.',
    input: { hint: '[what to learn, or blank for this conversation]' },
    async handler(invocation) {
      try {
        const result = await bridge.request({
          op: 'learn_prompt',
          request: invocation.rawInput.trim(),
          sessionId: String(invocation.agent.id),
        }, invocation.signal);
        invocation.agent.steer({
          content: [{ type: 'text', text: namespaceGuidance(result.prompt, options.namespace) }],
          source: { kind: 'user' },
        });
        return {
          kind: 'success',
          text: invocation.rawInput.trim()
            ? 'Learning a Hermes skill from what you described.'
            : 'Learning a Hermes skill from this conversation.',
        };
      } catch (error) {
        return { kind: 'error', text: `Hermes learning failed: ${error.message}` };
      }
    },
  });
}

function frozenSnapshotFor(agent, ctx, options, snapshots) {
  if (!agent) return '';
  const sessionId = String(agent.id);
  const parentId = agent.session.header.parentSession;
  if (isHermesReviewAgent(agent) && parentId) {
    const inherited = snapshots.get(String(parentId));
    if (inherited !== undefined) return inherited;
    const parent = ctx.agents.get(parentId);
    if (parent) return frozenSnapshotFor(parent, ctx, options, snapshots);
  }
  if (!snapshots.has(sessionId)) {
    const snapshot = runBridgeOnce(options, { op: 'snapshot', sessionId });
    snapshots.set(sessionId, snapshot.text);
  }
  return snapshots.get(sessionId) || '';
}

function namespaceGuidance(text, namespace) {
  let result = String(text || '');
  for (const tool of ['memory', 'skills_list', 'skill_view', 'skill_manage']) {
    result = result.replace(new RegExp(`\\b${tool}\\b`, 'g'), mirrorToolName(tool, namespace));
  }
  return result;
}

function capabilityPrompt(matrix, options) {
  const available = Object.values(matrix.toolsets).filter((item) => item.status === 'available').length;
  return [
    'Hermes Agent is mounted as a compatibility bridge.',
    `Use ${options.namespace}_* tools for Hermes-owned capabilities and ${options.namespace}_delegate for a full Hermes agent run.`,
    `Hermes ${matrix.hermes.version}; ${matrix.mirroredToolCount} tool schemas across ${available} available toolsets.`,
    'Hermes memory and skills share the same durable HERMES_HOME with native Hermes surfaces.',
  ].join(' ');
}

function jsonOutput() {
  return {
    schema: { type: 'json' },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  };
}

function compactJson(value) {
  const text = JSON.stringify(value);
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

export async function synchronizeHermesSkills(options) {
  const sourceRoot = join(options.hermesHome, 'skills');
  const sourceStatus = await pathStatus(sourceRoot);
  if (!sourceStatus?.isDirectory()) return { linked: 0, unchanged: 0, conflicts: 0, warnings: [] };
  const canonicalHome = await realpath(options.hermesHome);
  const hermesSkills = await realpath(sourceRoot);
  if (!isInside(hermesSkills, canonicalHome)) throw new Error('Hermes skill root resolves outside HERMES_HOME');
  await mkdir(options.dshHome, { recursive: true, mode: 0o700 });
  await validatePrivateDirectory(options.dshHome, 'DSH_HOME');
  const linkRoot = join(options.dshHome, 'skills');
  await mkdir(linkRoot, { recursive: true, mode: 0o700 });
  const canonicalLinkRoot = await realpath(linkRoot);
  if (!isInside(canonicalLinkRoot, await realpath(options.dshHome))) {
    throw new Error('DSH skill link root resolves outside DSH_HOME');
  }
  const summary = { linked: 0, unchanged: 0, conflicts: 0, warnings: [] };
  for (const entry of await readdir(hermesSkills, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(entry.name)) continue;
    const source = join(hermesSkills, entry.name);
    if (!(await pathStatus(join(source, 'SKILL.md')))?.isFile()) continue;
    const destination = join(canonicalLinkRoot, entry.name);
    const status = await pathStatus(destination);
    if (status) {
      if (status.isSymbolicLink() && resolve(dirname(destination), await readlink(destination)) === source) {
        summary.unchanged += 1;
      } else {
        summary.conflicts += 1;
        summary.warnings.push(`DSH skill '${entry.name}' already exists; Hermes left it unchanged.`);
      }
      continue;
    }
    try {
      await symlink(source, destination, 'dir');
      summary.linked += 1;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      summary.conflicts += 1;
      summary.warnings.push(`DSH skill '${entry.name}' appeared during synchronization; Hermes left it unchanged.`);
    }
  }
  return summary;
}

async function synchronizeDshSkillLink(options, args, result) {
  if (!options.syncSkills || !result?.success || !['create', 'delete'].includes(args.action)) return undefined;
  if (!/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(args.name || '')) {
    return `Hermes updated the skill, but DSH refused an invalid catalog link name: ${args.name}`;
  }
  if (args.action === 'delete') {
    return `Hermes deleted '${args.name}'; the bridge preserved any DSH catalog path to avoid destructive link races.`;
  }
  if (!result.skill_md) return `Hermes created '${args.name}', but did not return its SKILL.md path.`;
  const canonicalHome = await realpath(options.hermesHome);
  const hermesSkills = await realpath(join(canonicalHome, 'skills'));
  const skillDirectory = await realpath(dirname(result.skill_md));
  if (!isInside(hermesSkills, canonicalHome) || !isInside(skillDirectory, hermesSkills)) {
    return 'DSH refused a skill path outside the Hermes skill root.';
  }
  await mkdir(options.dshHome, { recursive: true, mode: 0o700 });
  await validatePrivateDirectory(options.dshHome, 'DSH_HOME');
  const linkRoot = join(options.dshHome, 'skills');
  await mkdir(linkRoot, { recursive: true, mode: 0o700 });
  const canonicalLinkRoot = await realpath(linkRoot);
  if (!isInside(canonicalLinkRoot, await realpath(options.dshHome))) return 'DSH refused a skill link root outside DSH_HOME.';
  const linkPath = join(canonicalLinkRoot, args.name);
  const status = await pathStatus(linkPath);
  if (status) {
    if (status.isSymbolicLink() && resolve(dirname(linkPath), await readlink(linkPath)) === skillDirectory) return undefined;
    return `DSH preserved an existing skill path at ${linkPath}.`;
  }
  try {
    await symlink(skillDirectory, linkPath, 'dir');
    return undefined;
  } catch (error) {
    if (error.code === 'EEXIST') return `DSH preserved a skill path that appeared at ${linkPath}.`;
    throw error;
  }
}

async function validatePrivateDirectory(path, label) {
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(`${label} must be a real directory, not a symbolic link`);
  if (typeof process.getuid === 'function' && status.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
  if ((status.mode & 0o022) !== 0) throw new Error(`${label} must not be writable by group or other users`);
}

async function pathStatus(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function isInside(path, root) {
  const child = relative(root, path);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !child.startsWith(sep));
}

function currentTurn(agent) {
  const event = agent?.session.events.findLast((candidate) => candidate.type === 'turn/start');
  return event?.data.turn;
}

function isHermesReviewAgent(agent) {
  return Boolean(agent?.session.events.some((event) => (
    event.type === 'subagent/descriptor' && event.data?.label === REVIEW_LABEL
  )));
}

function installBackgroundReview(ctx, options, bridge, bootstrap) {
  const memoryInterval = bootstrap.settings.memoryNudgeInterval;
  const skillInterval = bootstrap.settings.skillNudgeInterval;
  const states = new Map();
  let curatorRunning = false;
  const initialize = (agent) => {
    if (agent.session.header.origin === 'subagent') return;
    states.set(String(agent.id), {
      turnsSinceMemory: memoryInterval > 0 ? userTurns(agent) % memoryInterval : 0,
      itersSinceSkill: 0,
      pendingMemoryTurns: new Set(),
      reviewController: undefined,
      reviewRun: undefined,
    });
  };
  for (const agent of ctx.agents.list()) initialize(agent);
  ctx.on('agent/created', ({ agent }) => initialize(agent));
  ctx.on('agent/disposed', ({ agent }) => {
    states.get(String(agent.id))?.reviewController?.abort();
    states.delete(String(agent.id));
  });
  ctx.on('session/event', (session, event) => {
    const agent = ctx.agents.get(session.id);
    if (!agent || agent.session.header.origin === 'subagent') return;
    const state = states.get(String(agent.id));
    if (!state) return;
    if (event.type === 'turn/start') {
      state.reviewController?.abort();
      if (memoryInterval > 0 && ++state.turnsSinceMemory >= memoryInterval) {
        state.turnsSinceMemory = 0;
        state.pendingMemoryTurns.add(event.data.turn);
      }
      return;
    }
    if (event.type === 'step/start') {
      if (skillInterval > 0) state.itersSinceSkill += 1;
      return;
    }
    if (event.type === 'tool/call') {
      if (event.data.name === mirrorToolName('memory', options.namespace)) state.turnsSinceMemory = 0;
      if (event.data.name === mirrorToolName('skill_manage', options.namespace)) state.itersSinceSkill = 0;
      return;
    }
    if (event.type !== 'turn/end') return;
    const reviewMemory = state.pendingMemoryTurns.delete(event.data.turn);
    const reviewSkills = skillInterval > 0 && state.itersSinceSkill >= skillInterval;
    if (reviewSkills) state.itersSinceSkill = 0;
    if (event.data.reason.kind !== 'completed' || !hasAssistantReply(agent, event.data.turn)) return;
    if (reviewMemory || reviewSkills) {
      queueMicrotask(() => void runReview(ctx, state, agent, bootstrap, options, reviewMemory, reviewSkills));
    }
    if (options.curator && !curatorRunning) {
      curatorRunning = true;
      queueMicrotask(async () => {
        try {
          await bridge.request({ op: 'curator_if_due', sessionId: `curator:${agent.id}` });
        } catch (error) {
          ctx.logger.warn(`Hermes curator check failed: ${error.message}`);
        } finally {
          curatorRunning = false;
        }
      });
    }
  });
}

async function runReview(ctx, state, parent, bootstrap, options, reviewMemory, reviewSkills) {
  if (state.reviewRun) return;
  const controller = new AbortController();
  state.reviewController = controller;
  const prompts = bootstrap.reviewPrompts;
  const prompt = reviewMemory && reviewSkills ? prompts.combined : reviewMemory ? prompts.memory : prompts.skills;
  let run;
  try {
    run = await ctx.subagents.start('fork', {
      label: REVIEW_LABEL,
      prompt: [{ type: 'text', text: namespaceGuidance(prompt, options.namespace) }],
      parent,
      signal: controller.signal,
      toolFilter: { allow: ['memory', 'skills_list', 'skill_view', 'skill_manage'].map((name) => mirrorToolName(name, options.namespace)) },
    });
    state.reviewRun = run;
    await run.result;
  } catch (error) {
    if (!controller.signal.aborted) ctx.logger.warn(`Hermes background review failed: ${error.message}`);
  } finally {
    if (run) {
      try {
        await run.dispose();
      } catch (error) {
        ctx.logger.warn(`Hermes background review cleanup failed: ${error.message}`);
      }
    }
    state.reviewRun = undefined;
    if (state.reviewController === controller) state.reviewController = undefined;
  }
}

function userTurns(agent) {
  return agent.session.events.filter((event) => event.type === 'user/message' && event.data.source?.kind === 'user').length;
}

function hasAssistantReply(agent, turn) {
  return agent.session.events.some((event) => (
    event.type === 'assistant/message'
    && event.data.turn === turn
    && Array.isArray(event.data.message?.content)
    && event.data.message.content.length > 0
  ));
}

function valueSpecFromJsonSchema(node, required = false) {
  if (!isRecord(node)) return withRequired({ type: 'json' }, required);
  const annotations = copyAnnotations(node);
  const typedUnion = Array.isArray(node.type) && node.type.length >= 2
    ? node.type.map((type) => ({ ...node, type }))
    : undefined;
  const union = Array.isArray(node.oneOf)
    ? node.oneOf
    : Array.isArray(node.anyOf)
      ? node.anyOf
      : typedUnion;
  if (union && union.length >= 2) {
    return withRequired({
      ...annotations,
      oneOf: union.map((branch) => valueSpecFromJsonSchema(branch)),
    }, required);
  }
  if (SCALAR_TYPES.has(node.type)) {
    return withRequired(copyLiteralConstraints({ ...annotations, type: node.type }, node), required);
  }
  if (node.type === 'array') {
    return withRequired({
      ...annotations,
      type: 'array',
      ...(node.items ? { items: valueSpecFromJsonSchema(node.items) } : {}),
    }, required);
  }
  if (node.type === 'object' || isRecord(node.properties)) {
    return withRequired({
      ...annotations,
      type: 'object',
      properties: parameterSpecFromJsonSchema(node),
      additionalProperties: node.additionalProperties !== false,
    }, required);
  }
  return withRequired({ ...annotations, type: 'json' }, required);
}

function copyAnnotations(node) {
  const result = {};
  for (const key of ['description', 'title', 'default', 'examples']) {
    if (node[key] !== undefined) result[key] = node[key];
  }
  const enforced = [];
  for (const key of [
    'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
    'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems',
    'uniqueItems', 'minProperties', 'maxProperties',
  ]) {
    if (node[key] !== undefined) enforced.push(`${key}=${JSON.stringify(node[key])}`);
  }
  if (enforced.length) {
    const suffix = `[${enforced.join(', ')}; enforced by Hermes runtime.]`;
    result.description = result.description ? `${result.description} ${suffix}` : suffix;
  }
  return result;
}

function copyLiteralConstraints(result, node) {
  if (Array.isArray(node.enum)) result.enum = node.enum;
  if (node.const !== undefined) result.const = node.const;
  return result;
}

function withRequired(spec, required) {
  return required ? { ...spec, required: true } : spec;
}

function normalizeStringList(value, fallback) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new TypeError('toolset configuration must be an array of non-empty strings');
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function normalizeDelegateRoots(value, cwd) {
  const roots = normalizeStringList(value, []);
  return (roots.length ? roots : [cwd]).map((path) => resolve(path));
}

function normalizeEnvironmentNames(value) {
  const names = normalizeStringList(value, []);
  if (names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new TypeError('envAllowlist must contain valid environment variable names');
  }
  return names;
}

function resolveCommandOrPath(value) {
  return value.includes('/') || value.includes('\\') || isAbsolutePath(value) ? resolve(value) : value;
}

function isAbsolutePath(value) {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new TypeError('timeout and size limits must be positive integers');
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
