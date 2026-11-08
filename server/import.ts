import { createHash, randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { createTLSchema, defaultShapeSchemas } from "@tldraw/tlschema";
import { T } from "@tldraw/validate";
import { validateExperiment } from "../src/diff.ts";
import type {
  Card,
  Course,
  ConversationExcerpt,
  Evidence,
  ImportPreview,
  Progress,
} from "../src/types.ts";
import type { LearningState, SavedBoard } from "./store.ts";
import { Store } from "./store.ts";

const fail = (message: string, status = 400) =>
  Object.assign(new Error(message), { status });
const check: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw fail(message);
};
const object = (value: any) =>
  value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-zA-Z0-9_-]{1,100}$/.test(value) &&
  !["__proto__", "constructor", "prototype"].includes(value);
const string = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;
const date = (value: unknown) =>
  string(value, 100) && Number.isFinite(Date.parse(value));
const ids = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every(id) &&
  new Set(value).size === value.length;
const hash = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const schema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    "knowledge-card": { props: { w: T.number, h: T.number, cardId: T.string } },
  },
});
const sessionValidator = T.object({
  version: T.number,
  currentPageId: T.string.optional(),
  isFocusMode: T.boolean.optional(),
  exportBackground: T.boolean.optional(),
  isDebugMode: T.boolean.optional(),
  isToolLocked: T.boolean.optional(),
  isGridMode: T.boolean.optional(),
  pageStates: T.arrayOf(
    T.object({
      pageId: T.string,
      camera: T.object({ x: T.number, y: T.number, z: T.number }).optional(),
      selectedShapeIds: T.arrayOf(T.string).optional(),
      focusedGroupId: T.string.nullable().optional(),
    }),
  ).optional(),
});
interface Unit {
  key: string;
  lessonId?: string;
  courseId?: string;
  title: string;
  board?: SavedBoard;
  cards: Card[];
  evidence: Evidence[];
  excerpts: ConversationExcerpt[];
  progress?: Progress;
}
export interface ImportPackage {
  digest: string;
  mode: "private" | "share";
  warnings: string[];
  units: Unit[];
  assets: Map<string, Uint8Array>;
}

// Nothing is extracted onto disk while reading or previewing an untrusted ZIP.
export function readImport(bytes: Uint8Array): ImportPackage {
  check(bytes.length <= 100 * 1024 * 1024, "ZIP 最大 100 MB");
  let total = 0;
  const names = new Set<string>();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter(entry) {
        check(!names.has(entry.name), `ZIP 含重复路径：${entry.name}`);
        names.add(entry.name);
        check(
          names.size <= 10000 &&
            entry.originalSize <= 20 * 1024 * 1024 &&
            (total += entry.originalSize) <= 200 * 1024 * 1024,
          "导入包超过限制：最多 10000 文件、单文件 20 MB、解压总计 200 MB",
        );
        check(
          !entry.name.startsWith("/") &&
            !entry.name.includes("\\") &&
            entry.name
              .split("/")
              .every((part) => part && part !== "." && part !== "..") &&
            !entry.name.includes(":"),
          "ZIP 文件路径无效",
        );
        return true;
      },
    });
  } catch (error) {
    throw fail(
      (error as { status?: number }).status
        ? (error as Error).message
        : "ZIP 损坏或格式不支持",
    );
  }
  const consumed = new Set<string>();
  const text = (name: string) => {
    check(files[name], `缺失文件：${name}`);
    consumed.add(name);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(files[name]);
    } catch {
      throw fail(`文件不是 UTF-8：${name}`);
    }
  };
  const parse = (raw: string, name: string) => {
    try {
      return JSON.parse(raw, (key, value) => {
        check(
          !["__proto__", "constructor", "prototype"].includes(key),
          `文件含无效属性：${name}`,
        );
        return value;
      });
    } catch (error) {
      throw fail(
        (error as { status?: number }).status
          ? (error as Error).message
          : `JSON 无效：${name}`,
      );
    }
  };
  const json = (name: string) => parse(text(name), name);
  const manifest = json("manifest.json");
  check(
    object(manifest) && manifest.schemaVersion === 1,
    "仅支持 schemaVersion 1 导出包",
  );
  check(
    ["private", "share"].includes(manifest.mode) &&
      ids(manifest.courseIds) &&
      ids(manifest.draftBoardIds) &&
      ids(manifest.unassignedLessonIds) &&
      ids(manifest.excerptIds) &&
      Array.isArray(manifest.files) &&
      manifest.files.every((f: unknown) => typeof f === "string") &&
      Array.isArray(manifest.assets) &&
      typeof manifest.includeAssets === "boolean" &&
      date(manifest.exportedAt),
    "导出清单格式无效",
  );
  check(
    new Set(manifest.files).size === manifest.files.length &&
      same(
        [...names].filter((name) => name !== "manifest.json").sort(),
        [...manifest.files].sort(),
      ),
    "文件索引与 ZIP 内容不一致",
  );
  text("README.md");
  const assets = new Map<string, Uint8Array>();
  for (const item of manifest.assets) {
    check(
      object(item) &&
        typeof item.file === "string" &&
        /^assets\/[a-f0-9-]+\.(png|jpg|webp|gif)$/.test(item.file) &&
        !assets.has(item.file),
      "图片清单无效",
    );
    const data = files[item.file];
    check(
      data && data.length === item.bytes && hash(data) === item.sha256,
      `图片缺失或摘要不匹配：${item.file}`,
    );
    assets.set(item.file, data);
    consumed.add(item.file);
  }
  const units: Unit[] = [];
  const seen = {
    lessons: new Set<string>(),
    boards: new Set<string>(),
    cards: new Set<string>(),
    evidence: new Map<string, string>(),
    excerpts: new Set<string>(),
  };
  const unique = (set: Set<string>, value: unknown, label: string) => {
    check(id(value) && !set.has(value), `${label} ID 无效或重复`);
    set.add(value);
  };
  const canvas = (
    directory: string,
    boardId: string,
    lessonId: string | null,
    cards: Card[],
  ): SavedBoard => {
    const value = json(`${directory}/canvas.json`);
    unique(seen.boards, boardId, "画板");
    check(
      object(value) &&
        value.id === boardId &&
        value.lessonId === lessonId &&
        string(value.name, 100) &&
        value.name.trim(),
      "画板元数据无效",
    );
    const document = value.document;
    if (document !== null) {
      check(
        object(document) && object(document.store) && object(document.schema),
        "画布快照格式无效",
      );
      // Import accepts the installed schema only; a newer/custom schema must be reported, not silently dropped.
      const sort = (v: any): any =>
        Array.isArray(v)
          ? v.map(sort)
          : object(v)
            ? Object.fromEntries(
                Object.keys(v)
                  .sort()
                  .map((k) => [k, sort(v[k])]),
              )
            : v;
      check(
        same(sort(document.schema), sort(schema.serialize())),
        "画布 schema 或对象类型不支持，请使用相同版本的 CourseX",
      );
      const records = document.store as Record<string, any>;
      const cardRefs = new Set<string>();
      check(
        records["document:document"]?.typeName === "document" &&
          Object.values(records).some((r) => r?.typeName === "page"),
        "画布缺少文档或页面",
      );
      for (const [key, record] of Object.entries(records)) {
        check(
          object(record) &&
            record.id === key &&
            Object.hasOwn(schema.types, record.typeName) &&
            schema.types[record.typeName as keyof typeof schema.types].scope ===
              "document",
          `画布对象无效：${key}`,
        );
        let packageAsset: string | undefined;
        if (
          record.typeName === "asset" &&
          typeof record.props?.src === "string" &&
          record.props.src
        ) {
          const src = record.props.src as string;
          if (/^https?:\/\//i.test(src)) {
            let url: URL;
            try {
              url = new URL(src);
            } catch {
              throw fail("外部图片链接无效");
            }
            check(!url.username && !url.password, "外部图片链接含凭据");
          } else if (!/^data:image\/(png|jpeg|webp|gif);base64,/i.test(src)) {
            packageAsset = path.posix.normalize(
              path.posix.join(directory, src),
            );
            check(assets.has(packageAsset), `图片资源缺失或引用不支持：${src}`);
            record.props.src = `/api/assets/${path.posix.basename(packageAsset)}`;
          }
        }
        try {
          schema.types[record.typeName as keyof typeof schema.types].validate(
            record,
          );
        } catch {
          throw fail(
            `未知对象类型或属性无效：${key}（${record.type ?? record.typeName}）`,
          );
        }
        if (packageAsset) record.props.src = `coursex-import:${packageAsset}`;
        if (record.typeName === "shape") {
          check(
            ["page", "shape"].includes(records[record.parentId]?.typeName),
            `画布父节点缺失：${key}`,
          );
          const visited = new Set([key]);
          let parent = records[record.parentId];
          while (parent?.typeName === "shape") {
            check(!visited.has(parent.id), "画布父节点存在循环");
            visited.add(parent.id);
            parent = records[parent.parentId];
          }
          if (record.type === "knowledge-card") {
            check(
              cards.some((card) => card.id === record.props.cardId),
              "画布引用了缺失的知识卡片",
            );
            cardRefs.add(record.props.cardId);
          }
          if (record.props.assetId)
            check(
              records[record.props.assetId]?.typeName === "asset",
              `画布图片记录缺失：${key}`,
            );
        }
        if (record.typeName === "binding")
          check(
            records[record.fromId]?.typeName === "shape" &&
              records[record.toId]?.typeName === "shape",
            "画布连接引用缺失",
          );
      }
      check(cardRefs.size === cards.length, "卡片缺少画布节点");
    } else check(cards.length === 0, "卡片缺少画布布局");
    if (value.session !== undefined) {
      try {
        sessionValidator.validate(value.session);
      } catch {
        throw fail("画布视口格式无效");
      }
      check(value.session.version === 0, "画布视口版本不支持");
      const records = document?.store ?? {};
      check(
        !value.session.currentPageId ||
          records[value.session.currentPageId]?.typeName === "page",
        "视口页面缺失",
      );
      for (const page of value.session.pageStates ?? [])
        check(
          records[page.pageId]?.typeName === "page" &&
            (!page.camera || page.camera.z > 0) &&
            (page.selectedShapeIds ?? []).every(
              (key: string) => records[key]?.typeName === "shape",
            ) &&
            (!page.focusedGroupId ||
              records[page.focusedGroupId]?.typeName === "shape"),
          "视口对象引用无效",
        );
    }
    return {
      id: boardId,
      name: value.name,
      document,
      ...(value.session === undefined ? {} : { session: value.session }),
      revision: 0,
      updatedAt: manifest.exportedAt,
    };
  };
  const chapter = (directory: string, lessonId: string, courseId?: string) => {
    unique(seen.lessons, lessonId, "章节");
    const meta = json(`${directory}/chapter.json`);
    check(
      object(meta) &&
        meta.id === lessonId &&
        meta.courseId === (courseId ?? null) &&
        (meta.canvasId === null || id(meta.canvasId)) &&
        ids(meta.cardIds) &&
        ids(meta.evidenceIds) &&
        ids(meta.excerptIds) &&
        (meta.title === null || string(meta.title, 1000)),
      "章节元数据无效",
    );
    const cards: Card[] = meta.cardIds.map((cardId: string) => {
      unique(seen.cards, cardId, "卡片");
      const file = `${directory}/cards/${cardId}.md`;
      const raw = text(file);
      const match = /^---\n([\s\S]*?)\n---\n\n# ([^\n]+)\n\n([\s\S]*)\n$/.exec(
        raw,
      );
      check(match, `卡片 Markdown 格式无效：${file}`);
      const fields: Record<string, any> = Object.create(null);
      for (const line of match[1].split("\n")) {
        const pair = /^([A-Za-z]+): (.+)$/.exec(line);
        check(
          pair &&
            !Object.hasOwn(fields, pair[1]) &&
            [
              "id",
              "lessonId",
              "type",
              "status",
              "createdAt",
              "updatedAt",
              "evidenceIds",
              "excerptId",
              "handoutSource",
              "target",
              "experiment",
            ].includes(pair[1]),
          `卡片元数据无效：${file}`,
        );
        fields[pair[1]] = parse(pair[2], file);
      }
      check(
        fields.id === cardId &&
          fields.lessonId === lessonId &&
          [
            "text",
            "question",
            "conclusion",
            "source",
            "conversation",
            "reference",
            "experiment",
          ].includes(fields.type) &&
          ["draft", "verified"].includes(fields.status) &&
          date(fields.createdAt) &&
          date(fields.updatedAt) &&
          ids(fields.evidenceIds) &&
          fields.evidenceIds.length <= 50 &&
          (fields.excerptId === undefined || id(fields.excerptId)) &&
          match[2].trim() &&
          match[2].length <= 200 &&
          match[3].length <= 100000,
        `卡片内容无效：${file}`,
      );
      if (fields.type === "experiment") {
        try {
          fields.experiment = validateExperiment(fields.experiment);
        } catch (error) {
          throw fail((error as Error).message);
        }
      } else
        check(fields.experiment === undefined, "非实验卡片不能保存实验输入");
      if (fields.type === "reference")
        check(
          object(fields.target) &&
            id(fields.target.lessonId) &&
            id(fields.target.cardId) &&
            fields.target.lessonId !== lessonId &&
            match[3] === "",
          "跨章节引用目标无效",
        );
      else check(fields.target === undefined, "非引用卡片不能关联目标");
      if (fields.handoutSource)
        check(
          object(fields.handoutSource) &&
            fields.handoutSource.lessonId === lessonId &&
            /^[a-f0-9]{64}$/.test(fields.handoutSource.hash) &&
            string(fields.handoutSource.quote, 2000) &&
            fields.handoutSource.quote.trim(),
          "课件来源快照无效",
        );
      return { ...fields, title: match[2], body: match[3] } as Card;
    });
    const evidence: Evidence[] = meta.evidenceIds.map((key: string) => {
      const value = json(`${directory}/evidence/${key}.json`);
      check(
        object(value) &&
          value.id === key &&
          ["lesson", "url", "commit", "file", "test"].includes(
            value.sourceType,
          ) &&
          string(value.uri, 8192) &&
          value.uri.trim() &&
          (value.version === undefined || string(value.version, 200)),
        "证据数据无效",
      );
      if (value.sourceType === "url" || /^https?:/i.test(value.uri)) {
        let url: URL;
        try {
          url = new URL(value.uri);
        } catch {
          throw fail("证据链接无效");
        }
        check(
          ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password,
          "证据链接协议或凭据无效",
        );
      }
      check(
        !seen.evidence.has(key) ||
          seen.evidence.get(key) === JSON.stringify(value),
        "重复证据 ID 内容不一致",
      );
      seen.evidence.set(key, JSON.stringify(value));
      return {
        id: key,
        sourceType: value.sourceType,
        uri: value.uri,
        ...(value.version === undefined ? {} : { version: value.version }),
      };
    });
    const excerpts: ConversationExcerpt[] = meta.excerptIds.map(
      (key: string) => {
        unique(seen.excerpts, key, "问答片段");
        const value = json(`${directory}/conversations/${key}.json`);
        check(
          object(value) &&
            value.id === key &&
            value.lessonId === lessonId &&
            date(value.createdAt) &&
            ids(value.messageIds) &&
            value.messageIds.length === 2 &&
            Array.isArray(value.turns) &&
            value.turns.length === 2,
          "问答片段格式无效",
        );
        for (let i = 0; i < 2; i++) {
          const turn = value.turns[i];
          check(
            object(turn) &&
              turn.id === value.messageIds[i] &&
              turn.role === ["user", "assistant"][i] &&
              string(turn.text, 150000) &&
              (turn.createdAt === null || date(turn.createdAt)) &&
              (turn.incomplete === undefined ||
                typeof turn.incomplete === "boolean"),
            "问答消息格式无效",
          );
          if (turn.context !== undefined)
            check(
              object(turn.context) &&
                string(turn.context.model, 1000) &&
                /^[a-f0-9]{64}$/.test(turn.context.handoutHash),
              "问答来源上下文无效",
            );
        }
        return {
          id: key,
          lessonId,
          createdAt: value.createdAt,
          messageIds: value.messageIds,
          turns: value.turns.map((turn: any) => ({
            id: turn.id,
            role: turn.role,
            text: turn.text,
            createdAt: turn.createdAt,
            ...(turn.incomplete === undefined
              ? {}
              : { incomplete: turn.incomplete }),
            ...(turn.context === undefined
              ? {}
              : {
                  context: {
                    model: turn.context.model,
                    handoutHash: turn.context.handoutHash,
                  },
                }),
          })),
        };
      },
    );
    check(
      same(
        [...new Set(cards.flatMap((card) => card.evidenceIds))].sort(),
        [...meta.evidenceIds].sort(),
      ) &&
        same(
          [
            ...new Set(
              cards.flatMap((card) => (card.excerptId ? [card.excerptId] : [])),
            ),
          ].sort(),
          [...meta.excerptIds].sort(),
        ),
      "卡片与来源索引不一致",
    );
    const board = meta.canvasId
      ? canvas(directory, meta.canvasId, lessonId, cards)
      : undefined;
    check(board || cards.length === 0, "章节卡片缺少主画布绑定");
    if (meta.progress != null)
      check(
        object(meta.progress) &&
          Number.isFinite(meta.progress.position) &&
          meta.progress.position >= 0 &&
          Number.isFinite(meta.progress.rate) &&
          meta.progress.rate > 0 &&
          meta.progress.rate <= 16,
        "播放进度无效",
      );
    units.push({
      key: `lesson:${lessonId}`,
      lessonId,
      courseId,
      title: meta.title ?? `失联章节 ${lessonId}`,
      board,
      cards,
      evidence,
      excerpts,
      ...(meta.progress == null ? {} : { progress: meta.progress }),
    });
  };
  for (const courseId of manifest.courseIds) {
    const directory = `courses/${courseId}`;
    const course = json(`${directory}/course.json`);
    check(
      object(course) &&
        course.id === courseId &&
        string(course.title, 1000) &&
        ids(course.chapterIds),
      "课程清单无效",
    );
    for (const lessonId of course.chapterIds)
      chapter(`${directory}/chapters/${lessonId}`, lessonId, courseId);
  }
  for (const lessonId of manifest.unassignedLessonIds)
    chapter(`unassigned/chapters/${lessonId}`, lessonId);
  for (const boardId of manifest.draftBoardIds)
    units.push({
      key: `board:${boardId}`,
      title: boardId,
      board: canvas(`boards/${boardId}`, boardId, null, []),
      cards: [],
      evidence: [],
      excerpts: [],
    });
  check(
    same([...seen.excerpts].sort(), [...manifest.excerptIds].sort()),
    "问答总索引不一致",
  );
  check(
    consumed.size === names.size,
    `存在未识别文件：${[...names]
      .filter((name) => !consumed.has(name))
      .slice(0, 3)
      .join("、")}`,
  );
  return {
    digest: hash(bytes),
    mode: manifest.mode,
    units,
    assets,
    warnings: Array.isArray(manifest.warnings)
      ? manifest.warnings.filter((v: unknown) => string(v, 1000)).slice(0, 30)
      : [],
  };
}

export function previewImport(
  pkg: ImportPackage,
  state: LearningState,
  courses: Course[],
): ImportPreview {
  const rows = pkg.units.map((unit) => {
    let status: ImportPreview["rows"][number]["status"] = "ready";
    let reason = "可新增";
    if (
      unit.lessonId &&
      !courses.some(
        (course) =>
          (!unit.courseId || course.id === unit.courseId) &&
          course.lessons.some((lesson) => lesson.id === unit.lessonId),
      )
    ) {
      status = "missing";
      reason =
        "课程库中未找到匹配的章节 ID，请先恢复课程目录及 .coursex-id.json";
    } else if (
      unit.lessonId &&
      !unit.board &&
      !unit.progress &&
      !unit.cards.length
    ) {
      status = "empty";
      reason = "没有可恢复的学习数据";
    } else if (
      (unit.lessonId &&
        (state.primaryBoards[unit.lessonId] ||
          Object.values(state.cards).some(
            (card) => card.lessonId === unit.lessonId,
          ) ||
          (unit.progress && state.progress[unit.lessonId]))) ||
      (unit.board &&
        state.boards.some((board) => board.id === unit.board!.id)) ||
      unit.cards.some((card) => Object.hasOwn(state.cards, card.id)) ||
      unit.evidence.some((item) => Object.hasOwn(state.evidence, item.id)) ||
      unit.excerpts.some((item) => Object.hasOwn(state.excerpts, item.id))
    ) {
      status = "conflict";
      reason = "已有章节数据或对象 ID 冲突，保留本地内容并跳过整个项目";
    }
    return {
      key: unit.key,
      title: unit.board?.name ?? unit.title,
      lessonId: unit.lessonId,
      status,
      reason,
      cards: unit.cards.length,
      excerpts: unit.excerpts.length,
    };
  });
  const importedCards = new Map(
    pkg.units.flatMap((unit) => unit.cards).map((card) => [card.id, card]),
  );
  const warnings = [...pkg.warnings];
  for (const card of importedCards.values()) {
    if (!card.target) continue;
    const target =
      importedCards.get(card.target.cardId) ?? state.cards[card.target.cardId];
    if (!target || target.lessonId !== card.target.lessonId)
      warnings.push(
        `引用“${card.title}”的目标不在包内或本地，恢复后将显示失效链接`,
      );
  }
  return {
    token: hash(JSON.stringify({ digest: pkg.digest, rows, warnings })),
    mode: pkg.mode,
    rows,
    assets: pkg.assets.size,
    warnings,
  };
}

export async function applyImport(
  pkg: ImportPackage,
  store: Store,
  courses: Course[],
  token: string,
) {
  const snapshot = await store.snapshot();
  const preview = previewImport(pkg, snapshot, courses);
  if (preview.token !== token)
    throw fail("导入范围或本地数据已变化，请重新预览", 409);
  const ready = new Set(
    preview.rows.filter((row) => row.status === "ready").map((row) => row.key),
  );
  check(ready.size > 0, "没有可新增的内容");
  const selected = structuredClone(
    pkg.units.filter((unit) => ready.has(unit.key)),
  );
  const staged: string[] = [];
  const assetNames = new Map<string, string>();
  try {
    for (const unit of selected)
      for (const record of Object.values(
        (unit.board?.document as any)?.store ?? {},
      ) as any[]) {
        if (
          record.typeName !== "asset" ||
          !record.props?.src?.startsWith("coursex-import:")
        )
          continue;
        const file = record.props.src.slice("coursex-import:".length);
        let name = assetNames.get(file);
        if (!name) {
          name = `${randomUUID()}${path.extname(file)}`;
          const target = path.join(store.directory, "assets", name);
          await writeFile(target, pkg.assets.get(file)!, {
            mode: 0o600,
            flag: "wx",
          });
          staged.push(target);
          assetNames.set(file, name);
        }
        record.props.src = `/api/assets/${name}`;
      }
    // Recompute the preview inside the serialized transaction, after staging assets.
    await store.update((state) => {
      if (previewImport(pkg, state, courses).token !== token)
        throw fail("本地数据已变化，请重新预览后导入", 409);
      for (const unit of selected) {
        if (unit.board) state.boards.push(unit.board);
        if (unit.lessonId && unit.board)
          state.primaryBoards[unit.lessonId] = unit.board.id;
        if (unit.lessonId && unit.progress)
          state.progress[unit.lessonId] = unit.progress;
        for (const card of unit.cards) state.cards[card.id] = card;
        for (const item of unit.evidence) state.evidence[item.id] = item;
        for (const item of unit.excerpts) state.excerpts[item.id] = item;
      }
    });
  } catch (error) {
    await Promise.all(staged.map((file) => unlink(file).catch(() => {})));
    throw error;
  }
  return {
    imported: selected.length,
    cards: selected.reduce((count, unit) => count + unit.cards.length, 0),
    skipped: preview.rows.length - selected.length,
  };
}
