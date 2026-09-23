/**
 * Newest-page-wins voice arbitration. One owner key (profile + user) may hold
 * only one voice-active session: when a newer session.start claims the same
 * owner, the previous holder is demoted to view-only — it keeps receiving
 * transcripts and task events but can no longer start turns or speak. Two
 * pages open at once can never transcribe and answer the same utterance twice.
 */
export interface VoiceArbitrationHandle {
  demote(reason: "superseded"): void;
}

export class VoiceArbiter {
  private readonly holders = new Map<string, VoiceArbitrationHandle>();

  /** Installs the claimant and demotes the previous holder, if any. */
  claim(ownerKey: string, handle: VoiceArbitrationHandle): void {
    const previous = this.holders.get(ownerKey);
    this.holders.set(ownerKey, handle);
    if (previous && previous !== handle) previous.demote("superseded");
  }

  /** Frees the key on close, but only if this handle still owns it. */
  release(ownerKey: string, handle: VoiceArbitrationHandle): void {
    if (this.holders.get(ownerKey) === handle) this.holders.delete(ownerKey);
  }
}
