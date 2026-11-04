import { expect, test } from "bun:test";
import { EXTRACT_SYSTEM } from "./llm";
import { taskOwnedBySomeoneElse } from "./pipeline";

test("a task owned by another named person is rejected, and the user's own names are kept", () => {
  expect(taskOwnedBySomeoneElse("Sakshi Sharma", "Nilesh")).toBe(true);
  expect(taskOwnedBySomeoneElse("me", "Nilesh")).toBe(false);
  expect(taskOwnedBySomeoneElse("", "Nilesh")).toBe(false);
  expect(taskOwnedBySomeoneElse(null, "Nilesh")).toBe(false);
  expect(taskOwnedBySomeoneElse("Dhruv", "Dhruv Dabhi")).toBe(false);
  expect(taskOwnedBySomeoneElse("Dhruv Dabhi", "Dhruv Dabhi")).toBe(false);
  expect(taskOwnedBySomeoneElse("Sakshi Sharma", null)).toBe(true);
});

test("the extractor still keeps a future meeting when it tells the model to drop a live join link", () => {
  expect(EXTRACT_SYSTEM).toContain("happening this minute");
  expect(EXTRACT_SYSTEM).toContain("A future meeting that has a time");
});
