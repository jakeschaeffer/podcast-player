import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app/context.js";
import * as S from "../schemas.js";

import { reportPlayback } from "../../services/playback.js";

export function registerPlaybackRoutes(instance: FastifyInstance, ctx: AppContext): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  app.put("/v1/playback/:asset_id", { schema: { tags: ["playback"], summary: "Report this device's position for a recording; a stale seq is ignored", params: Type.Object({ asset_id: Type.String() }), body: S.PlaybackBody, response: { 200: S.PlaybackResponse } } }, async (request) => {
    const { accepted, state } = reportPlayback(ctx, request.device.id, request.params.asset_id, request.body);
    return { accepted, position_ms: state.position_ms, speed: state.speed, playing: state.playing === 1, finished: state.finished === 1, seq: state.seq, updated_at: state.updated_at };
  });
}
