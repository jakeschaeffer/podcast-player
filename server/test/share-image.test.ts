import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it } from "vitest";
import { artworkOf, cardVersion, clipsBy, renderShareCard, SHARE_IMAGE } from "../src/services/shareImage.js";

/** Width and height from a PNG's IHDR chunk. */
function size(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const tinyPng = (): Buffer =>
  new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#f59e0b"/></svg>`).render().asPng();

describe("share image", () => {
  it("says how many clips and whose they are", () => {
    expect(clipsBy(10, "Jake")).toBe("10 clips from Jake");
    expect(clipsBy(1, "Jake")).toBe("A clip from Jake");
    expect(clipsBy(0, "Jake")).toBe("Clips from Jake");
    expect(clipsBy(3, " ")).toBe("3 clips");
  });

  it("draws artwork only when it is a PNG or JPEG", () => {
    expect(artworkOf(tinyPng())?.mime).toBe("image/png");
    expect(artworkOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))?.mime).toBe("image/jpeg");
    expect(artworkOf(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBeNull();
  });

  it("changes version with anything it shows", () => {
    const card = { eyebrow: "Stratechery", title: "An Interview", byline: "10 clips from Jake", artworkUrl: "https://a.test/art.png" };
    expect(cardVersion(card)).toBe(cardVersion({ ...card }));
    expect(cardVersion(card)).not.toBe(cardVersion({ ...card, byline: "11 clips from Jake" }));
  });

  it("renders a 1200 × 630 PNG with and without artwork", async () => {
    const card = { eyebrow: "Stratechery", title: "An Interview with Palantir CTO Shyam Sankar About Giving Up Production Means Losing Innovation", byline: "10 clips from Jake", artworkUrl: null };
    for (const art of [null, artworkOf(tinyPng())]) {
      const png = await renderShareCard(card, art);
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      expect(size(png)).toEqual({ width: SHARE_IMAGE.width, height: SHARE_IMAGE.height });
    }
  });
});
