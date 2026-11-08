import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { unzipSync } from "fflate";
import { Store } from "../server/store.ts";
import { exportCatalog, exportFiles, exportZip } from "../server/export.ts";
import { handoutCard, handoutText } from "../server/handout.ts";
import type { Card, Course, ExportOptions } from "../src/types.ts";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const markdown =
  "# JSX\n\nJSX **描述 UI**，不是 DOM。\n\n`jsx()` 返回元素。\n\n- 编译\n- 创建元素\n\n| 机制 | 说明 |\n| --- | --- |\n| DOM | 宿主输出 |";
test("课件选文支持格式化正文，拒绝整篇、伪造和过长引用，默认草稿", () => {
  assert.ok(handoutText(markdown).includes("JSX 描述 UI，不是 DOM。"));
  const card = handoutCard("lesson-a", markdown, "JSX 描述 UI，不是 DOM。");
  assert.equal(card.status, "draft");
  assert.equal(card.handoutSource?.quote, card.body);
  assert.match(card.handoutSource!.hash, /^[a-f0-9]{64}$/);
  for (const quote of [
    "不存在的文字",
    handoutText(markdown),
    "x".repeat(2001),
    " ",
    undefined,
  ])
    assert.throws(() => handoutCard("lesson-a", markdown, quote), /请选择/);
});

test("结构化 ZIP：范围、确定性、资源、隐私和语义布局分离", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coursex-export-"));
  const assets = path.join(directory, "assets");
  await mkdir(assets);
  const image = "11111111-1111-1111-1111-111111111111.png";
  await writeFile(path.join(assets, image), "owned-image-bytes");
  const store = new Store(path.join(directory, "data"));
  await store.init();
  const fixtureKey = randomUUID();
  const courses: Course[] = [
    {
      id: "course-a",
      name: "React",
      lessons: [
        {
          id: "lesson-a",
          courseId: "course-a",
          title: "JSX",
          folder: "private-folder",
          video: true,
          handout: true,
        },
      ],
    },
    {
      id: "course-b",
      name: "Other",
      lessons: [
        {
          id: "lesson-b",
          courseId: "course-b",
          title: "Other",
          folder: "other-private-folder",
          video: true,
          handout: true,
        },
      ],
    },
  ];
  const card = (id: string, type: Card["type"], body: string): Card => ({
    id,
    lessonId: "lesson-a",
    type,
    body,
    title: id,
    status: "draft",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    evidenceIds: [],
  });
  await store.update((state) => {
    state.settings = {
      baseUrl: "https://private-provider.example",
      model: "model",
      apiKey: fixtureKey,
    };
    state.chats["lesson-a"] = [
      {
        id: "unsaved",
        lessonId: "lesson-a",
        role: "user",
        text: "UNSAVED-CHAT-NEVER-EXPORT",
        createdAt: null,
      },
    ];
    state.cards.own = {
      ...card(
        "own",
        "text",
        `我的笔记 ${fixtureKey} /Users/person/private/note.txt\nC:\\Users\\person\\private\\note.txt`,
      ),
      evidenceIds: ["file-ref", "url-ref"],
    };
    state.cards.raw = {
      ...card("raw", "conversation", "RAW-SAVED-ANSWER"),
      excerptId: "excerpt-a",
    };
    state.cards.summary = {
      ...card("summary", "conclusion", "我整理的解释"),
      excerptId: "excerpt-b",
    };
    state.cards.quote = handoutCard(
      "lesson-a",
      markdown,
      "JSX 描述 UI，不是 DOM。",
    );
    state.cards.quote.id = "quote";
    state.cards.other = {
      ...card("other", "text", "OTHER-COURSE"),
      lessonId: "lesson-b",
    };
    state.evidence["file-ref"] = {
      id: "file-ref",
      sourceType: "file",
      uri: "/Volumes/private/repo/src/index.ts",
    };
    state.evidence["url-ref"] = {
      id: "url-ref",
      sourceType: "url",
      uri: "https://user:pass@example.com/source?token=private-token&topic=jsx",
      version: "18.2.0",
    };
    for (const id of ["excerpt-a", "excerpt-b"])
      state.excerpts[id] = {
        id,
        lessonId: "lesson-a",
        createdAt: "2026-01-01",
        messageIds: ["q", "a"],
        turns: [
          { id: "q", role: "user", text: "问题", createdAt: null },
          {
            id: "a",
            role: "assistant",
            text: id === "excerpt-a" ? "RAW-SAVED-ANSWER" : "SELECTED-EXCERPT",
            createdAt: null,
          },
        ],
      };
    state.boards = [
      {
        id: "board-a",
        name: "我的画布",
        revision: 3,
        updatedAt: "2026-01-01",
        document: {
          schema: { schemaVersion: 2 },
          store: {
            "page:one": {
              id: "page:one",
              typeName: "page",
              name: "Page 1",
              meta: {},
            },
            ...Object.fromEntries(
              ["own", "raw", "summary", "quote"].map((id) => [
                `shape:${id}`,
                {
                  id: `shape:${id}`,
                  typeName: "shape",
                  type: "knowledge-card",
                  parentId: "page:one",
                  x: 0,
                  y: 0,
                  props: { cardId: id },
                },
              ]),
            ),
            "asset:image": {
              id: "asset:image",
              typeName: "asset",
              type: "image",
              props: { src: `/api/assets/${image}` },
            },
            "shape:image": {
              id: "shape:image",
              typeName: "shape",
              type: "image",
              props: { assetId: "asset:image" },
            },
            "shape:bookmark": {
              id: "shape:bookmark",
              typeName: "shape",
              type: "bookmark",
              props: {
                assetId: "asset:image",
                url: "https://example.com/source#access_token=hidden-fragment",
              },
            },
            "asset:course": {
              id: "asset:course",
              typeName: "asset",
              type: "image",
              props: {
                src: "/api/lessons/lesson-a/media?file=images/paid.png",
              },
            },
            "shape:course": {
              id: "shape:course",
              typeName: "shape",
              type: "image",
              props: { assetId: "asset:course" },
            },
            "binding:raw": {
              id: "binding:raw",
              typeName: "binding",
              fromId: "shape:own",
              toId: "shape:raw",
            },
            "shape:text": {
              id: "shape:text",
              typeName: "shape",
              type: "text",
              props: {
                text: fixtureKey,
                url: "https://name:secret@example.com/path?signature=hidden&x=1",
              },
              meta: { cookie: "cookie-value" },
            },
          },
        },
        session: { pageStates: [{ selectedShapeIds: ["shape:raw"] }] },
      },
      {
        id: "draft",
        name: "独立草稿",
        revision: 0,
        updatedAt: "old",
        document: null,
      },
    ];
    state.primaryBoards["lesson-a"] = "board-a";
    state.progress["lesson-a"] = { position: 12, rate: 1.5 };
    state.progress["missing-lesson"] = { position: 5, rate: 1 };
  });
  const state = await store.snapshot();
  const original = structuredClone(state);
  const options: ExportOptions = {
    mode: "private",
    includeAssets: true,
    excerptIds: ["excerpt-a", "excerpt-b"],
  };
  const base = "courses/course-a/chapters/lesson-a";
  try {
    await t.test(
      "完整学习成果保留独立草稿与失联课节，未读完整聊天或课程源文件",
      async () => {
        const files = await exportFiles(state, courses, options, assets);
        assert.ok(files[`${base}/cards/own.md`]);
        assert.ok(files[`${base}/conversations/excerpt-a.json`]);
        assert.ok(files["boards/draft/canvas.json"]);
        assert.ok(files["unassigned/chapters/missing-lesson/chapter.json"]);
        assert.equal(decode(files[`assets/${image}`]), "owned-image-bytes");
        const canvas = JSON.parse(decode(files[`${base}/canvas.json`]));
        assert.equal(canvas.document.store["shape:course"], undefined);
        assert.equal(canvas.document.store["asset:course"], undefined);
        assert.equal(
          canvas.document.store["asset:image"].props.src,
          `../../../../assets/${image}`,
        );
        const text = Object.entries(files)
          .filter(([name]) => !name.startsWith("assets/"))
          .map(([, bytes]) => decode(bytes))
          .join("\n");
        for (const excluded of [
          fixtureKey,
          "private-provider",
          "UNSAVED-CHAT-NEVER-EXPORT",
          "private-folder",
          "/Users/person",
          "/Volumes/private",
          "private-token",
          "cookie-value",
          "signature=hidden",
          "name:secret@",
          "C:\\Users\\person",
          "hidden-fragment",
        ])
          assert.ok(!text.includes(excluded), excluded);
        assert.match(text, /topic=jsx/);
        assert.deepEqual(state, original);
      },
    );
    await t.test(
      "重复导出只有 manifest 导出时间可变；移动不改 Markdown",
      async () => {
        const first = await exportFiles(state, courses, options, assets),
          second = await exportFiles(state, courses, options, assets);
        assert.deepEqual(Object.keys(first).sort(), Object.keys(second).sort());
        for (const name of Object.keys(first))
          if (name !== "manifest.json")
            assert.deepEqual(first[name], second[name], name);
        assert.deepEqual(exportZip(first), exportZip(first));
        const extracted = unzipSync(exportZip(first));
        assert.deepEqual(
          Object.keys(extracted).sort(),
          Object.keys(first).sort(),
        );
        const moved = structuredClone(state);
        (moved.boards[0].document as any).store["shape:own"].x = 120;
        moved.boards[0].updatedAt = "new-layout-time";
        const after = await exportFiles(moved, courses, options, assets);
        assert.deepEqual(
          first[`${base}/cards/own.md`],
          after[`${base}/cards/own.md`],
        );
        assert.notDeepEqual(
          first[`${base}/canvas.json`],
          after[`${base}/canvas.json`],
        );
      },
    );
    await t.test(
      "分享默认排除问答、课件摘录、图片，并移除悬空引用",
      async () => {
        const files = await exportFiles(
          state,
          courses,
          {
            mode: "share",
            includeAssets: false,
            excerptIds: [],
            courseId: "course-a",
          },
          assets,
        );
        assert.ok(
          !Object.keys(files).some(
            (name) =>
              name.includes("course-b") ||
              name.startsWith("boards/") ||
              name.startsWith("assets/") ||
              name.includes("conversations/") ||
              name.endsWith("/raw.md") ||
              name.endsWith("/quote.md"),
          ),
        );
        assert.ok(
          !decode(files[`${base}/cards/summary.md`]).includes("excerptId"),
        );
        const canvas = JSON.parse(decode(files[`${base}/canvas.json`]));
        for (const id of [
          "shape:raw",
          "shape:quote",
          "asset:image",
          "shape:image",
          "binding:raw",
        ])
          assert.equal(canvas.document.store[id], undefined);
        assert.equal(
          canvas.document.store["shape:bookmark"].props.assetId,
          null,
        );
        assert.equal(
          canvas.document.store["shape:bookmark"].props.url,
          "https://example.com/source",
        );
        assert.equal(canvas.session, undefined);
        assert.equal(
          JSON.parse(decode(files[`${base}/chapter.json`])).progress,
          undefined,
        );
        const explicit = await exportFiles(
          state,
          courses,
          { mode: "share", includeAssets: false, excerptIds: ["excerpt-a"] },
          assets,
        );
        assert.ok(explicit[`${base}/cards/raw.md`]);
        assert.ok(explicit[`${base}/conversations/excerpt-a.json`]);
      },
    );
    await t.test("错范围、缺失资源和路径越界中止导出", async () => {
      assert.throws(
        () => exportCatalog(state, courses, "unknown"),
        /课程不存在/,
      );
      await assert.rejects(
        exportFiles(
          state,
          courses,
          { ...options, courseId: "course-b" },
          assets,
        ),
        /问答已变化/,
      );
      await assert.rejects(
        exportFiles(
          state,
          courses,
          { ...options, excerptIds: ["missing"] },
          assets,
        ),
        /问答已变化/,
      );
      const broken = structuredClone(state);
      (broken.boards[0].document as any).store["asset:image"].props.src =
        "/api/assets/missing.png";
      await assert.rejects(
        exportFiles(broken, courses, options, assets),
        /图片引用无效/,
      );
      (broken.boards[0].document as any).store["asset:image"].props.src =
        "/api/assets/22222222-2222-2222-2222-222222222222.png";
      await assert.rejects(
        exportFiles(broken, courses, options, assets),
        /图片缺失/,
      );
      await writeFile(path.join(directory, "private.png"), "private");
      await symlink(
        path.join(directory, "private.png"),
        path.join(assets, "22222222-2222-2222-2222-222222222222.png"),
      );
      await assert.rejects(
        exportFiles(broken, courses, options, assets),
        /路径越界/,
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
