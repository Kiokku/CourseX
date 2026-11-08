import { createContext, useContext } from "react";
import { BaseBoxShapeUtil, HTMLContainer, T, type TLBaseShape } from "tldraw";
import { evidenceHref } from "./CardSources";
import type { Card, Evidence } from "./types";

declare module "tldraw" {
  interface TLGlobalShapePropsMap {
    "knowledge-card": { w: number; h: number; cardId: string };
  }
}
type KnowledgeShape = TLBaseShape<
  "knowledge-card",
  { w: number; h: number; cardId: string }
>;
export const CardContext = createContext<{
  cards: Record<string, Card>;
  edit: (id: string) => void;
  evidence: Record<string, Evidence>;
  targets: Record<
    string,
    Pick<Card, "id" | "lessonId" | "title" | "status"> | null
  >;
  navigate: (lessonId: string, cardId: string) => void;
}>({
  cards: {},
  evidence: {},
  targets: {},
  edit: () => {},
  navigate: () => {},
});
const labels = {
  text: "笔记",
  question: "问题",
  conclusion: "结论",
  source: "代码 / 来源",
  conversation: "对话",
  reference: "章节引用",
  experiment: "交互实验",
};
function CardView({ shape }: { shape: KnowledgeShape }) {
  const { cards, edit, evidence, targets, navigate } = useContext(CardContext);
  const card = cards[shape.props.cardId];
  const target = targets[shape.props.cardId];
  return (
    <HTMLContainer
      className="knowledge-card"
      style={{ width: shape.props.w, height: shape.props.h }}
    >
      {card ? (
        <>
          <div className="knowledge-card-heading">
            <span>
              {labels[card.type]} ·{" "}
              {card.target
                ? "只读链接"
                : card.status === "verified"
                  ? "已验证"
                  : "待验证"}
            </span>
            {card.type !== "reference" && (
              <button
                aria-label={`${card.experiment ? "打开实验" : "编辑卡片"} ${card.title}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  edit(card.id);
                }}
              >
                {card.experiment ? "运行实验" : "编辑"}
              </button>
            )}
          </div>
          <strong>
            {card.target ? (target?.title ?? card.title) : card.title}
          </strong>
          {!card.target && <p>{card.body || "点击编辑，留下你的思考。"}</p>}
          {card.target && (
            <div onPointerDown={(event) => event.stopPropagation()}>
              <p>
                {target
                  ? `原卡片 · ${target.status === "verified" ? "已验证" : "待验证"}`
                  : "目标已失效，或未随导出包恢复"}
              </p>
              <button
                disabled={!target}
                onClick={() =>
                  navigate(card.target!.lessonId, card.target!.cardId)
                }
              >
                打开原章节并定位
              </button>
            </div>
          )}
          <div
            className="knowledge-card-sources"
            onPointerDown={(event) => event.stopPropagation()}
          >
            {card.excerptId && (
              <button onClick={() => edit(card.id)}>查看原问答</button>
            )}
            {card.evidenceIds.slice(0, 2).map((id) => {
              const source = evidence[id];
              const href = source && evidenceHref(source.uri);
              return source ? (
                href ? (
                  <a
                    key={id}
                    href={href}
                    title={source.uri}
                    target="_blank"
                    rel="noreferrer"
                  >
                    来源{source.version ? ` · ${source.version}` : ""} ↗
                  </a>
                ) : (
                  <span key={id} title={source.uri}>
                    {source.sourceType === "test" ? "测试记录" : "来源记录"}
                    {source.version ? ` · ${source.version}` : ""}
                  </span>
                )
              ) : null;
            })}
          </div>
        </>
      ) : (
        <p>卡片内容缺失，请保留画板并检查数据。</p>
      )}
    </HTMLContainer>
  );
}
export class KnowledgeCardUtil extends BaseBoxShapeUtil<KnowledgeShape> {
  static override type = "knowledge-card" as const;
  static override props = { w: T.number, h: T.number, cardId: T.string };
  override getDefaultProps() {
    return { w: 300, h: 240, cardId: "" };
  }
  override canEdit() {
    return false;
  }
  override component(shape: KnowledgeShape) {
    return <CardView shape={shape} />;
  }
  override getIndicatorPath(shape: KnowledgeShape) {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }
}
export const knowledgeShapeUtils = [KnowledgeCardUtil];
