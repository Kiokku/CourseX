import { useEffect, useRef, useState } from "react";
import { MessageCircle, Send, Square, Minus } from "lucide-react";
import { json } from "./api";
import { Markdown } from "./Markdown";
import type { ChatMessage, SaveConversationInput } from "./types";
export function Chat({
  lesson,
  initial,
  saveConversation,
}: {
  lesson: string;
  initial: ChatMessage[];
  saveConversation: (input: SaveConversationInput) => Promise<void>;
}) {
  const [messages, setMessages] = useState(initial);
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<{
    id: string;
    text: string;
  } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const save = async (
    message: ChatMessage,
    mode: SaveConversationInput["mode"],
  ) => {
    if (
      selection?.id === message.id &&
      (!selection.text.trim() || !message.text.includes(selection.text))
    ) {
      setError("请仅保留回答中的连续原文片段，或选择使用完整回答");
      return;
    }
    setError("");
    setNotice("");
    setSaving(message.id);
    try {
      await saveConversation({
        answerId: message.id,
        mode,
        ...(selection?.id === message.id
          ? { selectedText: selection.text }
          : {}),
      });
      setNotice(
        mode === "distill"
          ? "草稿已保存，可在画布修改与验证。"
          : "问答已保存到章节主画布。",
      );
      setOpen(false);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(null);
    }
  };
  const abort = useRef<AbortController | null>(null);
  const scrolling = useRef<HTMLDivElement>(null);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    scrolling.current?.scrollTo({ top: scrolling.current.scrollHeight });
  }, [messages, open]);
  const submit = async () => {
    if (!question.trim() || busy) return;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    abort.current = controller;
    let started = false,
      finished = false;
    try {
      const response = await fetch(`/api/lessons/${lesson}/chat`, {
        ...json("POST", { question }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error((await response.json()).error);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const updateLast = (change: (message: ChatMessage) => ChatMessage) =>
        setMessages((old) =>
          old.map((message, i) =>
            i === old.length - 1 ? change(message) : message,
          ),
        );
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (!frame.startsWith("data: ")) continue;
          const event = JSON.parse(frame.slice(6));
          if (event.type === "start") {
            setMessages((old) => [
              ...old,
              event.data.question,
              event.data.answer,
            ]);
            setQuestion("");
            started = true;
          }
          if (event.type === "delta")
            updateLast((message) => ({
              ...message,
              text: message.text + event.data,
            }));
          if (event.type === "error") {
            setError(event.data);
            updateLast((message) => ({ ...message, incomplete: true }));
          }
          if (event.type === "done") {
            finished = true;
            updateLast((message) => ({
              ...message,
              incomplete: event.data.incomplete,
            }));
          }
        }
      }
      if (!finished) throw new Error("连接中断，回答可能未完成");
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
      if (started)
        setMessages((old) =>
          old.map((message, i) =>
            i === old.length - 1 ? { ...message, incomplete: true } : message,
          ),
        );
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };
  return (
    <>
      {!open && (
        <button
          className="chat-launcher primary"
          aria-expanded={false}
          aria-controls="lesson-chat"
          onClick={() => setOpen(true)}
        >
          <MessageCircle size={20} />
          {busy ? "正在回答…" : notice ? "已保存 · 课节问答" : "课节问答"}
        </button>
      )}
      <section
        id="lesson-chat"
        className="chat-pane"
        aria-label="课节问答"
        hidden={!open}
      >
        <header>
          <h2>课节问答</h2>
          <span>依据当前课件 · Pi Agent</span>
          <button
            aria-label="收起课节问答"
            aria-expanded={true}
            aria-controls="lesson-chat"
            onClick={() => setOpen(false)}
          >
            <Minus size={18} />
          </button>
        </header>
        <div className="chat-history" ref={scrolling}>
          {!messages.length && (
            <div className="chat-empty">
              <MessageCircle size={22} />
              <span>依据当前课件提问</span>
            </div>
          )}
          {messages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <small>
                {message.role === "user" ? "你" : "学习助手"}
                {message.incomplete ? " · 未完成" : ""}
              </small>
              <Markdown
                text={message.text || (busy ? "正在思考…" : "未收到回答")}
              />
              {message.role === "assistant" && message.text && (
                <div className="message-save">
                  <details>
                    <summary>选取回答片段</summary>
                    <textarea
                      aria-label={`回答片段 ${message.id}`}
                      onKeyDown={(event) => event.stopPropagation()}
                      onKeyUp={(event) => event.stopPropagation()}
                      rows={4}
                      value={
                        selection?.id === message.id
                          ? selection.text
                          : message.text
                      }
                      onChange={(event) =>
                        setSelection({
                          id: message.id,
                          text: event.target.value,
                        })
                      }
                    />
                    <small>仅保留要保存的连续原文片段；原回答不会修改。</small>
                  </details>
                  {selection?.id === message.id && (
                    <div className="selected-excerpt">
                      已选 {selection.text.length} 字
                      <button onClick={() => setSelection(null)}>
                        使用完整回答
                      </button>
                    </div>
                  )}
                  <div className="message-save-actions">
                    <button
                      disabled={busy || saving !== null}
                      onClick={() => void save(message, "conversation")}
                    >
                      {saving === message.id ? "处理中…" : "保存问答到画布"}
                    </button>
                    <button
                      disabled={busy || saving !== null}
                      onClick={() => void save(message, "distill")}
                    >
                      提炼为草稿
                    </button>
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
        {notice && (
          <p role="status" className="chat-notice">
            {notice}
          </p>
        )}
        {error && (
          <div role="alert" className="error chat-error">
            {error}
          </div>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <textarea
            aria-label="问题"
            rows={2}
            placeholder="有什么想弄明白的？"
            value={question}
            disabled={busy}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          {busy ? (
            <button
              type="button"
              aria-label="停止生成"
              onClick={() => abort.current?.abort()}
            >
              <Square size={16} />
              停止
            </button>
          ) : (
            <button className="primary" disabled={!question.trim()}>
              <Send size={16} />
              发送
            </button>
          )}
        </form>
      </section>
    </>
  );
}
