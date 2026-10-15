import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodePng } from "../src/geo/png.ts";
import { lonLatToPixel, projection, terrariumHeight, toLatLon, toLocal } from "../src/geo/dem.ts";
import { buildingKind, osmColour, parseOverpass, surfaceOf } from "../src/geo/osm.ts";
import { FURNITURE, TREE_GENUS } from "../src/geo/types.ts";
import { decodeGrid, sampleGrid } from "../src/geo/types.ts";

/** A tiny RGB PNG with the given filter bytes per row. */
function png(width: number, rows: { filter: number; bytes: number[] }[]) {
  const chunk = (type: string, body: Uint8Array) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "ascii");
    Buffer.from(body).copy(out, 8);
    return out; // CRC isn't checked by the decoder
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(rows.length, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.from(rows.flatMap((r) => [r.filter, ...r.bytes]));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}

describe("PNG decoding", () => {
  it("undoes the row filters", () => {
    const img = decodePng(
      png(2, [
        { filter: 0, bytes: [10, 20, 30, 40, 50, 60] },
        { filter: 1, bytes: [1, 2, 3, 4, 4, 4] }, // sub: left neighbor
        { filter: 2, bytes: [1, 1, 1, 1, 1, 1] }, // up
      ]),
    );
    expect([...img.data]).toEqual([10, 20, 30, 40, 50, 60, 1, 2, 3, 5, 6, 7, 2, 3, 4, 6, 7, 8]);
  });

  it("decodes Terrarium heights", () => {
    expect(terrariumHeight(128, 0, 0)).toBe(0);
    expect(terrariumHeight(131, 232, 128)).toBeCloseTo(1000.5, 3);
  });
});

describe("projection and tiles", () => {
  it("round-trips local meters", () => {
    const p = projection(46.2, 8.5);
    const l = toLocal(p, 46.21, 8.52);
    expect(l.z).toBeLessThan(0); // north is −z
    const back = toLatLon(p, l.x, l.z);
    expect(back.lat).toBeCloseTo(46.21, 9);
    expect(back.lon).toBeCloseTo(8.52, 9);
  });

  it("puts lat/lon on the right Web Mercator tile", () => {
    // Zürich at zoom 10 is tile 536/358
    const { px, py } = lonLatToPixel(47.3769, 8.5417, 10);
    expect(Math.floor(px / 256)).toBe(536);
    expect(Math.floor(py / 256)).toBe(358);
  });

  it("encodes height grids as decimeters around a base", () => {
    const values = [100, 100.5, 101, 102.3];
    const bytes = new Uint8Array(8);
    values.forEach((v, i) => {
      const q = Math.round((v - 100) * 10);
      bytes[i * 2] = q & 255;
      bytes[i * 2 + 1] = q >> 8;
    });
    const grid = {
      x0: 0,
      z0: 0,
      step: 10,
      nx: 2,
      nz: 2,
      base: 100,
      data: Buffer.from(bytes).toString("base64"),
    };
    const h = decodeGrid(grid);
    expect([...h].map((v) => +v.toFixed(1))).toEqual(values);
    expect(sampleGrid(grid, h, 5, 5)).toBeCloseTo((100 + 100.5 + 101 + 102.3) / 4, 5);
  });
});

describe("OpenStreetMap", () => {
  const p = projection(46.2, 8.5);
  const square = (lat: number, lon: number, d = 0.0005) => [
    { lat, lon },
    { lat, lon: lon + d },
    { lat: lat + d, lon: lon + d },
    { lat: lat + d, lon },
    { lat, lon },
  ];
  const features = parseOverpass(
    {
      elements: [
        { type: "way", tags: { highway: "residential" }, geometry: square(46.2, 8.5).slice(0, 2) },
        { type: "way", tags: { highway: "path" }, geometry: square(46.2, 8.5).slice(0, 2) },
        {
          type: "way",
          tags: { highway: "track", surface: "asphalt" },
          geometry: square(46.2, 8.5).slice(0, 2),
        },
        {
          type: "way",
          tags: { highway: "footway", tunnel: "yes" },
          geometry: square(46.2, 8.5).slice(0, 2),
        },
        {
          type: "way",
          tags: { building: "yes", "building:levels": "4" },
          geometry: square(46.201, 8.501),
        },
        { type: "way", tags: { natural: "wood" }, geometry: square(46.202, 8.502) },
        { type: "way", tags: { landuse: "meadow" }, geometry: square(46.203, 8.503) },
        { type: "way", tags: { waterway: "stream" }, geometry: square(46.204, 8.504).slice(0, 3) },
        {
          type: "relation",
          tags: { type: "multipolygon", natural: "water" },
          members: [{ type: "way", role: "outer", geometry: square(46.205, 8.505) }],
        },
      ],
    },
    p,
  );

  it("classifies roads by type and surface, skipping tunnels", () => {
    expect(features.roads.map((r) => [r.cls, r.paved])).toEqual([
      ["residential", true],
      ["path", false],
      ["track", true],
    ]);
  });

  it("reads the surface: mapped where tagged, else what the class usually has", () => {
    expect(features.roads.map((r) => [r.surface, r.surfaceMapped ?? false])).toEqual([
      ["asphalt", false],
      ["dirt", false],
      ["asphalt", true],
    ]);
    expect(surfaceOf("paving_stones")).toBe("paving");
    expect(surfaceOf("fine_gravel")).toBe("gravel");
    expect(surfaceOf("concrete:plates")).toBe("concrete");
    expect(surfaceOf("ground")).toBe("dirt");
    expect(surfaceOf("tartan")).toBe("asphalt");
    expect(surfaceOf("")).toBeNull();
  });

  it("reads facade and roof materials and colours", () => {
    const b = parseOverpass(
      {
        elements: [
          {
            type: "way",
            tags: {
              building: "yes",
              "building:material": "brick",
              "building:colour": "Beige",
              "roof:material": "roof_tiles",
              "roof:colour": "#a33",
            },
            geometry: square(46.2, 8.5),
          },
        ],
      },
      p,
    ).buildings[0]!;
    expect([b.material, b.colour, b.roofMaterial, b.roofColour]).toEqual([
      "brick",
      "#dccfb0",
      "tiles",
      "#aa3333",
    ]);
    expect(osmColour("no such colour")).toBeUndefined();
  });

  it("reads mapped street furniture with its direction", () => {
    const f = parseOverpass(
      {
        elements: [
          { type: "node", lat: 46.2, lon: 8.5, tags: { highway: "street_lamp" } },
          { type: "node", lat: 46.2, lon: 8.5, tags: { amenity: "bench", direction: "450" } },
          { type: "node", lat: 46.2, lon: 8.5, tags: { emergency: "fire_hydrant" } },
          { type: "node", lat: 46.2, lon: 8.5, tags: { amenity: "cafe" } },
        ],
      },
      p,
    );
    expect(f.furniture.filter((_, i) => i % 4 >= 2)).toEqual([
      FURNITURE.indexOf("street_lamp"),
      -1,
      FURNITURE.indexOf("bench"),
      90,
      FURNITURE.indexOf("fire_hydrant"),
      -1,
    ]);
  });

  it("reads buildings, land cover, rivers and multipolygon water", () => {
    expect(features.buildings).toHaveLength(1);
    expect(features.buildings[0]!.h).toBe(13);
    expect(features.buildings[0]!.levels).toBe(4);
    expect(features.buildings[0]!.kind).toBe("apartments");
    // Footprint without the repeated closing point
    expect(features.buildings[0]!.pts).toHaveLength(8);
    expect(features.areas.map((a) => a.kind)).toEqual(["forest", "grass", "water"]);
    expect(features.rivers[0]!.width).toBe(2.5);
  });

  it("reads roof shapes, assuming pitched roofs only on mapped houses", () => {
    const one = (tags: Record<string, string>) =>
      parseOverpass({ elements: [{ type: "way", tags, geometry: square(46.2, 8.5) }] }, p)
        .buildings[0]!.roof;
    expect(one({ building: "yes", "roof:shape": "hipped" })).toBe("hipped");
    expect(one({ building: "detached" })).toBe("pitched");
    expect(one({ building: "yes" })).toBeUndefined();
    expect(one({ building: "house", "roof:shape": "flat" })).toBe("flat");
  });

  it("reads mapped trees and samples tree rows", () => {
    const f = parseOverpass(
      {
        elements: [
          {
            type: "node",
            lat: 46.2,
            lon: 8.5,
            tags: { natural: "tree", leaf_type: "needleleaved", height: "12" },
          },
          { type: "node", lat: 46.2001, lon: 8.5, tags: { natural: "tree", genus: "Roystonea" } },
          {
            type: "way",
            tags: { natural: "tree_row" },
            geometry: [
              { lat: 46.2, lon: 8.5 },
              { lat: 46.2, lon: 8.5005 },
            ],
          },
        ],
      },
      p,
    );
    // [x, z, height, kind] per tree
    expect(f.trees.slice(2, 4)).toEqual([12, 1]);
    expect(f.trees.slice(6, 8)).toEqual([0, 2]);
    // Genus groups ride in the kind value (group × 4 + kind)
    const genus = parseOverpass(
      {
        elements: [{ type: "node", lat: 46.2, lon: 8.5, tags: { natural: "tree", genus: "Acer" } }],
      },
      p,
    ).trees[3]!;
    expect([genus & 3, genus >> 2]).toEqual([0, TREE_GENUS.indexOf("maple")]);
    // ~38 m row → a tree every 7 m
    expect(f.trees.length / 4 - 2).toBeGreaterThanOrEqual(5);
    expect(f.trees.length / 4 - 2).toBeLessThanOrEqual(6);
  });

  it("tells what a building is used for", () => {
    expect(buildingKind({ building: "detached" }, 7)).toBe("house");
    expect(buildingKind({ building: "yes", shop: "bakery" }, 7)).toBe("shop");
    expect(buildingKind({ building: "yes", office: "it" }, 30)).toBe("office");
    expect(buildingKind({ building: "warehouse" }, 8)).toBe("industrial");
    expect(buildingKind({ building: "garage" }, 3)).toBe("shed");
    expect(buildingKind({ building: "yes" }, 7)).toBe("house");
    expect(buildingKind({ building: "yes" }, 25)).toBe("apartments");
  });
});
