/**
 * Golden cases for HeardTracker (web/src/player/heard.ts), the reference for where a snip may reach back to. Each
 * case is a list of steps: reset, tick (a position sample), jump (a deliberate seek), and queries whose expected
 * answers come from running the reference. A port replays the steps and must give the same answers.
 */
import { describe, expect, it } from "vitest";
import { HeardTracker, MERGE_GAP_MS } from "../src/player/heard";
import { golden, lcg } from "./golden";

type Step =
  | { op: "reset"; start_ms: number; assume_heard_before_ms: number }
  | { op: "tick"; pos_ms: number; playing: boolean; speed: number; wall_ms: number }
  | { op: "jump"; from_ms: number; to_ms: number }
  | { op: "heard_from"; pos_ms: number; expect?: number }
  | { op: "ranges"; pos_ms: number; expect?: [number, number][] };
type Case = { name: string; steps: Step[] };

/** Builds a step list while keeping a simulated wall clock and playhead. */
class Script {
  steps: Step[] = [];
  pos = 0;
  wall = 1_000_000;
  reset(start: number, assumeHeardBefore = 0) {
    this.pos = start;
    this.steps.push({ op: "reset", start_ms: start, assume_heard_before_ms: assumeHeardBefore });
    return this;
  }
  /** Play for `ms` of wall time at `speed`, sampling every `sampleMs`. */
  play(ms: number, opts: { speed?: number; sampleMs?: number } = {}) {
    const speed = opts.speed ?? 1;
    const sample = opts.sampleMs ?? 250;
    for (let t = 0; t < ms; t += sample) {
      const step = Math.min(sample, ms - t);
      this.wall += step;
      this.pos += Math.round(step * speed);
      this.tick(true, speed);
    }
    return this;
  }
  tick(playing: boolean, speed = 1) {
    this.steps.push({ op: "tick", pos_ms: this.pos, playing, speed, wall_ms: this.wall });
    return this;
  }
  /** Wall time passes with no sample (app suspended, a stall) and the position moves by `posDelta`. */
  gap(wallMs: number, posDelta: number, playing = true) {
    this.wall += wallMs;
    this.pos += posDelta;
    return this.tick(playing);
  }
  jump(to: number) {
    this.steps.push({ op: "jump", from_ms: this.pos, to_ms: to });
    this.pos = to;
    return this;
  }
  ask(pos = this.pos) {
    this.steps.push({ op: "heard_from", pos_ms: pos });
    this.steps.push({ op: "ranges", pos_ms: pos });
    return this;
  }
}

const handWritten: [string, Script][] = [
  ["plays from the start", new Script().reset(0).play(120_000).ask()],
  ["resume point assumes 180 s heard before it", new Script().reset(600_000, 180_000).play(30_000).ask()],
  ["resume point near the start assumes only what exists", new Script().reset(100_000, 180_000).play(10_000).ask()],
  ["skip forward starts a new stretch", new Script().reset(0).play(60_000).jump(90_000).play(20_000).ask()],
  ["skip back inside heard audio keeps the whole stretch", new Script().reset(0).play(60_000).jump(45_000).play(30_000).ask()],
  ["seek by native controls (no jump call) is detected", new Script().reset(0).play(30_000).gap(250, 40_000).play(10_000).ask()],
  ["backward drift under a second is not a seek", new Script().reset(0).play(30_000).gap(250, -800).play(10_000).ask()],
  ["backward move over a second is a seek", new Script().reset(0).play(30_000).gap(250, -1_500).play(10_000).ask()],
  ["buffering stall: wall time passes, position does not", new Script().reset(0).play(30_000).gap(10_000, 0).play(10_000).ask()],
  ["double speed advances twice as fast and is not a seek", new Script().reset(0).play(30_000, { speed: 2 }).ask()],
  ["seek while paused is detected from position alone", new Script().reset(0).play(20_000).tick(false).gap(5_000, 30_000, false).play(10_000).ask()],
  [`stretches closer than ${MERGE_GAP_MS} ms merge`, new Script().reset(0).play(30_000).jump(31_500).play(20_000).ask()],
  ["stretches further apart stay separate", new Script().reset(0).play(30_000).jump(32_500).play(20_000).ask()],
  ["a position before anything heard answers itself", new Script().reset(300_000).play(10_000).ask(100_000)],
  ["sampled every 250 ms", new Script().reset(0).play(40_000, { sampleMs: 250 }).jump(70_000).play(20_000, { sampleMs: 250 }).ask()],
  ["sampled every second gives the same answer", new Script().reset(0).play(40_000, { sampleMs: 1_000 }).jump(70_000).play(20_000, { sampleMs: 1_000 }).ask()],
  ["app suspended while another output kept playing", new Script().reset(0).play(30_000).gap(60_000, 60_000).play(10_000).ask()],
  ["extrapolated position snapping back after suspension reads as a seek", new Script().reset(0).play(30_000).gap(60_000, 60_000).gap(250, -20_000).play(5_000).ask()],
];

function randomCase(seed: number): Script {
  const r = lcg(seed);
  const s = new Script().reset(Math.floor(r() * 4) * 120_000, r() < 0.5 ? 180_000 : 0);
  for (let i = 0; i < 6 + Math.floor(r() * 6); i++) {
    const roll = r();
    if (roll < 0.45) s.play(2_000 + Math.floor(r() * 60_000), { speed: [1, 1, 1.25, 1.5, 2][Math.floor(r() * 5)]!, sampleMs: [250, 500, 1_000][Math.floor(r() * 3)]! });
    else if (roll < 0.7) s.jump(Math.max(0, s.pos + Math.floor((r() - 0.4) * 120_000)));
    else if (roll < 0.85) s.gap(Math.floor(r() * 20_000), Math.floor((r() - 0.3) * 30_000));
    else s.tick(false);
    if (r() < 0.5) s.ask(Math.max(0, s.pos - Math.floor(r() * 90_000)));
  }
  return s.ask();
}

/** Run the reference over a case's steps, filling in every query's expected answer. */
function run(steps: Step[]): Step[] {
  const t = new HeardTracker();
  return steps.map((step) => {
    switch (step.op) {
      case "reset": t.reset(step.start_ms, { assumeHeardBeforeMs: step.assume_heard_before_ms }); return step;
      case "tick": t.tick(step.pos_ms, step.playing, step.speed, step.wall_ms); return step;
      case "jump": t.jump(step.from_ms, step.to_ms); return step;
      case "heard_from": return { ...step, expect: t.heardFrom(step.pos_ms) };
      case "ranges": return { ...step, expect: t.heardRanges(step.pos_ms) };
    }
  });
}

const cases: Case[] = [
  ...handWritten.map(([name, s]) => ({ name, steps: run(s.steps) })),
  ...Array.from({ length: 20 }, (_, i) => ({ name: `random seed ${i + 1}`, steps: run(randomCase(i + 1).steps) })),
];
const lastAnswer = (c: Case) => (c.steps.filter((s) => s.op === "heard_from").at(-1) as { expect: number }).expect;

describe("heard_v1 golden cases", () => {
  it("behave as intended on the hand-written cases", () => {
    const by = Object.fromEntries(cases.map((c) => [c.name, lastAnswer(c)]));
    expect(by["plays from the start"]).toBe(0);
    expect(by["resume point assumes 180 s heard before it"]).toBe(420_000);
    expect(by["resume point near the start assumes only what exists"]).toBe(0);
    expect(by["skip forward starts a new stretch"]).toBe(90_000);
    expect(by["skip back inside heard audio keeps the whole stretch"]).toBe(0);
    expect(by["seek by native controls (no jump call) is detected"]).toBeGreaterThan(30_000);
    expect(by["backward drift under a second is not a seek"]).toBe(0);
    expect(by["buffering stall: wall time passes, position does not"]).toBe(0);
    expect(by["double speed advances twice as fast and is not a seek"]).toBe(0);
    expect(by[`stretches closer than ${MERGE_GAP_MS} ms merge`]).toBe(0);
    expect(by["stretches further apart stay separate"]).toBe(32_500);
    expect(by["a position before anything heard answers itself"]).toBe(100_000);
    expect(by["sampled every second gives the same answer"]).toBe(by["sampled every 250 ms"]);
    expect(by["app suspended while another output kept playing"]).toBe(0);
  });

  it("match the committed file", () => {
    const file = { family: "heard", version: "heard_v1", reference: "web/src/player/heard.ts", cases };
    expect(golden("heard/heard_v1.json", file)).toEqual(file);
  });
});
