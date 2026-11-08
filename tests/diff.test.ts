import test from "node:test";
import assert from "node:assert/strict";
import {
  diffSteps,
  diffChildren,
  initialExperiment,
  validateExperiment,
} from "../src/diff.ts";

for (const [name, before, after, actions] of [
  ["顺序不变", "A:li,B:li", "A:li,B:li", ["reuse:A", "reuse:B"]],
  [
    "交换时移动落后于 lastPlacedIndex 的 A",
    "A:li,B:li",
    "B:li,A:li",
    ["reuse:B", "move:A"],
  ],
  [
    "头部插入不会让原节点全被标记移动",
    "A:li,B:li",
    "C:li,A:li,B:li",
    ["insert:C", "reuse:A", "reuse:B"],
  ],
  [
    "删除剩余节点",
    "A:li,B:li,C:li",
    "B:li",
    ["reuse:B", "delete:A", "delete:C"],
  ],
  [
    "同 key 改标签会新建并删除旧节点",
    "A:li",
    "A:div",
    ["insert:A", "delete:A"],
  ],
  ["空列表", "", "", []],
  ["全部插入", "", "A:li", ["insert:A"]],
  ["全部删除", "A:li", "", ["delete:A"]],
] as const)
  test(`React 18 keyed Diff：${name}`, () => {
    const steps = diffSteps(before, after);
    assert.deepEqual(
      steps.map((step) => `${step.action}:${step.key}`),
      actions,
    );
    assert.ok(
      steps.every(
        (step, i) =>
          i === 0 || step.lastPlacedIndex >= steps[i - 1].lastPlacedIndex,
      ),
    );
  });

test("Diff 实验拒绝重复 key、坏输入、超限和未知版本", () => {
  assert.throws(() => diffChildren("A:li,A:div"), /重复/);
  assert.throws(() => diffChildren("li"), /key:标签/);
  assert.throws(
    () =>
      diffChildren(Array.from({ length: 21 }, (_, i) => `${i}:li`).join(",")),
    /最多 20/,
  );
  assert.throws(
    () => validateExperiment({ ...initialExperiment, version: 2 }),
    /版本/,
  );
  assert.deepEqual(validateExperiment(initialExperiment), initialExperiment);
});
