import { createHash, randomUUID } from "node:crypto";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Card } from "../src/types.ts";

const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
interface TextNode {
  type: string;
  value?: string;
  children?: TextNode[];
}
export function handoutText(markdown: string): string {
  const visit = (node: TextNode): string => {
    if (
      node.type === "image" ||
      node.type === "imageReference" ||
      node.type === "definition"
    )
      return "";
    if (node.type === "break") return "\n";
    const text = node.value ?? (node.children ?? []).map(visit).join("");
    return (
      text +
      (["paragraph", "heading", "code", "listItem", "tableRow"].includes(
        node.type,
      )
        ? "\n"
        : node.type === "tableCell"
          ? "\t"
          : "")
    );
  };
  return normalize(
    visit(unified().use(remarkParse).use(remarkGfm).parse(markdown)),
  );
}
export function handoutSource(
  lessonId: string,
  markdown: string,
  quote: unknown,
): NonNullable<Card["handoutSource"]> {
  if (typeof quote !== "string" || !quote.trim() || quote.length > 2000)
    throw Object.assign(new Error("请选择 1–2000 字的课件片段"), {
      status: 400,
    });
  const selected = normalize(quote),
    full = handoutText(markdown);
  if (!full.includes(selected) || selected === full)
    throw Object.assign(new Error("请选择课件中的局部文字，不要复制完整课件"), {
      status: 400,
    });
  return {
    lessonId,
    hash: createHash("sha256").update(markdown).digest("hex"),
    quote: quote.trim(),
  };
}
export function handoutCard(
  lessonId: string,
  markdown: string,
  quote: unknown,
): Card {
  const source = handoutSource(lessonId, markdown, quote);
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    lessonId,
    type: "text",
    title: "课件摘录 · " + normalize(source.quote).slice(0, 60),
    body: source.quote,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    evidenceIds: [],
    handoutSource: source,
  };
}
