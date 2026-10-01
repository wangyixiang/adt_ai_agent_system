import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const packageDir = process.cwd();
const stateFile = join(packageDir, "smoke", ".server.json");

let server: ChildProcess;
let serverUrl = "";

test.beforeAll(async () => {
  rmSync(stateFile, { force: true });
  server = spawn("pnpm", ["exec", "tsx", "smoke/run.ts"], {
    cwd: packageDir,
    shell: true,
    stdio: "ignore",
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      serverUrl = (JSON.parse(readFileSync(stateFile, "utf8")) as { url: string }).url;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  expect(serverUrl, "the test server never came up").not.toBe("");
});

test.afterAll(() => {
  server?.kill();
});

async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = mkdtempSync(join(tmpdir(), "adt-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userData}`],
    cwd: packageDir,
    env: { ...process.env, ADT_SERVER_URL: serverUrl },
  });
  return { app, page: await app.firstWindow() };
}

async function login(page: Page): Promise<void> {
  await page.getByLabel("用户名").fill("alice");
  await page.getByLabel("密码").fill("pw-alice");
  await page.getByRole("button", { name: "登录" }).click();
}

test("a person can log in, run a diagnostic, and answer the cards", async () => {
  const { app, page } = await launchApp();
  try {
    await login(page);
    await page.getByPlaceholder(/请求/).fill("服务异常");
    await page.getByRole("button", { name: "发送" }).click();

    await page.getByRole("button", { name: "确认" }).click({ timeout: 20_000 });
    // The right-hand workbench shows the run's steps.
    await expect(page.getByTestId("workbench").getByText("复位测试台")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "已解决" }).click({ timeout: 20_000 });

    await expect(page.getByRole("main").getByText(/Record: rec_/)).toBeVisible({ timeout: 20_000 });
    // The run is now in the left conversation list.
    await expect(page.getByRole("button", { name: /服务异常/ }).first()).toBeVisible();
  } finally {
    await app.close();
  }
});

test("the past run survives a restart, reconstructed from its Record", async () => {
  const { app, page } = await launchApp();
  try {
    await login(page);

    // A fresh process has an empty projection, so the list can only come from
    // the Server's Records — and opening one reconstructs the transcript.
    const row = page.getByRole("button", { name: /服务异常/ }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await expect(page.getByRole("main").getByText(/Record: rec_/)).toBeVisible({ timeout: 20_000 });
  } finally {
    await app.close();
  }
});
