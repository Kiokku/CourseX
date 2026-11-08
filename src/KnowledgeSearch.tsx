import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { CardLocation } from "./types";

export function KnowledgeSearch({
  lessonId,
  reference = false,
  choose,
  close,
}: {
  lessonId?: string;
  reference?: boolean;
  choose: (card: CardLocation) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<CardLocation[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    input.current?.focus();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setError("");
      setItems(null);
      void api<CardLocation[]>(`/api/cards?q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      })
        .then((items) => {
          if (!controller.signal.aborted) setItems(items);
        })
        .catch((error) => {
          if (!controller.signal.aborted) setError(error.message);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  const visible = items?.filter(
    (card) =>
      !reference || (card.lessonId !== lessonId && card.type !== "reference"),
  );
  return (
    <dialog
      ref={dialog}
      className="export-dialog knowledge-search"
      onCancel={close}
      aria-labelledby="knowledge-search-title"
    >
      <header>
        <h2 id="knowledge-search-title">
          {reference ? "引用其他章节卡片" : "查找知识"}
        </h2>
        <button aria-label="关闭知识查找" onClick={close}>
          ×
        </button>
      </header>
      <label>
        搜索标题或正文
        <input
          ref={input}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="例如 ReactElement"
        />
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {error ? null : !items ? (
        <p>正在查找…</p>
      ) : visible?.length === 0 ? (
        <p>没有匹配的卡片。</p>
      ) : (
        <ul className="knowledge-results">
          {visible?.map((card) => (
            <li key={card.id}>
              <button disabled={!card.available} onClick={() => choose(card)}>
                <strong>{card.title}</strong>
                <small>
                  {card.courseTitle} / {card.lessonTitle} ·{" "}
                  {card.status === "verified" ? "已验证" : "待验证"}
                  {!card.available ? " · 章节失联" : ""}
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p>
        {reference
          ? "只保存指向原卡片的链接，正文仍在原章节。"
          : "选择结果将打开所在章节并聚焦原卡片。"}
      </p>
    </dialog>
  );
}
