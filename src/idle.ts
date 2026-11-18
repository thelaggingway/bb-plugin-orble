// The plugin's own idle pause for connected runners.
//
// Orble suspends idle boxes by itself, but a connected runner is never idle to
// Orble: the reverse SSH tunnel and its keepalives stay open (a box holding
// only an idle `ssh -R` stayed running for 10+ minutes in our test). So the
// supervisor applies the plugin's idle time instead: once no bb thread on the
// runner has been starting or active for that long, it suspends the runner
// through bb, and the next message resumes it.
export class IdleWatch {
  private readonly lastBusy = new Map<string, number>();

  /**
   * Record one supervisor observation. True when the box has had no busy
   * thread for idleSeconds and should be suspended now. The first sighting
   * (also after a plugin or bb restart) starts a full idle period; 0 is off.
   */
  observe(box: string, busy: boolean, idleSeconds: number, now: number): boolean {
    const since = this.lastBusy.get(box);
    if (busy || since === undefined) {
      this.lastBusy.set(box, now);
      return false;
    }
    if (!idleSeconds) return false;
    return now - since >= idleSeconds * 1000;
  }

  forget(box: string): void {
    this.lastBusy.delete(box);
  }

  retain(boxes: Set<string>): void {
    for (const id of this.lastBusy.keys()) if (!boxes.has(id)) this.lastBusy.delete(id);
  }
}
