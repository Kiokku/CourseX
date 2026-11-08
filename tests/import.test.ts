import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTLSchema, defaultShapeSchemas } from "@tldraw/tlschema";
import { T } from "@tldraw/validate";
import type { AddressInfo } from "node:net";
import { Store } from "../server/store.ts";
import { Library } from "../server/library.ts";
import { createApp } from "../server/app.ts";
import { exportFiles, exportZip } from "../server/export.ts";
import { readImport, previewImport, applyImport } from "../server/import.ts";

const schema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    "knowledge-card": { props: { w: T.number, h: T.number, cardId: T.string } },
  },
});
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const decode = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));

test("同版本恢复：真实结构、原子确认、冲突和资源校验", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coursex-import-"));
  const library = new Library(path.join(directory, "library"));
  const lessonPath = path.join(library.root, "React", "01 JSX");
  await mkdir(lessonPath, { recursive: true });
  await writeFile(path.join(lessonPath, "课件.md"), "# JSX\n用于恢复测试。");
  const source = new Store(path.join(directory, "source"));
  await source.init();
  const courses = await library.scan();
  const lessonId = courses[0].lessons[0].id;
  const assets = path.join(source.directory, "assets");
  await mkdir(assets);
  const imageName = "11111111-1111-1111-1111-111111111111.png";
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(path.join(assets, imageName), image);
  const now = "2026-11-08T01:00:00.000Z";
  const doc = {
    schema: schema.serialize(),
    store: {
      "document:document": schema.types.document.create({
        id: "document:document",
      }),
      "user:test": schema.types.user.create({
        id: "user:test",
        name: "学习者",
        color: "#333333",
      } as any),
      "page:main": schema.types.page.create({
        id: "page:main",
        name: "Page 1",
        index: "a1" as any,
      }),
      "shape:card": schema.types.shape.create({
        id: "shape:card",
        type: "knowledge-card",
        x: 135,
        y: 240,
        parentId: "page:main",
        index: "a1" as any,
        props: { w: 300, h: 240, cardId: "card-a" },
      } as any),
      "shape:image": schema.types.shape.create({
        id: "shape:image",
        type: "image",
        x: 500,
        y: 240,
        parentId: "page:main",
        index: "a2" as any,
        props: {
          w: 100,
          h: 100,
          playing: true,
          url: "",
          assetId: "asset:img",
          crop: null,
          flipX: false,
          flipY: false,
          altText: "",
        },
      } as any),
      "asset:img": schema.types.asset.create({
        id: "asset:img",
        type: "image",
        props: {
          name: "test.png",
          src: `/api/assets/${imageName}`,
          w: 1,
          h: 1,
          fileSize: image.length,
          mimeType: "image/png",
          isAnimated: false,
        },
      } as any),
    },
  };
  await source.update((state) => {
    state.boards.push({
      id: "main",
      name: "JSX 主画布",
      revision: 3,
      updatedAt: now,
      document: doc,
      session: {
        version: 0,
        currentPageId: "page:main",
        pageStates: [
          {
            pageId: "page:main",
            camera: { x: 11, y: 12, z: 1.5 },
            selectedShapeIds: ["shape:card"],
          },
        ],
      },
    });
    state.boards.push({
      id: "draft",
      name: "独立草稿",
      revision: 0,
      updatedAt: now,
      document: null,
    });
    state.primaryBoards[lessonId] = "main";
    state.cards["card-a"] = {
      id: "card-a",
      lessonId,
      type: "conversation",
      title: "JSX 与 DOM",
      body: "自己验证的正文。\n\n第二段。",
      status: "verified",
      createdAt: now,
      updatedAt: now,
      evidenceIds: ["evidence-a"],
      excerptId: "excerpt-a",
    };
    state.evidence["evidence-a"] = {
      id: "evidence-a",
      sourceType: "url",
      uri: "https://react.dev/",
      version: "18",
    };
    state.excerpts["excerpt-a"] = {
      id: "excerpt-a",
      lessonId,
      createdAt: now,
      messageIds: ["q", "a"],
      turns: [
        { id: "q", role: "user", text: "JSX 是 DOM 吗？", createdAt: null },
        {
          id: "a",
          role: "assistant",
          text: "不是。",
          createdAt: now,
          incomplete: true,
          context: { model: "test", handoutHash: "a".repeat(64) },
        },
      ],
    };
    state.progress[lessonId] = { position: 45, rate: 1.5 };
  });
  const files = await exportFiles(
    await source.snapshot(),
    courses,
    { mode: "private", excerptIds: ["excerpt-a"], includeAssets: true },
    assets,
  );
  const bytes = exportZip(files);
  const target = new Store(path.join(directory, "target"));
  await target.init();
  await mkdir(path.join(target.directory, "assets"));
  try {
    await t.test(
      "预览不落盘；确认还原卡片、来源、主画布、视口和图片，重启后可读",
      async () => {
        const pkg = readImport(bytes);
        const preview = previewImport(pkg, await target.snapshot(), courses);
        assert.equal(
          preview.rows.filter((row) => row.status === "ready").length,
          2,
        );
        assert.equal(
          (await readdir(target.directory)).includes("state.json"),
          false,
        );
        assert.deepEqual(
          await readdir(path.join(target.directory, "assets")),
          [],
        );
        const result = await applyImport(pkg, target, courses, preview.token);
        assert.equal(result.imported, 2);
        assert.equal(target.state.primaryBoards[lessonId], "main");
        assert.deepEqual(target.state.cards, source.state.cards);
        assert.deepEqual(target.state.evidence, source.state.evidence);
        assert.deepEqual(target.state.excerpts, source.state.excerpts);
        assert.deepEqual(target.state.progress, source.state.progress);
        assert.deepEqual(
          target.state.boards[0].session,
          source.state.boards[0].session,
        );
        const restoredDoc = target.state.boards[0].document as typeof doc;
        assert.deepEqual(
          restoredDoc.store["shape:card"],
          doc.store["shape:card"],
        );
        const src = (restoredDoc.store["asset:img"] as any).props.src!;
        assert.match(src, /^\/api\/assets\/[a-f0-9-]+\.png$/);
        assert.deepEqual(
          await readFile(
            path.join(target.directory, "assets", path.basename(src)),
          ),
          image,
        );
        const normalized = structuredClone(restoredDoc);
        (normalized.store["asset:img"] as any).props.src =
          `/api/assets/${imageName}`;
        assert.deepEqual(normalized, doc);
        const restoredFiles = await exportFiles(
          target.state,
          courses,
          {
            mode: "private",
            excerptIds: ["excerpt-a"],
            includeAssets: true,
          },
          path.join(target.directory, "assets"),
        );
        for (const file of Object.keys(files).filter((name) =>
          /\/(cards|evidence|conversations)\//.test(name),
        ))
          assert.deepEqual(
            restoredFiles[file],
            files[file],
            `恢复后语义文件应一致：${file}`,
          );
        const restart = new Store(target.directory);
        await restart.init();
        assert.deepEqual(restart.state, target.state);
        assert.deepEqual(target.state.chats, {});
        assert.equal(target.state.settings.apiKey, "");
      },
    );
    await t.test(
      "重复导入跳过、保留本地更改；已预览数据变化时拒绝确认",
      async () => {
        const pkg = readImport(bytes);
        const before = await readFile(
          path.join(target.directory, "state.json"),
        );
        assert.ok(
          previewImport(pkg, target.state, courses).rows.every(
            (row) => row.status === "conflict",
          ),
        );
        await assert.rejects(
          applyImport(pkg, target, courses, "old-preview"),
          /重新预览/,
        );
        assert.deepEqual(
          await readFile(path.join(target.directory, "state.json")),
          before,
        );
        const empty = new Store(path.join(directory, "changed"));
        await empty.init();
        await mkdir(path.join(empty.directory, "assets"));
        const preview = previewImport(pkg, empty.state, courses);
        await empty.update((state) => {
          state.progress[lessonId] = { position: 99, rate: 1 };
        });
        await assert.rejects(
          applyImport(pkg, empty, courses, preview.token),
          /重新预览/,
        );
        assert.equal(empty.state.progress[lessonId].position, 99);
        assert.equal(empty.state.boards.length, 0);
        const next = previewImport(pkg, empty.state, courses);
        assert.equal(next.rows.find((row) => row.lessonId)?.status, "conflict");
        await applyImport(pkg, empty, courses, next.token);
        assert.deepEqual(
          empty.state.boards.map((b) => b.id),
          ["draft"],
        );
      },
    );
    await t.test("新增提交期间发生冲突，不覆盖且清理暂存图片", async () => {
      const concurrent = new Store(path.join(directory, "concurrent"));
      await concurrent.init();
      await mkdir(path.join(concurrent.directory, "assets"));
      const pkg = readImport(bytes);
      const preview = previewImport(pkg, concurrent.state, courses);
      const pending = applyImport(pkg, concurrent, courses, preview.token);
      const rejected = assert.rejects(pending, /重新预览/);
      await concurrent.update((state) => {
        state.progress[lessonId] = { position: 88, rate: 1 };
      });
      await rejected;
      assert.equal(concurrent.state.progress[lessonId].position, 88);
      assert.equal(concurrent.state.boards.length, 0);
      assert.deepEqual(
        await readdir(path.join(concurrent.directory, "assets")),
        [],
      );
    });
    await t.test(
      "分享包只恢复实际内容，不补回省略的对话、图片和视口",
      async () => {
        const share = readImport(
          exportZip(
            await exportFiles(
              source.state,
              courses,
              {
                mode: "share",
                excerptIds: [],
                includeAssets: false,
              },
              assets,
            ),
          ),
        );
        const empty = new Store(path.join(directory, "share"));
        await empty.init();
        await mkdir(path.join(empty.directory, "assets"));
        const preview = previewImport(share, empty.state, courses);
        await applyImport(share, empty, courses, preview.token);
        assert.deepEqual(empty.state.cards, {});
        assert.deepEqual(empty.state.excerpts, {});
        assert.deepEqual(empty.state.progress, {});
        assert.equal(empty.state.boards[0].session, undefined);
        assert.deepEqual(
          await readdir(path.join(empty.directory, "assets")),
          [],
        );
      },
    );
    await t.test("章节缺失不伪造课程，不按同名标题错误匹配", () => {
      const pkg = readImport(bytes);
      const preview = previewImport(pkg, new Store("").state, []);
      assert.equal(preview.rows.find((row) => row.lessonId)?.status, "missing");
    });
    await t.test(
      "错误版本、缺失或损坏图片、未知对象、无效引用和路径越界均拒绝",
      () => {
        const modify = (mutate: (copy: typeof files) => void) => {
          const copy = structuredClone(files);
          mutate(copy);
          return () => readImport(exportZip(copy));
        };
        assert.throws(
          modify((copy) => {
            const m = decode(copy["manifest.json"]);
            m.schemaVersion = 2;
            copy["manifest.json"] = encode(m);
          }),
          /schemaVersion/,
        );
        assert.throws(
          modify((copy) => {
            copy[`assets/${imageName}`] = encode("bad bytes");
          }),
          /摘要/,
        );
        assert.throws(
          modify((copy) => {
            delete copy[`assets/${imageName}`];
          }),
          /索引|缺失/,
        );
        const canvas = `courses/${courses[0].id}/chapters/${lessonId}/canvas.json`;
        assert.throws(
          modify((copy) => {
            const v = decode(copy[canvas]);
            v.document.store["shape:card"].type = "alien-shape";
            copy[canvas] = encode(v);
          }),
          /未知对象/,
        );
        assert.throws(
          modify((copy) => {
            const v = decode(copy[canvas]);
            v.document.store["shape:card"].props.cardId = "missing";
            copy[canvas] = encode(v);
          }),
          /缺失/,
        );
        assert.throws(
          modify((copy) => {
            const v = decode(copy[canvas]);
            v.document.store["asset:img"].props.src =
              "../../../../../../private.png";
            copy[canvas] = encode(v);
          }),
          /图片资源缺失/,
        );
        assert.throws(
          modify((copy) => {
            copy["../escape"] = encode("bad");
          }),
          /路径/,
        );
        assert.throws(() => readImport(Buffer.from("not zip")), /ZIP/);
      },
    );
    await t.test("写盘失败时不提交状态且清理已暂存图片", async () => {
      const broken = new Store(path.join(directory, "broken"));
      await broken.init();
      await mkdir(path.join(broken.directory, "assets"));
      await mkdir(path.join(broken.directory, "state.json.tmp"));
      const pkg = readImport(bytes);
      const preview = previewImport(pkg, broken.state, courses);
      await assert.rejects(applyImport(pkg, broken, courses, preview.token));
      assert.equal(broken.state.boards.length, 0);
      assert.deepEqual(
        await readdir(path.join(broken.directory, "assets")),
        [],
      );
    });
    await t.test(
      "API 必须预览后确认，来源校验、上传类型与 ZIP 错误报告",
      async () => {
        const apiStore = new Store(path.join(directory, "api"));
        const server = (await createApp(library, apiStore)).listen(
          0,
          "127.0.0.1",
        );
        await new Promise<void>((resolve) => server.once("listening", resolve));
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const send = (action: string, token?: string, origin?: string) =>
          fetch(`${url}/api/import/${action}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/zip",
              ...(token ? { "X-CourseX-Import-Preview": token } : {}),
              ...(origin ? { Origin: origin } : {}),
            },
            body: Buffer.from(bytes),
          });
        try {
          assert.equal((await send("confirm")).status, 400);
          assert.equal(
            (await send("preview", undefined, "https://foreign.example"))
              .status,
            403,
          );
          const preview = await (await send("preview")).json();
          assert.equal(apiStore.state.boards.length, 0);
          const confirmed = await send("confirm", preview.token);
          assert.equal(confirmed.status, 200);
          assert.equal((await confirmed.json()).imported, 2);
          assert.equal(apiStore.state.boards.length, 2);
          const invalid = await fetch(`${url}/api/import/preview`, {
            method: "POST",
            headers: { "Content-Type": "application/zip" },
            body: "bad",
          });
          assert.equal(invalid.status, 400);
          assert.match((await invalid.json()).error, /ZIP/);
        } finally {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
