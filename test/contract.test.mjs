import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_LOOP_TOOLS,
  Config,
  capabilityMatrix,
  dshParameterSchemaFromJsonSchema,
  mirrorToolName,
  parameterSpecFromJsonSchema,
  resolveOptions,
  selectMirroredTools,
} from '../src/index.js';

test('portable defaults find Hermes without carrying private machine paths', () => {
  assert.doesNotThrow(() => Config({}));
  const options = resolveOptions({}, {
    env: {},
    home: '/home/example',
    platform: 'linux',
  });

  assert.equal(options.enabled, true);
  assert.equal(options.hermesHome, '/home/example/.hermes');
  assert.equal(options.hermesAgentRoot, '/home/example/.hermes/hermes-agent');
  assert.equal(options.namespace, 'hermes');
  assert.deepEqual(options.toolsets, ['all']);
  assert.equal(options.backgroundReview, false);
  assert.equal(options.curator, false);
  assert.equal(options.requireApproval, true);
  assert.equal(options.syncSkills, false);
  assert.deepEqual(options.envAllowlist, []);
  assert.equal(options.delegateRoots.length, 1);
  assert.ok(options.pythonCandidates.includes('/home/example/.hermes/hermes-agent/venv/bin/python'));
  assert.doesNotMatch(JSON.stringify(options), /ander|multiverse|compactif/i);
});

test('environment overrides are explicit and profile-safe', () => {
  const options = resolveOptions({ toolsets: ['coding', 'mcp-github'] }, {
    env: {
      HERMES_HOME: '/profiles/research',
      HERMES_AGENT_ROOT: '/opt/hermes-agent',
      HERMES_PYTHON: '/opt/hermes-agent/venv/bin/python',
      DSH_HOME: '/profiles/dsh',
    },
    home: '/ignored',
    platform: 'linux',
  });

  assert.equal(options.hermesHome, '/profiles/research');
  assert.equal(options.hermesAgentRoot, '/opt/hermes-agent');
  assert.equal(options.pythonPath, '/opt/hermes-agent/venv/bin/python');
  assert.equal(options.dshHome, '/profiles/dsh');
  assert.deepEqual(options.toolsets, ['coding', 'mcp-github']);
  assert.equal(resolveOptions({ pythonPath: 'python3' }, { env: {}, home: '/home/example', platform: 'linux' }).pythonPath, 'python3');
});

test('mirrored names are deterministic, namespaced, and model-tool safe', () => {
  assert.equal(mirrorToolName('web_search'), 'hermes_web_search');
  assert.equal(mirrorToolName('mcp__github__create_issue'), 'hermes_mcp_github_create_issue');
  assert.equal(mirrorToolName('read-file', 'hx'), 'hx_read_file');
  assert.throws(() => mirrorToolName('../escape'), /valid Hermes tool name/i);
  assert.throws(() => mirrorToolName('web_search', 'UPPER SPACE'), /valid namespace/i);
});

test('Hermes JSON Schema compiles into DSH parameter specs without losing requiredness', () => {
  const converted = parameterSpecFromJsonSchema({
    type: 'object',
    required: ['query', 'limit'],
    properties: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'integer', minimum: 1, default: 10 },
      filter: {
        anyOf: [
          { type: 'string' },
          { type: 'null' },
        ],
      },
      metadata: {
        type: 'object',
        additionalProperties: true,
      },
    },
  });

  assert.deepEqual(converted.query, {
    type: 'string',
    description: 'Search query',
    required: true,
  });
  assert.equal(converted.limit.type, 'integer');
  assert.equal(converted.limit.required, true);
  assert.equal(converted.limit.default, 10);
  assert.match(converted.limit.description, /minimum=1.*enforced by Hermes/i);
  assert.deepEqual(converted.filter.oneOf, [{ type: 'string' }, { type: 'null' }]);
  assert.deepEqual(converted.metadata, {
    type: 'object',
    properties: {},
    additionalProperties: true,
  });
  assert.deepEqual(dshParameterSchemaFromJsonSchema({
    type: 'object',
    properties: { known: { type: 'string' } },
    additionalProperties: true,
  }), {
    type: 'object',
    properties: { known: { type: 'string' } },
    additionalProperties: true,
  });
});

test('generic mirroring excludes agent-loop tools and preserves dynamic MCP tools', () => {
  assert.deepEqual([...AGENT_LOOP_TOOLS].sort(), [
    'clarify',
    'delegate_task',
    'memory',
    'session_search',
    'todo',
  ]);
  const selected = selectMirroredTools([
    definition('memory'),
    definition('delegate_task'),
    definition('todo'),
    definition('clarify'),
    definition('web_search'),
    definition('mcp__github__create_issue'),
  ]);
  assert.deepEqual(selected.map((item) => item.function.name), [
    'mcp__github__create_issue',
    'web_search',
  ]);
});

test('capability matrix reports native, mirrored, delegated, and unavailable surfaces honestly', () => {
  const matrix = capabilityMatrix({
    health: { version: '0.20.5', commit: 'abcdef123456' },
    tools: [definition('web_search'), definition('cronjob')],
    toolsets: {
      web: { available: true },
      cronjob: { available: false, reason: 'gateway not running' },
    },
    native: { memory: true, skills: true, backgroundReview: false },
    delegate: { available: true },
  });

  assert.equal(matrix.hermes.version, '0.20.5');
  assert.equal(matrix.sharedState.memory, 'native');
  assert.equal(matrix.sharedState.skills, 'native');
  assert.equal(matrix.agentDelegation, 'available');
  assert.equal(matrix.toolsets.web.status, 'available');
  assert.equal(matrix.toolsets.cronjob.status, 'unavailable');
  assert.equal(matrix.toolsets.cronjob.reason, 'gateway not running');
});

function definition(name) {
  return {
    type: 'function',
    function: {
      name,
      description: `${name} description`,
      parameters: { type: 'object', properties: {} },
    },
  };
}
