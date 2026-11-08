import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { createTLSchema, defaultShapeSchemas } from "@tldraw/tlschema";
import { T } from "@tldraw/validate";
import { createApp } from "../server/app.ts";
import { Library } from "../server/library.ts";
import { Store } from "../server/store.ts";
import { exportFiles, exportZip } from "../server/export.ts";
import { readImport, previewImport, applyImport } from "../server/import.ts";
import { learningLink, learningLocation } from "../src/navigation.ts";
import { initialExperiment } from "../src/diff.ts";

const schema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    "knowledge-card": { props: { w: T.number, h: T.number, cardId: T.string } },
  },
});
const document = (cardId: string) => ({
  schema: schema.serialize(),
  store: {
    "document:document": schema.types.document.create({
      id: "document:document",
    }),
    "page:main": schema.types.page.create({
      id: "page:main",
      name: "Page 1",
      index: "a1" as any,
    }),
    "shape:card": schema.types.shape.create({
      id: "shape:card",
      type: "knowledge-card",
      parentId: "page:main",
      index: "a1" as any,
      props: { w: 300, h: 240, cardId },
    } as any),
  },
});

test("稳定章节地址只依赖身份，保留卡片定位和画布视图", () => {
  assert.equal(
    learningLink("lesson-a", "card-a"),
    "/?lesson=lesson-a&card=card-a&view=board",
  );
  assert.deepEqual(learningLocation("?lesson=lesson-a&card=card-a"), {
    lessonId: "lesson-a",
    cardId: "card-a",
    board: true,
  });
  assert.equal(learningLocation(""), null);
  assert.throws(() => learningLocation("?lesson=../../private"), /无效/);
  assert.throws(() => learningLocation("?lesson=lesson-a&card="), /无效/);
});

test("跨章节引用与查找：只读链接、原子保存、失效状态、导出与恢复", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coursex-links-"));
  const library = new Library(path.join(directory, "library"));
  for (const title of ["02-01 JSX", "04-01 Fiber"]) {
    const folder = path.join(library.root, "React", title);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "课件.md"), "# 本节课\n有效课件。");
  }
  const store = new Store(path.join(directory, "data"));
  const server = (await createApp(library, store)).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (route: string, method = "GET", body?: unknown) => {
    const res = await fetch(url + route, {
      method,
      ...(body
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  try {
    const courses = await library.scan();
    const [jsx, fiber] = courses[0].lessons;
    assert.ok(
      (await library.navigation(courses[0].id)).lessons.every(
        (item) => item.sourceNumber === null,
      ),
    );
    await writeFile(
      path.join(library.root, "React", "课程清单.json"),
      JSON.stringify({
        videos: [
          { folder: "00 未下载的介绍" },
          { folder: jsx.folder },
          { folder: fiber.folder },
        ],
      }),
    );
    const navigation = (
      await request(`/api/navigation?courseId=${courses[0].id}`)
    ).data;
    assert.deepEqual(
      navigation.lessons.map((item: any) => item.sourceNumber),
      [2, 3],
    );
    assert.equal(navigation.lessons[0].id, jsx.id);
    assert.equal(navigation.lessons[0].folder, undefined);
    const a = (await request(`/api/lessons/${jsx.id}/board`, "POST", {})).data;
    const b = (await request(`/api/lessons/${fiber.id}/board`, "POST", {}))
      .data;
    const card = {
      id: "original",
      lessonId: jsx.id,
      type: "text",
      title: "ReactElement",
      body: "描述 UI，与宿主渲染不同。",
      status: "verified",
      evidenceIds: [],
    };
    assert.equal(
      (
        await request(`/api/boards/${a.id}`, "PUT", {
          name: a.name,
          revision: 0,
          document: document(card.id),
          cards: [card],
        })
      ).status,
      200,
    );
    const ref = {
      id: "reference",
      lessonId: fiber.id,
      type: "reference",
      title: card.title,
      body: "",
      status: "draft",
      evidenceIds: [],
      target: { lessonId: jsx.id, cardId: card.id },
    };
    const save = (value: typeof ref, revision = 0) =>
      request(`/api/boards/${b.id}`, "PUT", {
        name: b.name,
        revision,
        document: document(ref.id),
        cards: [value],
      });
    assert.equal((await save(ref)).status, 200);
    assert.deepEqual(store.state.cards.reference.target, ref.target);
    assert.equal(store.state.cards.reference.body, "");
    const catalog = (
      await request("/api/cards?q=" + encodeURIComponent("宿主渲染"))
    ).data;
    assert.deepEqual(
      catalog.map((item: any) => item.id),
      [card.id],
    );
    assert.equal(catalog[0].body, undefined);
    assert.equal(catalog[0].available, true);
    assert.equal(
      (await request(`/api/boards/${b.id}`)).data.targets.reference.title,
      "ReactElement",
    );
    const before = JSON.stringify(store.state);
    assert.equal(
      (await save({ ...ref, target: { ...ref.target, cardId: "missing" } }, 1))
        .status,
      400,
    );
    assert.equal((await save({ ...ref, body: "复制正文" }, 1)).status, 400);
    assert.equal(JSON.stringify(store.state), before);
    const experiment = {
      ...card,
      type: "experiment",
      experiment: initialExperiment,
    };
    const updateOriginal = (value: unknown) =>
      request(`/api/boards/${a.id}`, "PUT", {
        name: a.name,
        revision: 1,
        document: document(card.id),
        cards: [value],
      });
    assert.equal(
      (
        await updateOriginal({
          ...experiment,
          experiment: { ...initialExperiment, version: 2 },
        })
      ).status,
      400,
    );
    assert.equal((await updateOriginal(experiment)).status, 200);
    const files = await exportFiles(
      store.state,
      courses,
      { mode: "private", excerptIds: [], includeAssets: true },
      path.join(store.directory, "assets"),
    );
    const restored = new Store(path.join(directory, "restored"));
    await restored.init();
    await mkdir(path.join(restored.directory, "assets"));
    const pkg = readImport(exportZip(files));
    await applyImport(
      pkg,
      restored,
      courses,
      previewImport(pkg, restored.state, courses).token,
    );
    assert.deepEqual(restored.state.cards.reference.target, ref.target);
    assert.deepEqual(
      restored.state.cards.original.experiment,
      initialExperiment,
    );
    assert.equal(restored.state.primaryBoards[fiber.id], b.id);
    const privateState = structuredClone(store.state);
    privateState.cards.original.handoutSource = {
      lessonId: jsx.id,
      hash: "a".repeat(64),
      quote: "付费原文",
    };
    const shared = await exportFiles(
      privateState,
      courses,
      { mode: "share", excerptIds: [], includeAssets: false },
      path.join(store.directory, "assets"),
    );
    assert.equal(
      Object.keys(shared).some((file) => file.endsWith("reference.md")),
      false,
    );
    // Removing the original keeps an explicit broken link, while further source-board saves stay possible.
    assert.equal(
      (
        await request(`/api/boards/${a.id}`, "PUT", {
          name: a.name,
          revision: 2,
          document: null,
          cards: [],
        })
      ).status,
      200,
    );
    assert.equal(
      (await request(`/api/boards/${b.id}`)).data.targets.reference,
      null,
    );
    assert.equal((await save(ref, 1)).status, 200);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
