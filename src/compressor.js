import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';

/**
 * TrajectoryCompressor compresses agent trajectories to fit within a
 * target token budget while preserving training signal quality.
 *
 * Mirrors Hermes trajectory_compressor.py TrajectoryCompressor.
 *
 * Compression strategy:
 * 1. Keep protected head turns (system, human, first gpt+tool)
 * 2. Keep protected tail turns (last N turns)
 * 3. From the compressible middle region, compress only as much as needed
 * 4. Replace compressed turns with a single human summary message
 * 5. Keep remaining middle turns intact (model continues with tools)
 */

export class CompressionConfig {
  constructor(opts = {}) {
    // Compression targets
    this.targetMaxTokens = opts.targetMaxTokens ?? 15250;
    this.summaryTargetTokens = opts.summaryTargetTokens ?? 750;

    // Protected turns
    this.protectFirstSystem = opts.protectFirstSystem ?? true;
    this.protectFirstHuman = opts.protectFirstHuman ?? true;
    this.protectFirstGpt = opts.protectFirstGpt ?? true;
    this.protectFirstTool = opts.protectFirstTool ?? true;
    this.protectLastNTurns = opts.protectLastNTurns ?? 4;

    // Summarization
    this.summarizationModel = opts.summarizationModel ?? null;
    this.temperature = opts.temperature ?? 0.3;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 2000;

    // Output
    this.addSummaryNotice = opts.addSummaryNotice ?? true;
    this.summaryNoticeText = opts.summaryNoticeText ??
      '\n\nSome of your previous tool responses may be summarized to preserve context.';
    this.outputSuffix = opts.outputSuffix ?? '_compressed';

    // Processing
    this.skipUnderTarget = opts.skipUnderTarget ?? true;
    this.saveOverLimit = opts.saveOverLimit ?? true;
  }
}

export class TrajectoryMetrics {
  constructor() {
    this.originalTurns = 0;
    this.originalTokens = 0;
    this.compressedTurns = 0;
    this.compressedTokens = 0;
    this.turnsRemoved = 0;
    this.tokensSaved = 0;
    this.compressionRatio = 1.0;
    this.wasCompressed = false;
    this.skippedUnderTarget = false;
    this.stillOverLimit = false;
    this.summarizationApiCalls = 0;
    this.summarizationErrors = 0;
    this.turnsCompressedStartIdx = 0;
    this.turnsCompressedEndIdx = 0;
    this.turnsInCompressedRegion = 0;
  }

  toDict() {
    return {
      original_turns: this.originalTurns,
      original_tokens: this.originalTokens,
      compressed_turns: this.compressedTurns,
      compressed_tokens: this.compressedTokens,
      turns_removed: this.turnsRemoved,
      tokens_saved: this.tokensSaved,
      compression_ratio: Math.round(this.compressionRatio * 10000) / 10000,
      was_compressed: this.wasCompressed,
      skipped_under_target: this.skippedUnderTarget,
      still_over_limit: this.stillOverLimit,
      summarization_api_calls: this.summarizationApiCalls,
      summarization_errors: this.summarizationErrors,
      turns_compressed_start_idx: this.turnsCompressedStartIdx,
      turns_compressed_end_idx: this.turnsCompressedEndIdx,
      turns_in_compressed_region: this.turnsInCompressedRegion,
    };
  }
}

export class TrajectoryCompressor {
  constructor(config, { summarizeFn = null } = {}) {
    this.config = config;
    this.summarizeFn = summarizeFn;
  }

  /**
   * Estimate token count for text.
   * Uses character/4 estimation (Hermes fallback when tokenizer unavailable).
   */
  countTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  countTrajectoryTokens(trajectory) {
    return trajectory.reduce((sum, turn) => sum + this.countTokens(turn.value || ''), 0);
  }

  countTurnTokens(trajectory) {
    return trajectory.map((turn) => this.countTokens(turn.value || ''));
  }

  /**
   * Find indices of protected turns.
   * Returns { protected: Set, compressibleStart: int, compressibleEnd: int }
   */
  _findProtectedIndices(trajectory) {
    const n = trajectory.length;
    const protectedSet = new Set();

    let firstSystem = null;
    let firstHuman = null;
    let firstGpt = null;
    let firstTool = null;

    for (let i = 0; i < n; i++) {
      const role = trajectory[i].from || '';
      if (role === 'system' && firstSystem === null) firstSystem = i;
      else if (role === 'human' && firstHuman === null) firstHuman = i;
      else if (role === 'gpt' && firstGpt === null) firstGpt = i;
      else if (role === 'tool' && firstTool === null) firstTool = i;
    }

    if (this.config.protectFirstSystem && firstSystem !== null) protectedSet.add(firstSystem);
    if (this.config.protectFirstHuman && firstHuman !== null) protectedSet.add(firstHuman);
    if (this.config.protectFirstGpt && firstGpt !== null) protectedSet.add(firstGpt);
    if (this.config.protectFirstTool && firstTool !== null) protectedSet.add(firstTool);

    // Protect last N turns
    const tailStart = Math.max(0, n - this.config.protectLastNTurns);
    for (let i = tailStart; i < n; i++) protectedSet.add(i);

    // Determine compressible region
    const headProtected = [...protectedSet].filter((i) => i < n / 2).sort((a, b) => a - b);
    const tailProtected = [...protectedSet].filter((i) => i >= n / 2).sort((a, b) => a - b);

    const compressibleStart = headProtected.length > 0 ? headProtected[headProtected.length - 1] + 1 : 0;
    const compressibleEnd = tailProtected.length > 0 ? tailProtected[0] : n;

    return { protectedSet, compressibleStart, compressibleEnd };
  }

  /**
   * Return true if a region boundary at idx does not split a turn pair.
   * A tool turn must stay adjacent to its preceding gpt turn.
   */
  static _isBoundaryClean(trajectory, idx) {
    return idx >= trajectory.length || trajectory[idx].from !== 'tool';
  }

  /**
   * Move a compression boundary onto the nearest clean turn boundary.
   */
  static _snapBoundary(trajectory, idx, minIdx, maxIdx) {
    let forward = idx;
    while (forward < maxIdx && !TrajectoryCompressor._isBoundaryClean(trajectory, forward)) {
      forward++;
    }
    if (TrajectoryCompressor._isBoundaryClean(trajectory, forward)) {
      return forward;
    }
    let backward = idx;
    while (backward > minIdx && !TrajectoryCompressor._isBoundaryClean(trajectory, backward)) {
      backward--;
    }
    return backward;
  }

  /**
   * Extract content from turns to be summarized.
   */
  _extractTurnContentForSummary(trajectory, start, end) {
    const parts = [];
    for (let i = start; i < end; i++) {
      const turn = trajectory[i];
      const role = (turn.from || 'unknown').toUpperCase();
      let value = turn.value || '';
      // Truncate very long values for the summary prompt
      if (value.length > 3000) {
        value = value.slice(0, 1500) + '\n...[truncated]...\n' + value.slice(-500);
      }
      parts.push(`[Turn ${i} - ${role}]:\n${value}`);
    }
    return parts.join('\n\n');
  }

  static _ensureSummaryPrefix(summary) {
    const text = (summary || '').trim();
    if (text.startsWith('[CONTEXT SUMMARY]:')) return text;
    if (!text) return '[CONTEXT SUMMARY]:';
    return `[CONTEXT SUMMARY]: ${text}`;
  }

  /**
   * Generate a summary of compressed turns.
   * Uses the injected summarizeFn if available, otherwise returns a fallback.
   */
  async _generateSummary(content, metrics) {
    const prompt =
      `Summarize the following agent conversation turns concisely. This summary will replace these turns in the conversation history.\n\n` +
      'Write the summary from a neutral perspective describing what the assistant did and learned. Include:\n' +
      '1. What actions the assistant took (tool calls, searches, file operations)\n' +
      '2. Key information or results obtained\n' +
      '3. Any important decisions or findings\n' +
      '4. Relevant data, file names, values, or outputs\n\n' +
      `Keep the summary factual and informative. Target approximately ${this.config.summaryTargetTokens} tokens.\n\n` +
      '---\n' +
      `TURNS TO SUMMARIZE:\n${content}\n` +
      '---\n\n' +
      'Write only the summary, starting with "[CONTEXT SUMMARY]:" prefix.';

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        metrics.summarizationApiCalls++;
        if (!this.summarizeFn) {
          throw new Error('No summarization function configured');
        }
        const summary = await this.summarizeFn(prompt, {
          model: this.config.summarizationModel,
          temperature: this.config.temperature,
          maxTokens: this.config.summaryTargetTokens * 2,
        });
        return TrajectoryCompressor._ensureSummaryPrefix(summary);
      } catch (error) {
        metrics.summarizationErrors++;
        if (attempt < this.config.maxRetries - 1) {
          await new Promise((r) => setTimeout(r, this.config.retryDelayMs * (attempt + 1)));
        } else {
          return '[CONTEXT SUMMARY]: [Summary generation failed - previous turns contained tool calls and responses that have been compressed to save context space.]';
        }
      }
    }
  }

  /**
   * Compress a single trajectory to fit within target token budget.
   */
  async compressTrajectory(trajectory) {
    const metrics = new TrajectoryMetrics();
    metrics.originalTurns = trajectory.length;

    const turnTokens = this.countTurnTokens(trajectory);
    const totalTokens = turnTokens.reduce((a, b) => a + b, 0);
    metrics.originalTokens = totalTokens;

    // Check if compression needed
    if (totalTokens <= this.config.targetMaxTokens) {
      metrics.skippedUnderTarget = true;
      metrics.compressedTokens = totalTokens;
      metrics.compressedTurns = trajectory.length;
      metrics.compressionRatio = 1.0;
      return { trajectory, metrics };
    }

    // Find protected regions
    let { compressibleStart, compressibleEnd } = this._findProtectedIndices(trajectory);

    // Snap head boundary
    compressibleStart = TrajectoryCompressor._snapBoundary(
      trajectory, compressibleStart, compressibleStart, compressibleEnd,
    );

    if (compressibleStart >= compressibleEnd) {
      metrics.compressedTokens = totalTokens;
      metrics.compressedTurns = trajectory.length;
      metrics.stillOverLimit = totalTokens > this.config.targetMaxTokens;
      return { trajectory, metrics };
    }

    // Calculate how much we need to save
    const tokensToSave = totalTokens - this.config.targetMaxTokens;
    const targetTokensToCompress = tokensToSave + this.config.summaryTargetTokens;

    // Accumulate turns from compressibleStart until we have enough savings
    let accumulatedTokens = 0;
    let compressUntil = compressibleStart;

    for (let i = compressibleStart; i < compressibleEnd; i++) {
      accumulatedTokens += turnTokens[i];
      compressUntil = i + 1;
      if (accumulatedTokens >= targetTokensToCompress) break;
    }

    // If we still don't have enough savings, compress the entire region
    if (accumulatedTokens < targetTokensToCompress && compressUntil < compressibleEnd) {
      compressUntil = compressibleEnd;
      accumulatedTokens = turnTokens
        .slice(compressibleStart, compressibleEnd)
        .reduce((a, b) => a + b, 0);
    }

    // Snap tail boundary
    compressUntil = TrajectoryCompressor._snapBoundary(
      trajectory, compressUntil, compressibleStart, compressibleEnd,
    );
    if (compressUntil <= compressibleStart) {
      metrics.compressedTokens = totalTokens;
      metrics.compressedTurns = trajectory.length;
      metrics.stillOverLimit = totalTokens > this.config.targetMaxTokens;
      return { trajectory, metrics };
    }

    // If region is no larger than the summary that would replace it, skip
    const regionTokens = turnTokens
      .slice(compressibleStart, compressUntil)
      .reduce((a, b) => a + b, 0);
    if (regionTokens <= this.config.summaryTargetTokens) {
      metrics.compressedTokens = totalTokens;
      metrics.compressedTurns = trajectory.length;
      metrics.stillOverLimit = totalTokens > this.config.targetMaxTokens;
      return { trajectory, metrics };
    }

    // Record compression region
    metrics.turnsCompressedStartIdx = compressibleStart;
    metrics.turnsCompressedEndIdx = compressUntil;
    metrics.turnsInCompressedRegion = compressUntil - compressibleStart;

    // Extract content for summary
    const contentToSummarize = this._extractTurnContentForSummary(
      trajectory, compressibleStart, compressUntil,
    );

    // Generate summary
    const summary = await this._generateSummary(contentToSummarize, metrics);

    // Build compressed trajectory
    const compressed = [];

    // Add head (turns before compression region)
    for (let i = 0; i < compressibleStart; i++) {
      const turn = { ...trajectory[i] };
      if (turn.from === 'system' && this.config.addSummaryNotice) {
        turn.value = turn.value + this.config.summaryNoticeText;
      }
      compressed.push(turn);
    }

    // Add summary as human message
    compressed.push({ from: 'human', value: summary });

    // Add tail (turns after compression region)
    for (let i = compressUntil; i < trajectory.length; i++) {
      compressed.push({ ...trajectory[i] });
    }

    // Calculate final metrics
    metrics.compressedTurns = compressed.length;
    metrics.compressedTokens = this.countTrajectoryTokens(compressed);
    metrics.turnsRemoved = metrics.originalTurns - metrics.compressedTurns;
    metrics.tokensSaved = metrics.originalTokens - metrics.compressedTokens;
    metrics.compressionRatio = metrics.compressedTokens / Math.max(metrics.originalTokens, 1);
    metrics.wasCompressed = true;
    metrics.stillOverLimit = metrics.compressedTokens > this.config.targetMaxTokens;

    return { trajectory: compressed, metrics };
  }

  /**
   * Process a single JSONL entry.
   */
  async processEntry(entry) {
    if (!entry.conversations) {
      return { entry, metrics: new TrajectoryMetrics() };
    }

    const { trajectory, metrics } = await this.compressTrajectory(entry.conversations);

    const result = { ...entry, conversations: trajectory };
    if (metrics.wasCompressed) {
      result.compression_metrics = metrics.toDict();
    }

    return { entry: result, metrics };
  }

  /**
   * Process all JSONL files in a directory.
   */
  async processDirectory(inputDir, outputDir) {
    const startTime = Date.now();
    const files = (await readdir(inputDir)).filter((f) => f.endsWith('.jsonl'));
    const results = {
      total_trajectories: 0,
      trajectories_compressed: 0,
      trajectories_skipped: 0,
      trajectories_failed: 0,
      total_tokens_before: 0,
      total_tokens_after: 0,
      total_tokens_saved: 0,
      total_turns_before: 0,
      total_turns_after: 0,
      total_turns_removed: 0,
      summarization_calls: 0,
      summarization_errors: 0,
      files_processed: files.length,
      processing_duration_ms: 0,
    };

    await mkdir(outputDir, { recursive: true, mode: 0o700 });

    for (const file of files) {
      const inputPath = join(inputDir, file);
      const outputPath = join(
        outputDir,
        file.replace(/\.jsonl$/, `${this.config.outputSuffix}.jsonl`),
      );

      const lines = (await readFile(inputPath, 'utf8'))
        .split('\n')
        .filter((l) => l.trim());

      const outputLines = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          results.total_trajectories++;

          const { entry: processed, metrics } = await this.processEntry(entry);

          results.total_tokens_before += metrics.originalTokens;
          results.total_tokens_after += metrics.compressedTokens;
          results.total_tokens_saved += metrics.tokensSaved;
          results.total_turns_before += metrics.originalTurns;
          results.total_turns_after += metrics.compressedTurns;
          results.total_turns_removed += metrics.turnsRemoved;
          results.summarization_calls += metrics.summarizationApiCalls;
          results.summarization_errors += metrics.summarizationErrors;

          if (metrics.wasCompressed) results.trajectories_compressed++;
          if (metrics.skippedUnderTarget) results.trajectories_skipped++;

          outputLines.push(JSON.stringify(processed));
        } catch (error) {
          results.trajectories_failed++;
        }
      }

      await writeFile(outputPath, outputLines.join('\n') + '\n', { mode: 0o600 });
    }

    results.processing_duration_ms = Date.now() - startTime;
    return results;
  }
}
