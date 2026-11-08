export interface DiffExperiment {
  kind: "keyed-diff";
  version: 1;
  reactVersion: "18.2.0";
  before: string;
  after: string;
}
export interface DiffChild {
  key: string;
  type: string;
  index: number;
}
export interface DiffStep {
  key: string;
  type: string;
  action: "reuse" | "move" | "insert" | "delete";
  oldIndex?: number;
  newIndex?: number;
  lastPlacedIndex: number;
}
export function diffChildren(input: string): DiffChild[] {
  if (input.length > 1000) throw new Error("列表最多 1000 字符");
  if (!input.trim()) return [];
  const seen = new Set<string>();
  const parts = input.split(",");
  if (parts.length > 20) throw new Error("每个列表最多 20 个节点");
  return parts.map((part, index) => {
    const match = /^\s*([A-Za-z0-9_-]{1,30}):([a-z][a-z0-9-]{0,29})\s*$/.exec(
      part,
    );
    if (!match)
      throw new Error("使用 key:标签 格式，以英文逗号分隔，例如 A:li,B:li");
    if (seen.has(match[1])) throw new Error(`key 重复：${match[1]}`);
    seen.add(match[1]);
    return { key: match[1], type: match[2], index };
  });
}
// Models unique, explicitly keyed host-element siblings in an update.
// The prefix fast path is folded into the map lookup; deletion rows are a logical summary,
// not the order of DOM operations in commit. Source: React 18.2.0 ReactChildFiber.new.js.
export function diffSteps(before: string, after: string): DiffStep[] {
  const remaining = new Map(
    diffChildren(before).map((child) => [child.key, child]),
  );
  let lastPlacedIndex = 0;
  const steps: DiffStep[] = diffChildren(after).map((child) => {
    const old = remaining.get(child.key);
    if (!old || old.type !== child.type)
      return {
        key: child.key,
        type: child.type,
        action: "insert",
        newIndex: child.index,
        lastPlacedIndex,
      };
    remaining.delete(child.key);
    const action = old.index < lastPlacedIndex ? "move" : "reuse";
    if (action === "reuse") lastPlacedIndex = old.index;
    return {
      key: child.key,
      type: child.type,
      action,
      oldIndex: old.index,
      newIndex: child.index,
      lastPlacedIndex,
    };
  });
  for (const old of remaining.values())
    steps.push({
      key: old.key,
      type: old.type,
      action: "delete",
      oldIndex: old.index,
      lastPlacedIndex,
    });
  return steps;
}
export function validateExperiment(value: unknown): DiffExperiment {
  const config = value as DiffExperiment | undefined;
  if (
    !config ||
    config.kind !== "keyed-diff" ||
    config.version !== 1 ||
    config.reactVersion !== "18.2.0" ||
    typeof config.before !== "string" ||
    typeof config.after !== "string"
  )
    throw new Error("交互实验版本或输入格式无效");
  diffSteps(config.before, config.after);
  return {
    kind: config.kind,
    version: 1,
    reactVersion: "18.2.0",
    before: config.before,
    after: config.after,
  };
}
export const initialExperiment: DiffExperiment = {
  kind: "keyed-diff",
  version: 1,
  reactVersion: "18.2.0",
  before: "A:li,B:li,C:li",
  after: "B:li,A:li,D:li",
};
