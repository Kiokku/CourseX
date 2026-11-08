import { useEffect, useRef, useState } from "react";
import {
  diffChildren,
  diffSteps,
  validateExperiment,
  type DiffExperiment as Config,
} from "./diff";

export function DiffExperiment({
  config,
  save,
  close,
}: {
  config: Config;
  save: (config: Config) => Promise<void>;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [before, setBefore] = useState(config.before);
  const [after, setAfter] = useState(config.after);
  const [running, setRunning] = useState(config);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const steps = diffSteps(running.before, running.after);
  const visible = steps.slice(0, step);
  const labels = {
    reuse: "复用，无 Placement",
    move: "复用，标记移动",
    insert: "新建，标记插入",
    delete: "删除旧节点",
  };
  return (
    <dialog
      ref={dialog}
      className="export-dialog diff-dialog"
      aria-labelledby="diff-title"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          void (async () => {
            try {
              const next = validateExperiment({ ...config, before, after });
              await save(next);
              setRunning(next);
              setStep(0);
            } catch (error) {
              setError((error as Error).message);
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        <header>
          <h2 id="diff-title">React 18 · Keyed Diff 实验</h2>
          <button
            type="button"
            aria-label="关闭 Diff 实验"
            disabled={busy}
            onClick={close}
          >
            ×
          </button>
        </header>
        <p>
          模型 v1 · React 18.2.0 · 同层级、显式且唯一 key
          的宿主元素更新。复用还要求标签类型相同；本模型不包含 Fragment、无 key
          列表、并发调度或真实 DOM 提交。
        </p>
        <label>
          旧列表
          <input
            aria-label="Diff 旧列表"
            value={before}
            disabled={busy}
            maxLength={1000}
            onChange={(event) => setBefore(event.target.value)}
          />
        </label>
        <label>
          新列表
          <input
            aria-label="Diff 新列表"
            value={after}
            disabled={busy}
            maxLength={1000}
            onChange={(event) => setAfter(event.target.value)}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "保存中…" : "保存输入并运行"}
        </button>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="diff-lists" aria-label="Diff 输入可视化">
          {(
            [
              ["旧", running.before],
              ["新", running.after],
            ] as const
          ).map(([label, input]) => (
            <div key={label}>
              <strong>{label}</strong>
              {diffChildren(input).map((child) => (
                <span key={child.key}>
                  {child.key}
                  <small>
                    {child.type} · {child.index}
                  </small>
                </span>
              ))}
            </div>
          ))}
        </div>
        <p role="status">
          步骤 {step} / {steps.length} · lastPlacedIndex ={" "}
          {visible.at(-1)?.lastPlacedIndex ?? 0}
        </p>
        <div className="card-actions">
          <button
            type="button"
            disabled={step === 0}
            onClick={() => setStep(step - 1)}
          >
            上一步
          </button>
          <button
            type="button"
            disabled={step === steps.length}
            onClick={() => setStep(step + 1)}
          >
            下一步
          </button>
          <button type="button" onClick={() => setStep(steps.length)}>
            显示全部
          </button>
          <button type="button" onClick={() => setStep(0)}>
            重置步骤
          </button>
        </div>
        <ol className="diff-steps">
          {visible.map((item, index) => (
            <li
              key={`${item.action}-${item.key}-${index}`}
              data-action={item.action}
            >
              <strong>
                {item.key}:{item.type} · {labels[item.action]}
              </strong>
              <small>
                旧索引 {item.oldIndex ?? "无"} → 新索引 {item.newIndex ?? "无"}{" "}
                · lastPlacedIndex {item.lastPlacedIndex}
              </small>
            </li>
          ))}
        </ol>
        <p>
          移动判断：旧索引小于 lastPlacedIndex 时需要
          Placement。删除集中列在末尾表示分类结果，不代表实际 DOM
          操作顺序。输入可以保存、导出和恢复，操作过程不等于验证结论。
        </p>
        <p>
          <a
            href="https://github.com/facebook/react/blob/v18.2.0/packages/react-reconciler/src/ReactChildFiber.new.js"
            target="_blank"
            rel="noreferrer"
          >
            源码依据：placeChild / updateElement / reconcileChildrenArray ↗
          </a>
        </p>
      </form>
    </dialog>
  );
}
