import { mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const NAME_RE = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;
const RELATIVE_FILE_RE = /^(references|templates|scripts|assets)\/[A-Za-z0-9][A-Za-z0-9._\-\/]*$/;

export class SkillCatalog {
  constructor({ root, skillsDir = 'skills' }) {
    this.root = root;
    this.skillsDir = join(root, skillsDir);
    this._cache = null;
  }

  skillPath(name) {
    return join(this.skillsDir, name);
  }

  skillMdPath(name) {
    return join(this.skillPath(name), 'SKILL.md');
  }

  parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) throw new Error('SKILL.md must have YAML frontmatter delimited by --- lines');
    const front = match[1];
    const body = match[2];
    const fields = {};
    for (const line of front.split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return { fields, body };
  }

  validateName(name) {
    if (!NAME_RE.test(name)) throw new Error(`Invalid skill name: ${name}. Use lowercase letters, digits, hyphens, underscores.`);
  }

  validateContent(content) {
    if (!content.startsWith('---\n')) throw new Error('SKILL.md must start with YAML frontmatter (---)');
    const { fields } = this.parseFrontmatter(content);
    if (!fields.name) throw new Error('SKILL.md frontmatter must include a name field');
    if (!fields.description) throw new Error('SKILL.md frontmatter must include a description field');
    return { fields, body: this.parseFrontmatter(content).body };
  }

  async create({ name, content, category = null }) {
    this.validateName(name);
    this.validateContent(content);
    const dir = this.skillPath(name);
    try {
      await stat(dir);
      throw new Error(`Skill '${name}' already exists`);
    } catch (error) {
      if (error.code !== 'ENOENT' && !error.message.includes('already exists')) throw error;
      if (error.message.includes('already exists')) throw error;
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const skillMd = join(dir, 'SKILL.md');
    await writeFile(skillMd, content, { mode: 0o600 });
    if (category) {
      const catPath = join(dir, '.category');
      await writeFile(catPath, category, { mode: 0o600 });
    }
    this._cache = null;
    return { success: true, skill_md: skillMd };
  }

  async list(category = null) {
    if (!this._cache) await this.refresh();
    return category ? this._cache.filter((s) => s.category === category) : this._cache;
  }

  async refresh() {
    this._cache = await this._readList();
    return this._cache;
  }

  async _readList() {
    try {
      const entries = await readdir(this.skillsDir, { withFileTypes: true });
      const skills = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !NAME_RE.test(entry.name)) continue;
        try {
          const content = await readFile(join(this.skillsDir, entry.name, 'SKILL.md'), 'utf8');
          const { fields } = this.parseFrontmatter(content);
          let cat = null;
          try { cat = await readFile(join(this.skillsDir, entry.name, '.category'), 'utf8'); } catch {}
          skills.push({ name: entry.name, description: fields.description || '', category: cat });
        } catch {}
      }
      skills.sort((a, b) => a.name.localeCompare(b.name));
      return skills;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async view(name) {
    this.validateName(name);
    const path = this.skillMdPath(name);
    const content = await readFile(path, 'utf8');
    return { name, content };
  }

  async patch(name, oldString, newString, replaceAll = false) {
    this.validateName(name);
    const path = this.skillMdPath(name);
    const content = await readFile(path, 'utf8');
    if (!content.includes(oldString)) throw new Error(`Text not found in skill ${name}`);
    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);
    await writeFile(path, updated, { mode: 0o600 });
    return { success: true };
  }

  async delete(name) {
    this.validateName(name);
    const dir = this.skillPath(name);
    await rm(dir, { recursive: true, force: true });
    this._cache = null;
    return { success: true };
  }

  async writeFile(name, filePath, fileContent) {
    this.validateName(name);
    if (!RELATIVE_FILE_RE.test(filePath)) {
      throw new Error('File path must be under references/, templates/, scripts/, or assets/');
    }
    const fullPath = join(this.skillPath(name), filePath);
    await mkdir(dirname(fullPath), { recursive: true, mode: 0o700 });
    await writeFile(fullPath, fileContent, { mode: 0o600 });
    return { success: true };
  }

  async viewFile(name, filePath) {
    this.validateName(name);
    if (!RELATIVE_FILE_RE.test(filePath)) {
      throw new Error('File path must be under references/, templates/, scripts/, or assets/');
    }
    const content = await readFile(join(this.skillPath(name), filePath), 'utf8');
    return { name, path: filePath, content };
  }

  async removeFile(name, filePath) {
    this.validateName(name);
    if (!RELATIVE_FILE_RE.test(filePath)) {
      throw new Error('File path must be under references/, templates/, scripts/, or assets/');
    }
    await rm(join(this.skillPath(name), filePath), { force: true });
    return { success: true };
  }
}
