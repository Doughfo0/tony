import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { LiveKitAPI } from 'livekit-server-sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(here, '.env.local');

if (existsSync(envPath)) {
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
}

const config = {
  port: Number(process.env.PORT || 8787),
  livekitUrl: process.env.LIVEKIT_URL || '',
  livekitApiKey: process.env.LIVEKIT_API_KEY || '',
  livekitApiSecret: process.env.LIVEKIT_API_SECRET || '',
  trunkId: process.env.LIVEKIT_SIP_TRUNK_ID || '',
  deviceToken: process.env.TONY_CALL_API_TOKEN || '',
  allowedOrigins: new Set((process.env.CORS_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean)),
};

const rateLimit = new Map();
const idempotency = new Map();
const api = hasLiveKitConfig()
  ? new LiveKitAPI({ host: config.livekitUrl, apiKey: config.livekitApiKey, secret: config.livekitApiSecret })
  : null;

function hasLiveKitConfig() {
  return Boolean(config.livekitUrl && config.livekitApiKey && config.livekitApiSecret && config.trunkId);
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function setCors(request, response) {
  const origin = request.headers.origin;
  if (origin && config.allowedOrigins.has(origin)) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'Origin');
  }
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  response.setHeader('access-control-allow-headers', 'authorization, content-type');
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4096) throw new Error('Request body too large');
  }
  return body ? JSON.parse(body) : {};
}

function verifyDeviceToken(token) {
  if (!config.deviceToken || config.deviceToken.startsWith('replace-')) return false;
  const received = Buffer.from(token);
  const expected = Buffer.from(config.deviceToken);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function allowCall(clientId, callId) {
  const now = Date.now();
  for (const [key, until] of idempotency) if (until <= now) idempotency.delete(key);
  const idempotencyKey = `${clientId}:${callId}`;
  if (idempotency.has(idempotencyKey)) return { duplicate: true };

  const recent = (rateLimit.get(clientId) || []).filter((at) => now - at < 10 * 60 * 1000);
  if (recent.length >= 5) return { limited: true };
  recent.push(now);
  rateLimit.set(clientId, recent);
  idempotency.set(idempotencyKey, now + 10 * 60 * 1000);
  return { duplicate: false };
}

const server = createServer(async (request, response) => {
  setCors(request, response);
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url || '/', 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/health') {
    json(response, 200, {
      ok: true,
      configured: Boolean(api && !config.deviceToken.startsWith('replace-') && config.deviceToken.length >= 32),
      outboundTrunkConfigured: Boolean(config.trunkId),
    });
    return;
  }

  if (request.method !== 'POST' || url.pathname !== '/api/calls/incoming') {
    json(response, 404, { error: 'not_found' });
    return;
  }

  const match = request.headers.authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    json(response, 401, { error: 'authentication_required' });
    return;
  }

  let body;
  try {
    body = await readJson(request);
  } catch {
    json(response, 400, { error: 'invalid_request' });
    return;
  }
  const callId = typeof body.callId === 'string' ? body.callId : '';
  const destination = typeof body.phoneNumber === 'string' ? body.phoneNumber : '';
  if (!/^[a-zA-Z0-9_-]{6,80}$/.test(callId)) {
    json(response, 400, { error: 'invalid_call_id' });
    return;
  }
  if (!/^\+[1-9]\d{7,14}$/.test(destination)) {
    json(response, 400, { error: 'invalid_phone_number' });
    return;
  }

  if (!verifyDeviceToken(match[1])) {
    json(response, 401, { error: 'invalid_device_token' });
    return;
  }

  if (!api || config.deviceToken.length < 32 || config.deviceToken.startsWith('replace-')) {
    json(response, 503, { error: 'outbound_call_not_configured' });
    return;
  }

  const clientId = request.socket.remoteAddress || 'unknown-device';
  const allowed = allowCall(clientId, callId);
  if (allowed.duplicate) {
    json(response, 200, { status: 'already_requested', callId });
    return;
  }
  if (allowed.limited) {
    json(response, 429, { error: 'outbound_call_rate_limited' });
    return;
  }

  const roomName = `tony-${callId}`;
  try {
    const participant = await api.sip.createSipParticipant(
      config.trunkId,
      destination,
      roomName,
      {
        participantIdentity: `tony-${callId}`,
        participantName: 'Tony outbound call',
        waitUntilAnswered: false,
      },
    );
    json(response, 202, { status: 'dialing', callId, roomName, participantIdentity: participant.participantIdentity });
  } catch (error) {
    console.error('LiveKit outbound call failed:', error instanceof Error ? error.message : 'unknown error');
    json(response, 502, { error: 'outbound_call_failed' });
  }
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`Tony call API listening on port ${config.port}`);
  console.log(`LiveKit dial-out configuration: ${api && config.trunkId && config.deviceToken.length >= 32 ? 'ready' : 'incomplete'}`);
});
