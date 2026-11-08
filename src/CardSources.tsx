import type { Card, Evidence, ConversationExcerpt } from "./types";
export function evidenceHref(uri: string) {
  try {
    const url = new URL(uri);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function CardSources({
  card,
  evidence,
  excerpt,
  change,
  setEvidence,
}: {
  card: Card;
  evidence: Record<string, Evidence>;
  excerpt?: ConversationExcerpt;
  change: (card: Card) => void;
  setEvidence: (value: Evidence) => void;
}) {
  return (
    <details className="card-sources" open={card.type === "source" || !!excerpt || !!card.handoutSource}>
      <summary>
        来源与证据（{card.evidenceIds.length}）{excerpt ? " · 含原问答" : ""}
      </summary>
      {card.handoutSource && (
        <details open className="excerpt-source">
          <summary>查看课件摘录来源</summary>
          <p>原文：{card.handoutSource.quote}</p>
          <small>
            课节 {card.handoutSource.lessonId}
            <br />
            课件摘要 {card.handoutSource.hash}
          </small>
        </details>
      )}
      {card.evidenceIds.map((id, index) => {
        const value = evidence[id];
        if (!value) return <p key={id}>证据内容缺失</p>;
        const href = evidenceHref(value.uri);
        return (
          <div className="evidence-editor" key={id}>
            <div className="card-editor-row">
              <select
                aria-label={`证据类型 ${index + 1}`}
                value={value.sourceType}
                onChange={(event) =>
                  setEvidence({
                    ...value,
                    sourceType: event.target.value as Evidence["sourceType"],
                  })
                }
              >
                <option value="url">网页 / 源码链接</option>
                <option value="commit">Git commit</option>
                <option value="file">代码文件路径</option>
                <option value="test">测试 / 实验结果</option>
                <option value="lesson">课程章节</option>
              </select>
              <button
                type="button"
                onClick={() =>
                  change({
                    ...card,
                    evidenceIds: card.evidenceIds.filter((item) => item !== id),
                  })
                }
              >
                移除证据 {index + 1}
              </button>
            </div>
            <input
              aria-label={`证据内容 ${index + 1}`}
              maxLength={8192}
              placeholder="链接、commit、文件路径或测试结果"
              value={value.uri}
              onChange={(event) =>
                setEvidence({ ...value, uri: event.target.value })
              }
            />
            <input
              aria-label={`证据版本 ${index + 1}`}
              maxLength={200}
              placeholder="版本（可选，例如 React 18.2.0）"
              value={value.version ?? ""}
              onChange={(event) =>
                setEvidence({ ...value, version: event.target.value })
              }
            />
            {href && (
              <a href={href} target="_blank" rel="noreferrer">
                打开来源 ↗
              </a>
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => {
          // Also works over personal LAN HTTP where crypto.randomUUID is unavailable.
          const id = `evidence_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          setEvidence({ id, sourceType: "url", uri: "" });
          change({ ...card, evidenceIds: [...card.evidenceIds, id] });
        }}
      >
        ＋ 添加证据
      </button>
      {excerpt && (
        <details className="excerpt-source" open>
          <summary>查看保存时的原问答</summary>
          <p>课节：{excerpt.lessonId}</p>
          {excerpt.turns.map((turn) => (
            <div key={turn.id}>
              <strong>
                {turn.role === "user" ? "问题" : "回答"}
                {turn.incomplete ? "（未完成）" : ""}
              </strong>
              <small>
                {turn.createdAt ?? "历史时间未知"} · 消息 {turn.id}
              </small>
              <p>{turn.text}</p>
              {turn.context && (
                <small>
                  模型：{turn.context.model}
                  <br />
                  课件摘要：{turn.context.handoutHash}
                </small>
              )}
            </div>
          ))}
        </details>
      )}
    </details>
  );
}
