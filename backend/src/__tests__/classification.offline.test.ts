import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { classify } from "../lib/classification";
import { mapToCategory, UNCATEGORIZED } from "../lib/classification/categoryMapping";

// Offline verification for the spec's [Developer-verified] AC:
// "classification succeeds with outside networking unavailable"
// (specs/ai-classification.md, acceptance criteria — no real Vision call).
//
// Method (recorded in reports/mr-drafts/feature-ai-classification.md):
// 1. Runtime: every Node network entry point reachable from userland
//    (globalThis.fetch, http/https request+get, net.Socket.prototype.connect)
//    is stubbed to THROW for the duration of this file, then classify() is
//    run on every committed fixture — a single outbound attempt anywhere in
//    the classification path would fail these tests.
// 2. Static: the classification module and its only sibling
//    (categoryMapping) are asserted to import no network-capable module.
//
// This file needs no DB/MinIO/worker — it runs everywhere, including the
// Tester's environment.

const FIXTURES_DIR = path.resolve(__dirname, "../../test/fixtures");
const fixtureBytes = (name: string) => fs.readFileSync(path.join(FIXTURES_DIR, name));

const networkDisabled = () => {
  throw new Error("Network access attempted during offline classification test");
};

beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(networkDisabled);
  vi.spyOn(http, "request").mockImplementation(networkDisabled);
  vi.spyOn(http, "get").mockImplementation(networkDisabled);
  vi.spyOn(https, "request").mockImplementation(networkDisabled);
  vi.spyOn(https, "get").mockImplementation(networkDisabled);
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(networkDisabled);
});

afterAll(() => {
  vi.restoreAllMocks();
});

// Expected values are the committed contract from backend/test/fixtures/README.md
// (filename -> mock label set -> confidence -> expected folder). If
// MOCK_LABEL_SETS ever changes length/order, fixtures + README + this table
// must be regenerated together.
const EXPECTED: Array<{
  fixture: string;
  labels: string[];
  confidence: number;
  folder: string;
}> = [
  { fixture: "fixture-people.jpg", labels: ["Person", "Outdoor"], confidence: 0.89, folder: "People" },
  { fixture: "fixture-food.jpg", labels: ["Food", "Meal"], confidence: 0.83, folder: "Food" },
  { fixture: "fixture-documents.jpg", labels: ["Document", "Text"], confidence: 0.89, folder: "Documents" },
  { fixture: "fixture-nature.jpg", labels: ["Landscape", "Nature"], confidence: 0.79, folder: "Nature" },
  { fixture: "fixture-animals.jpg", labels: ["Dog", "Animal"], confidence: 0.76, folder: "Animals" },
  { fixture: "fixture-vehicles.jpg", labels: ["Car", "Truck"], confidence: 0.9, folder: "Vehicles" },
  { fixture: "fixture-unmappable.jpg", labels: ["Abstract", "Pattern"], confidence: 0.94, folder: UNCATEGORIZED },
];

describe("classification works fully offline (mock provider, no network)", () => {
  for (const expected of EXPECTED) {
    it(`classifies ${expected.fixture} -> ${expected.labels.join("/")} -> ${expected.folder} with all network entry points disabled`, async () => {
      const result = await classify(fixtureBytes(expected.fixture));
      expect(result.labels).toEqual(expected.labels);
      expect(result.confidence).toBe(expected.confidence);
      expect(mapToCategory(result)).toBe(expected.folder);
    });
  }

  it("multi-category priority: the People+Nature label set resolves to People (CATEGORY_PRIORITY order)", async () => {
    const result = await classify(fixtureBytes("fixture-people.jpg"));
    // ["Person", "Outdoor"] spans People AND Nature — People wins on priority.
    expect(result.labels).toEqual(["Person", "Outdoor"]);
    expect(mapToCategory(result)).toBe("People");
    // And Outdoor alone would have been Nature — proving both categories matched.
    expect(mapToCategory({ labels: ["Outdoor"], confidence: result.confidence })).toBe("Nature");
  });

  it("classification module dependency graph contains no network-capable import (static check)", () => {
    const moduleFiles = [
      path.resolve(__dirname, "../lib/classification/index.ts"),
      path.resolve(__dirname, "../lib/classification/categoryMapping.ts"),
    ];
    const forbidden =
      /(?:from\s+|require\()\s*["'](?:node:)?(?:http|https|net|tls|dns|dgram|undici|axios|node-fetch)["']/;
    for (const file of moduleFiles) {
      const source = fs.readFileSync(file, "utf8");
      expect(source).not.toMatch(forbidden);
      expect(source).not.toContain("fetch(");
    }
  });
});
