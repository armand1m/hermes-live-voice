import { expect, it } from 'vitest';
import { PcmVoiceActivityDetector } from '../clients/browser/hermes-live-client.js';

it('detects PCM speech boundaries, ignores clicks, keeps pauses inside turns, and rearms', () => {
  const vad = new PcmVoiceActivityDetector(24000);
  const silence = new Int16Array(1200);
  const speech = Int16Array.from({ length: 1200 }, (_, i) => Math.sin(i * 0.08) * 8000);
  expect(vad.process(silence).active).toBe(false);
  expect(vad.process(speech).started).toBe(false); // 50ms click is insufficient
  expect(vad.process(silence).active).toBe(false);
  vad.process(speech);
  expect(vad.process(speech)).toMatchObject({ active: true, started: true });
  for (let i = 0; i < 10; i++) expect(vad.process(silence).stopped).toBe(false);
  expect(vad.process(speech).active).toBe(true); // pause does not split turn
  for (let i = 0; i < 19; i++) expect(vad.process(silence).stopped).toBe(false);
  expect(vad.process(silence)).toMatchObject({ active: false, stopped: true });
  expect(vad.process(silence).stopped).toBe(false);
  vad.process(speech);
  expect(vad.process(speech).started).toBe(true);
});
