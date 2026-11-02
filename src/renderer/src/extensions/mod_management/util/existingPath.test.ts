import * as path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const existingPaths = new Set<string>();

vi.mock("../../../util/fs", () => ({
  statSync: vi.fn((filePath: string) => {
    if (!existingPaths.has(filePath)) {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    }
    return {};
  }),
}));

import { existingPathSync } from "./existingPath";

describe("existingPathSync", () => {
  beforeEach(() => existingPaths.clear());

  it("returns an existing target unchanged", () => {
    const targetPath = path.join(path.sep, "game", "mods");
    existingPaths.add(targetPath);
    expect(existingPathSync(targetPath)).toBe(targetPath);
  });

  it("finds the nearest existing parent for a target not created yet", () => {
    const gamePath = path.join(path.sep, "game");
    existingPaths.add(gamePath);
    expect(existingPathSync(path.join(gamePath, "Content", "Paks", "LogicMods"))).toBe(gamePath);
  });
});
