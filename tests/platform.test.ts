import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  rename,
  cp,
} from "node:fs/promises";
import { unzipSync } from "fflate";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { createApp } from "../server/app.ts";
import { Store } from "../server/store.ts";
import { Library } from "../server/library.ts";

test("本地学习平台集成", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coursex-test-"));
  const root = path.join(directory, "library");
  const lessonPath = path.join(root, "测试课程", "02-01 测试课");
  await mkdir(path.join(lessonPath, "images"), { recursive: true });
  await writeFile(path.join(lessonPath, "视频.mp4"), Buffer.from("0123456789"));
  await writeFile(
    path.join(lessonPath, "课件.md"),
    "# JSX\n当前课件真实依据。\n![](images/test.png)",
  );
  await writeFile(
    path.join(lessonPath, "images/test.png"),
    Buffer.from("image"),
  );
  await writeFile(path.join(root, "private.png"), "private");
  await symlink(
    path.join(root, "private.png"),
    path.join(lessonPath, "images/escape.png"),
  );
  const store = new Store(path.join(directory, ".coursex-data"));
  const server = (await createApp(new Library(root), store)).listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = (method: string, body: unknown) => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const request = async (route: string, options?: RequestInit) => {
    const response = await fetch(url + route, options);
    return { status: response.status, data: await response.json() };
  };
  const courses = (await request("/api/library")).data;
  const lesson = courses[0].lessons[0].id;
  let providerPayload: Record<string, any> = {};
  let slow = false;
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const piece of req) raw += piece;
    providerPayload = JSON.parse(raw);
    res.setHeader("Content-Type", "text/event-stream");
    const chunk = (text: string | null, stop: boolean) =>
      res.write(
        `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason: stop ? "stop" : null }] })}\n\n`,
      );
    chunk("课件依据：", false);
    if (slow) {
      const timer = setTimeout(() => {
        chunk("迟到的答案", true);
        res.end("data: [DONE]\n\n");
      }, 5000);
      res.on("close", () => clearTimeout(timer));
    } else {
      chunk("JSX。", false);
      chunk(null, true);
      res.end("data: [DONE]\n\n");
    }
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => provider.once("listening", resolve));
  try {
    await t.test("目录与课件读取、视频 Range、路径越界保护", async () => {
      assert.equal(courses[0].name, "测试课程");
      const media = await fetch(
        url +
          `/api/lessons/${lesson}/media?file=${encodeURIComponent("视频.mp4")}`,
        { headers: { Range: "bytes=2-5" } },
      );
      assert.equal(media.status, 206);
      assert.equal(await media.text(), "2345");
      const image = await fetch(
        url + `/api/lessons/${lesson}/media?file=images/test.png`,
      );
      assert.equal(await image.text(), "image");
      const escaped = await fetch(
        url + `/api/lessons/${lesson}/media?file=images/escape.png`,
      );
      assert.equal(escaped.status, 403);
      const traversal = await fetch(
        url + `/api/lessons/${lesson}/media?file=images/../../private.png`,
      );
      assert.equal(traversal.status, 403);
      assert.match(
        (await request(`/api/lessons/${lesson}`)).data.handout,
        /当前课件真实依据/,
      );
    });
    await t.test("画板保存、图片持久化和并发版本冲突", async () => {
      const board = (await request("/api/boards", json("POST", {}))).data;
      const saved = await request(
        `/api/boards/${board.id}`,
        json("PUT", {
          name: "独立笔记",
          document: { marker: "retained" },
          session: { camera: { x: 10, y: 20, z: 2 } },
          revision: 0,
        }),
      );
      assert.equal(saved.status, 200);
      assert.equal(
        (
          await request(
            `/api/boards/${board.id}`,
            json("PUT", { name: "覆盖", document: null, revision: 0 }),
          )
        ).status,
        409,
      );
      assert.equal(
        (await request(`/api/boards/${board.id}`)).data.name,
        "独立笔记",
      );
      const asset = await request("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: Buffer.from("saved-image"),
      });
      assert.equal(
        await (await fetch(url + asset.data.src)).text(),
        "saved-image",
      );
      const reloaded = new Store(store.directory);
      await reloaded.init();
      assert.deepEqual(reloaded.state.boards[0].session, {
        camera: { x: 10, y: 20, z: 2 },
      });
      assert.deepEqual(reloaded.state.boards[0].document, {
        marker: "retained",
      });
    });
    await t.test(
      "章节主画布幂等创建，知识与布局原子保存，删除和重启恢复",
      async () => {
        assert.equal(
          (await request(`/api/lessons/${lesson}/board`)).data,
          null,
        );
        const before = store.state.boards.length;
        const [first, second] = await Promise.all([
          request(`/api/lessons/${lesson}/board`, json("POST", {})),
          request(`/api/lessons/${lesson}/board`, json("POST", {})),
        ]);
        assert.equal(first.data.id, second.data.id);
        assert.equal(first.data.lessonId, lesson);
        assert.equal(store.state.boards.length, before + 1);
        assert.equal(
          (await request("/api/lessons/missing/board", json("POST", {})))
            .status,
          404,
        );
        assert.equal(store.state.boards.length, before + 1);
        const primary = first.data;
        const document = {
          store: {
            "shape:card-1": {
              typeName: "shape",
              type: "knowledge-card",
              x: 0,
              props: { cardId: "card-1" },
            },
          },
        };
        const card = {
          id: "card-1",
          lessonId: lesson,
          title: "JSX 为什么不是 DOM？",
          body: "我的解释",
          type: "question",
          status: "draft",
        };
        const save = (body: unknown) =>
          request(`/api/boards/${primary.id}`, json("PUT", body));
        const saved = await save({
          name: "JSX 主画布",
          document,
          revision: 0,
          cards: [card],
        });
        assert.equal(saved.status, 200);
        const semantic = structuredClone(store.state.cards[card.id]);
        assert.ok(semantic.createdAt);
        const draft = store.state.boards[0];
        assert.equal(
          (
            await request(
              `/api/boards/${draft.id}`,
              json("PUT", {
                name: draft.name,
                revision: draft.revision,
                document,
              }),
            )
          ).status,
          400,
        );
        assert.deepEqual(store.state.boards[0].document, {
          marker: "retained",
        });
        document.store["shape:card-1"].x = 200;
        assert.equal(
          (
            await save({
              name: "JSX 主画布",
              document,
              revision: 1,
              cards: [card],
            })
          ).status,
          200,
        );
        assert.deepEqual(store.state.cards[card.id], semantic);
        assert.equal(
          (
            await save({
              name: "覆盖",
              document,
              revision: 1,
              cards: [{ ...card, body: "旧页面" }],
            })
          ).status,
          409,
        );
        const snapshot = structuredClone(store.state);
        assert.equal(
          (await save({ name: "无效", document, revision: 2, cards: [] }))
            .status,
          400,
        );
        assert.equal(
          (await save({ name: "无效", document, revision: 2 })).status,
          400,
        );
        assert.equal(
          (
            await save({
              name: "无效",
              document,
              revision: 2,
              cards: [{ ...card, lessonId: "other" }],
            })
          ).status,
          400,
        );
        assert.deepEqual(store.state, snapshot);
        const otherPath = path.join(root, "测试课程", "03 另一课");
        await mkdir(otherPath);
        await writeFile(path.join(otherPath, "课件.md"), "另一章");
        const library = (await request("/api/library")).data;
        const otherLesson = library[0].lessons.find(
          (item: { title: string }) => item.title === "03 另一课",
        ).id;
        const otherBoard = (
          await request(`/api/lessons/${otherLesson}/board`, json("POST", {}))
        ).data;
        assert.notEqual(otherBoard.id, primary.id);
        assert.equal(
          (
            await request(
              `/api/boards/${otherBoard.id}`,
              json("PUT", {
                name: "另一画布",
                document,
                revision: 0,
                cards: [{ ...card, lessonId: otherLesson }],
              }),
            )
          ).status,
          400,
        );
        const reload = new Store(store.directory);
        await reload.init();
        assert.equal(reload.state.primaryBoards[lesson], primary.id);
        assert.deepEqual(reload.state.cards[card.id], semantic);
        assert.equal(
          (await request(`/api/lessons/${lesson}/board`)).data.id,
          primary.id,
        );
        assert.equal(
          (
            await save({
              name: "JSX 主画布",
              document: { store: {} },
              revision: 2,
              cards: [],
            })
          ).status,
          200,
        );
        assert.equal(store.state.cards[card.id], undefined);
        assert.equal(store.state.boards[0].name, "独立笔记");
      },
    );
    await t.test("课件选文草稿与来源原子保存，拒绝伪造及版本变化", async () => {
      const quote = "当前课件真实依据。";
      const draft = await request(
        `/api/lessons/${lesson}/handout-draft`,
        json("POST", { quote }),
      );
      assert.equal(draft.status, 200);
      assert.equal(draft.data.card.status, "draft");
      assert.equal(
        (
          await request(
            `/api/lessons/${lesson}/handout-draft`,
            json("POST", { quote: "不存在" }),
          )
        ).status,
        400,
      );
      const card = draft.data.card;
      const primary = (await request(`/api/lessons/${lesson}/board`)).data;
      const document = {
        store: {
          [`shape:${card.id}`]: {
            typeName: "shape",
            type: "knowledge-card",
            props: { cardId: card.id },
          },
        },
      };
      const body = {
        name: primary.name,
        revision: primary.revision,
        document,
        cards: [card],
        evidence: [],
        excerpts: [],
      };
      const put = (value: unknown) =>
        request(`/api/boards/${primary.id}`, json("PUT", value));
      const before = structuredClone(store.state);
      assert.equal(
        (
          await put({
            ...body,
            cards: [
              {
                ...card,
                handoutSource: { ...card.handoutSource, hash: "fake" },
              },
            ],
          })
        ).status,
        400,
      );
      const file = path.join(lessonPath, "课件.md");
      const original = await readFile(file, "utf8");
      await writeFile(file, original + "\n新增内容");
      try {
        assert.equal((await put(body)).status, 400);
      } finally {
        await writeFile(file, original);
      }
      assert.deepEqual(store.state, before);
      assert.equal((await put(body)).status, 200);
      assert.equal(
        (
          await put({
            ...body,
            revision: primary.revision + 1,
            cards: [
              {
                ...card,
                body: "自己的解释",
                handoutSource: { ...card.handoutSource, quote: "伪造" },
              },
            ],
          })
        ).status,
        200,
      );
      assert.equal(store.state.cards[card.id].handoutSource?.quote, quote);
      const reload = new Store(store.directory);
      await reload.init();
      assert.equal(reload.state.cards[card.id].body, "自己的解释");
      assert.equal(
        (
          await put({
            ...body,
            revision: primary.revision + 2,
            document: { store: {} },
            cards: [],
          })
        ).status,
        200,
      );
    });
    await t.test(
      "导出 API 返回可解压 ZIP，显式范围校验且不改变学习状态",
      async () => {
        const before = structuredClone(store.state);
        const catalog = await request(
          `/api/export/options?courseId=${courses[0].id}`,
        );
        assert.equal(catalog.status, 200);
        const response = await fetch(
          url + "/api/export",
          json("POST", {
            mode: "private",
            includeAssets: false,
            excerptIds: [],
            courseId: courses[0].id,
          }),
        );
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type")!, /application\/zip/);
        const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
        assert.ok(files["manifest.json"]);
        assert.equal(
          JSON.parse(new TextDecoder().decode(files["manifest.json"]))
            .schemaVersion,
          1,
        );
        assert.ok(
          !Object.values(files).some((bytes) =>
            new TextDecoder().decode(bytes).includes("test-secret"),
          ),
        );
        assert.equal(
          (
            await request(
              "/api/export",
              json("POST", {
                mode: "private",
                includeAssets: false,
                excerptIds: [],
                courseId: "missing",
              }),
            )
          ).status,
          404,
        );
        assert.deepEqual(store.state, before);
      },
    );
    await t.test("进度存盘和并行写入不丢失", async () => {
      await Promise.all([
        request(
          `/api/lessons/${lesson}/progress`,
          json("PUT", { position: 120, rate: 1.5 }),
        ),
        store.update((state) => {
          state.lastLesson = lesson;
        }),
      ]);
      assert.equal(
        (await request(`/api/lessons/${lesson}`)).data.progress.position,
        120,
      );
      const reloaded = new Store(store.directory);
      await reloaded.init();
      assert.equal(reloaded.state.progress[lesson].rate, 1.5);
      assert.equal(
        (
          await request(
            `/api/lessons/${lesson}/progress`,
            json("PUT", { position: -1, rate: 1 }),
          )
        ).status,
        400,
      );
    });
    await t.test("模型密钥不返回浏览器，拒绝跨来源写入", async () => {
      const settings = {
        baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
        model: "test-model",
        apiKey: "test-secret",
      };
      assert.equal(
        (await request("/api/settings", json("PUT", settings))).status,
        200,
      );
      const data = (await request("/api/settings")).data;
      assert.equal(data.hasKey, true);
      assert.equal(data.apiKey, undefined);
      assert.ok(!JSON.stringify(data).includes("test-secret"));
      assert.equal(
        (
          await request("/api/settings", {
            ...json("PUT", settings),
            headers: {
              "Content-Type": "application/json",
              Origin: "https://foreign.example",
            },
          })
        ).status,
        403,
      );
      const info = await import("node:fs/promises").then((fs) =>
        fs.stat(path.join(store.directory, "state.json")),
      );
      assert.equal(info.mode & 0o777, 0o600);
    });
    await t.test(
      "真实 Pi Agent 经过兼容接口流式返回，并携带当前课件和历史",
      async () => {
        const response = await fetch(
          url + `/api/lessons/${lesson}/chat`,
          json("POST", { question: "解释 JSX" }),
        );
        assert.equal(response.status, 200);
        const stream = await response.text();
        assert.match(stream, /"type":"delta"/);
        assert.match(stream, /"type":"done"/);
        assert.match(
          JSON.stringify(providerPayload.messages),
          /当前课件真实依据/,
        );
        const [question, answer] = store.state.chats[lesson];
        const start = stream
          .split("\n\n")
          .find((frame) => frame.includes('"type":"start"'))!;
        const metadata = JSON.parse(start.slice(6)).data;
        assert.equal(metadata.question.id, question.id);
        assert.equal(metadata.answer.id, answer.id);
        assert.equal(answer.text, "课件依据：JSX。");
        assert.equal(answer.replyTo, question.id);
        assert.equal(answer.lessonId, lesson);
        assert.ok(Number.isFinite(Date.parse(answer.createdAt!)));
        assert.equal(
          answer.context?.handoutHash,
          createHash("sha256")
            .update("# JSX\n当前课件真实依据。\n![](images/test.png)")
            .digest("hex"),
        );
        assert.equal(answer.context?.model, "test-model");
        assert.notEqual(question.id, answer.id);
        await (
          await fetch(
            url + `/api/lessons/${lesson}/chat`,
            json("POST", { question: "继续解释" }),
          )
        ).text();
        assert.ok(
          providerPayload.messages.some(
            (item: any) =>
              item.role === "assistant" && item.content.includes("JSX"),
          ),
        );
        assert.ok(
          providerPayload.messages.some(
            (item: any) =>
              item.role === "user" && item.content.includes("解释 JSX"),
          ),
        );
      },
    );
    await t.test(
      "问答预览保留真实来源，选中片段校验，提炼不改写聊天且默认草稿",
      async () => {
        const history = structuredClone(store.state.chats[lesson]);
        const preview = `/api/lessons/${lesson}/conversation-draft`;
        const raw = (
          await request(
            preview,
            json("POST", { answerId: history[1].id, mode: "conversation" }),
          )
        ).data;
        assert.equal(raw.card.type, "conversation");
        assert.equal(raw.card.status, "draft");
        assert.deepEqual(raw.excerpt.messageIds, [
          history[0].id,
          history[1].id,
        ]);
        assert.equal(raw.excerpt.turns[1].createdAt, history[1].createdAt);
        assert.deepEqual(raw.excerpt.turns[1].context, history[1].context);
        const selected = await request(
          preview,
          json("POST", {
            answerId: history[1].id,
            selectedText: "JSX",
            mode: "conversation",
          }),
        );
        assert.equal(selected.status, 200);
        assert.equal(selected.data.excerpt.turns[1].text, "JSX");
        for (const input of [
          {
            answerId: history[1].id,
            selectedText: "伪造的回答",
            mode: "conversation",
          },
          { answerId: history[0].id, mode: "conversation" },
          { answerId: "missing", mode: "conversation" },
          { answerId: history[1].id, mode: "unknown" },
        ])
          assert.equal(
            (await request(preview, json("POST", input))).status,
            400,
          );
        const summary = await request(
          preview,
          json("POST", { answerId: history[1].id, mode: "distill" }),
        );
        assert.equal(summary.status, 200);
        assert.equal(summary.data.card.status, "draft");
        assert.equal(summary.data.card.body, "课件依据：JSX。");
        assert.match(JSON.stringify(providerPayload.messages), /不要新增事实/);
        assert.deepEqual(store.state.chats[lesson], history);
        assert.equal(store.state.cards[raw.card.id], undefined);
        assert.equal(store.state.excerpts[raw.excerpt.id], undefined);
      },
    );
    await t.test(
      "问答、证据与画布原子提交，来源重启恢复，移动不改语义，移除清理",
      async () => {
        const draft = (
          await request(
            `/api/lessons/${lesson}/conversation-draft`,
            json("POST", {
              answerId: store.state.chats[lesson][1].id,
              selectedText: "JSX",
              mode: "conversation",
            }),
          )
        ).data;
        const primary = (await request(`/api/lessons/${lesson}/board`)).data;
        const uri =
          "https://github.com/facebook/react/blob/v18.2.0/packages/react/src/ReactElement.js";
        const evidence = [
          { id: "react-source", sourceType: "url", uri, version: "18.2.0" },
          {
            id: "local-test",
            sourceType: "test",
            uri: "npm test: 3 passed",
            version: "mini-react commit abc123",
          },
        ];
        draft.card.evidenceIds = evidence.map((item) => item.id);
        const document = {
          store: {
            [`shape:${draft.card.id}`]: {
              typeName: "shape",
              type: "knowledge-card",
              x: 0,
              props: { cardId: draft.card.id },
            },
          },
        };
        const body = {
          name: primary.name,
          revision: primary.revision,
          document,
          cards: [draft.card],
          evidence,
          excerpts: [draft.excerpt],
        };
        const put = (value: unknown) =>
          request(`/api/boards/${primary.id}`, json("PUT", value));
        const original = structuredClone(store.state);
        assert.equal(
          (
            await put({
              ...body,
              evidence: [
                { ...evidence[0], uri: "javascript:alert(1)" },
                evidence[1],
              ],
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await put({
              ...body,
              excerpts: [{ ...draft.excerpt, messageIds: ["fake"] }],
            })
          ).status,
          400,
        );
        assert.equal((await put({ ...body, evidence: [] })).status, 400);
        assert.deepEqual(store.state, original);
        assert.equal((await put(body)).status, 200);
        const semantic = structuredClone(store.state.cards[draft.card.id]);
        const savedExcerpt = structuredClone(
          store.state.excerpts[draft.excerpt.id],
        );
        assert.equal(savedExcerpt.turns[1].text, "JSX");
        const reload = new Store(store.directory);
        await reload.init();
        assert.deepEqual(reload.state.excerpts[draft.excerpt.id], savedExcerpt);
        const restored = (await request(`/api/boards/${primary.id}`)).data;
        assert.deepEqual(restored.evidence, evidence);
        assert.equal(restored.excerpts[0].id, draft.excerpt.id);
        document.store[`shape:${draft.card.id}`].x = 100;
        assert.equal(
          (await put({ ...body, revision: primary.revision + 1 })).status,
          200,
        );
        assert.deepEqual(store.state.cards[draft.card.id], semantic);
        // Refusing an outdated revision must not commit changed evidence either.
        const current = structuredClone(store.state);
        assert.equal(
          (
            await put({
              ...body,
              evidence: [{ ...evidence[0], version: "19" }, evidence[1]],
            })
          ).status,
          409,
        );
        assert.deepEqual(store.state, current);
        assert.equal(
          (
            await put({
              ...body,
              revision: primary.revision + 2,
              cards: [{ ...draft.card, evidenceIds: [] }],
              evidence: [],
            })
          ).status,
          200,
        );
        assert.equal(store.state.evidence["react-source"], undefined);
        assert.ok(store.state.excerpts[draft.excerpt.id]);
        assert.equal(
          (
            await put({
              ...body,
              revision: primary.revision + 3,
              document: { store: {} },
              cards: [],
              evidence: [],
              excerpts: [],
            })
          ).status,
          200,
        );
        assert.equal(store.state.excerpts[draft.excerpt.id], undefined);
        assert.equal(store.state.cards[draft.card.id], undefined);
      },
    );
    await t.test(
      "保存原问答不依赖模型配置，提炼未配置时不产生学习数据",
      async () => {
        const settings = structuredClone(store.state.settings);
        await store.update((state) => {
          state.settings = { baseUrl: "", model: "", apiKey: "" };
        });
        try {
          const snapshot = structuredClone(store.state);
          const route = `/api/lessons/${lesson}/conversation-draft`;
          const input = {
            answerId: store.state.chats[lesson][1].id,
            mode: "conversation",
          };
          assert.equal((await request(route, json("POST", input))).status, 200);
          assert.equal(
            (await request(route, json("POST", { ...input, mode: "distill" })))
              .status,
            400,
          );
          assert.equal((await request(route, json("POST", null))).status, 400);
          assert.deepEqual(store.state, snapshot);
        } finally {
          await store.update((state) => {
            state.settings = settings;
          });
        }
      },
    );
    await t.test("中止流式回答后保存已有文本，课节恢复可提问", async () => {
      slow = true;
      const controller = new AbortController();
      const response = await fetch(url + `/api/lessons/${lesson}/chat`, {
        ...json("POST", { question: "慢速回答" }),
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      await reader.read();
      const competing = await request(
        `/api/lessons/${lesson}/chat`,
        json("POST", { question: "重复请求" }),
      );
      assert.equal(competing.status, 409);
      controller.abort();
      for (
        let i = 0;
        i < 50 && !store.state.chats[lesson].at(-1)?.incomplete;
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(store.state.chats[lesson].at(-1)?.incomplete, true);
      assert.equal(store.state.chats[lesson].at(-1)?.text, "课件依据：");
      slow = false;
      assert.equal(
        (
          await fetch(
            url + `/api/lessons/${lesson}/chat`,
            json("POST", { question: "重新提问" }),
          )
        ).status,
        200,
      );
    });
    await t.test("服务重启后学习数据恢复", async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const reloaded = new Store(store.directory);
      await reloaded.init();
      assert.equal(reloaded.state.boards[0].name, "独立笔记");
      assert.ok(reloaded.state.chats[lesson].length >= 8);
      assert.equal(reloaded.state.lastLesson, lesson);
      assert.ok(
        (
          await readFile(path.join(store.directory, "state.json"), "utf8")
        ).includes("独立笔记"),
      );
    });
    await t.test("课程和课节改名后，原问答、进度与会话仍可访问", async () => {
      const messageIds = store.state.chats[lesson].map((message) => message.id);
      await rename(lessonPath, path.join(root, "测试课程", "改名课节"));
      await rename(path.join(root, "测试课程"), path.join(root, "改名课程"));
      const renamed = (await request("/api/library")).data;
      assert.equal(renamed[0].id, courses[0].id);
      assert.ok(
        renamed[0].lessons.some((item: { id: string }) => item.id === lesson),
      );
      const restored = (await request(`/api/lessons/${lesson}`)).data;
      assert.equal(restored.progress.position, 120);
      assert.deepEqual(
        restored.chat.map((message: { id: string }) => message.id),
        messageIds,
      );
      assert.equal((await request("/api/session")).data.lastLesson, lesson);
    });
  } finally {
    server.closeAllConnections();
    provider.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => provider.close(() => resolve())),
    ]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("稳定身份：并发扫描、改名、重启、移动与重复目录检测", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coursex-identity-"));
  try {
    const original = path.join(root, "原课程", "原课节");
    await mkdir(original, { recursive: true });
    await writeFile(path.join(original, "课件.md"), "# 内容");
    const library = new Library(root);
    const [first, concurrent] = await Promise.all([
      library.scan(),
      new Library(root).scan(),
    ]);
    assert.deepEqual(first, concurrent);
    const id = first[0].lessons[0].id;
    assert.equal(
      id,
      createHash("sha256").update("原课程/原课节").digest("hex").slice(0, 24),
    );
    assert.equal(first[0].lessons[0].courseId, first[0].id);
    await rename(original, path.join(root, "原课程", "新课节"));
    await rename(path.join(root, "原课程"), path.join(root, "新课程"));
    const renamed = await new Library(root).scan();
    assert.equal(renamed[0].id, first[0].id);
    assert.equal(renamed[0].lessons[0].id, id);
    assert.equal(renamed[0].lessons[0].title, "新课节");
    const movedRoot = path.join(root, "moved");
    await mkdir(movedRoot);
    await rename(path.join(root, "新课程"), path.join(movedRoot, "新课程"));
    const moved = await new Library(movedRoot).scan();
    assert.equal(moved[0].lessons[0].id, id);
    const lesson = path.join(movedRoot, "新课程", "新课节");
    await cp(lesson, path.join(movedRoot, "新课程", "复制课节"), {
      recursive: true,
    });
    await assert.rejects(new Library(movedRoot).scan(), /课节 ID 重复/);
    await rm(path.join(movedRoot, "新课程", "复制课节"), { recursive: true });
    await cp(path.join(movedRoot, "新课程"), path.join(movedRoot, "复制课程"), {
      recursive: true,
    });
    await assert.rejects(new Library(movedRoot).scan(), /课程 ID 重复/);
    await rm(path.join(movedRoot, "复制课程"), { recursive: true });
    await writeFile(
      path.join(lesson, ".coursex-id.json"),
      '{"schemaVersion":99,"id":"bad"}',
    );
    await assert.rejects(new Library(movedRoot).scan(), /身份文件无效/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v0 迁移保留画板、进度与密钥；旧消息身份只生成一次，时间未知", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coursex-migration-"));
  try {
    const legacy = {
      boards: [
        {
          id: "old-board",
          name: "旧画板",
          updatedAt: "old",
          revision: 3,
          document: { shapes: ["原图形"] },
        },
      ],
      chats: {
        lesson: [
          { role: "user", text: "旧问题" },
          { role: "assistant", text: "未完成回答", incomplete: true },
        ],
      },
      progress: { lesson: { position: 42, rate: 1.5 } },
      settings: {
        baseUrl: "https://example.com/v1",
        model: "model",
        apiKey: "secret",
      },
      lastLesson: "lesson",
    };
    const raw = JSON.stringify(legacy);
    await writeFile(path.join(directory, "state.json"), raw);
    const store = new Store(directory);
    await store.init();
    assert.equal(store.state.schemaVersion, 1);
    assert.deepEqual(store.state.boards, legacy.boards);
    assert.deepEqual(store.state.progress, legacy.progress);
    assert.deepEqual(store.state.settings, legacy.settings);
    assert.equal(store.state.lastLesson, "lesson");
    const messages = store.state.chats.lesson;
    assert.equal(new Set(messages.map((m) => m.id)).size, 2);
    assert.equal(messages[1].text, "未完成回答");
    assert.equal(messages[1].incomplete, true);
    assert.equal(messages[1].createdAt, null);
    assert.equal(messages[1].lessonId, "lesson");
    assert.deepEqual(store.state.cards, {});
    assert.equal(
      await readFile(path.join(directory, "state.v0.backup.json"), "utf8"),
      raw,
    );
    const reload = new Store(directory);
    await reload.init();
    assert.deepEqual(reload.state, store.state);
    await writeFile(
      path.join(directory, "state.json"),
      '{"schemaVersion":999}',
    );
    await assert.rejects(new Store(directory).init(), /不支持学习数据版本/);
    assert.equal(
      await readFile(path.join(directory, "state.json"), "utf8"),
      '{"schemaVersion":999}',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("知识正文独立持久化：移动画布不改变卡片、证据或问答摘录", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coursex-content-"));
  try {
    const store = new Store(directory);
    await store.init();
    await store.update((state) => {
      state.boards.push({
        id: "board",
        name: "笔记",
        revision: 0,
        updatedAt: "now",
        document: { cardId: "card", x: 0 },
      });
      state.primaryBoards.lesson = "board";
      state.cards.card = {
        id: "card",
        lessonId: "lesson",
        type: "question",
        title: "JSX",
        body: "独立的 Markdown 正文",
        status: "draft",
        createdAt: "now",
        updatedAt: "now",
        evidenceIds: ["evidence"],
        excerptId: "excerpt",
      };
      state.evidence.evidence = {
        id: "evidence",
        sourceType: "commit",
        uri: "https://example.com/commit/abc",
        version: "18.2.0",
      };
      state.excerpts.excerpt = {
        id: "excerpt",
        lessonId: "lesson",
        createdAt: "now",
        messageIds: ["message"],
        turns: [
          {
            id: "message",
            role: "assistant",
            text: "选中的解释",
            createdAt: null,
          },
        ],
      };
    });
    const before = structuredClone({
      cards: store.state.cards,
      excerpts: store.state.excerpts,
      evidence: store.state.evidence,
    });
    await store.update((state) => {
      state.boards[0].document = { cardId: "card", x: 500 };
    });
    const reload = new Store(directory);
    await reload.init();
    assert.deepEqual(
      {
        cards: reload.state.cards,
        excerpts: reload.state.excerpts,
        evidence: reload.state.evidence,
      },
      before,
    );
    assert.equal(reload.state.primaryBoards.lesson, "board");
    assert.deepEqual(reload.state.boards[0].document, {
      cardId: "card",
      x: 500,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
