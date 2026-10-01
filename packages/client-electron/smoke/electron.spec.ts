import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const packageDir = process.cwd();
const stateFile = join(packageDir, "smoke", ".server.json");

let server: ChildProcess;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  rmSync(stateFile, { force: true });
  server = spawn("pnpm", ["exec", "tsx", "smoke/run.ts"], {
    cwd: packageDir,
    shell: true,
    stdio: "ignore",
  });

  const deadline = Date.now() + 30_000;
  let url = "";
  while (Date.now() < deadline) {
    try {
      url = (JSON.parse(readFileSync(stateFile, "utf8")) as { url: string }).url;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  expect(url, "the test server never came up").not.toBe("");

  const userData = mkdtempSync(join(tmpdir(), "adt-e2e-"));
  app = await electron.launch({
    args: [".", `--user-data-dir=${userData}`],
    cwd: packageDir,
    env: { ...process.env, ADT_SERVER_URL: url },
  });
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close();
  server?.kill();
});

test("a person can log in, run a diagnostic, and answer the cards", async () => {
  await page.getByLabel("用户名").fill("alice");
  await page.getByLabel("密码").fill("pw-alice");
  await page.getByRole("button", { name: "登录" }).click();

  await page.getByPlaceholder(/请求/).fill("服务异常");
  await page.getByRole("button", { name: "发送" }).click();

  // The side-effect step asks for approval...
  await page.getByRole("button", { name: "确认" }).click({ timeout: 20_000 });

  // ...then the completion candidate arrives and the human disposes.
  await page.getByRole("button", { name: "已解决" }).click({ timeout: 20_000 });

  await expect(page.getByText(/Record: rec_/)).toBeVisible({ timeout: 20_000 });
});
