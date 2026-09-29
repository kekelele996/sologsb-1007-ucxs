// Node test for the localStorage conflict protocol.
// Multiple "tabs" share one in-memory Storage; tsc emits the TS sources.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "persist-"));
execFileSync(
  process.execPath,
  [
    join(root, "node_modules/typescript/bin/tsc"),
    join(root, "src/persistence.ts"),
    join(root, "src/data.ts"),
    "--outDir",
    dir,
    "--module",
    "esnext",
    "--target",
    "es2022",
    "--moduleResolution",
    "bundler",
    "--skipLibCheck",
    "--ignoreConfig",
  ],
  { stdio: "inherit", cwd: root },
);
const emitted = readFileSync(join(dir, "persistence.js"), "utf8").replace(
  /from\s+"\.\/data"/g,
  'from "./data.mjs"',
);
writeFileSync(join(dir, "persistence.mjs"), emitted);
writeFileSync(join(dir, "data.mjs"), readFileSync(join(dir, "data.js"), "utf8"));
const p = await import(pathToFileURL(join(dir, "persistence.mjs")).href);

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    _raw: map,
  };
}

const edit = (project, title) => ({ ...project, title, updatedAt: new Date().toISOString() });
// Write an envelope directly, mimicking a racing tab that bypassed our CAS
// because both processes read the same old head before either wrote.
const rawWrite = (store, envelope) => store.setItem(p.STORAGE_KEY, JSON.stringify(envelope));
const siblingOf = (envelope, tabId, project) => ({
  schema: 1,
  revision: envelope.revision + 1,
  tabId,
  saveId: `sv-race-${Math.random().toString(36).slice(2, 8)}`,
  parentSaveId: envelope.parentSaveId, // same parent => siblings
  savedAt: Date.now(),
  project,
});

// --- Scenario 1: same version, two tabs, later sequential save diverges ----
{
  console.log("Scenario 1: 同版本两标签页顺序保存，晚保存方分叉且不覆盖主存储");
  const store = memoryStorage();
  const a = p.openProjectState("tab-A", store);
  const b = p.openProjectState("tab-B", store);
  check("双方起点相同", a.saveId === b.saveId);

  const aOutcome = p.saveProject(edit(a.project, "A"), a.revision + 1, "tab-A", a.saveId, a.saveId, store);
  check("A 保存成功", aOutcome.status === "saved");
  check("A 的 outbox 已留底", p.readOutbox("tab-A", store)?.saveId === aOutcome.envelope.saveId);

  const bOutcome = p.saveProject(edit(b.project, "B"), b.revision + 1, "tab-B", b.saveId, b.saveId, store);
  check("B 被判分叉", bOutcome.status === "diverged");
  check("主存储仍是 A", p.readEnvelope(store).project.title === "A");
  check("B 落为分叉草稿", p.readDraft("tab-B", store)?.project.title === "B");
}

// --- Scenario 2: storage race — both CAS succeed, the later physical write
// overwrites the earlier one. Lineage (not CAS result) must catch it. -------
{
  console.log("Scenario 2: 跨进程竞态双方都写入，靠世系识别兄弟版本，不静默丢失");
  const store = memoryStorage();
  const a = p.openProjectState("tab-A", store);
  const s0 = p.readEnvelope(store);

  // Both read S0, both writes land: S1 first, S2 physically overwrites it.
  const s1 = {
    schema: 1,
    revision: 1,
    tabId: "tab-A",
    saveId: "sv-S1",
    parentSaveId: s0.saveId,
    savedAt: 1,
    project: edit(a.project, "A-S1"),
  };
  const s2 = {
    schema: 1,
    revision: 1,
    tabId: "tab-B",
    saveId: "sv-S2",
    parentSaveId: s0.saveId,
    savedAt: 2,
    project: edit(a.project, "B-S2"),
  };
  rawWrite(store, s1);
  p.writeOutbox(s1, store);
  rawWrite(store, s2); // S1 silently lost from the head at storage level
  p.writeOutbox(s2, store);

  // A reloads: outbox S1 is not the head and head is its sibling → conflict.
  const aReload = p.openProjectState("tab-A", store);
  check("A 重进识别出自己输掉了竞态", aReload.mode === "outbox-losing");
  check("A 仍看到自己的内容 S1", aReload.project.title === "A-S1");
  check("A 拿到竞争版本 S2", aReload.competitor?.project.title === "B-S2");

  // B reloads: its outbox IS the head; A's candidate would have been parked
  // by the runtime via writeIncoming; emulate that parking.
  p.writeIncoming({ kind: "incoming-candidate", fromTabId: "tab-A", baseSaveId: s0.saveId, envelope: s1 }, "tab-B", store);
  const bReload = p.openProjectState("tab-B", store);
  check("B 作为后写方重进看到待裁决状态", bReload.mode === "outbox-winning");
  check("B 保留自己的内容 S2", bReload.project.title === "B-S2");
  check("B 拿到兄弟版本 S1 作候选", bReload.candidate?.envelope.project.title === "A-S1");
}

// --- Scenario 3: offline reload restores fork draft exactly ----------------
{
  console.log("Scenario 3: 断网/刷新后批注与片段修改原样找回");
  const store = memoryStorage();
  const a = p.openProjectState("tab-A", store);
  const b = p.openProjectState("tab-B", store);
  p.saveProject(edit(a.project, "A"), a.revision + 1, "tab-A", a.saveId, a.saveId, store);
  p.saveProject(edit(b.project, "B"), b.revision + 1, "tab-B", b.saveId, b.saveId, store);
  const reopened = p.openProjectState("tab-B", store);
  check("B 重进恢复分叉稿", reopened.project.title === "B" && reopened.mode === "fork");
  check("基准为 A 的 saveId", reopened.saveId === p.readEnvelope(store).saveId);
  check("A 重进看到自己的版本", p.openProjectState("tab-A", store).project.title === "A");
}

// --- Scenario 4: adopt incoming then continue linearly ---------------------
{
  console.log("Scenario 4: 载入对方版本后继续保存走线性世系");
  const store = memoryStorage();
  const a = p.openProjectState("tab-A", store);
  const b = p.openProjectState("tab-B", store);
  const aOutcome = p.saveProject(edit(a.project, "A"), a.revision + 1, "tab-A", a.saveId, a.saveId, store);
  const bDiverge = p.saveProject(edit(b.project, "B"), b.revision + 1, "tab-B", b.saveId, b.saveId, store);
  check("B 分叉", bDiverge.status === "diverged");
  p.resolveWithIncoming(aOutcome.envelope, "tab-B", store);
  const adopted = p.openProjectState("tab-B", store);
  check("B 采用 A", adopted.project.title === "A" && adopted.mode === "clean");
  const again = p.saveProject(edit(adopted.project, "B2"), adopted.revision + 1, "tab-B", adopted.saveId, adopted.saveId, store);
  check("B 在线性世系上保存成功", again.status === "saved");
  check("parent 指向 A", again.envelope.parentSaveId === aOutcome.envelope.saveId);
}

// --- Scenario 5: keep-mine forced overwrite records honest lineage ---------
{
  console.log("Scenario 5: 保留本页强制覆盖带 forced 标记与被替换 saveId");
  const store = memoryStorage();
  const a = p.openProjectState("tab-A", store);
  const b = p.openProjectState("tab-B", store);
  const aOutcome = p.saveProject(edit(a.project, "A"), a.revision + 1, "tab-A", a.saveId, a.saveId, store);
  const bDiverge = p.saveProject(edit(b.project, "B"), b.revision + 1, "tab-B", b.saveId, b.saveId, store);
  const forced = p.forceSaveLocal(
    edit(bDiverge.draft.project, "B-final"),
    bDiverge.draft.revision + 1,
    "tab-B",
    aOutcome.envelope.saveId,
    bDiverge.draft.parentSaveId,
    store,
  );
  check("forced 标记", forced.forced === true);
  check("replacedSaveId 指向 A", forced.replacedSaveId === aOutcome.envelope.saveId);
  check("parent 仍是共同祖先", forced.parentSaveId === a.saveId);
  check("主存储变为 B", p.readEnvelope(store).project.title === "B-final");
}

// --- Scenario 6: promote outbox forced (later-writer keeps own save) --------
{
  console.log("Scenario 6: 后写方（赢竞态）保留本页，复用自身信封并打 forced");
  const store = memoryStorage();
  const opened = p.openProjectState("tab-B", store);
  const s0 = p.readEnvelope(store);
  const own = {
    schema: 1,
    revision: 1,
    tabId: "tab-B",
    saveId: "sv-B-win",
    parentSaveId: s0.saveId,
    savedAt: 10,
    project: edit(opened.project, "B-wins"),
  };
  rawWrite(store, own);
  p.writeOutbox(own, store);
  // Sibling S-A parked as incoming candidate.
  const sibling = {
    schema: 1,
    revision: 1,
    tabId: "tab-A",
    saveId: "sv-A-lose",
    parentSaveId: s0.saveId,
    savedAt: 9,
    project: edit(opened.project, "A-loses"),
  };
  p.writeIncoming({ kind: "incoming-candidate", fromTabId: "tab-A", baseSaveId: s0.saveId, envelope: sibling }, "tab-B", store);

  const promoted = p.promoteOutboxForced(own, sibling.saveId, store);
  check("复用同一 saveId 内容", promoted.project.title === "B-wins");
  check("带 forced/replaced", promoted.forced === true && promoted.replacedSaveId === sibling.saveId);
  check("候选已清除", p.readIncoming("tab-B", store) === null);
}

// --- Scenario 7: idle tab sees latest head ----------------------------------
{
  console.log("Scenario 7: 新打开标签页直接看到最新主版本");
  const store = memoryStorage();
  const a = p.openProjectState("tab-A", store);
  const a2 = p.saveProject(edit(a.project, "A2"), a.revision + 1, "tab-A", a.saveId, a.saveId, store);
  const a3 = p.saveProject(edit(a2.envelope.project, "A3"), a2.envelope.revision + 1, "tab-A", a2.envelope.saveId, a2.envelope.saveId, store);
  const idle = p.openProjectState("tab-C", store);
  check("看到 A3", idle.project.title === "A3" && idle.saveId === a3.envelope.saveId);
}

// --- Scenario 8: outbox whose child became head is a clean fast-forward -----
{
  console.log("Scenario 8: 本页保存已被他人在线性世系上续接，重进静默跟进");
  const store = memoryStorage();
  const a = p.openProjectState("tab-A", store);
  const s1 = p.saveProject(edit(a.project, "A1"), a.revision + 1, "tab-A", a.saveId, a.saveId, store).envelope;
  const s2 = {
    schema: 1,
    revision: s1.revision + 1,
    tabId: "tab-B",
    saveId: "sv-S2",
    parentSaveId: s1.saveId,
    savedAt: 2,
    project: edit(s1.project, "B2-on-A1"),
  };
  rawWrite(store, s2);
  const reopened = p.openProjectState("tab-A", store);
  check("A 静默跟进到 S2", reopened.mode === "clean" && reopened.project.title === "B2-on-A1");
  check("过期 outbox 已清除", p.readOutbox("tab-A", store) === null);
}

// --- Scenario 9: stale fork draft is discarded -----------------------------
{
  console.log("Scenario 9: 分叉基准已过时的旧草稿不覆盖新版本");
  const store = memoryStorage();
  const a = p.openProjectState("tab-A", store);
  const a2 = p.saveProject(edit(a.project, "A2"), a.revision + 1, "tab-A", a.saveId, a.saveId, store);
  p.persistDraft(edit(a2.envelope.project, "stale"), a2.envelope.revision + 1, "tab-B", a2.envelope.saveId, a2.envelope.saveId, store);
  const a3 = p.saveProject(edit(a2.envelope.project, "A3"), a2.envelope.revision + 1, "tab-A", a2.envelope.saveId, a2.envelope.saveId, store);
  check("A 线性保存到 A3", a3.status === "saved");
  const reopened = p.openProjectState("tab-B", store);
  check("B 跟随主版本", reopened.project.title === "A3");
  check("旧草稿清除", p.readDraft("tab-B", store) === null);
}

// --- Scenario 10: legacy envelope migration --------------------------------
{
  console.log("Scenario 10: 旧版无世系信封可兼容打开");
  const seed = p.openProjectState("tab-A", memoryStorage()).project;
  const store = memoryStorage({
    [p.STORAGE_KEY]: JSON.stringify({ schema: 1, revision: 3, tabId: "old", savedAt: Date.now(), project: seed }),
  });
  const opened = p.openProjectState("tab-B", store);
  check("内容可读", opened.revision === 3);
  check("补全 saveId", typeof p.readEnvelope(store).saveId === "string");
}

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
