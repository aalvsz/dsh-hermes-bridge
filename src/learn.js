export function buildLearnPrompt(request) {
  return `You are learning a new reusable skill. Analyze the request below and produce a complete SKILL.md file with YAML frontmatter (name, description) followed by a markdown body with numbered steps, pitfalls, and verification steps.

Request: ${request}

The SKILL.md must:
- Start with --- frontmatter delimiters
- Include name (lowercase, hyphenated) and description fields
- Include numbered concrete steps with exact commands
- Include a pitfalls section
- Include verification steps that confirm the task succeeded`;
}
