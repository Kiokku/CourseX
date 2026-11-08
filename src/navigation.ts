export interface LearningLocation {
  lessonId: string;
  cardId?: string;
  board: boolean;
}
// The origin is environment-specific. Identity lives in the query, not in names or paths.
export function learningLink(lessonId: string, cardId?: string, board = true) {
  const query = new URLSearchParams({ lesson: lessonId });
  if (cardId) query.set("card", cardId);
  if (board) query.set("view", "board");
  return `/?${query}`;
}
export function learningLocation(search: string): LearningLocation | null {
  const query = new URLSearchParams(search);
  const lessonId = query.get("lesson");
  const cardId = query.get("card") ?? undefined;
  const valid = (value: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(value);
  if (!lessonId) return null;
  if (!valid(lessonId) || (cardId !== undefined && !valid(cardId)))
    throw new Error("章节或卡片链接无效");
  return { lessonId, cardId, board: query.get("view") === "board" || !!cardId };
}
