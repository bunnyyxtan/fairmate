import type { ClockState, Mover } from "../shared/protocol";

export const DEFAULT_CLOCK_MS = 5 * 60 * 1000;

export function createClock(now: number, initialMs = DEFAULT_CLOCK_MS): ClockState {
  if (!Number.isFinite(initialMs) || initialMs <= 0) {
    throw new Error(`clock initialMs must be positive, got ${initialMs}`);
  }
  return {
    initialMs,
    playerMs: initialMs,
    modelMs: initialMs,
    active: "player",
    activeSince: now,
  };
}

/** Charge elapsed wall time to the active side. Mutates the clock in place. */
export function tickClock(clock: ClockState, now: number): Mover | null {
  if (!clock.active || clock.activeSince === null) return null;
  const elapsed = Math.max(0, now - clock.activeSince);
  const key = clock.active === "player" ? "playerMs" : "modelMs";
  clock[key] = Math.max(0, clock[key] - elapsed);
  clock.activeSince = now;
  return clock[key] === 0 ? clock.active : null;
}

export function startTurn(clock: ClockState, mover: Mover, now: number): Mover | null {
  const expired = tickClock(clock, now);
  if (expired) return expired;
  clock.active = mover;
  clock.activeSince = now;
  return null;
}

export function stopClock(clock: ClockState, now: number): Mover | null {
  const expired = tickClock(clock, now);
  clock.active = null;
  clock.activeSince = null;
  return expired;
}