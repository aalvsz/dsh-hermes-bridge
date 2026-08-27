import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { TrajectoryRecorder } from '../src/trajectory.js';
import { TrajectoryCompressor, CompressionConfig } from '../src/compressor.js';

test('convertToTrajectoryFormat produces ShareGPT format with execute/result tags', () => {
  const recorder = new TrajectoryRecorder({ root: '/tmp/test', enabled: false });
  const messages = [
    { role: 'user', content: 'What files are in the current directory?' },
    {
      role: 'assistant',
      content: '',
      reasoning: 'I need to list files.',
      tool_calls: [
        { function: { name: 'list_files', arguments: '{"path": "."}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'tc1', content: '["file1.txt", "file2.py"]' },
    { role: 'assistant', content: 'The files are file1.txt and file2.py.' },
  ];

  const trajectory = recorder.convertToTrajectoryFormat(messages, 'What files are in the current directory?');

  assert.equal(trajectory[0].from, 'system');
  assert.match(trajectory[0].value, /<tools>/);
  assert.equal(trajectory[1].from, 'human');
  assert.equal(trajectory[1].value, 'What files are in the current directory?');
  assert.equal(trajectory[2].from, 'gpt');
  assert.match(trajectory[2].value, /<execute>/);
  assert.match(trajectory[2].value, /list_files/);
  assert.match(trajectory[2].value, /path.*\./);
  assert.equal(trajectory[3].from, 'tool');
  assert.match(trajectory[3].value, /<result>/);
  assert.match(trajectory[3].value, /file1\.txt/);
  assert.equal(trajectory[4].from, 'gpt');
  assert.match(trajectory[4].value, /file1\.txt/);
});

test('every gpt turn has a think block', () => {
  const recorder = new TrajectoryRecorder({ root: '/tmp/test', enabled: false });
  const messages = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there!' },
  ];

  const trajectory = recorder.convertToTrajectoryFormat(messages, 'Hello');
  const gptTurn = trajectory.find((t) => t.from === 'gpt');
  assert.match(gptTurn.value, /<think>/);
  assert.match(gptTurn.value, /<\/think>/);
});

test('REASONING_SCRATCHPAD tags converted to think tags', () => {
  const recorder = new TrajectoryRecorder({ root: '/tmp/test', enabled: false });
  const messages = [
    { role: 'user', content: 'Think' },
    { role: 'assistant', content: '<REASONING_SCRATCHPAD>my thoughts</REASONING_SCRATCHPAD>\nDone.' },
  ];

  const trajectory = recorder.convertToTrajectoryFormat(messages, 'Think');
  const gptTurn = trajectory.find((t) => t.from === 'gpt');
  assert.doesNotMatch(gptTurn.value, /REASONING_SCRATCHPAD/);
  assert.match(gptTurn.value, /<think>my thoughts<\/think>/);
});

test('trajectory is saved to JSONL with correct filename', async () => {
  const root = await mkdtemp(join(tmpdir(), 'traj-save-'));
  try {
    const recorder = new TrajectoryRecorder({ root, model: 'test-model', enabled: true });
    const trajectory = [{ from: 'human', value: 'test' }];
    await recorder.save(trajectory, true);
    await recorder.save(trajectory, false);

    const successContent = await readFile(join(root, 'trajectories', 'trajectory_samples.jsonl'), 'utf8');
    const failContent = await readFile(join(root, 'trajectories', 'failed_trajectories.jsonl'), 'utf8');

    const successEntry = JSON.parse(successContent.trim());
    assert.equal(successEntry.completed, true);
    assert.equal(successEntry.model, 'test-model');
    assert.deepEqual(successEntry.conversations, trajectory);
    assert.match(successEntry.timestamp, /^\d{4}-/);

    const failEntry = JSON.parse(failContent.trim());
    assert.equal(failEntry.completed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('compressor skips trajectories under target token limit', async () => {
  const config = new CompressionConfig({ targetMaxTokens: 100000 });
  const compressor = new TrajectoryCompressor(config);
  const trajectory = [
    { from: 'system', value: 'You are an assistant.' },
    { from: 'human', value: 'Hello' },
    { from: 'gpt', value: 'Hi there!' },
  ];

  const { trajectory: result, metrics } = await compressor.compressTrajectory(trajectory);
  assert.equal(metrics.skippedUnderTarget, true);
  assert.equal(metrics.wasCompressed, false);
  assert.deepEqual(result, trajectory);
});

test('compressor compresses trajectories over target token limit', async () => {
  const summarizeCalls = [];
  const summarizeFn = async (prompt) => {
    summarizeCalls.push(prompt);
    return 'The assistant listed files and reported the result.';
  };
  const config = new CompressionConfig({
    targetMaxTokens: 200,
    summaryTargetTokens: 50,
    protectLastNTurns: 2,
    maxRetries: 1,
  });
  const compressor = new TrajectoryCompressor(config, { summarizeFn });

  // Build a trajectory with long middle turns that exceed 200 tokens
  const longValue = 'A'.repeat(1200);
  const trajectory = [
    { from: 'system', value: 'You are an assistant.' },
    { from: 'human', value: 'List files' },
    { from: 'gpt', value: 'I will list files.' },
    { from: 'tool', value: 'tool result 1' },
    { from: 'gpt', value: longValue },
    { from: 'tool', value: longValue },
    { from: 'gpt', value: longValue },
    { from: 'tool', value: longValue },
    { from: 'gpt', value: 'Here are the files.' },
    { from: 'human', value: 'Thanks' },
    { from: 'gpt', value: 'You are welcome.' },
  ];

  const { trajectory: result, metrics } = await compressor.compressTrajectory(trajectory);
  assert.equal(metrics.wasCompressed, true);
  assert.equal(metrics.skippedUnderTarget, false);
  assert.ok(metrics.compressedTurns < metrics.originalTurns);
  assert.ok(metrics.compressedTokens < metrics.originalTokens);
  assert.equal(summarizeCalls.length, 1);
  assert.match(result[result.length - 1].value, /welcome/);
});

test('compressor does not split tool/gpt pairs at boundary', async () => {
  const summarizeFn = async () => 'Summary of turns.';
  const config = new CompressionConfig({
    targetMaxTokens: 100,
    summaryTargetTokens: 20,
    protectFirstSystem: true,
    protectFirstHuman: true,
    protectFirstGpt: true,
    protectFirstTool: true,
    protectLastNTurns: 2,
    maxRetries: 1,
  });
  const compressor = new TrajectoryCompressor(config, { summarizeFn });

  const trajectory = [
    { from: 'system', value: 'Sys' },
    { from: 'human', value: 'Q' },
    { from: 'gpt', value: 'B'.repeat(200) },
    { from: 'tool', value: 'R'.repeat(200) },
    { from: 'gpt', value: 'Final answer.' },
    { from: 'human', value: 'Thanks' },
  ];

  const { trajectory: result, metrics } = await compressor.compressTrajectory(trajectory);
  // If compression occurred, verify no tool turn starts the tail without its gpt
  if (metrics.wasCompressed) {
    for (let i = 1; i < result.length; i++) {
      if (result[i].from === 'tool') {
        assert.equal(result[i - 1].from, 'gpt', 'tool turn must be preceded by gpt turn');
      }
    }
  }
});

test('compressor processEntry adds compression_metrics to output', async () => {
  const summarizeFn = async () => 'Summary text here.';
  const config = new CompressionConfig({ targetMaxTokens: 100, summaryTargetTokens: 20, maxRetries: 1, protectLastNTurns: 1 });
  const compressor = new TrajectoryCompressor(config, { summarizeFn });

  const entry = {
    conversations: [
      { from: 'system', value: 'S' },
      { from: 'human', value: 'Q' },
      { from: 'gpt', value: 'short1' },
      { from: 'tool', value: 'short2' },
      { from: 'gpt', value: 'B'.repeat(800) },
      { from: 'tool', value: 'R'.repeat(800) },
      { from: 'gpt', value: 'B'.repeat(800) },
      { from: 'tool', value: 'R'.repeat(800) },
      { from: 'gpt', value: 'Done.' },
    ],
    timestamp: '2026-01-01T00:00:00Z',
    model: 'test',
    completed: true,
  };

  const { entry: result, metrics } = await compressor.processEntry(entry);
  assert.equal(metrics.wasCompressed, true);
  assert.ok(result.compression_metrics);
  assert.equal(result.compression_metrics.was_compressed, true);
  assert.equal(result.compression_metrics.original_tokens, metrics.originalTokens);
});

test('compressor processDirectory processes all JSONL files', async () => {
  const inputDir = await mkdtemp(join(tmpdir(), 'compress-in-'));
  const outputDir = await mkdtemp(join(tmpdir(), 'compress-out-'));
  try {
    const trajectory = [
      { from: 'system', value: 'S' },
      { from: 'human', value: 'Q' },
      { from: 'gpt', value: 'short1' },
      { from: 'tool', value: 'short2' },
      { from: 'gpt', value: 'B'.repeat(800) },
      { from: 'tool', value: 'R'.repeat(800) },
      { from: 'gpt', value: 'B'.repeat(800) },
      { from: 'tool', value: 'R'.repeat(800) },
      { from: 'gpt', value: 'Done.' },
    ];
    const entry = { conversations: trajectory, model: 'test', completed: true, timestamp: '2026-01-01' };

    await writeFile(join(inputDir, 'run1.jsonl'), JSON.stringify(entry) + '\n');
    await writeFile(join(inputDir, 'run2.jsonl'), JSON.stringify(entry) + '\n');

    const summarizeFn = async () => 'Summary.';
    const config = new CompressionConfig({ targetMaxTokens: 100, summaryTargetTokens: 20, maxRetries: 1, protectLastNTurns: 1 });
    const compressor = new TrajectoryCompressor(config, { summarizeFn });

    const results = await compressor.processDirectory(inputDir, outputDir);

    assert.equal(results.total_trajectories, 2);
    assert.equal(results.trajectories_compressed, 2);
    assert.equal(results.files_processed, 2);
    assert.ok(results.total_tokens_saved > 0);
  } finally {
    await rm(inputDir, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  }
});
