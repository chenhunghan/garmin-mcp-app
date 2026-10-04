import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GarminClient } from "../src/index.ts";
import { endpoints } from "./live/endpoints.ts";
import { responseSchemas } from "./schemas.ts";
import { fakeTokenStorage, garminMockServer, loadContext, loadFixtures } from "./helpers/msw.ts";

const server = garminMockServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

const fixtures = loadFixtures();
const ctx = loadContext();

describe("client endpoints (recorded Garmin responses)", () => {
  for (const ep of endpoints) {
    const recorded = fixtures[ep.name]?.at(-1);
    if (!recorded || (recorded.status >= 300 && recorded.status !== 204)) {
      it.skip(`${ep.name} (no successful recording)`, () => {});
      continue;
    }
    it(ep.name, async () => {
      const client = new GarminClient({ storage: fakeTokenStorage() });
      await client.resume();
      // The request must hit the exact recorded URL, so this also checks
      // that the method builds the right path and query
      const result = await ep.call(client, ctx);
      expect(result ?? null).toEqual(recorded.body);
      const schema = responseSchemas[ep.name];
      expect(schema, `missing schema for ${ep.name}`).toBeDefined();
      schema!.parse(result ?? null);
    });
  }
});

describe("fixtures", () => {
  it("every endpoint has a schema", () => {
    const missing = endpoints
      .filter((ep) => (fixtures[ep.name]?.at(-1)?.status ?? 500) < 300)
      .filter((ep) => !responseSchemas[ep.name])
      .map((ep) => ep.name);
    expect(missing).toEqual([]);
  });
});
