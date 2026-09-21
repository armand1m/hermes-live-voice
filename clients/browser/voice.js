import { HermesLiveClient, HermesLiveAudio, HermesVoiceVisualizer } from './hermes-live-client.js';
const state = document.querySelector('#state');
const detail = document.querySelector('#detail');
const mute = document.querySelector('#mute');
// Optional operator-supplied token stays in memory, never in HTML or storage.
const token = new URLSearchParams(location.hash.slice(1)).get('token') || undefined;
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
// The bundled page may be mounted at /voice (for example through Tailscale
// Serve). Keep the WebSocket on that same mount instead of falling back to
// the host's unrelated root service.
const mountPath = location.pathname.endsWith('/')
  ? location.pathname.slice(0, -1)
  : location.pathname;
const url = new URL(`${mountPath}/v1/live`, location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const client = new HermesLiveClient({ url: url.href, token, conversation: { mode: 'new' } });
const audio = new HermesLiveAudio(client, { workletUrl: `${mountPath}/mic-worklet.js` });
const visualizer = new HermesVoiceVisualizer(document.querySelector('#field'), audio, client);
function status(value, text) { state.dataset.state = value; state.textContent = text; }
function error(event) { status('error', 'Voice needs attention'); detail.textContent = event.error?.message || event.message || String(event); }
client.on('error', error); audio.on('error', error);
client.on('session.error', error);
client.on('close', () => { status('offline', 'Disconnected'); mute.disabled = true; });
audio.on('microphone', event => {
  mute.textContent = event.active ? 'Mute' : 'Unmute';
  mute.setAttribute('aria-pressed', String(!event.active));
  if (event.active) { status('armed', 'Listening'); detail.textContent = 'Talk naturally. I’ll hear when you finish.'; }
  else if (event.state === 'idle') status('muted', 'Microphone muted');
});
client.on('audio.output', event => void audio.play(event).catch(error));
client.on('input.speech_started', () => audio.clearPlayback());
client.on('input.pause_requested', () => void audio.stopMicrophone({ endTurn: false }));
let current;
client.on('transcript.delta', event => {
  if (!current || current.dataset.speaker !== event.speaker || current.dataset.final === 'true') {
    current = document.createElement('p'); current.dataset.speaker = event.speaker;
    document.querySelector('#transcript').append(current);
    while (document.querySelector('#transcript').children.length > 100) document.querySelector('#transcript').firstChild.remove();
  }
  // Final provider transcripts are authoritative, not an additional delta.
  current.textContent = event.final ? event.text : current.textContent + event.text;
  current.dataset.final = String(Boolean(event.final));
  current.scrollIntoView({ block: 'nearest' });
});
mute.addEventListener('click', async () => {
  mute.disabled = true;
  try {
    if (audio.microphoneActive) await audio.stopMicrophone({ endTurn: true });
    else { await audio.primePlayback(); await audio.startMicrophone(); }
  } catch (e) { error(e); } finally { mute.disabled = !client.connected; }
});
try {
  await client.connect();
  mute.disabled = false;
  await audio.startMicrophone();
} catch (e) { error(e); mute.textContent = 'Unmute'; }
window.addEventListener('pagehide', () => { visualizer.dispose(); void audio.dispose(); void client.disconnect(); }, { once: true });
