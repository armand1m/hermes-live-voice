import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import { voiceHarness } from './support/voice-harness.js';
import { readManagedConfig } from '../src/cli/managed-config.js';

async function roundTrip(env?: Record<string, string | undefined>) {
  const harness = await voiceHarness(env);
  const socket = new WebSocket(harness.url.replace('http:', 'ws:') + '/v1/live');
  const events: any[] = [];
  socket.on('message', raw => events.push(JSON.parse(raw.toString())));
  const wait = async (type: string) => {
    const deadline = Date.now() + 90000;
    while (!events.some(e => e.type === type)) {
      const failure = events.find(e => e.type === 'session.error');
      if (failure) throw new Error(JSON.stringify(failure));
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${type}: ${JSON.stringify(events)}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return events.find(e => e.type === type);
  };
  try {
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'session.start', protocolVersion: 6, conversation: { mode: 'new', title: `Voice contract ${randomUUID()}` } }));
    await wait('session.ready');
    const wav = await readFile(new URL('./fixtures/hello.wav', import.meta.url));
    const offset = wav.indexOf(Buffer.from('data'));
    const pcm = wav.subarray(offset + 8, offset + 8 + wav.readUInt32LE(offset + 4));
    for (let i = 0; i < pcm.length; i += 2400) socket.send(JSON.stringify({ type: 'audio.input', data: pcm.subarray(i, i + 2400).toString('base64'), mimeType: 'audio/pcm;rate=24000' }));
    const audio = await wait('audio.output');
    await wait('response.completed');
    expect(events).toContainEqual(expect.objectContaining({ type: 'transcript.delta', speaker: 'user', text: 'Hello. Please say hello back.' }));
    expect(audio.mimeType).toBe('audio/pcm;rate=24000');
    expect(Buffer.from(audio.data, 'base64').length).toBe(4800);
    expect(harness.observed.turns).toBe(1);
    // A response is scheduled only AFTER the real HermesClient HTTP chat result.
    expect(harness.observed.speechReplies[0].metadata.hermes_live_purpose).toMatch(/^conversation_(answer|summary)$/);
    if (!env) {
      expect(harness.observed.chats).toEqual(['Hello. Please say hello back.']);
      // The durable voice thread is created (POST) then chatted through, and
      // the context digest pulls the sessions list plus the skills catalog.
      expect(harness.observed.requests.some((request) => /^POST \/api\/sessions\/voice-contract-\d+\/chat$/u.test(request))).toBe(true);
      expect(harness.observed.requests.some((request) => request === 'POST /api/sessions')).toBe(true);
      expect(harness.observed.requests).toContain('GET /v1/skills');
    } else {
      // Errors also have spoken receipts: require successful agent output.
      const reply = harness.observed.speechReplies[0];
      if (reply.metadata.hermes_live_purpose === 'conversation_answer') {
        expect(reply.metadata.hermes_live_exact_speech.trim().length).toBeGreaterThan(0);
      } else {
        const text = reply.input[0].content[0].text;
        const result = JSON.parse(text.slice(text.indexOf('\n') + 1));
        expect(result.ok).toBe(true);
        expect(result.answer.trim().length).toBeGreaterThan(0);
      }
    }
  } finally { socket.terminate(); await harness.close(); }
}

it('boots an ephemeral gateway: PCM -> transcript -> Hermes HTTP chat -> PCM output', () => roundTrip(), 100000);

it('reaches the running HERMES_BASE_URL through the gateway (real agent HTTP contract)', async context => {
  const managed = await readManagedConfig().catch(() => ({ values: {} }));
  const env = { ...managed.values, ...process.env };
  const base = env.HERMES_BASE_URL ?? 'http://127.0.0.1:8642';
  try { await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) }); }
  catch { console.warn(`LIVE CONTRACT SKIPPED: Hermes is unavailable at ${base}`); context.skip(); return; }
  const key = env.HERMES_AGENT_API_SERVER_KEY ?? env.HERMES_API_KEY;
  if (!key) { console.warn('LIVE CONTRACT SKIPPED: configure HERMES_AGENT_API_SERVER_KEY for the running Hermes API'); context.skip(); return; }
  await roundTrip({ HERMES_BASE_URL: base, HERMES_AGENT_API_SERVER_KEY: key });
}, 100000);
