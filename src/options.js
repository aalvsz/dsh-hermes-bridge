import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function resolveOptions(config = {}, runtime = {}) {
  const env = runtime.env ?? process.env;
  const home = runtime.home ?? homedir();
  return {
    enabled: config.enabled !== false,
    dshHome: resolve(config.dshHome || env.DSH_HOME || join(home, '.dsh')),
    memoryRoot: resolve(config.memoryRoot || env.DSH_HOME || join(home, '.dsh')),
    skillsRoot: resolve(config.skillsRoot || env.DSH_HOME || join(home, '.dsh')),
    namespace: config.namespace || 'hermes',
    toolsets: normalizeStringList(config.toolsets, ['all']),
    disabledToolsets: normalizeStringList(config.disabledToolsets, []),
    backgroundReview: config.backgroundReview === true,
    curator: config.curator === true,
    memoryCharLimit: positiveInteger(config.memoryCharLimit, 2200),
    userCharLimit: positiveInteger(config.userCharLimit, 1375),
    memoryNudgeInterval: positiveInteger(config.memoryNudgeInterval, 10),
    skillNudgeInterval: positiveInteger(config.skillNudgeInterval, 10),
    operationTimeoutMs: positiveInteger(config.operationTimeoutMs, 120_000),
    saveTrajectories: config.saveTrajectories === true,
    model: config.model || null,
    trajectoryTargetMaxTokens: positiveInteger(config.trajectoryTargetMaxTokens, 15250),
    trajectorySummaryTargetTokens: positiveInteger(config.trajectorySummaryTargetTokens, 750),
  };
}

function normalizeStringList(value, fallback) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new TypeError('toolset configuration must be an array of non-empty strings');
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new TypeError('must be a positive integer');
  return value;
}
