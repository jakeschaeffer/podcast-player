const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID (26 chars, time-sortable) for client_request_id. Matches the server's id format so an outbox replays in order. */
export function ulid(now: number = Date.now()): string {
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = ENC[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let rand = "";
  for (const b of bytes) rand += ENC[b % 32];
  return time + rand;
}
