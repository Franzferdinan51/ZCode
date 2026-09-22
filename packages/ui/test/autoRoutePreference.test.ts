import assert from "node:assert/strict";
import test from "node:test";
import {
  readAutoRouteEnabled,
  writeAutoRouteEnabled,
} from "../src/lib/autoRoutePreference.js";

function memoryStorage(): Map<string, string> & {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
} {
  const map = new Map<string, string>() as Map<string, string> & {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
  map.getItem = (key: string) => (map.has(key) ? map.get(key)! : null);
  map.setItem = (key: string, value: string) => {
    map.set(key, value);
  };
  return map;
}

test("auto-route preference defaults off and round-trips per workspace", () => {
  const storage = memoryStorage();
  assert.equal(readAutoRouteEnabled("/a", undefined, storage), false);
  writeAutoRouteEnabled("/a", true, undefined, storage);
  assert.equal(readAutoRouteEnabled("/a", undefined, storage), true);
  assert.equal(readAutoRouteEnabled("/b", undefined, storage), false);
  writeAutoRouteEnabled("/a", false, undefined, storage);
  assert.equal(readAutoRouteEnabled("/a", undefined, storage), false);
});

test("auto-route preference honors workspace identity and missing storage", () => {
  const storage = memoryStorage();
  writeAutoRouteEnabled("/a", true, "ws-1", storage);
  assert.equal(readAutoRouteEnabled("/a", "ws-1", storage), true);
  assert.equal(readAutoRouteEnabled("/a", "ws-2", storage), false);
  assert.equal(readAutoRouteEnabled("/a", undefined, null), false);
  writeAutoRouteEnabled("/a", true, undefined, null);
});
