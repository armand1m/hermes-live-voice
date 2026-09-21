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
    await page.locator('#log-toggle').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#log-drawer')).toBeVisible();
    await expect(page.locator('#log-transcript [data-speaker="user"]').first()).toHaveText('Hello. Please say hello back.');
    await expect(page.locator('#log-transcript [data-speaker="assistant"]').first()).toHaveText('Hello from Hermes.');
    await page.keyboard.press('Escape');
    await expect(page.locator('#log-drawer')).toBeHidden();
    expect(harness.observed.audioFrames).toBeGreaterThan(10);
    expect(harness.observed.chats[0]).toBe('Hello. Please say hello back.');
    await expect(page.locator('button')).toHaveCount(1);
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

test('history follows streaming text and final corrections without duplicating messages', async ({ page }) => {
  const harness = await voiceHarness();
  try {
    await page.goto(`${harness.url}?dev=1`);
    await expect(page.locator('#state')).toHaveAttribute('data-state', 'armed');
    await page.waitForFunction(() => (window as any).__entity?.scene?.head?.kind === 'ict-facekit');
    await page.getByRole('button', { name: 'Mute', exact: true }).click();
    await page.evaluate(() => {
      const client = (window as any).__entity.client;
      client.emitter.emit('transcript.delta', { speaker: 'assistant', text: 'Checking ', final: false });
      client.emitter.emit('transcript.delta', { speaker: 'assistant', text: 'files', final: false });
    });
    await page.locator('#log-toggle').click();
    await expect(page.locator('#log-transcript p').last()).toHaveText('Checking files');
    const count = await page.locator('#log-transcript p').count();
    await page.evaluate(() => (window as any).__entity.client.emitter.emit('transcript.delta', {
      speaker: 'assistant', text: 'Checked your files.', final: true,
    }));
    await expect(page.locator('#log-transcript p')).toHaveCount(count);
    await expect(page.locator('#log-transcript p').last()).toHaveText('Checked your files.');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Space');
    await expect(page.locator('#log-drawer')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__entityError)).toBeUndefined();
    expect(await page.evaluate(() => (window as any).__entity.scene.loadError)).toBeUndefined();
    expect(await page.evaluate(() => (window as any).__entity.scene.renderer.gl.getError())).toBe(0);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: '/tmp/hermes-voice-desktop.jpg', type: 'jpeg', quality: 65 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: '/tmp/hermes-voice-mobile.jpg', type: 'jpeg', quality: 65 });
    await page.locator('#log-toggle').click();
    await expect(page.locator('#log-drawer')).toBeVisible();
    await page.locator('#log-toggle').click();
    await expect(page.locator('#log-drawer')).toBeHidden();
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
