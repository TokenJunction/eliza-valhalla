import { afterEach, expect, it, vi } from "vitest";
import { resetModelRouteBudgetForTests } from "./model-route-budget.js";
import { warmVoiceModels } from "./voice-warmup.js";

afterEach(() => {
  resetModelRouteBudgetForTests();
  vi.unstubAllEnvs();
});

it("warms both voice models once when no route budget is configured", async () => {
  vi.stubEnv("ELIZA_MODEL_ROUTE_MAX_CALLS", "");
  const useModel = vi.fn(async () => "ready");
  const info = vi.fn();
  await warmVoiceModels(
    { useModel },
    { ttsType: "tts", transcriptionType: "stt" },
    { info, warn: () => {} },
  );
  expect(useModel).toHaveBeenCalledTimes(2);
  expect(info.mock.calls.map((call) => call[0])).toEqual([
    "[eliza] Voice TTS model: ready",
    "[eliza] Voice STT model: ready",
  ]);
});

it("does not call a provider after the configured route budget is spent", async () => {
  vi.stubEnv("ELIZA_MODEL_ROUTE_MAX_CALLS", "1");
  const useModel = vi.fn(async () => "ready");
  const warn = vi.fn();
  await warmVoiceModels(
    { useModel },
    { ttsType: "tts", transcriptionType: "stt" },
    { info: () => {}, warn },
  );
  expect(useModel).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain(
    "configured model route budget exceeded",
  );
  expect(String(warn.mock.calls[0]?.[0])).not.toContain("ready");
});

it("stops transient retries when the next attempt would exceed the cap", async () => {
  vi.stubEnv("ELIZA_MODEL_ROUTE_MAX_CALLS", "1");
  const useModel = vi.fn(async () => {
    throw new Error("provider returned 429");
  });
  const warn = vi.fn();
  await warmVoiceModels(
    { useModel },
    { ttsType: "tts", transcriptionType: "stt" },
    { info: () => {}, warn },
  );
  expect(useModel).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain("429");
  expect(String(warn.mock.calls[1]?.[0])).toContain(
    "configured model route budget exceeded",
  );
});
