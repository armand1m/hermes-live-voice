import { HermesLiveClient, HermesLiveAudio, HermesVoiceVisualizer } from './hermes-live-client.js';
const state = document.querySelector('#state');
const detail = document.querySelector('#detail');
const mute = document.querySelector('#mute');
const taskList = document.querySelector('#tasks');
const taskCount = document.querySelector('#task-count');
// The operator can bootstrap a tab with #token=... once. Keep it only in
// sessionStorage so reloads do not require the secret again, while closing
// the tab clears the credential. Never use localStorage or put it in HTML.
const tokenKey = 'hermes-live-auth-token';
const conversationKey = 'hermes-live-conversation-id';
const hashToken = new URLSearchParams(location.hash.slice(1)).get('token')?.trim();
let token;
let rememberedConversation;
try {
  if (hashToken) sessionStorage.setItem(tokenKey, hashToken);
  token = hashToken || sessionStorage.getItem(tokenKey) || undefined;
  const sessionId = sessionStorage.getItem(conversationKey)?.trim();
  if (sessionId) rememberedConversation = { mode: 'resume', sessionId };
} catch {
  token = hashToken || undefined;
}
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
// The bundled page may be mounted at /voice (for example through Tailscale
// Serve). Keep the WebSocket on that same mount instead of falling back to
// the host's unrelated root service.
const mountPath = location.pathname.endsWith('/')
  ? location.pathname.slice(0, -1)
  : location.pathname;
const url = new URL(`${mountPath}/v1/live`, location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const client = new HermesLiveClient({ url: url.href, token, conversation: rememberedConversation || { mode: 'new' } });
const audio = new HermesLiveAudio(client, { workletUrl: `${mountPath}/mic-worklet.js` });
const visualizer = new HermesVoiceVisualizer(document.querySelector('#field'), audio, client);
function status(value, text) { state.dataset.state = value; state.textContent = text; }
function error(event) { status('error', 'Voice needs attention'); detail.textContent = event.error?.message || event.message || String(event); }
client.on('error', error); audio.on('error', error);
client.on('session.error', error);
client.on('session.ready', event => {
  const sessionId = event.conversation?.sessionId;
  if (!sessionId) return;
  try { sessionStorage.setItem(conversationKey, sessionId); } catch { /* storage may be blocked */ }
});
client.on('close', () => { status('offline', 'Disconnected'); mute.disabled = true; });
function renderTasks(tasks = []) {
  taskCount.textContent = tasks.length ? `${tasks.length} task${tasks.length === 1 ? '' : 's'}` : 'No tasks';
  if (!tasks.length) { taskList.innerHTML = '<p class="tasks-empty">Tasks delegated by voice will appear here.</p>'; return; }
  taskList.replaceChildren(...tasks.slice(0, 20).map(task => {
    const card = document.createElement('article'); card.className = 'task-card'; card.dataset.state = task.state;
    const title = document.createElement('strong'); title.textContent = task.title || `Task ${task.taskId.slice(0, 8)}`;
    const state = document.createElement('span'); state.className = 'task-state'; state.textContent = task.state;
    const detail = document.createElement('p'); detail.textContent = task.progress?.message || task.result?.summary || task.error?.message || (task.state === 'running' ? 'Working…' : '');
    card.append(title, state, detail);
    if (task.error?.message && /approval|permission|authorize|pending/i.test(task.error.message)) {
      const notice = document.createElement('em'); notice.textContent = 'Needs your approval in the Hermes dashboard'; card.append(notice);
    }
    return card;
  }));
}
client.on('tasks.changed', ({ tasks, activeTasks }) => {
  renderTasks(tasks);
  if (activeTasks.length && !audio.speechActive && !audio.playbackSources.size) {
    status('waiting', 'Working in the background');
    detail.textContent = `${activeTasks.length} task${activeTasks.length === 1 ? '' : 's'} still running. You can keep talking.`;
  }
});
audio.on('microphone', event => {
  mute.textContent = event.active ? 'Mute' : 'Unmute';
  mute.setAttribute('aria-pressed', String(!event.active));
  if (event.active) { status('armed', 'Listening'); detail.textContent = 'Talk naturally. I’ll hear when you finish.'; }
  else if (event.state === 'idle') status('muted', 'Microphone muted');
});
client.on('audio.output', event => void audio.play(event).catch(error));
client.on('input.speech_started', () => audio.clearPlayback());
client.on('input.pause_requested', () => void audio.stopMicrophone({ endTurn: false }).catch(() => undefined));
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
} catch (e) {
  // A deleted or expired saved chat should not strand the standalone console.
  // Clear only the remembered conversation and start a fresh one once.
  if (rememberedConversation) {
    try { sessionStorage.removeItem(conversationKey); } catch { /* storage may be blocked */ }
    rememberedConversation = undefined;
    try {
      await client.connect({ conversation: { mode: 'new' } });
      mute.disabled = false;
      await audio.startMicrophone();
    } catch (retryError) { error(retryError); mute.textContent = 'Unmute'; }
  } else { error(e); mute.textContent = 'Unmute'; }
}
window.addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  visualizer.dispose(); void audio.dispose(); void client.disconnect();
}, { once: true });
