// Codex / Responses regression: GPT-backed Cascade sometimes says
// "I'll inspect the repository..." without emitting a tool-call protocol
// block. The streaming path must retry with a correction prompt instead of
// ending the agent loop with plain text and finish_reason=stop.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHAT_JS = readFileSync(join(__dirname, '..', 'src/handlers/chat.js'), 'utf8');

describe('Codex narrated tool retry', () => {
  test('stream path holds emulated tool narration until it knows no tool call exists', () => {
    assert.match(CHAT_JS, /const holdEmulatedToolNarrative = emulateTools[\s\S]{0,220}?isNluRetryEnabled\(provider, modelKey, deps\.route \|\| 'chat'\)/,
      'stream path must enable holdback for Codex/GPT tool-emulated turns');
    assert.match(CHAT_JS, /if \(wantJson \|\| holdEmulatedToolNarrative\) return;/,
      'content deltas must not be sent before the tool/no-tool decision');
    assert.match(CHAT_JS, /if \(holdEmulatedToolNarrative\) return;\s+send\(\{ id, object: 'chat\.completion\.chunk'[\s\S]{0,140}?reasoning_content/s,
      'reasoning deltas must also be held to avoid visible narration before tool_calls');
    assert.match(CHAT_JS, /dropping because tool_calls were emitted[\s\S]{0,120}?accText = '';[\s\S]{0,80}?accThinking = '';/,
      'held narration must be dropped when retry/recovery emits tool_calls');
  });

  test('stream path performs a correction retry before finalizing narrate-only tool turns', () => {
    const start = CHAT_JS.indexOf('Chat[stream]: emulateTools=true but parser found 0 tool_calls');
    const end = CHAT_JS.indexOf('fabricate detection on stream tail', start);
    assert.ok(start > -1 && end > start, 'stream narrate-only diagnostic/recovery region not found');
    const region = CHAT_JS.slice(start, end);

    assert.match(region, /isNluRetryEnabled\(provider, modelKey, deps\.route \|\| 'chat'\)/,
      'stream path must gate correction retry with the shared NLU retry default');
    assert.match(region, /detectToolIntentInNarrative\(accNarrative, declaredTools/,
      'stream path must detect action-only narration such as "I will inspect..."');
    assert.match(region, /await client\.cascadeChat\(correctionMessages/,
      'stream path must spend a second Cascade pass with an explicit correction prompt');
    assert.match(region, /parseToolCallsFromText\(retryText/,
      'stream retry output must be parsed as tool-call protocol');
    assert.match(region, /emitToolCallDelta\(tc, idx\)/,
      'stream retry must emit OpenAI-compatible tool_call deltas');
    assert.match(region, /synthesizeToolCallFromIntent\(intendedTool, declaredTools/,
      'stream retry must synthesize a safe inventory call if the correction pass still narrates');
  });
});
