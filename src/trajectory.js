import { mkdir, appendFile, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';

/**
 * TrajectoryRecorder captures DSH conversation turns and saves them in
 * ShareGPT trajectory format ({from, value}) as JSONL files.
 *
 * Mirrors Hermes agent/trajectory.py + agent_runtime_helpers.convert_to_trajectory_format.
 */

export class TrajectoryRecorder {
  constructor({ root, model = 'unknown', enabled = false }) {
    this.root = root;
    this.model = model;
    this.enabled = enabled;
    this.trajectoriesDir = join(root, 'trajectories');
  }

  /**
   * Convert an array of OpenAI-format messages into ShareGPT trajectory format.
   *
   * Input messages: [{role, content, tool_calls?, reasoning?}, ...]
   * Output: [{from, value}, ...]
   *
   * This mirrors Hermes convert_to_trajectory_format:
   * - System message is prepended with tool definitions wrapper
   * - Tool calls are wrapped in <execute>...</execute> tags
   * - Tool responses are wrapped in <result>...</result> tags
   * - Assistant reasoning is wrapped in <think>...</think> tags
   * - Every gpt turn gets a <think> block (empty if no reasoning)
   */
  convertToTrajectoryFormat(messages, userQuery, toolDefinitions = '') {
    const trajectory = [];

    // System message with tool definitions
    const systemMsg =
      'You are a function calling AI model. You are provided with function signatures within <tools> </tools> XML tags. ' +
      'You may call one or more functions to assist with the user query. If available tools are not relevant in assisting ' +
      'with the user query, just respond in natural conversational language. Don\'t make assumptions about what values to plug ' +
      'into functions. After calling & executing the functions, you will be provided with function results within ' +
      '<result> </result> XML tags. Here are the available tools:\n' +
      `<tools>\n${toolDefinitions}\n</tools>\n` +
      'For each function call return a JSON object, with the following pydantic model json schema for each:\n' +
      '{"title": "FunctionCall", "type": "object", "properties": {"name": {"title": "Name", "type": "string"}, ' +
      '"arguments": {"title": "Arguments", "type": "object"}}, "required": ["name", "arguments"]}\n' +
      'Each function call should be enclosed within <execute> </execute> XML tags.\n' +
      'Example:\n<execute>\n{"name": <function-name>,"arguments": <args-dict>}\n</execute>';

    trajectory.push({ from: 'system', value: systemMsg });

    // Add the original user query as first human message
    trajectory.push({ from: 'human', value: userQuery });

    // Process remaining messages (skip first user message)
    let i = 1;
    while (i < messages.length) {
      const msg = messages[i];

      if (msg.role === 'assistant') {
        let content = '';

        // Prepend reasoning in <think> tags
        if (msg.reasoning && msg.reasoning.trim()) {
          content = `<think>\n${msg.reasoning}\n</think>\n`;
        }

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // Assistant with tool calls
          if (msg.content && msg.content.trim()) {
            content += this._convertScratchpadToThink(msg.content) + '\n';
          }

          for (const tc of msg.tool_calls) {
            if (!tc || typeof tc !== 'object') continue;
            let args;
            try {
              args = typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments;
            } catch {
              args = {};
            }
            const tcJson = { name: tc.function.name, arguments: args };
            content += `<execute>\n${JSON.stringify(tcJson)}\n</execute>\n`;
          }

          // Ensure every gpt turn has a <think> block
          if (!content.includes('<think>')) {
            content = '<think>\n</think>\n' + content;
          }

          trajectory.push({ from: 'gpt', value: content.trim() });

          // Collect subsequent tool responses
          const toolResponses = [];
          let j = i + 1;
          while (j < messages.length && messages[j].role === 'tool') {
            const toolMsg = messages[j];
            let toolContent = toolMsg.content;
            // Try to parse as JSON
            try {
              if (typeof toolContent === 'string' && toolContent.trim().startsWith(('{', '['))) {
                toolContent = JSON.parse(toolContent);
              }
            } catch { /* keep as string */ }

            const toolIndex = toolResponses.length;
            const toolName = toolIndex < msg.tool_calls.length
              ? msg.tool_calls[toolIndex].function.name
              : 'unknown';

            let toolResponse = '<result>\n';
            toolResponse += JSON.stringify({
              tool_call_id: toolMsg.tool_call_id || '',
              name: toolName,
              content: toolContent,
            });
            toolResponse += '\n</result>';
            toolResponses.push(toolResponse);
            j += 1;
          }

          if (toolResponses.length > 0) {
            trajectory.push({ from: 'tool', value: toolResponses.join('\n') });
            i = j - 1;
          }
        } else {
          // Regular assistant message without tool calls
          const rawContent = msg.content || '';
          content += this._convertScratchpadToThink(rawContent);

          if (!content.includes('<think>')) {
            content = '<think>\n</think>\n' + content;
          }

          trajectory.push({ from: 'gpt', value: content.trim() });
        }
      } else if (msg.role === 'user') {
        trajectory.push({ from: 'human', value: msg.content });
      }

      i += 1;
    }

    return trajectory;
  }

  /**
   * Convert <REASONING_SCRATCHPAD> tags to <think> tags.
   */
  _convertScratchpadToThink(content) {
    if (!content || !content.includes('<REASONING_SCRATCHPAD>')) return content;
    return content
      .replace(/<REASONING_SCRATCHPAD>/g, '<think>')
      .replace(/<\/REASONING_SCRATCHPAD>/g, '</think>');
  }

  /**
   * Save a trajectory to JSONL (mirrors Hermes save_trajectory).
   */
  async save(trajectory, completed) {
    if (!this.enabled) return;

    const filename = completed ? 'trajectory_samples.jsonl' : 'failed_trajectories.jsonl';
    const path = join(this.trajectoriesDir, filename);

    const entry = {
      conversations: trajectory,
      timestamp: new Date().toISOString(),
      model: this.model,
      completed,
    };

    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }

  /**
   * Read all trajectory entries from a JSONL file.
   */
  async readJsonl(filePath) {
    const content = await readFile(filePath, 'utf8');
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  }

  /**
   * Read all trajectories from a directory of JSONL files.
   */
  async readDirectory(dirPath) {
    const entries = [];
    const files = await readdir(dirPath);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const path = join(dirPath, file);
      const parsed = await this.readJsonl(path);
      for (const entry of parsed) {
        entries.push({ file: path, entry });
      }
    }
    return entries;
  }
}
