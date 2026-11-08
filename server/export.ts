import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import type { Card, Course, ExportOptions } from "../src/types.ts";
import type { LearningState, SavedBoard } from "./store.ts";

const fail = (message: string, status = 400) =>
  Object.assign(new Error(message), { status });
const idPath = (id: string) => {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw fail("学习数据含无效 ID，无法导出", 409);
  return id;
};
export function exportLessons(
  state: LearningState,
  courses: Course[],
  courseId?: string,
) {
  if (courseId && !courses.some((course) => course.id === courseId))
    throw fail("课程不存在", 404);
  return new Set(
    courseId
      ? courses
          .find((course) => course.id === courseId)!
          .lessons.map((lesson) => lesson.id)
      : [
          ...courses.flatMap((course) =>
            course.lessons.map((lesson) => lesson.id),
          ),
          ...Object.keys(state.primaryBoards),
          ...Object.values(state.cards).map((card) => card.lessonId),
          ...Object.keys(state.progress),
        ],
  );
}
export function exportCatalog(
  state: LearningState,
  courses: Course[],
  courseId?: string,
) {
  const lessons = exportLessons(state, courses, courseId);
  const cards = Object.values(state.cards).filter((card) =>
    lessons.has(card.lessonId),
  );
  const refs = new Set(
    cards.flatMap((card) => (card.excerptId ? [card.excerptId] : [])),
  );
  return {
    cardCount: cards.length,
    boardCount: state.boards.filter(
      (board) =>
        !courseId ||
        Object.entries(state.primaryBoards).some(
          ([lesson, id]) => lessons.has(lesson) && id === board.id,
        ),
    ).length,
    excerpts: Object.values(state.excerpts)
      .filter((item) => refs.has(item.id))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((item) => ({
        id: item.id,
        lessonId: item.lessonId,
        title: item.turns[0]?.text.slice(0, 100) ?? "保存的问答",
        preview: item.turns[1]?.text.slice(0, 160) ?? "",
        createdAt: item.createdAt,
      })),
  };
}
function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}
const json = (value: unknown) => JSON.stringify(stable(value), null, 2) + "\n";

export async function exportFiles(
  state: LearningState,
  courses: Course[],
  options: ExportOptions,
  assetsDirectory: string,
) {
  if (
    !options ||
    !["private", "share"].includes(options.mode) ||
    (options.courseId !== undefined && typeof options.courseId !== "string") ||
    typeof options.includeAssets !== "boolean" ||
    !Array.isArray(options.excerptIds) ||
    options.excerptIds.some((id) => typeof id !== "string")
  )
    throw fail("导出选项无效");
  const lessons = exportLessons(state, courses, options.courseId);
  const allowed = new Set(
    exportCatalog(state, courses, options.courseId).excerpts.map(
      (item) => item.id,
    ),
  );
  if (options.excerptIds.some((id) => !allowed.has(id)))
    throw fail("所选问答已变化或不属于导出范围，请重新打开导出窗口", 409);
  const excerpts = new Set(options.excerptIds);
  const exportedExcerpts = new Set<string>();
  const files: Record<string, Uint8Array> = Object.create(null);
  const warnings = new Set<string>();
  const encoder = new TextEncoder();
  const secretKeys =
    /api.?key|token|cookie|password|authorization|secret|credential/i;
  const cleanText = (input: string) => {
    let text = input.replace(/\r\n?/g, "\n");
    if (state.settings.apiKey && text.includes(state.settings.apiKey)) {
      text = text.replaceAll(state.settings.apiKey, "[密钥已省略]");
      warnings.add("已清除正文中的已配置模型密钥");
    }
    text = text.replace(/https?:\/\/[^\s<>"`)\]]+/g, (original) => {
      try {
        const url = new URL(original);
        let changed = false;
        if (url.username || url.password) {
          url.username = "";
          url.password = "";
          changed = true;
        }
        for (const key of [...url.searchParams.keys()])
          if (secretKeys.test(key) || /sign|session/i.test(key)) {
            url.searchParams.delete(key);
            changed = true;
          }
        if (url.hash.includes("=") && secretKeys.test(url.hash)) {
          url.hash = "";
          changed = true;
        }
        if (changed) {
          warnings.add("已清除链接中的凭据及签名参数");
          return url.href;
        }
      } catch {
        /* A prose fragment need not be a URL. */
      }
      return original;
    });
    text = text.replace(
      /file:\/\/[^\s<>"`)\]]+|(?<![A-Za-z0-9:.])\/(?:Users|Volumes|home|private|var|tmp)\/[^\s<>"`)\]]+|(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\r\n<>"`)\]]+/g,
      () => {
        warnings.add("已省略本地绝对路径");
        return "[本地路径已省略]";
      },
    );
    return text.replace(
      /\/api\/lessons\/[^\s/]+\/media\?[^\s<>"`)\]]+/g,
      "[课程资源未导出]",
    );
  };
  const clean = (value: any): any => {
    if (typeof value === "string") return cleanText(value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => {
          if (secretKeys.test(key)) {
            warnings.add("已省略敏感元数据字段");
            return [key, "[已省略]"];
          }
          return [key, clean(item)];
        }),
      );
    return value;
  };
  const write = (name: string, value: unknown) => {
    files[name] = encoder.encode(json(clean(value)));
  };
  const keptCards = new Map(
    Object.values(state.cards)
      .filter(
        (card) =>
          lessons.has(card.lessonId) &&
          !(options.mode === "share" && card.handoutSource) &&
          !(
            card.type === "conversation" &&
            (card.excerptId
              ? !excerpts.has(card.excerptId)
              : options.mode === "share")
          ),
      )
      .map((card) => [card.id, card]),
  );
  if (options.mode === "share")
    warnings.add("分享包默认排除课件摘录；笔记与自由画布文字仍需人工检查");
  for (const [id, card] of keptCards) {
    if (card.target && !keptCards.has(card.target.cardId)) {
      if (options.mode === "share") keptCards.delete(id);
      warnings.add("部分跨章节引用目标不在包内；分享包省略这些引用卡片");
    }
  }
  const assetInfo = new Map<
    string,
    { file: string; sha256: string; bytes: number }
  >();
  const assetsRoot = await realpath(assetsDirectory);
  const canvas = async (
    board: SavedBoard,
    directory: string,
    lessonId?: string,
  ) => {
    const document: any = structuredClone(board.document);
    const records: Record<string, any> = document?.store ?? {};
    const removed = new Set<string>();
    const usedAssets = new Set<string>();
    const excludedAssets = new Set(
      Object.entries(records)
        .filter(
          ([, record]) =>
            record?.typeName === "asset" &&
            typeof record.props?.src === "string" &&
            (/\/api\/lessons\/[^/]+\/media\?/.test(record.props.src) ||
              record.props.src.startsWith("file:")),
        )
        .map(([id]) => id),
    );
    if (excludedAssets.size) warnings.add("已排除课程资源与本地文件图片引用");
    for (const [id, record] of Object.entries(records)) {
      if (record?.typeName !== "shape") continue;
      if (!options.includeAssets && record.type === "bookmark")
        record.props.assetId = null;
      if (
        (record.type === "knowledge-card" &&
          !keptCards.has(record.props?.cardId)) ||
        excludedAssets.has(record.props?.assetId) ||
        (!options.includeAssets && record.props?.assetId)
      )
        removed.add(id);
      else if (record.props?.assetId) usedAssets.add(record.props.assetId);
    }
    for (const id of usedAssets)
      if (!records[id]) throw fail("画布资源记录缺失，导出未生成", 409);
    for (const [id, record] of Object.entries(records)) {
      if (
        removed.has(id) ||
        (record?.typeName === "binding" &&
          (removed.has(record.fromId) || removed.has(record.toId))) ||
        (record?.typeName === "asset" && !usedAssets.has(id))
      ) {
        delete records[id];
        continue;
      }
      if (record?.typeName !== "asset") continue;
      const src = record.props?.src;
      if (typeof src === "string" && src.startsWith("/api/assets/")) {
        const name = src.slice("/api/assets/".length);
        if (!/^[a-f0-9-]+\.(png|jpg|webp|gif)$/.test(name))
          throw fail("画布图片引用无效", 409);
        const assetFile = await realpath(path.join(assetsRoot, name)).catch(
          () => {
            throw fail("画布图片缺失，导出未生成", 409);
          },
        );
        if (!assetFile.startsWith(assetsRoot + path.sep))
          throw fail("画布图片路径越界", 409);
        if (!assetInfo.has(name)) {
          const data = await readFile(assetFile);
          files[`assets/${name}`] = data;
          assetInfo.set(name, {
            file: `assets/${name}`,
            sha256: createHash("sha256").update(data).digest("hex"),
            bytes: data.length,
          });
        }
        record.props.src = path.posix.relative(directory, `assets/${name}`);
      } else if (src) warnings.add("外部或内嵌资源仅保留引用，未下载外部文件");
    }
    // Excluded cards must not survive as selected shape IDs in a session snapshot.
    const session: any = structuredClone(board.session);
    for (const page of session?.pageStates ?? [])
      page.selectedShapeIds = (page.selectedShapeIds ?? []).filter(
        (id: string) => !removed.has(id),
      );
    write(`${directory}/canvas.json`, {
      id: board.id,
      lessonId: lessonId ?? null,
      name: board.name,
      document,
      ...(options.mode === "private" ? { session } : {}),
    });
  };
  const chapter = async (
    lessonId: string,
    directory: string,
    courseId: string | null,
    title: string | null,
    order: number | null,
  ) => {
    idPath(lessonId);
    const cards = [...keptCards.values()]
      .filter((card) => card.lessonId === lessonId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const evidenceIds = new Set(cards.flatMap((card) => card.evidenceIds));
    const excerptIds = new Set(
      cards.flatMap((card) =>
        card.excerptId && excerpts.has(card.excerptId) ? [card.excerptId] : [],
      ),
    );
    const boardId = state.primaryBoards[lessonId] ?? null;
    write(`${directory}/chapter.json`, {
      id: lessonId,
      courseId,
      title,
      order,
      canvasId: boardId,
      cardIds: cards.map((card) => card.id),
      evidenceIds: [...evidenceIds].sort(),
      excerptIds: [...excerptIds].sort(),
      ...(options.mode === "private"
        ? { progress: state.progress[lessonId] ?? null }
        : {}),
    });
    for (const card of cards) {
      const metadata = clean({
        id: card.id,
        lessonId,
        type: card.type,
        status: card.status,
        createdAt: card.createdAt,
        updatedAt: card.updatedAt,
        evidenceIds: card.evidenceIds,
        ...(card.target ? { target: card.target } : {}),
        ...(card.experiment ? { experiment: card.experiment } : {}),
        ...(card.excerptId && excerpts.has(card.excerptId)
          ? { excerptId: card.excerptId }
          : {}),
        ...(card.handoutSource ? { handoutSource: card.handoutSource } : {}),
      });
      const frontmatter = Object.keys(metadata)
        .sort()
        .map((key) => `${key}: ${JSON.stringify(stable(metadata[key]))}`)
        .join("\n");
      files[`${directory}/cards/${idPath(card.id)}.md`] = encoder.encode(
        `---\n${frontmatter}\n---\n\n# ${cleanText(card.title).replace(/\n/g, " ")}\n\n${cleanText(card.body)}\n`,
      );
    }
    for (const id of [...evidenceIds].sort()) {
      const item = state.evidence[id];
      if (!item) throw fail("卡片证据缺失，导出未生成", 409);
      write(`${directory}/evidence/${idPath(id)}.json`, {
        id,
        sourceType: item.sourceType,
        uri: item.uri,
        version: item.version,
      });
    }
    for (const id of [...excerptIds].sort()) {
      const item = state.excerpts[id];
      if (!item || item.lessonId !== lessonId)
        throw fail("问答摘录引用无效", 409);
      exportedExcerpts.add(id);
      write(`${directory}/conversations/${idPath(id)}.json`, {
        id,
        lessonId,
        createdAt: item.createdAt,
        messageIds: item.messageIds,
        turns: item.turns.map((turn) => ({
          id: turn.id,
          role: turn.role,
          text: turn.text,
          createdAt: turn.createdAt,
          context: turn.context,
          incomplete: turn.incomplete,
        })),
      });
    }
    if (boardId) {
      const board = state.boards.find((item) => item.id === boardId);
      if (!board) throw fail("章节主画布缺失，导出未生成", 409);
      await canvas(board, directory, lessonId);
    }
  };
  const selectedCourses = courses
    .filter((course) => !options.courseId || course.id === options.courseId)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const covered = new Set<string>();
  for (const course of selectedCourses) {
    const directory = `courses/${idPath(course.id)}`;
    write(`${directory}/course.json`, {
      id: course.id,
      title: course.name,
      chapterIds: course.lessons.map((lesson) => lesson.id),
    });
    for (let order = 0; order < course.lessons.length; order++) {
      const lesson = course.lessons[order];
      covered.add(lesson.id);
      await chapter(
        lesson.id,
        `${directory}/chapters/${idPath(lesson.id)}`,
        course.id,
        lesson.title,
        order,
      );
    }
  }
  const unassigned = [...lessons].filter((id) => !covered.has(id)).sort();
  for (const id of unassigned)
    await chapter(id, `unassigned/chapters/${idPath(id)}`, null, null, null);
  const primaryIds = new Set(Object.values(state.primaryBoards));
  const drafts = options.courseId
    ? []
    : state.boards
        .filter((board) => !primaryIds.has(board.id))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const board of drafts) await canvas(board, `boards/${idPath(board.id)}`);
  files["README.md"] = encoder.encode(
    "# CourseX 学习成果导出 v1\n\n正文在 cards/*.md，来源在 evidence/ 和 conversations/，布局在 canvas.json。ID 是关联依据。assets/ 保存本次选中的自有画板图片。\n\n这是学习成果包，不含课程原视频、完整课件、模型配置或完整聊天历史。分享前仍需检查笔记、自由画布文字和图片中的私人内容与课程引用。\n\n可通过同版本 CourseX 的“导入”预览并恢复无冲突内容。已省略的内容无法补回；请保留部署电脑的完整私有数据备份。\n",
  );
  write("manifest.json", {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    mode: options.mode,
    courseId: options.courseId ?? null,
    courseIds: selectedCourses.map((course) => course.id),
    draftBoardIds: drafts.map((board) => board.id),
    unassignedLessonIds: unassigned,
    includeAssets: options.includeAssets,
    excerptIds: [...exportedExcerpts].sort(),
    assets: [...assetInfo.values()].sort((a, b) =>
      a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
    ),
    files: Object.keys(files).sort(),
    warnings: [...warnings].sort(),
  });
  return files;
}
export function exportZip(files: Record<string, Uint8Array>) {
  return zipSync(
    Object.fromEntries(
      Object.keys(files)
        .sort()
        .map((name) => [name, files[name]]),
    ),
    { level: 6, mtime: new Date(1980, 0, 1) },
  );
}
