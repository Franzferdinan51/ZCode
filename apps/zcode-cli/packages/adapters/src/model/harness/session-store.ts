import { randomUUID } from "node:crypto";
import type { HarnessDriverId } from "@zcode/shared/harness-drivers";

/**
 * Per-app harness session affinity. The app (and its model adapter) is
 * 1:1 with a ZCode session, so one store instance gives each routed session
 * its own harness-side conversation per driver. In-memory by design: after
 * an app restart the next routed turn starts a fresh harness session.
 */
export class HarnessSessionStore {
  readonly #sessions = new Map<HarnessDriverId, string>();

  get(driverId: HarnessDriverId): string | undefined {
    return this.#sessions.get(driverId);
  }

  set(driverId: HarnessDriverId, harnessSessionId: string): void {
    this.#sessions.set(driverId, harnessSessionId);
  }

  /** Deterministic-style id for drivers that require the caller to mint one. */
  getOrMint(driverId: HarnessDriverId): string {
    const existing = this.#sessions.get(driverId);
    if (existing) return existing;
    const minted = randomUUID();
    this.#sessions.set(driverId, minted);
    return minted;
  }

  clear(driverId?: HarnessDriverId): void {
    if (driverId) {
      this.#sessions.delete(driverId);
      return;
    }
    this.#sessions.clear();
  }
}
