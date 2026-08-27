import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MemoryStore,
  SkillCatalog,
  buildLearnPrompt,
  resolveOptions,
} from '../src/index.js';

test('memory store persists and reads MEMORY.md and USER.md under bounded limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-memory-'));
  try {
    const store = new MemoryStore({ root, memoryCharLimit: 1000, userCharLimit: 500 });
    assert.equal(store.formatForPrompt('memory'), '');
    assert.equal(store.formatForPrompt('user'), '');

    await store.write('memory', 'The bridge uses a single shared store.');
    await store.write('user', 'User prefers concise answers.');
    assert.match(store.formatForPrompt('memory'), /shared store/);
    assert.match(store.formatForPrompt('user'), /concise/);

    const file = await readFile(join(root, 'memories', 'MEMORY.md'), 'utf8');
    assert.match(file, /shared store/);
    assert.equal(store.memoryCharLimit, 1000);
    assert.equal(store.userCharLimit, 500);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('memory store supports atomic add, replace, and remove operations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-ops-'));
  try {
    const store = new MemoryStore({ root });
    await store.add('memory', 'First fact.');
    await store.add('memory', 'Second fact.');
    assert.equal(store.formatForPrompt('memory').split('\n').filter(Boolean).length, 2);

    await store.replace('memory', 'Second fact.', 'Updated fact.');
    assert.match(store.formatForPrompt('memory'), /Updated fact./);
    assert.doesNotMatch(store.formatForPrompt('memory'), /Second fact./);

    await store.remove('memory', 'First fact.');
    assert.equal(store.formatForPrompt('memory').trim(), 'Updated fact.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('memory store enforces character limits with truncation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-limit-'));
  try {
    const store = new MemoryStore({ root, memoryCharLimit: 50 });
    await store.write('memory', 'A'.repeat(100));
    const text = store.formatForPrompt('memory');
    assert.ok(text.length <= 51);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skill catalog lists, creates, views, patches, and deletes skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-skills-'));
  try {
    const catalog = new SkillCatalog({ root });
    assert.deepEqual(await catalog.list(), []);

    const created = await catalog.create({ name: 'test-fixture', content: '---\nname: test-fixture\ndescription: A test skill.\n---\n\n# Fixture\n' });
    assert.equal(created.success, true);
    assert.match(created.skill_md, /SKILL\.md$/);

    const skills = await catalog.list();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'test-fixture');
    assert.equal(skills[0].description, 'A test skill.');

    const viewed = await catalog.view('test-fixture');
    assert.match(viewed.content, /# Fixture/);

    const patched = await catalog.patch('test-fixture', '# Fixture', '# Patched Fixture');
    assert.equal(patched.success, true);
    assert.match((await catalog.view('test-fixture')).content, /Patched Fixture/);

    const deleted = await catalog.delete('test-fixture');
    assert.equal(deleted.success, true);
    assert.deepEqual(await catalog.list(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skill catalog validates skill names and SKILL.md frontmatter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-validate-'));
  try {
    const catalog = new SkillCatalog({ root });
    await assert.rejects(catalog.create({ name: 'UPPER', content: '' }), /invalid skill name/i);
    await assert.rejects(catalog.create({ name: 'valid-name', content: 'no frontmatter' }), /frontmatter/i);
    await catalog.create({ name: 'valid', content: '---\nname: valid\ndescription: ok.\n---\n\nbody' });
    await assert.rejects(catalog.create({ name: 'valid', content: '---\nname: valid\ndescription: ok.\n---\n\nbody' }), /already exists/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skill catalog supports categories and file operations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-cat-'));
  try {
    const catalog = new SkillCatalog({ root });
    await catalog.create({ name: 'web-search', content: '---\nname: web-search\ndescription: Search the web.\n---\n\n# Web\n', category: 'research' });
    await catalog.create({ name: 'file-read', content: '---\nname: file-read\ndescription: Read files.\n---\n\n# Read\n', category: 'filesystem' });

    const research = await catalog.list('research');
    assert.equal(research.length, 1);
    assert.equal(research[0].name, 'web-search');

    const written = await catalog.writeFile('web-search', 'scripts/search.py', 'print("hi")');
    assert.equal(written.success, true);
    const read = await catalog.viewFile('web-search', 'scripts/search.py');
    assert.equal(read.content, 'print("hi")');

    const removed = await catalog.removeFile('web-search', 'scripts/search.py');
    assert.equal(removed.success, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildLearnPrompt produces a self-contained skill-authoring prompt', () => {
  const prompt = buildLearnPrompt('Create a skill for deploying CloudFormation templates');
  assert.match(prompt, /skill/i);
  assert.match(prompt, /CloudFormation/i);
  assert.match(prompt, /SKILL\.md/i);
});

test('resolveOptions produces portable defaults without private machine paths', () => {
  const options = resolveOptions({}, { env: {}, home: '/home/example', platform: 'linux' });
  assert.equal(options.enabled, true);
  assert.equal(options.namespace, 'hermes');
  assert.equal(options.backgroundReview, false);
  assert.equal(options.curator, false);
  assert.doesNotMatch(JSON.stringify(options), /ander|multiverse|compactif/i);
});

test('resolveOptions respects environment overrides', () => {
  const options = resolveOptions({ toolsets: ['file', 'web'] }, {
    env: { DSH_HOME: '/profiles/dsh-1' },
    home: '/ignored',
    platform: 'linux',
  });
  assert.equal(options.dshHome, '/profiles/dsh-1');
  assert.deepEqual(options.toolsets, ['file', 'web']);
});
