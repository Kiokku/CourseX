import express from "express";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Library } from "./library.ts";
import { boardData, saveCards } from "./boards.ts";
import { Store } from "./store.ts";
import { exportCatalog, exportFiles, exportZip } from "./export.ts";
import { readImport, previewImport, applyImport } from "./import.ts";
import { handoutCard, handoutSource } from "./handout.ts";
import { conversationDraft } from "./excerpts.ts";
import { createLearningAgent } from "./chat.ts";
import type { ChatMessage } from "../src/types.ts";

const fail = (message: string, status = 400) =>
  Object.assign(new Error(message), { status });
export async function createApp(library: Library, store: Store) {
  await library.scan();
  await store.init();
  const app = express();
  app.disable("x-powered-by");
  app.use(
    "/tldraw-assets",
    express.static(
      path.resolve(import.meta.dirname, "../node_modules/@tldraw/assets"),
    ),
  );
  // Reject cross-origin writes to this personal LAN service.
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!["GET", "HEAD"].includes(req.method) && req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host)
          throw fail("请求来源无效", 403);
      } catch {
        res.status(403).json({ error: "请求来源无效" });
        return;
      }
    }
    next();
  });
  const assetsPath = path.join(store.directory, "assets");
  await mkdir(assetsPath, { recursive: true, mode: 0o700 });
  const imageTypes = new Map([
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/webp", "webp"],
    ["image/gif", "gif"],
  ]);
  app.post(
    "/api/assets",
    express.raw({ type: Array.from(imageTypes.keys()), limit: "20mb" }),
    async (req, res) => {
      const type = req.headers["content-type"]?.split(";")[0] ?? "";
      const extension = imageTypes.get(type);
      if (!extension || !Buffer.isBuffer(req.body))
        throw fail("支持 PNG、JPEG、WebP、GIF 图片，最大 20 MB");
      const name = `${randomUUID()}.${extension}`;
      await writeFile(path.join(assetsPath, name), req.body, { mode: 0o600 });
      res.json({ src: `/api/assets/${name}` });
    },
  );
  app.get("/api/assets/:name", (req, res, next) => {
    if (!/^[a-f0-9-]+\.(png|jpg|webp|gif)$/.test(req.params.name)) {
      next(fail("图片不存在", 404));
      return;
    }
    res.sendFile(path.join(assetsPath, req.params.name), { dotfiles: "allow" });
  });
  app.post(
    "/api/import/:action",
    express.raw({ type: "application/zip", limit: "100mb" }),
    async (req, res) => {
      if (!["preview", "confirm"].includes(req.params.action))
        throw fail("导入操作无效");
      if (!Buffer.isBuffer(req.body)) throw fail("请选择 ZIP 导出包");
      const pkg = readImport(req.body);
      const courses = await library.scan();
      if (req.params.action === "preview")
        res.json(previewImport(pkg, await store.snapshot(), courses));
      else {
        const token = req.headers["x-coursex-import-preview"];
        if (typeof token !== "string") throw fail("请先预览导入内容");
        res.json(await applyImport(pkg, store, courses, token));
      }
    },
  );
  app.use(express.json({ limit: "20mb" }));
  app.get("/api/library", async (_req, res) => res.json(await library.scan()));
  app.get("/api/navigation", async (req, res) => {
    if (typeof req.query.courseId !== "string") throw fail("请选择课程");
    res.attachment("coursex-navigation.json").json(await library.navigation(req.query.courseId));
  });
  app.get("/api/cards", async (req, res) => {
    const courses = await library.scan();
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase().slice(0, 200) : "";
    const lessonId = typeof req.query.lessonId === "string" ? req.query.lessonId : undefined;
    res.json(Object.values(store.state.cards)
      .filter(card => (!lessonId || card.lessonId === lessonId) && (!q || `${card.title}\n${card.body}`.toLowerCase().includes(q)))
      .map(card => {
        const course = courses.find(item => item.lessons.some(lesson => lesson.id === card.lessonId));
        const lesson = course?.lessons.find(item => item.id === card.lessonId);
        return { id: card.id, lessonId: card.lessonId, title: card.title, type: card.type, status: card.status,
          courseTitle: course?.name ?? "未关联课程", lessonTitle: lesson?.title ?? "失联章节", available: !!lesson };
      }).sort((a, b) => a.title.localeCompare(b.title, "zh-CN")));
  });
  app.get("/api/export/options", async (req, res) => {
    res.json(
      exportCatalog(
        await store.snapshot(),
        await library.scan(),
        typeof req.query.courseId === "string" ? req.query.courseId : undefined,
      ),
    );
  });
  app.post("/api/export", async (req, res) => {
    const courses = await library.scan();
    const snapshot = await store.snapshot();
    const files = await exportFiles(snapshot, courses, req.body, assetsPath);
    const archive = exportZip(files);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="coursex-export.zip"',
    );
    res.send(Buffer.from(archive));
  });
  app.get("/api/session", (_req, res) =>
    res.json({ lastLesson: store.state.lastLesson }),
  );
  app.put("/api/session", async (req, res) => {
    await library.handout(String(req.body.lessonId));
    await store.update((state) => {
      state.lastLesson = req.body.lessonId;
    });
    res.json({ ok: true });
  });
  app.get("/api/lessons/:id", async (req, res) => {
    const id = req.params.id;
    res.json({
      handout: await library.handout(id),
      chat: store.state.chats[id] ?? [],
      progress: store.state.progress[id] ?? { position: 0, rate: 1 },
    });
  });
  app.get("/api/lessons/:id/media", async (req, res) => {
    const file = String(req.query.file ?? "");
    if (
      file !== "视频.mp4" &&
      !(
        file.startsWith("images/") &&
        /\.(png|jpg|jpeg|webp|gif|svg)$/i.test(file)
      )
    )
      throw fail("不支持该文件", 403);
    const location = await library.file(req.params.id, file);
    if (file.endsWith(".svg"))
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      );
    res.sendFile(location);
  });
  app.put("/api/lessons/:id/progress", async (req, res) => {
    const { position, rate } = req.body;
    await library.handout(req.params.id);
    if (
      !Number.isFinite(position) ||
      position < 0 ||
      !Number.isFinite(rate) ||
      rate < 0.25 ||
      rate > 4
    )
      throw fail("播放进度无效");
    await store.update((state) => {
      state.progress[req.params.id] = { position, rate };
    });
    res.json({ ok: true });
  });
  app.get("/api/settings", (_req, res) => {
    const { baseUrl, model, apiKey } = store.state.settings;
    res.json({
      baseUrl,
      model,
      hasKey: Boolean(apiKey),
      tldrawLicense: process.env.TLDRAW_LICENSE_KEY ?? "",
    });
  });
  app.put("/api/settings", async (req, res) => {
    const { baseUrl, model, apiKey } = req.body;
    if (
      typeof baseUrl !== "string" ||
      typeof model !== "string" ||
      typeof apiKey !== "string"
    )
      throw fail("模型配置无效");
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw fail("请输入有效的 Base URL");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw fail("Base URL 必须为 HTTP 或 HTTPS 地址");
    if (!model.trim()) throw fail("请填写模型名");
    await store.update((state) => {
      state.settings = {
        baseUrl: baseUrl.trim().replace(/\/+$/, ""),
        model: model.trim(),
        apiKey: apiKey.trim() || state.settings.apiKey,
      };
    });
    res.json({ ok: true });
  });
  app.post("/api/lessons/:id/handout-draft", async (req, res) => {
    res.json({
      card: handoutCard(
        req.params.id,
        await library.handout(req.params.id),
        req.body?.quote,
      ),
    });
  });
  app.post("/api/lessons/:id/conversation-draft", async (req, res) => {
    await library.handout(req.params.id);
    const controller = new AbortController();
    const close = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", close);
    try {
      res.json(
        await conversationDraft(
          store.state,
          req.params.id,
          req.body,
          controller.signal,
        ),
      );
    } finally {
      res.off("close", close);
    }
  });
  app.get("/api/lessons/:id/board", async (req, res) => {
    await library.handout(req.params.id);
    const id = store.state.primaryBoards[req.params.id];
    const board = store.state.boards.find((item) => item.id === id);
    res.json(board ? boardData(store.state, board) : null);
  });
  app.post("/api/lessons/:id/board", async (req, res) => {
    await library.handout(req.params.id);
    const result = await store.update((state) => {
      const id = state.primaryBoards[req.params.id];
      let board = state.boards.find((item) => item.id === id);
      if (!board) {
        board = {
          id: randomUUID(),
          name: "章节主画布",
          updatedAt: new Date().toISOString(),
          revision: 0,
          document: null,
        };
        state.boards.push(board);
        state.primaryBoards[req.params.id] = board.id;
      }
      return boardData(state, board);
    });
    res.json(result);
  });
  app.get("/api/boards", (_req, res) =>
    res.json(
      store.state.boards.map((board) => {
        const {
          document: _document,
          session: _session,
          cards: _cards,
          evidence: _evidence,
          excerpts: _excerpts,
          targets: _targets,
          ...info
        } = boardData(store.state, board);
        return info;
      }),
    ),
  );
  app.post("/api/boards", async (req, res) => {
    const board = {
      id: randomUUID(),
      name: "未命名画板",
      updatedAt: new Date().toISOString(),
      revision: 0,
      document: null,
    };
    await store.update((state) => state.boards.push(board));
    res.status(201).json(board);
  });
  app.get("/api/boards/:id", (req, res) => {
    const board = store.state.boards.find((item) => item.id === req.params.id);
    if (!board) throw fail("画板不存在", 404);
    res.json(boardData(store.state, board));
  });
  app.put("/api/boards/:id", async (req, res) => {
    const { name, document, session, revision, cards, evidence, excerpts } =
      req.body;
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 100 ||
      !Number.isInteger(revision)
    )
      throw fail("画板数据无效");
    // Check new quote provenance before entering the synchronous transaction.
    const sources = new Map<
      string,
      NonNullable<import("../src/types.ts").Card["handoutSource"]>
    >();
    if (Array.isArray(cards))
      for (const card of cards) {
        if (card?.handoutSource && !store.state.cards[card.id]) {
          const source = card.handoutSource;
          const canonical = handoutSource(
            source.lessonId,
            await library.handout(source.lessonId),
            source.quote,
          );
          if (
            canonical.hash !== source.hash ||
            card.lessonId !== source.lessonId
          )
            throw fail("课件已变化或来源不匹配，请重新选文");
          sources.set(card.id, canonical);
        }
      }
    const result = await store.update((state) => {
      const board = state.boards.find((item) => item.id === req.params.id);
      if (!board) throw fail("画板不存在", 404);
      if (board.revision !== revision)
        throw fail(
          "画板已在其他页面修改。请保留当前内容并重新打开后再编辑。",
          409,
        );
      const semantic = boardData(state, board);
      if (semantic.lessonId) {
        if (cards === undefined)
          throw fail("保存章节画布时必须同时提交知识卡片");
        if (!Array.isArray(cards)) throw fail("知识卡片列表无效");
        for (const card of cards) {
          if (card?.handoutSource && !state.cards[card.id]) {
            const source = sources.get(card.id);
            if (!source) throw fail("课件来源无效");
            card.handoutSource = source;
          }
        }
        saveCards(state, board, document, cards, evidence, excerpts);
      } else if (
        cards?.length ||
        Object.values(document?.store ?? {}).some(
          (record: any) =>
            record?.typeName === "shape" && record.type === "knowledge-card",
        )
      )
        throw fail("请在章节主画布中创建知识卡片");
      Object.assign(board, {
        name: name.trim(),
        document,
        ...(session === undefined ? {} : { session }),
        revision: revision + 1,
        updatedAt: new Date().toISOString(),
      });
      return {
        revision: board.revision,
        updatedAt: board.updatedAt,
        cards: boardData(state, board).cards,
      };
    });
    res.json(result);
  });
  const active = new Map<string, ReturnType<typeof createLearningAgent>>();
  app.post("/api/lessons/:id/chat", async (req, res) => {
    const id = req.params.id;
    const question = req.body.question;
    if (
      typeof question !== "string" ||
      !question.trim() ||
      question.length > 10000
    )
      throw fail("请输入 1–10000 字的问题");
    if (active.has(id)) throw fail("该课节正在回答，请稍后再试", 409);
    const settings = store.state.settings;
    if (!settings.baseUrl || !settings.model || !settings.apiKey)
      throw fail("请先在“模型设置”中配置 Base URL、模型名和 API Key");
    const handout = await library.handout(id);
    if (handout.length > 150000)
      throw fail("当前课件过长，P0 暂不支持直接问答");
    if (active.has(id)) throw fail("该课节正在回答，请稍后再试", 409);
    const history = store.state.chats[id] ?? [];
    const agent = createLearningAgent(settings, handout, history);
    active.set(id, agent);
    const questionMessage: ChatMessage = {
      id: randomUUID(),
      lessonId: id,
      createdAt: new Date().toISOString(),
      role: "user",
      text: question.trim(),
    };
    const answerMessage: ChatMessage = {
      id: randomUUID(),
      lessonId: id,
      createdAt: new Date().toISOString(),
      role: "assistant",
      text: "",
      replyTo: questionMessage.id,
      context: {
        handoutHash: createHash("sha256").update(handout).digest("hex"),
        model: settings.model,
      },
    };
    const newMessages: ChatMessage[] = [...history, questionMessage];
    let answer = "",
      errorMessage = "",
      aborted = false;
    const send = (type: string, data: unknown) => {
      if (!res.destroyed && !res.writableEnded)
        res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    };
    const onClose = () => {
      if (!res.writableEnded) {
        aborted = true;
        agent.abort();
      }
    };
    res.on("close", onClose);
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      await store.update((state) => {
        state.chats[id] = newMessages;
        state.lastLesson = id;
      });
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      send("start", { question: questionMessage, answer: answerMessage });
      heartbeat = setInterval(() => {
        if (!res.destroyed) res.write(": heartbeat\n\n");
      }, 15000);
      agent.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          answer += event.assistantMessageEvent.delta;
          send("delta", event.assistantMessageEvent.delta);
        }
        if (
          event.type === "message_end" &&
          event.message.role === "assistant"
        ) {
          if (event.message.stopReason === "error")
            errorMessage = event.message.errorMessage ?? "模型调用失败";
          if (event.message.stopReason === "aborted") aborted = true;
        }
      });
      if (!aborted) await agent.prompt(question.trim());
      if (errorMessage) throw new Error(errorMessage);
    } catch (error) {
      errorMessage = (error as Error).message.replaceAll(
        settings.apiKey,
        "[已隐藏]",
      );
      if (res.headersSent) send("error", errorMessage);
      else res.status(500).json({ error: errorMessage });
    } finally {
      clearInterval(heartbeat);
      try {
        if (answer)
          newMessages.push({
            ...answerMessage,
            text: answer,
            incomplete: aborted || Boolean(errorMessage),
          });
        await store.update((state) => {
          state.chats[id] = newMessages;
        });
        if (res.headersSent)
          send("done", { incomplete: aborted || Boolean(errorMessage) });
      } catch {
        send("error", "回答未能写入本地，请保留当前页面中的内容");
      }
      active.delete(id);
      res.off("close", onClose);
      res.end();
    }
  });
  app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在" }));
  app.use(
    (
      error: Error & { status?: number; code?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = error.status ?? (error.code === "ENOENT" ? 404 : 500);
      res.status(status).json({
        error:
          status === 500 ? "本地服务处理失败，请检查服务日志" : error.message,
      });
      if (status === 500) console.error(error.message);
    },
  );
  return app;
}
