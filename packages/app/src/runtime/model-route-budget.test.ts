import { afterEach, expect, it } from "vitest";
import {
  consumeModelRouteCall,
  modelRouteBudgetBlocksPaidRoute,
  resetModelRouteBudgetForTests,
  resolveModelRouteCallCap,
} from "./model-route-budget.js";

afterEach(() => {
  resetModelRouteBudgetForTests();
});

it("leaves routing open when no call cap is configured", () => {
  expect(resolveModelRouteCallCap({})).toBeNull();
  expect(modelRouteBudgetBlocksPaidRoute({})).toBe(false);
  expect(consumeModelRouteCall({})).toBe(true);
  expect(modelRouteBudgetBlocksPaidRoute({})).toBe(false);
});

it("fails closed for invalid text and clamps an oversized cap", () => {
  expect(
    resolveModelRouteCallCap({ ELIZA_MODEL_ROUTE_MAX_CALLS: "many" }),
  ).toBe(0);
  expect(
    modelRouteBudgetBlocksPaidRoute({ ELIZA_MODEL_ROUTE_MAX_CALLS: "many" }),
  ).toBe(true);
  expect(
    resolveModelRouteCallCap({ ELIZA_MODEL_ROUTE_MAX_CALLS: "1000" }),
  ).toBe(8);
});

it("stops optional probes and paid routes after the configured cap", () => {
  const env = { ELIZA_MODEL_ROUTE_MAX_CALLS: "2" };
  expect(consumeModelRouteCall(env)).toBe(true);
  expect(modelRouteBudgetBlocksPaidRoute(env)).toBe(false);
  expect(consumeModelRouteCall(env)).toBe(true);
  expect(consumeModelRouteCall(env)).toBe(false);
  expect(modelRouteBudgetBlocksPaidRoute(env)).toBe(true);
});
