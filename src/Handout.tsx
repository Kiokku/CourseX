import { useRef, useState } from "react";
import { Markdown } from "./Markdown";
export function Handout({
  lesson,
  text,
  save,
}: {
  lesson: string;
  text: string;
  save: (quote: string) => Promise<void>;
}) {
  const article = useRef<HTMLDivElement>(null);
  const [quote, setQuote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const capture = () => {
    const selection = window.getSelection();
    if (
      selection?.anchorNode &&
      selection.focusNode &&
      article.current?.contains(selection.anchorNode) &&
      article.current.contains(selection.focusNode)
    )
      setQuote(selection.toString().trim());
  };
  return (
    <article className="handout markdown" aria-label="课程课件">
      <div ref={article} onPointerUp={capture} onKeyUp={capture}>
        <Markdown
          lesson={lesson}
          text={text || "本课节暂无课件。你仍可观看视频和记录笔记。"}
        />
      </div>
      {quote && (
        <div
          className="handout-selection"
          role="region"
          aria-label="保存课件选文"
        >
          <span>已选 {quote.length} 字 · 保存为待验证草稿</span>
          <button
            disabled={busy || quote.length > 2000}
            onClick={() => {
              setBusy(true);
              setError("");
              void save(quote)
                .then(() => {
                  setQuote("");
                  window.getSelection()?.removeAllRanges();
                })
                .catch((error) => setError(error.message))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "保存中…" : "保存选文到画布"}
          </button>
          <button disabled={busy} onClick={() => setQuote("")}>
            取消选文
          </button>
          {quote.length > 2000 && <small>请将片段缩短至 2000 字以内。</small>}
          {error && <span role="alert">{error}</span>}
        </div>
      )}
    </article>
  );
}
