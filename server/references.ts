import type { Card, Evidence, ConversationExcerpt } from "../src/types.ts";
import type { LearningState } from "./store.ts";
import { conversationExcerpt } from "./excerpts.ts";
const invalid = (message: string) =>
  Object.assign(new Error(message), { status: 400 });
const validId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id);

export function saveReferences(
  state: LearningState,
  lessonId: string,
  cards: Map<string, Card>,
  evidenceInput: unknown,
  excerptsInput: unknown,
) {
  const evidenceIds = new Set(
    [...cards.values()].flatMap((card) => card.evidenceIds),
  );
  const excerptIds = new Set(
    [...cards.values()].flatMap((card) =>
      card.excerptId ? [card.excerptId] : [],
    ),
  );
  const previousCards = Object.values(state.cards).filter(
    (card) => card.lessonId === lessonId,
  );
  const evidence = new Map<string, Evidence>();
  const excerpts = new Map<string, ConversationExcerpt>();
  if (evidenceInput !== undefined && !Array.isArray(evidenceInput))
    throw invalid("证据列表无效");
  if (excerptsInput !== undefined && !Array.isArray(excerptsInput))
    throw invalid("问答片段列表无效");
  for (const value of (evidenceInput ??
    [...evidenceIds].map((id) => state.evidence[id])) as Evidence[]) {
    if (
      !value ||
      !validId(value.id) ||
      !evidenceIds.has(value.id) ||
      evidence.has(value.id) ||
      !["lesson", "url", "commit", "file", "test"].includes(value.sourceType) ||
      typeof value.uri !== "string" ||
      !value.uri.trim() ||
      value.uri.length > 8192 ||
      (value.version !== undefined &&
        (typeof value.version !== "string" || value.version.length > 200))
    )
      throw invalid("证据类型、内容或引用无效");
    if (value.sourceType === "url" || /^https?:/i.test(value.uri)) {
      try {
        const url = new URL(value.uri);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new Error();
      } catch {
        throw invalid("来源链接必须是有效的 HTTP 或 HTTPS 地址");
      }
    }
    if (
      Object.values(state.cards).some(
        (card) =>
          card.lessonId !== lessonId && card.evidenceIds.includes(value.id),
      )
    )
      throw invalid("不能修改其他章节的证据");
    evidence.set(value.id, {
      id: value.id,
      sourceType: value.sourceType,
      uri: value.uri.trim(),
      ...(value.version?.trim() ? { version: value.version.trim() } : {}),
    });
  }
  for (const value of (excerptsInput ??
    [...excerptIds].map((id) => state.excerpts[id])) as ConversationExcerpt[]) {
    if (
      !value ||
      !validId(value.id) ||
      value.lessonId !== lessonId ||
      !excerptIds.has(value.id) ||
      excerpts.has(value.id)
    )
      throw invalid("问答片段引用无效");
    const previous = state.excerpts[value.id];
    if (previous) {
      if (previous.lessonId !== lessonId)
        throw invalid("不能引用其他章节的问答片段");
      excerpts.set(value.id, previous);
    } else {
      if (
        !Array.isArray(value.turns) ||
        value.turns.length !== 2 ||
        !Array.isArray(value.messageIds)
      )
        throw invalid("问答片段来源无效");
      const canonical = conversationExcerpt(state, lessonId, {
        answerId: value.turns[1]?.id,
        selectedText: value.turns[1]?.text,
        mode: "conversation",
      });
      if (
        JSON.stringify(canonical.messageIds) !==
          JSON.stringify(value.messageIds) ||
        canonical.turns[0].id !== value.turns[0]?.id
      )
        throw invalid("问答片段与原消息不匹配");
      excerpts.set(value.id, { ...canonical, id: value.id });
    }
  }
  if (evidence.size !== evidenceIds.size || excerpts.size !== excerptIds.size)
    throw invalid("卡片引用了缺失的证据或问答片段");
  for (const card of cards.values()) {
    const previous = state.cards[card.id];
    if (
      previous &&
      (JSON.stringify(previous.evidenceIds) !==
        JSON.stringify(card.evidenceIds) ||
        previous.excerptId !== card.excerptId ||
        card.evidenceIds.some(
          (id) =>
            JSON.stringify(state.evidence[id]) !==
            JSON.stringify(evidence.get(id)),
        ))
    )
      card.updatedAt = new Date().toISOString();
  }
  for (const [id, value] of evidence) state.evidence[id] = value;
  for (const [id, value] of excerpts) state.excerpts[id] = value;
  const retained = Object.values(state.cards)
    .filter((card) => card.lessonId !== lessonId)
    .concat([...cards.values()]);
  for (const id of previousCards.flatMap((card) => card.evidenceIds)) {
    if (!retained.some((card) => card.evidenceIds.includes(id)))
      delete state.evidence[id];
  }
  for (const id of previousCards.flatMap((card) =>
    card.excerptId ? [card.excerptId] : [],
  )) {
    if (!retained.some((card) => card.excerptId === id))
      delete state.excerpts[id];
  }
}
