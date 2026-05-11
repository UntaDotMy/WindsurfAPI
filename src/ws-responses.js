/**
 * Minimal Codex/OpenAI Responses WebSocket facade.
 *
 * Upstream Windsurf is still served through the existing HTTP/SSE Responses
 * adapter. This layer speaks downstream WebSocket so Codex-style clients can
 * send `response.create` frames and receive Responses event JSON frames.
 */

import { createHash, randomUUID } from 'crypto';
import { handleResponses } from './handlers/responses.js';
import { validateApiKey, isAuthenticated } from './auth.js';
import { callerKeyFromRequest } from './caller-key.js';
import { getCodexSettings } from './runtime-config.js';
import { log } from './config.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_PATHS = new Set([
  '/v1/responses',
  '/v1/ws/responses',
  '/backend-api/codex/responses',
]);

function extractToken(req) {
  const authHeader = String(req.headers['authorization'] || '').trim();
  if (authHeader && authHeader.includes(',')) return '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return req.headers['x-api-key'] || '';
}

function httpReject(socket, status, message) {
  const body = JSON.stringify({ error: { message } });
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n`
    + 'Content-Type: application/json\r\n'
    + `Content-Length: ${Buffer.byteLength(body)}\r\n`
    + 'Connection: close\r\n\r\n'
    + body
  );
  socket.destroy();
}

function acceptKey(secKey) {
  return createHash('sha1').update(secKey + WS_GUID).digest('base64');
}

function sendFrame(socket, opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, body]));
}

function sendText(socket, payload) {
  sendFrame(socket, 0x1, typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function sendClose(socket, code = 1000, reason = '') {
  const reasonBuf = Buffer.from(String(reason));
  const payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(code, 0);
  reasonBuf.copy(payload, 2);
  try { sendFrame(socket, 0x8, payload); } catch {}
  socket.end();
}

function parseFrames(state, chunk) {
  state.buffer = state.buffer.length ? Buffer.concat([state.buffer, chunk]) : chunk;
  const frames = [];
  while (state.buffer.length >= 2) {
    const b0 = state.buffer[0];
    const b1 = state.buffer[1];
    const opcode = b0 & 0x0f;
    const masked = !!(b1 & 0x80);
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (state.buffer.length < offset + 2) break;
      len = state.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (state.buffer.length < offset + 8) break;
      const big = state.buffer.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame too large');
      len = Number(big);
      offset += 8;
    }
    const maskOffset = offset;
    if (masked) offset += 4;
    if (state.buffer.length < offset + len) break;
    let payload = state.buffer.subarray(offset, offset + len);
    if (masked) {
      const mask = state.buffer.subarray(maskOffset, maskOffset + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    frames.push({ opcode, payload });
    state.buffer = state.buffer.subarray(offset + len);
  }
  return frames;
}

function normalizeResponseCreatePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.type && payload.type !== 'response.create') return null;
  const source = payload.response && typeof payload.response === 'object'
    ? payload.response
    : payload;
  const out = { ...source };
  delete out.type;
  delete out.event_id;
  out.stream = true;
  return out.input == null ? null : out;
}

function createSseToWebSocketSink(socket) {
  const listeners = new Map();
  let pending = '';
  const fire = (event) => {
    const cbs = listeners.get(event) || [];
    for (const cb of cbs) { try { cb(); } catch {} }
  };
  const feed = (chunk) => {
    pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx;
    while ((idx = pending.indexOf('\n\n')) !== -1) {
      const frame = pending.slice(0, idx);
      pending = pending.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data && data !== '[DONE]') sendText(socket, data);
      }
    }
  };
  return {
    writableEnded: false,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    setHeader() {},
    write(chunk) { if (!this.writableEnded) feed(chunk); return true; },
    end(chunk) {
      if (this.writableEnded) return;
      if (chunk) feed(chunk);
      this.writableEnded = true;
      fire('close');
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
    once(event, cb) {
      const wrapped = (...args) => { this.off(event, wrapped); cb(...args); };
      return this.on(event, wrapped);
    },
    off(event, cb) {
      const arr = listeners.get(event);
      if (arr) {
        const i = arr.indexOf(cb);
        if (i !== -1) arr.splice(i, 1);
      }
      return this;
    },
    removeListener(event, cb) { return this.off(event, cb); },
    _clientDisconnected() { fire('close'); },
  };
}

async function handleResponseCreate(socket, req, payload, context) {
  const responsesPayload = normalizeResponseCreatePayload(payload);
  if (!responsesPayload) {
    sendText(socket, {
      type: 'response.failed',
      response: {
        status: 'failed',
        error: { type: 'invalid_request_error', message: 'Expected response.create with input' },
      },
    });
    return;
  }

  const result = await handleResponses(responsesPayload, { context });
  if (!result.stream) {
    if (result.status >= 400) {
      sendText(socket, {
        type: 'response.failed',
        response: {
          status: 'failed',
          error: result.body?.error || { type: 'upstream_error', message: 'Request failed' },
        },
      });
    } else {
      sendText(socket, { type: 'response.completed', response: result.body });
    }
    return;
  }
  const sink = createSseToWebSocketSink(socket);
  socket.once('close', () => sink._clientDisconnected());
  await result.handler(sink);
}

export function handleResponsesWebSocketUpgrade(req, socket, head) {
  const path = String(req.url || '').split('?')[0];
  if (!WS_PATHS.has(path)) return false;

  const settings = getCodexSettings();
  if (!settings.websocketEnabled) {
    httpReject(socket, 403, 'Responses WebSocket disabled');
    return true;
  }
  if (!validateApiKey(extractToken(req))) {
    httpReject(socket, 401, 'Unauthorized');
    return true;
  }
  if (!isAuthenticated()) {
    httpReject(socket, 503, 'No active accounts');
    return true;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    httpReject(socket, 400, 'Missing Sec-WebSocket-Key');
    return true;
  }
  const turnState = String(req.headers['x-codex-turn-state'] || '').trim() || `turn_${randomUUID().replace(/-/g, '')}`;
  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    `x-codex-turn-state: ${turnState}`,
    '\r\n',
  ];
  socket.write(responseHeaders.join('\r\n'));

  const headers = { ...req.headers, 'x-codex-turn-state': turnState };
  const context = {
    callerKey: callerKeyFromRequest(req, extractToken(req), null),
    headers,
  };
  const state = { buffer: Buffer.alloc(0), busy: Promise.resolve() };
  if (head && head.length) state.buffer = Buffer.from(head);

  socket.on('data', (chunk) => {
    try {
      for (const frame of parseFrames(state, chunk)) {
        if (frame.opcode === 0x8) return sendClose(socket);
        if (frame.opcode === 0x9) { sendFrame(socket, 0xA, frame.payload); continue; }
        if (frame.opcode !== 0x1) continue;
        const text = frame.payload.toString('utf8');
        let payload;
        try { payload = JSON.parse(text); } catch {
          sendText(socket, { type: 'error', error: { message: 'Invalid JSON', type: 'invalid_request_error' } });
          continue;
        }
        state.busy = state.busy
          .then(() => handleResponseCreate(socket, req, payload, context))
          .catch((e) => {
            log.error(`Responses WS error: ${e.message}`);
            sendText(socket, {
              type: 'response.failed',
              response: { status: 'failed', error: { type: 'server_error', message: e.message } },
            });
          });
      }
    } catch (e) {
      log.warn(`Responses WS parse error: ${e.message}`);
      sendClose(socket, 1002, 'Protocol error');
    }
  });
  socket.on('error', () => {});
  return true;
}

export const _test = {
  normalizeResponseCreatePayload,
  parseFrames,
  sendFrame,
};
