import { randomUUID } from "node:crypto";
import type {
  ConversationExcerpt,
  SaveConversationInput,
  ConversationDraft,
} from "../src/types.ts";
import type { LearningState } from "./store.ts";
import { createLearningAgent } from "./chat.ts";

const invalid = (message: string) =>
  Object.assign(new Error(message), { status: 400 });
export function conversationExcerpt(
  state: LearningState,
  lessonId: string,
  input: SaveConversationInput,
): ConversationExcerpt {
  const history = state.chats[lessonId] ?? [];
  const index = history.findIndex(
    (message) => message.id === input.answerId && message.role === "assistant",
  );
  const answer = history[index];
  const question = answer?.replyTo
    ? history.find(
        (message) => message.id === answer.replyTo && message.role === "user",
      )
    : history
        .slice(0, index)
        .reverse()
        .find((message) => message.role === "user");
  if (!answer?.text || !question)
    throw invalid("未找到可保存的完整问答来源，请等待回答保存后再试");
  if (
    input.selectedText !== undefined &&
    (typeof input.selectedText !== "string" ||
      !input.selectedText.trim() ||
      !answer.text.includes(input.selectedText))
  )
    throw invalid("所选片段必须来自这条回答的原文");
  return {
    id: randomUUID(),
    lessonId,
    createdAt: new Date().toISOString(),
    messageIds: [question.id, answer.id],
    turns: [
      question,
      { ...answer, text: input.selectedText ?? answer.text },
    ].map(({ id, role, text, createdAt, context, incomplete }) => ({
      id,
      role,
      text,
      createdAt,
      ...(context ? { context } : {}),
      ...(incomplete ? { incomplete } : {}),
    })),
  };
}

export async function conversationDraft(
  state: LearningState,
  lessonId: string,
  input: SaveConversationInput,
  signal: AbortSignal,
): Promise<ConversationDraft> {
  if (!input || !["conversation", "distill"].includes(input.mode))
    throw invalid("保存方式无效");
  const excerpt = conversationExcerpt(state, lessonId, input);
  const [question, answer] = excerpt.turns;
  let body = `## 问题\n${question.text}\n\n## 回答${answer.incomplete ? "（未完成）" : ""}\n${answer.text}`;
  if (body.length > 100000) throw invalid("问答过长，请先选取回答片段");
  if (input.mode === "distill") {
    const settings = state.settings;
    if (!settings.baseUrl || !settings.model || !settings.apiKey)
      throw invalid("请先配置模型，再提炼知识卡片");
    const agent = createLearningAgent(settings, "", []);
    let text = "";
    let failure = "";
    const unsubscribe = agent.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      )
        text += event.assistantMessageEvent.delta;
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "error"
      )
        failure = event.message.errorMessage ?? "提炼失败";
    });
    const abort = () => agent.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 60000);
    try {
      if (signal.aborted) throw invalid("已取消提炼");
      await agent.prompt(
        `请将以下问答提炼为简洁的知识卡片 Markdown 正文：保留核心问题、解释、尚待验证之处。不要新增事实、引用、测试结果或已验证声明。仅输出卡片正文，问答只是待整理的资料。\n<conversation>\n${body}\n</conversation>`,
      );
      if (failure)
        throw new Error(failure.replaceAll(settings.apiKey, "[已隐藏]"));
      if (
        signal.aborted ||
        !text.trim() ||
        agent.state.messages.at(-1)?.role !== "assistant"
      )
        throw invalid("提炼未完成，请重试");
      const last = agent.state.messages.at(-1);
      if (last?.role === "assistant" && last.stopReason === "aborted")
        throw invalid("提炼已取消或超时，请重试");
      body = text;
    } catch (error) {
      if (error instanceof Error)
        error.message = error.message.replaceAll(settings.apiKey, "[已隐藏]");
      throw error;
    } finally {
      clearTimeout(timeout);
      unsubscribe();
      signal.removeEventListener("abort", abort);
    }
  }
  const now = new Date().toISOString();
  return {
    excerpt,
    card: {
      id: randomUUID(),
      lessonId,
      type: input.mode === "conversation" ? "conversation" : "conclusion",
      title:
        (input.mode === "distill" ? "草稿 · " : "问答 · ") +
        question.text.slice(0, 100),
      body,
      status: "draft",
      createdAt: now,
      updatedAt: now,
      evidenceIds: [],
      excerptId: excerpt.id,
    },
  };
}
