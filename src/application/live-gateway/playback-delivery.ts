/** Session-local playback correlation. Durable unread task state is the retry source. */
export type PlaybackStatus = "playing" | "delivered" | "interrupted" | "failed";
export class PlaybackDelivery {
  private pending = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; playing: boolean }>();
  wait(id: string, timeoutMs = 180_000): Promise<void> {
    if (this.pending.has(id)) throw new Error("Playback delivery already pending.");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Playback completion was not confirmed.")); }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, playing: false });
    });
  }
  acknowledge(id: string, status: PlaybackStatus): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    if (status === "playing") { pending.playing = true; return true; }
    if (status === "delivered" && !pending.playing) return false;
    clearTimeout(pending.timer); this.pending.delete(id);
    if (status === "delivered") pending.resolve();
    else pending.reject(new Error(`Playback ${status}.`));
    return true;
  }
  cancel(id: string): void { this.acknowledge(id, "interrupted"); }
  close(): void { for (const id of this.pending.keys()) this.cancel(id); }
}
