import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { loadConfig } from '../../src/config.js';
import { startServer } from '../../src/adapters/inbound/http/server.js';
import { PcmVoiceActivityDetector } from '../../clients/browser/hermes-live-client.js';

export async function voiceHarness(hermesEnv?: Record<string, string | undefined>) {
  const observed = { audioFrames: 0, turns: 0, chats: [] as string[], requests: [] as string[], speechReplies: [] as any[] };
  const sessions = new Map<string, { id: string; title?: string; model: string; last_active: number }>();
  const upstream = createServer(async (req, res) => {
    observed.requests.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    const reply = (value: unknown) => res.end(JSON.stringify(value));
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /v1/capabilities') return reply({ object: 'hermes.capabilities', model: 'hermes-agent', features: Object.fromEntries(['run_submission','run_status','run_events_sse','run_stop','run_approval_response','session_resources','session_chat','session_chat_streaming','model_options','session_model_lock','skills_api'].map(k => [k,true])) });
    if (route === 'GET /api/model/options') return reply({ model: 'test-llm', provider: 'test' });
    if (route === 'GET /v1/skills') {
      return reply({ object: 'list', data: [{ name: 'release-notes', category: 'devops', description: 'Draft release notes' }] });
    }
    if (route === 'GET /api/sessions') {
      const title = url.searchParams.get('title') ?? undefined;
      const data = [...sessions.values()]
        .filter((session) => title === undefined || session.title === title)
        .sort((left, right) => right.last_active - left.last_active)
        .map((session) => ({ ...session, preview: 'Voice conversation', message_count: 1 }));
      return reply({ object: 'list', data });
    }
    if (route === 'POST /api/sessions') {
      let body = ''; for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      const session = { id: `voice-contract-${sessions.size + 1}`, ...(parsed.title ? { title: parsed.title } : {}), model: parsed.model ?? 'test-llm', last_active: Date.now() };
      sessions.set(session.id, session);
      return reply({ object: 'hermes.session', session: { ...session } });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/chat')) {
      let body = ''; for await (const chunk of req) body += chunk;
      observed.chats.push(JSON.parse(body).message);
      return reply({ object: 'hermes.session.chat.completion', session_id: url.pathname.split('/')[3], message: { role: 'assistant', content: 'Hello from Hermes.' } });
    }
    res.statusCode = 404; return reply({ error: 'unexpected request' });
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const speech = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(speech, 'listening');
  speech.on('connection', ws => {
    const send = (event: unknown) => ws.send(JSON.stringify(event));
    const vad = new PcmVoiceActivityDetector(24000, { silenceMs: 700 });
    send({ type: 'session.created', session: { id: 'speech-contract' } });
    ws.on('message', raw => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'input_audio_buffer.append') {
        observed.audioFrames++;
        const pcm = Buffer.from(event.audio, 'base64');
        const samples = new Int16Array(pcm.length / 2);
        for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2);
        const activity = vad.process(samples);
        if (activity.started) send({ type: 'input_audio_buffer.speech_started' });
        if (activity.stopped) {
          observed.turns++;
          send({ type: 'input_audio_buffer.speech_stopped' });
          send({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hello. Please say hello back.' });
        }
      }
      if (event.type === 'response.create') {
        observed.speechReplies.push(event.response);
        send({ type: 'response.created', response: { id: 'reply' } });
        send({ type: 'response.output_audio.delta', delta: Buffer.alloc(4800, 1).toString('base64'), item_id: 'reply-audio', content_index: 0 });
        send({ type: 'response.output_audio_transcript.done', transcript: 'Hello from Hermes.' });
        send({ type: 'response.done', response: { id: 'reply', status: 'completed' } });
      }
    });
  });
  const directory = await mkdtemp(join(tmpdir(), 'voice-contract-'));
  const config = loadConfig({
    HERMES_BASE_URL: `http://127.0.0.1:${(upstream.address() as any).port}`,
    HERMES_AGENT_API_SERVER_KEY: 'test-key', ...hermesEnv,
    HERMES_LIVE_PROVIDER: 'local', HERMES_LIVE_LOCAL_OWNS_TURN_ROUTING: 'true',
    HERMES_LIVE_LOCAL_URL: `ws://127.0.0.1:${(speech.address() as any).port}/v1/realtime`,
    HERMES_LIVE_TASK_STATE_FILE: join(directory, 'tasks.json'),
    // Keep the e2e digest deterministic: an empty Hermes home skips the
    // memory-file sections instead of reading this machine's real files.
    HERMES_LIVE_HERMES_HOME: join(directory, 'hermes-home'),
  });
  config.server.port = 0;
  let gateway: Awaited<ReturnType<typeof startServer>> | undefined;
  const close = async () => {
    await gateway?.close();
    for (const ws of speech.clients) ws.terminate();
    await new Promise<void>(resolve => speech.close(() => resolve()));
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    gateway = await startServer({ config, logger: { info() {}, warn(message, data) { console.warn(message, data); }, error() {}, debug() {} } });
    return { url: gateway.url, observed, close };
  } catch (error) { await close(); throw error; }
}
