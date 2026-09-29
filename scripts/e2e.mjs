// End-to-end verification with Playwright against the production build:
//  1. first online load caches the app shell via service worker;
//  2. setOffline + reload still renders the full editor (no white screen);
//  3. every keystroke lands in localStorage immediately (no debounce window);
//  4. two tabs diverged from one version: the later writer's CAS fails and it
//     sees the conflict banner first; the shared draft is not overwritten;
//  5. the diverged tab reloads (even offline) and gets its own draft back;
//  6. the proofreader resolves it by loading the other version;
//  7. a forced "keep mine" resolution reaches the displaced tab.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "sologsb-1007-project-v1";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "client");
const MIME = {
  ".html": "text/html;charset=utf-8",
  ".js": "text/javascript;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".json": "application/json",
};

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let file = join(root, normalize(decodeURIComponent(url.pathname)));
  if (url.pathname === "/sw.js") res.setHeader("Cache-Control", "no-cache, must-revalidate");
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
  try {
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const browser = await chromium.launch();
const context = await browser.newContext();

// --- 1 & 2: service worker caches shell; offline reload re-enters ---------
{
  console.log("E2E 1-2: 首次在线加载后断网刷新，不白屏且数据仍在");
  const page = await context.newPage();
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForSelector(".app-shell");
  const swReg = await page.evaluate(async () => !!((await navigator.serviceWorker.ready).active));
  check("Service Worker 已激活", swReg);
  await page.waitForTimeout(500);

  await context.setOffline(true);
  await page.reload({ waitUntil: "commit" });
  await page.waitForSelector(".app-shell", { timeout: 5000 });
  const heading = await page.locator("h1").first().textContent();
  check("断网刷新后编辑器完整渲染", !!heading && heading.includes("普通话校订轨"));
  const seedText = await page.locator(".segment-card p").first().textContent();
  check("断网后本地批注内容仍可读", seedText.includes("码头"));
  await context.setOffline(false);
  await page.close();
}

// --- 3: write-through persistence ------------------------------------------
{
  console.log("E2E 3: 每次修改即时落盘，关闭页面后原样找回");
  const page = await context.newPage();
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForSelector(".app-shell");
  await page.evaluate((k) => localStorage.removeItem(k), KEY);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".segment-card");

  await page.locator('header input[aria-label="项目标题"]').fill("断网前最后一秒的标题");
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).project.title, KEY);
  check("击键 0ms 内已写入 localStorage", stored === "断网前最后一秒的标题", `got "${stored}"`);

  await page.locator('header input[aria-label="项目标题"]').fill("关页前瞬间改动");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(base, { waitUntil: "networkidle" });
  await reopened.waitForSelector(".app-shell");
  const restored = await reopened.evaluate((k) => JSON.parse(localStorage.getItem(k)).project.title, KEY);
  check("重进后最后一次改动原样找回", restored === "关页前瞬间改动", `got "${restored}"`);
  await reopened.close();
}

// --- 4–7: divergence, reload recovery, proofreader resolution --------------
{
  console.log("E2E 4: 两标签页同版本分叉，晚保存方先看到冲突提示且不能盖掉对方");
  const ctx = await browser.newContext();
  const tabA = await ctx.newPage();
  await tabA.goto(base, { waitUntil: "networkidle" });
  await tabA.evaluate((k) => localStorage.clear(), KEY);
  await tabA.reload({ waitUntil: "networkidle" });
  await tabA.waitForSelector(".segment-card");
  const tabB = await ctx.newPage();
  await tabB.goto(base, { waitUntil: "networkidle" });
  await tabB.waitForSelector(".segment-card");

  // A saves first: SA becomes the shared head; idle B fast-forwards to it.
  await tabA.locator('header input[aria-label="项目标题"]').fill("SA 先保存");
  await tabA.waitForTimeout(200);
  const headAfterA = await tabB.evaluate((k) => JSON.parse(localStorage.getItem(k)).project.title, KEY);
  check("B 已静默跟进 A 的线性新版本", headAfterA === "SA 先保存", `got "${headAfterA}"`);

  // Deterministic divergence: inside ONE synchronous task in A, first plant a
  // sibling envelope (parent = SA, authored by a third tab id) into storage,
  // then dispatch A's keystroke. Storage events never fire mid-task, so A's
  // CAS is guaranteed to observe the replaced head and must fail.
  const plantAndType = (page, otherTitle, ownTitle) =>
    page.evaluate(
      ({ k, otherTitle, ownTitle }) => {
        const head = JSON.parse(localStorage.getItem(k));
        const sibling = {
          ...head,
          saveId: `sv-other-${Math.random().toString(36).slice(2, 8)}`,
          parentSaveId: head.saveId,
          tabId: `tab-other-${Math.random().toString(36).slice(2, 8)}`,
          savedAt: Date.now(),
          revision: head.revision + 1,
          project: { ...head.project, title: otherTitle },
        };
        localStorage.setItem(k, JSON.stringify(sibling));
        const input = document.querySelector('header input[aria-label="项目标题"]');
        input.focus();
        input.value = ownTitle;
        input.dispatchEvent(new InputEvent("input", { bubbles: true, data: ownTitle, inputType: "insertText" }));
      },
      { k: KEY, otherTitle, ownTitle },
    );

  await plantAndType(tabA, "SC 对方的批注", "SA2 本页晚保存");
  await tabA.waitForSelector(".conflict-banner", { timeout: 5000 });
  const banner = await tabA.locator(".conflict-banner strong").textContent();
  check("晚保存方先看到分叉冲突提示", banner.includes("分叉"));
  const sharedTitle = await tabA.evaluate((k) => JSON.parse(localStorage.getItem(k)).project.title, KEY);
  check("共享草稿仍是对方版本，未被本页盖掉", sharedTitle === "SC 对方的批注", `got "${sharedTitle}"`);
  const parked = await tabA.evaluate(() => {
    const draftKey = Object.keys(localStorage).find((key) => key.startsWith("sologsb-1007-draft-"));
    return draftKey ? JSON.parse(localStorage.getItem(draftKey)).project.title : null;
  });
  check("本页内容另存为分叉草稿", parked === "SA2 本页晚保存", `got "${parked}"`);

  console.log("E2E 5: 断网刷新后分叉稿与冲突提示原样恢复");
  await ctx.setOffline(true);
  await tabA.reload({ waitUntil: "commit" });
  await tabA.waitForSelector(".conflict-banner", { timeout: 5000 });
  await tabA.waitForSelector(".app-shell");
  const restoredTitle = await tabA.locator('header input[aria-label="项目标题"]').inputValue();
  check("离线重进后本页批注/修改原样找回", restoredTitle === "SA2 本页晚保存", `got "${restoredTitle}"`);
  const restoredCompetitor = await tabA.evaluate((k) => JSON.parse(localStorage.getItem(k)).project.title, KEY);
  check("对方版本仍保留在共享位置", restoredCompetitor === "SC 对方的批注");
  await ctx.setOffline(false);

  console.log("E2E 6: 校对员选择载入对方版本");
  await tabA.locator(".conflict-banner .btn-danger").click();
  await tabA.waitForSelector(".conflict-banner", { state: "detached" });
  const adopted = await tabA.locator('header input[aria-label="项目标题"]').inputValue();
  check("本页已切换为对方版本", adopted === "SC 对方的批注", `got "${adopted}"`);
  const noDrafts = await tabA.evaluate(() => !Object.keys(localStorage).some((k) => k.startsWith("sologsb-1007-draft-")));
  check("分叉草稿在解决后清除", noDrafts);

  console.log("E2E 7: 保留本页的强制覆盖会通知被覆盖方");
  // B has been idle on SA all along. Plant a fresh sibling of the current head
  // for A, diverge A again, then resolve with "keep mine" and notify B.
  await plantAndType(tabA, "SD 又一份分叉", "SA3 校对员保留本页");
  await tabA.waitForSelector(".conflict-banner");
  const replacedId = await tabA.evaluate((k) => JSON.parse(localStorage.getItem(k)).saveId, KEY);
  await tabA.locator(".conflict-banner .btn-quiet").click();
  await tabA.waitForSelector(".conflict-banner", { state: "detached" });
  const forcedTitle = await tabA.evaluate((k) => JSON.parse(localStorage.getItem(k)).project.title, KEY);
  check("共享主版本已是本页保留内容", forcedTitle === "SA3 校对员保留本页", `got "${forcedTitle}"`);
  const forcedEnv = await tabA.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY);
  check("强写信封带 forced/replaced 标记", forcedEnv.forced === true && forcedEnv.replacedSaveId === replacedId);

  // Deliver the forced envelope to B exactly as the storage event would.
  await tabB.evaluate((k) => {
    const raw = localStorage.getItem(k);
    window.dispatchEvent(new StorageEvent("storage", { key: k, newValue: raw }));
  }, KEY);
  await tabB.waitForTimeout(300);
  const bTitle = await tabB.locator('header input[aria-label="项目标题"]').inputValue();
  check("被覆盖方收到通知并显示最新版本", bTitle === "SA3 校对员保留本页", `got "${bTitle}"`);
  const bNotice = await tabB.locator(".statusbar span").first().textContent();
  check("被覆盖方状态栏说明来源", bNotice.includes("保留其版本"));

  await ctx.close();
}

await context.close();
await browser.close();
server.close();
console.log(failures ? `\n${failures} 项失败` : "\nE2E 全部通过");
process.exit(failures ? 1 : 0);
