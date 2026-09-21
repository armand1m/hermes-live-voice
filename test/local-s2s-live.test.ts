import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { expect, it } from 'vitest';
import { HuggingFaceRealtimeAdapter } from '../src/adapters/outbound/realtime/huggingface-realtime.adapter.js';
import type { LiveModelEvent } from '../src/application/live-gateway/ports/realtime-model.port.js';

it('contracts with local S2S: session, VAD, real transcription and PCM reply', async context => {
  const url = new URL(process.env.HERMES_LIVE_LOCAL_URL ?? 'ws://127.0.0.1:8765/v1/realtime');
  const reachable = await new Promise<boolean>(resolve => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port || (url.protocol === 'wss:' ? 443 : 80)) });
    const finish = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(1000, () => finish(false)); socket.once('error', () => finish(false)); socket.once('connect', () => finish(true));
  });
  if (!reachable) { console.warn(`LIVE CONTRACT SKIPPED: local S2S is down at ${url.origin}`); context.skip(); return; }
  const events: LiveModelEvent[] = [];
  const errors: unknown[] = [];
  const session = await new HuggingFaceRealtimeAdapter({ url: url.href, voice: 'Aiden', allowRemote: false, ownsTurnRouting: false }).connect({
    sessionId: 'live-audio-contract', systemInstruction: 'Reply to the greeting in one short sentence. Do not call tools.', availableTools: [],
    callbacks: { onEvent: e => events.push(e), onError: e => errors.push(e) },
  });
  try {
    const wav = await readFile(new URL('./fixtures/hello.wav', import.meta.url));
    const offset = wav.indexOf(Buffer.from('data'));
    const pcm = wav.subarray(offset + 8, offset + 8 + wav.readUInt32LE(offset + 4));
    for (let i = 0; i < pcm.length; i += 2400) {
      await session.sendRealtimeAudio({ data: pcm.subarray(i, i + 2400).toString('base64'), mimeType: 'audio/pcm;rate=24000' });
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await expect.poll(() => events.some(e => e.type === 'response' && e.status === 'completed'), { timeout: 60000 }).toBe(true);
    expect(errors).toEqual([]);
    expect(events.some(e => e.type === 'input_speech_started')).toBe(true);
    expect(events.some(e => e.type === 'input_speech_stopped')).toBe(true);
    expect(events.some(e => e.type === 'text' && e.speaker === 'user' && /hello/i.test(e.text))).toBe(true);
    const audio = events.find(e => e.type === 'audio');
    expect(audio?.type === 'audio' && audio.audio.mimeType).toBe('audio/pcm;rate=24000');
    expect(audio?.type === 'audio' && Buffer.from(audio.audio.data, 'base64').length).toBeGreaterThan(0);
  } finally { await session.close(); }
}, 100000);
