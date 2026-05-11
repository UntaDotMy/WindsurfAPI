import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'windsurfapi-codex-'));

const sticky = await import('../src/sticky-sessions.js');
const runtime = await import('../src/runtime-config.js');
const ws = await import('../src/ws-responses.js');

test('Codex sticky context prefers turn-state headers in auto mode', () => {
  runtime.setCodexSettings({
    stickySessionsEnabled: true,
    stickySessionMode: 'auto',
    derivePromptCacheKey: true,
    promptCacheMaxAgeSeconds: 1800,
  });
  const ctx = sticky.buildStickyContext(
    { model: 'gpt-5.4', input: 'hello', prompt_cache_key: 'pc-1' },
    { 'x-codex-turn-state': 'turn-abc' },
    'api:test',
  );
  assert.equal(ctx.kind, 'codex_session');
  assert.equal(ctx.key, 'turn-abc');
});

test('Codex sticky store preserves prompt-cache mapping during fallback', () => {
  sticky.clearStickySessions();
  runtime.setCodexSettings({
    stickySessionsEnabled: true,
    stickySessionMode: 'prompt_cache',
    derivePromptCacheKey: false,
    reallocateSticky: false,
  });
  const ctx = sticky.buildStickyContext({ model: 'gpt-5.4', input: 'hello', prompt_cache_key: 'pc-2' }, {}, 'api:test');
  assert.ok(ctx);
  assert.equal(sticky.getStickyAccountId(ctx), null);
  assert.equal(sticky.bindStickyAccount(ctx, 'acct-a'), true);
  assert.equal(sticky.getStickyAccountId(ctx), 'acct-a');
  assert.equal(sticky.shouldPreserveStickyFallback(ctx, 'acct-a', 'acct-b'), true);
  assert.equal(sticky.bindStickyAccount(ctx, 'acct-b', { preserveExisting: true }), false);
  assert.equal(sticky.getStickyAccountId(ctx), 'acct-a');
});

test('Responses WebSocket accepts response.create wrapper and forces streaming', () => {
  const normalized = ws._test.normalizeResponseCreatePayload({
    type: 'response.create',
    response: {
      model: 'gpt-5.4',
      input: 'hello',
      stream: false,
    },
  });
  assert.deepEqual(normalized, {
    model: 'gpt-5.4',
    input: 'hello',
    stream: true,
  });
});
