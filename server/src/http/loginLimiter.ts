/**
 * Failed-login lockout for POST /v1/devices, per client address. nginx already limits the request rate; this caps
 * how many wrong passwords one address may try per hour, which matters once /v1 is reachable without Cloudflare
 * Access in front of it. Per address, not global: a global lock would let anyone lock the owner out.
 *
 * State is in memory: a restart clears it, which is acceptable for one owner and needs no table.
 */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly now: () => number,
    private readonly opts: { maxFailures: number; windowMs: number; maxKeys: number } = { maxFailures: 10, windowMs: 3_600_000, maxKeys: 10_000 },
  ) {}

  /** Milliseconds until `key` may try again, or 0 if it may try now. */
  retryAfterMs(key: string): number {
    const recent = this.recent(key);
    if (recent.length < this.opts.maxFailures) return 0;
    return recent[0]! + this.opts.windowMs - this.now();
  }

  recordFailure(key: string): void {
    const recent = this.recent(key);
    recent.push(this.now());
    this.failures.delete(key); // re-insert so the map stays ordered by last failure
    this.failures.set(key, recent);
    if (this.failures.size > this.opts.maxKeys) this.failures.delete(this.failures.keys().next().value!);
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.opts.windowMs;
    return (this.failures.get(key) ?? []).filter((t) => t > cutoff);
  }
}
