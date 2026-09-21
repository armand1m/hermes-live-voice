import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { voiceHarness } from '../test/support/voice-harness.js';

test.use({
  permissions: ['microphone'],
  launchOptions: { args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    `--use-file-for-fake-audio-capture=${fileURLToPath(new URL('../test/fixtures/hello.wav', import.meta.url))}`,
  ] },
});

test('page load arms continuous capture and a spoken PCM fixture reaches the transcript without a click', async ({ page }) => {
  const harness = await voiceHarness();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(harness.url);
    await expect(page.locator('#state')).toHaveAttribute('data-state', 'armed');
    await expect(page.locator('[data-speaker="user"]').first()).toContainText('Hello. Please say hello back.', { timeout: 20000 });
    await expect(page.locator('[data-speaker="assistant"]').first()).toContainText('Hello from Hermes.');
    expect(harness.observed.audioFrames).toBeGreaterThan(10);
    expect(harness.observed.chats[0]).toBe('Hello. Please say hello back.');
    await expect(page.getByRole('button')).toHaveCount(1);
    await page.getByRole('button', { name: 'Mute', exact: true }).click();
    await expect(page.locator('#state')).toHaveAttribute('data-state', 'muted');
    const frames = harness.observed.audioFrames;
    await page.waitForTimeout(350);
    expect(harness.observed.audioFrames).toBe(frames);
    await page.getByRole('button', { name: 'Unmute', exact: true }).click();
    await expect(page.locator('#state')).toHaveAttribute('data-state', 'armed');
    expect(errors).toEqual([]);
  } finally { await page.close(); await harness.close(); }
});

test('reduced motion still renders an accessible idle field', async ({ page }) => {
  const harness = await voiceHarness();
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(harness.url);
    await expect(page.locator('#state')).toHaveAttribute('data-state', 'armed');
    await expect(page.locator('canvas')).toHaveAttribute('data-state', /idle|listening|thinking|speaking/);
    expect(await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBeGreaterThan(0);
  } finally { await page.close(); await harness.close(); }
});
