import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { strictSchema } from "./codex-cli.js";

describe("strictSchema", () => {
  it("forbids additional properties and requires every property at every level", () => {
    const schema = Type.Object({
      preview: Type.String(),
      takeaways: Type.Array(Type.Object({ text: Type.String(), sentence_id: Type.Integer() })),
      nested: Type.Object({ kind: Type.Union([Type.Literal("a"), Type.Literal("b")]), inner: Type.Object({ n: Type.Number() }) }),
    });
    const strict = strictSchema(JSON.parse(JSON.stringify(schema))) as Record<string, unknown>;
    expect(strict["additionalProperties"]).toBe(false);
    expect(strict["required"]).toEqual(["preview", "takeaways", "nested"]);
    const items = ((strict["properties"] as Record<string, unknown>)["takeaways"] as Record<string, unknown>)["items"] as Record<string, unknown>;
    expect(items["additionalProperties"]).toBe(false);
    expect(items["required"]).toEqual(["text", "sentence_id"]);
    const nested = (strict["properties"] as Record<string, unknown>)["nested"] as Record<string, unknown>;
    const inner = (nested["properties"] as Record<string, unknown>)["inner"] as Record<string, unknown>;
    expect(inner["additionalProperties"]).toBe(false);
    expect(inner["required"]).toEqual(["n"]);
  });

  it("leaves non-object schemas alone", () => {
    expect(strictSchema({ type: "string", maxLength: 5 })).toEqual({ type: "string", maxLength: 5 });
  });
});
