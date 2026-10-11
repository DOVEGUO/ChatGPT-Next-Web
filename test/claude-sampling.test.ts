import { omitsSamplingParameters } from "../app/client/platforms/anthropic";

describe("Claude sampling parameter compatibility", () => {
  it.each([
    "claude-opus-5-5",
    "claude-haiku-5-5",
    "claude-sonnet-5-5",
    "claude-opus-5",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-4-9",
  ])("omits deprecated sampling params for %s", (model) => {
    expect(omitsSamplingParameters(model)).toBe(true);
  });

  it.each([
    "claude-opus-4-20250514",
    "claude-sonnet-4-20250514",
    "claude-3-5-sonnet-20241022",
    "claude-3-7-sonnet-20250219",
    "claude-2.1",
    "gpt-6-luna",
  ])("keeps legacy sampling behavior for %s", (model) => {
    expect(omitsSamplingParameters(model)).toBe(false);
  });
});
