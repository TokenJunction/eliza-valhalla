import { expect, it } from "vitest";
import {
  DEFAULT_MAX_RESTARTS,
  resolveStewardMaxRestarts,
  STEWARD_RESTART_HARD_MAX,
} from "./types";

it("keeps the default and the explicit zero restart setting", () => {
  expect(resolveStewardMaxRestarts(undefined)).toBe(DEFAULT_MAX_RESTARTS);
  expect(resolveStewardMaxRestarts(0)).toBe(0);
  expect(resolveStewardMaxRestarts(5)).toBe(5);
});

it("fails closed for invalid restart counts and clamps an unbounded request", () => {
  expect(resolveStewardMaxRestarts(Number.NaN)).toBe(0);
  expect(resolveStewardMaxRestarts(-1)).toBe(0);
  expect(resolveStewardMaxRestarts(Number.POSITIVE_INFINITY)).toBe(0);
  expect(resolveStewardMaxRestarts(10_000)).toBe(STEWARD_RESTART_HARD_MAX);
});
