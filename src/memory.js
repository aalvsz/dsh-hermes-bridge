import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const TARGETS = { memory: 'MEMORY.md', user: 'USER.md' };

export class MemoryStore {
  constructor({ root, memoryCharLimit = 2200, userCharLimit = 1375 }) {
    this.root = root;
    this.memoryCharLimit = memoryCharLimit;
    this.userCharLimit = userCharLimit;
    this.cache = new Map();
  }

  getPath(target) {
    return join(this.root, 'memories', TARGETS[target]);
  }

  getLimit(target) {
    return target === 'memory' ? this.memoryCharLimit : this.userCharLimit;
  }

  async _readRaw(target) {
    if (this.cache.has(target)) return this.cache.get(target);
    try {
      const content = await readFile(this.getPath(target), 'utf8');
      this.cache.set(target, content);
      return content;
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.cache.set(target, '');
        return '';
      }
      throw error;
    }
  }

  async _writeRaw(target, content) {
    const path = this.getPath(target);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600 });
    this.cache.set(target, content);
  }

  formatForPrompt(target) {
    const raw = this.cache.get(target) ?? '';
    const limit = this.getLimit(target);
    if (!raw || raw.length <= limit) return raw;
    return raw.slice(0, limit).lastIndexOf('\n') >= 0
      ? raw.slice(0, raw.lastIndexOf('\n', limit) + 1)
      : raw.slice(0, limit) + '\n';
  }

  async write(target, content) {
    await this._writeRaw(target, content);
  }

  async add(target, entry) {
    const current = await this._readRaw(target);
    const updated = current ? `${current.trimEnd()}\n${entry}\n` : `${entry}\n`;
    await this._writeRaw(target, updated);
  }

  async replace(target, oldText, newText) {
    const current = await this._readRaw(target);
    if (!current.includes(oldText)) throw new Error(`Text not found in ${target}: ${oldText}`);
    await this._writeRaw(target, current.replace(oldText, newText));
  }

  async remove(target, oldText) {
    const current = await this._readRaw(target);
    if (!current.includes(oldText)) throw new Error(`Text not found in ${target}: ${oldText}`);
    await this._writeRaw(target, current.replace(oldText, '').replace(/\n{3,}/g, '\n\n').trim() + '\n');
  }

  async batch(target, operations) {
    for (const op of operations) {
      if (op.action === 'add') await this.add(target, op.content);
      else if (op.action === 'replace') await this.replace(target, op.old_text, op.new_text);
      else if (op.action === 'remove') await this.remove(target, op.old_text);
    }
  }

  invalidate() {
    this.cache.clear();
  }
}
