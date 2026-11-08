import { useEffect, useRef, useState } from "react";
import { api, json } from "./api";
import type { Course, ExportOptions } from "./types";
interface Catalog {
  cardCount: number;
  boardCount: number;
  excerpts: { id: string; title: string; preview: string; createdAt: string }[];
}
export function Export({
  courses,
  courseId,
  flush,
  close,
}: {
  courses: Course[];
  courseId?: string;
  flush: () => Promise<void>;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [scope, setScope] = useState(courseId ?? "");
  const [mode, setMode] = useState<ExportOptions["mode"]>("private");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [includeAssets, setIncludeAssets] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    let alive = true;
    setCatalog(null);
    setError("");
    void api<Catalog>(
      `/api/export/options${scope ? `?courseId=${encodeURIComponent(scope)}` : ""}`,
    )
      .then((value) => {
        if (alive) {
          setCatalog(value);
          setSelected(
            modeRef.current === "private"
              ? value.excerpts.map((item) => item.id)
              : [],
          );
        }
      })
      .catch((error) => {
        if (alive) setError(error.message);
      });
    return () => {
      alive = false;
    };
  }, [scope]);
  const download = async () => {
    setBusy(true);
    setError("");
    try {
      await flush();
      const response = await fetch(
        "/api/export",
        json("POST", {
          ...(scope ? { courseId: scope } : {}),
          mode,
          includeAssets,
          excerptIds: selected,
        } satisfies ExportOptions),
      );
      if (!response.ok)
        throw new Error((await response.json()).error ?? "导出失败");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "coursex-export.zip";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      close();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="export-dialog"
      aria-labelledby="export-title"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void download();
        }}
      >
        <header>
          <h2 id="export-title">导出学习成果</h2>
          <button
            type="button"
            disabled={busy}
            onClick={close}
            aria-label="关闭导出"
          >
            ×
          </button>
        </header>
        <label>
          导出范围
          <select
            aria-label="导出范围"
            disabled={busy}
            value={scope}
            onChange={(event) => setScope(event.target.value)}
          >
            <option value="">全部学习成果（含独立草稿）</option>
            {courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          用途
          <select
            aria-label="导出用途"
            disabled={busy}
            value={mode}
            onChange={(event) => {
              const next = event.target.value as ExportOptions["mode"];
              setMode(next);
              setIncludeAssets(next === "private");
              setSelected(
                next === "private"
                  ? (catalog?.excerpts.map((item) => item.id) ?? [])
                  : [],
              );
            }}
          >
            <option value="private">个人备份包</option>
            <option value="share">分享包</option>
          </select>
        </label>
        <p>
          ZIP 内含可读的卡片 Markdown、来源、画布 JSON
          和所选图片。可通过“导入”恢复同版本包中的无冲突内容。
        </p>
        <p className="export-boundary">
          始终排除模型配置、登录凭据、课程原视频、完整课件和完整聊天历史。已知密钥、链接凭据及常见本地绝对路径会被省略。笔记和图片可能仍含私人信息或课程引用，公开前请检查。
        </p>
        {mode === "share" && (
          <p>
            分享包默认不含问答和图片，并排除课件摘录卡片；你可以主动勾选要分享的问答或图片。
          </p>
        )}
        {catalog && (
          <small>
            当前范围有 {catalog.cardCount} 张卡片、{catalog.boardCount}{" "}
            张画板。实际内容按下方选项筛选；未勾选的对话卡片也会排除。
          </small>
        )}
        <label className="export-check">
          <input
            type="checkbox"
            checked={includeAssets}
            disabled={busy}
            onChange={(event) => setIncludeAssets(event.target.checked)}
          />
          包含画布图片（可能含私人信息或课件截图）
        </label>
        <fieldset disabled={busy || !catalog}>
          <legend>主动保存的问答片段</legend>
          {catalog?.excerpts.length === 0 && <p>当前范围没有保存的问答。</p>}
          {catalog?.excerpts.map((item) => (
            <label className="export-check" key={item.id}>
              <input
                type="checkbox"
                checked={selected.includes(item.id)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, item.id]
                      : current.filter((id) => id !== item.id),
                  )
                }
              />
              <span>
                {item.title}
                <small>
                  {item.createdAt}
                  <br />
                  {item.preview}
                </small>
              </span>
            </label>
          ))}
        </fieldset>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <footer>
          <button type="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button className="primary" disabled={busy || !catalog} type="submit">
            {busy ? "正在生成 ZIP…" : "下载 ZIP"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
