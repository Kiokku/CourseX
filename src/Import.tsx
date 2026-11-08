import { useEffect, useRef, useState } from "react";
import type { ImportPreview } from "./types";

export function Import({
  flush,
  close,
}: {
  flush: () => Promise<void>;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<{
    imported: number;
    cards: number;
    skipped: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      await flush();
      const response = await fetch(
        `/api/import/${preview ? "confirm" : "preview"}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/zip",
            ...(preview ? { "X-CourseX-Import-Preview": preview.token } : {}),
          },
          body: file,
        },
      );
      const value = await response.json();
      if (!response.ok) {
        setPreview(null);
        throw new Error(value.error ?? "导入失败");
      }
      if (preview) setResult(value);
      else setPreview(value);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ready =
    preview?.rows.filter((row) => row.status === "ready").length ?? 0;
  return (
    <dialog
      ref={dialog}
      className="export-dialog"
      aria-labelledby="import-title"
      onCancel={(event) => {
        if (busy || result) event.preventDefault();
        else close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <header>
          <h2 id="import-title">恢复学习成果</h2>
          <button
            type="button"
            disabled={busy}
            onClick={result ? () => window.location.reload() : close}
            aria-label="关闭导入"
          >
            ×
          </button>
        </header>
        {result ? (
          <>
            <p role="status">
              已恢复 {result.imported} 个项目、{result.cards} 张卡片，跳过{" "}
              {result.skipped} 个项目。
            </p>
            <p>原有数据已保留。刷新页面后查看恢复结果。</p>
            <footer>
              <button
                type="button"
                className="primary"
                onClick={() => window.location.reload()}
              >
                刷新并查看
              </button>
            </footer>
          </>
        ) : (
          <>
            <p>
              支持同版本 CourseX 导出
              ZIP。先预览再确认；仅新增无冲突的章节与草稿，已有数据整项跳过。
            </p>
            <p className="export-boundary">
              不会恢复模型配置、完整聊天、课程视频或完整课件。章节以稳定 ID
              匹配，请保留课程目录中的
              .coursex-id.json。分享包与导出时省略的内容无法补回。
            </p>
            <label>
              选择导出包（最大 100 MB）
              <input
                aria-label="选择导出包"
                type="file"
                accept=".zip,application/zip"
                disabled={busy}
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setPreview(null);
                  setError("");
                }}
              />
            </label>
            {preview && (
              <section className="import-preview" aria-label="导入预览">
                <p role="status">
                  {preview.mode === "private" ? "个人备份包" : "分享包"} ·
                  可新增 {ready} 项 · 跳过 {preview.rows.length - ready} 项 ·
                  包内图片 {preview.assets} 张
                </p>
                <ul>
                  {preview.rows.map((row) => (
                    <li key={row.key}>
                      <strong>
                        {row.status === "ready"
                          ? "可新增"
                          : row.status === "conflict"
                            ? "冲突，跳过"
                            : row.status === "missing"
                              ? "章节未匹配"
                              : "无学习数据"}{" "}
                        · {row.title}
                      </strong>
                      <small>
                        {row.cards} 张卡片 · {row.excerpts} 段问答
                        <br />
                        {row.reason}
                      </small>
                    </li>
                  ))}
                </ul>
                {preview.warnings.length > 0 && (
                  <details>
                    <summary>导出时的处理提示</summary>
                    <ul>
                      {preview.warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </section>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <footer>
              <button type="button" disabled={busy} onClick={close}>
                取消
              </button>
              {preview && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPreview(null)}
                >
                  重新预览
                </button>
              )}
              <button
                className="primary"
                disabled={
                  busy ||
                  !file ||
                  file.size > 100 * 1024 * 1024 ||
                  (preview !== null && ready === 0)
                }
                type="submit"
              >
                {busy
                  ? "正在处理…"
                  : preview
                    ? `确认新增 ${ready} 项`
                    : "预览导入"}
              </button>
            </footer>
            {file && file.size > 100 * 1024 * 1024 && (
              <p role="alert" className="error">
                ZIP 最大 100 MB，请按课程分别导出。
              </p>
            )}
          </>
        )}
      </form>
    </dialog>
  );
}
