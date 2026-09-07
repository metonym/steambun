import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ciAnnotation } from "../src/util/annotations";

const originalGithubActions = process.env.GITHUB_ACTIONS;
const originalSteambunCi = process.env.STEAMBUN_CI;

afterEach(() => {
  if (originalGithubActions === undefined) delete process.env.GITHUB_ACTIONS;
  else process.env.GITHUB_ACTIONS = originalGithubActions;
  if (originalSteambunCi === undefined) delete process.env.STEAMBUN_CI;
  else process.env.STEAMBUN_CI = originalSteambunCi;
});

describe("ciAnnotation", () => {
  test("no-op when neither env var is set", () => {
    delete process.env.GITHUB_ACTIONS;
    delete process.env.STEAMBUN_CI;
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      ciAnnotation("error", "message");
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  test("GITHUB_ACTIONS=true prints ::error with file", () => {
    process.env.GITHUB_ACTIONS = "true";
    delete process.env.STEAMBUN_CI;
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      ciAnnotation("error", "budget exceeded", { file: "assets/app.js" });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0]).toStartWith("::error file=assets/app.js::");
    } finally {
      log.mockRestore();
    }
  });

  test("STEAMBUN_CI=1 with no file/line omits file=", () => {
    delete process.env.GITHUB_ACTIONS;
    process.env.STEAMBUN_CI = "1";
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      ciAnnotation("warning", "message");
      expect(log).toHaveBeenCalledWith("::warning::message");
    } finally {
      log.mockRestore();
    }
  });

  test("escapes a newline in the message to %0A", () => {
    process.env.STEAMBUN_CI = "1";
    delete process.env.GITHUB_ACTIONS;
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      ciAnnotation("notice", "line one\nline two");
      expect(log).toHaveBeenCalledWith("::notice::line one%0Aline two");
    } finally {
      log.mockRestore();
    }
  });
});
