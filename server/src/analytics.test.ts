import { expect, test } from "bun:test";

test("the normal test runner never sends events to the configured project", async () => {
  const { analytics } = await import("./analytics");
  expect(analytics).toBeNull();
});

test("actual API handlers deliver metadata-only events through the PostHog SDK", async () => {
  // A separate process keeps test credentials, SDK queues and SQLite state out of other suites.
  const child = Bun.spawn([process.execPath, "run", "scripts/verify-analytics.ts"], {
    cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(stdout).toContain("Verified 18 delivered server events");
}, 15_000);
