import { saveReferences } from "./references.ts";
import { validateExperiment } from "../src/diff.ts";
import type { Card } from "../src/types.ts";
import type { LearningState, SavedBoard } from "./store.ts";

const invalid = (message: string) =>
  Object.assign(new Error(message), { status: 400 });
export function boardData(state: LearningState, board: SavedBoard) {
  const lessonId = Object.keys(state.primaryBoards).find(
    (id) => state.primaryBoards[id] === board.id,
  );
  const cards = Object.values(state.cards).filter(
    (card) => card.lessonId === lessonId,
  );
  return {
    ...board,
    lessonId,
    cards,
    targets: Object.fromEntries(
      cards
        .filter((card) => card.target)
        .map((card) => {
          const target = state.cards[card.target!.cardId];
          return [
            card.id,
            target && target.lessonId === card.target!.lessonId
              ? {
                  id: target.id,
                  lessonId: target.lessonId,
                  title: target.title,
                  status: target.status,
                }
              : null,
          ];
        }),
    ),
    evidence: Object.values(state.evidence).filter((item) =>
      cards.some((card) => card.evidenceIds.includes(item.id)),
    ),
    excerpts: Object.values(state.excerpts).filter((item) =>
      cards.some((card) => card.excerptId === item.id),
    ),
  };
}

// Called inside the same revision-checked Store update as the layout write.
export function saveCards(
  state: LearningState,
  board: SavedBoard,
  document: any,
  input: unknown,
  evidence?: unknown,
  excerpts?: unknown,
) {
  const lessonId = boardData(state, board).lessonId;
  if (!lessonId || !Array.isArray(input))
    throw invalid("知识卡片只能保存到章节主画布");
  const refs = new Set<string>();
  for (const record of Object.values(document?.store ?? {}) as any[]) {
    if (record.typeName === "shape" && record.type === "knowledge-card")
      refs.add(record.props?.cardId);
  }
  const cards = new Map<string, Card>();
  const now = new Date().toISOString();
  for (const value of input) {
    if (
      !value ||
      typeof value.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(value.id) ||
      value.lessonId !== lessonId ||
      ![
        "text",
        "question",
        "conclusion",
        "source",
        "conversation",
        "reference",
        "experiment",
      ].includes(value.type) ||
      typeof value.title !== "string" ||
      !value.title.trim() ||
      value.title.length > 200 ||
      typeof value.body !== "string" ||
      value.body.length > 100000 ||
      !["draft", "verified"].includes(value.status) ||
      cards.has(value.id) ||
      !refs.has(value.id)
    )
      throw invalid("知识卡片数据或画布引用无效");
    const previous = state.cards[value.id];
    if (previous && previous.lessonId !== lessonId)
      throw invalid("不能覆盖其他章节的卡片");
    let target: Card["target"];
    if (value.type === "reference") {
      const input = value.target;
      if (
        !input ||
        typeof input.lessonId !== "string" ||
        typeof input.cardId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(input.lessonId) ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(input.cardId) ||
        input.lessonId === lessonId
      )
        throw invalid("跨章节引用目标无效");
      target = { lessonId: input.lessonId, cardId: input.cardId };
      const original = state.cards[target.cardId];
      const unchanged =
        previous?.type === "reference" &&
        previous.target?.cardId === target.cardId &&
        previous.target.lessonId === target.lessonId;
      if (
        !unchanged &&
        (!original ||
          original.lessonId !== target.lessonId ||
          original.type === "reference")
      )
        throw invalid("引用目标不存在，或目标本身是引用卡片");
      if (value.body !== "") throw invalid("引用卡片只保存链接，不复制正文");
    } else if (value.target !== undefined)
      throw invalid("仅引用卡片可以关联目标");
    let experiment: Card["experiment"];
    if (value.type === "experiment") {
      try {
        experiment = validateExperiment(value.experiment);
      } catch (error) {
        throw invalid((error as Error).message);
      }
    } else if (value.experiment !== undefined)
      throw invalid("仅实验卡片可以保存实验输入");
    const evidenceIds = value.evidenceIds ?? previous?.evidenceIds ?? [];
    const excerptId = value.excerptId ?? previous?.excerptId;
    if (target && (evidenceIds.length || excerptId || value.handoutSource))
      throw invalid("引用卡片只保存目标链接");
    if (
      !Array.isArray(evidenceIds) ||
      evidenceIds.length > 50 ||
      new Set(evidenceIds).size !== evidenceIds.length ||
      evidenceIds.some((id: unknown) => typeof id !== "string") ||
      (excerptId !== undefined && typeof excerptId !== "string")
    )
      throw invalid("卡片来源引用无效");
    const fields = {
      type: value.type,
      title: value.title.trim(),
      body: value.body,
      status: value.status,
      ...(target ? { target } : {}),
      ...(experiment ? { experiment } : {}),
    };
    const changed =
      !previous ||
      Object.entries(fields).some(
        ([key, field]) =>
          JSON.stringify(previous[key as keyof Card]) !== JSON.stringify(field),
      );
    cards.set(value.id, {
      ...fields,
      id: value.id,
      lessonId,
      createdAt: previous?.createdAt ?? now,
      updatedAt: changed ? now : previous.updatedAt,
      evidenceIds,
      ...(excerptId ? { excerptId } : {}),
      ...((previous ? previous.handoutSource : value.handoutSource)
        ? {
            handoutSource: previous
              ? previous.handoutSource
              : value.handoutSource,
          }
        : {}),
    });
  }
  if (refs.size !== cards.size) throw invalid("画布引用了缺失的知识卡片");
  saveReferences(state, lessonId, cards, evidence, excerpts);
  for (const card of Object.values(state.cards)) {
    if (card.lessonId === lessonId && !cards.has(card.id))
      delete state.cards[card.id];
  }
  for (const [id, card] of cards) state.cards[id] = card;
}
