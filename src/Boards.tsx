import { useCallback, useEffect, useRef, useState } from "react";
import {
  Tldraw,
  createShapeId,
  getSnapshot,
  loadSnapshot,
  type Editor,
  type TLAssetStore,
  type TLEditorSnapshot,
} from "tldraw";
import { getAssetUrls } from "@tldraw/assets/selfHosted";
import { Maximize2, Minimize2, Plus, PencilLine } from "lucide-react";
import { api, json } from "./api";
import { CardSources, evidenceHref } from "./CardSources";
import { CardContext, knowledgeShapeUtils } from "./KnowledgeCard";
import { KnowledgeSearch } from "./KnowledgeSearch";
import { DiffExperiment } from "./DiffExperiment";
import { initialExperiment } from "./diff";
import type {
  BoardInfo,
  Card,
  Lesson,
  Evidence,
  ConversationExcerpt,
  SaveConversationInput,
  ConversationDraft,
  CardLocation,
} from "./types";
import "tldraw/tldraw.css";

interface BoardData extends BoardInfo {
  cards?: Card[];
  evidence?: Evidence[];
  excerpts?: ConversationExcerpt[];
  targets?: Record<
    string,
    Pick<Card, "id" | "lessonId" | "title" | "status"> | null
  >;
  document: TLEditorSnapshot["document"] | null;
  session?: TLEditorSnapshot["session"];
}
interface BoardHandle {
  flush: () => Promise<void>;
  insertDraft: (draft: ConversationDraft) => Promise<void>;
}
export interface BoardsHandle {
  flush: () => Promise<void>;
  saveConversation: (input: SaveConversationInput) => Promise<void>;
  saveHandout: (quote: string) => Promise<void>;
}
const assetUrls = getAssetUrls({ baseUrl: "/tldraw-assets" });
const assets: TLAssetStore = {
  async upload(_asset, file, signal) {
    const response = await fetch("/api/assets", {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
      signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  },
};
function cardPosition(instance: Editor) {
  const center = instance.getViewportPageBounds().center;
  const x = center.x - 150;
  let y = center.y - 120;
  const bounds = instance
    .getCurrentPageShapes()
    .map((shape) => instance.getShapePageBounds(shape))
    .filter((box) => !!box)
    .sort((a, b) => a.y - b.y);
  for (const box of bounds) {
    if (
      x < box.x + box.w + 16 &&
      x + 300 + 16 > box.x &&
      y < box.y + box.h + 16 &&
      y + 240 + 16 > box.y
    )
      y = box.y + box.h + 24;
  }
  return { x, y };
}
function focusKnowledgeCard(instance: Editor, cardId: string) {
  const shape = Object.values(getSnapshot(instance.store).document.store).find(
    (record) =>
      record.typeName === "shape" &&
      record.type === "knowledge-card" &&
      record.props.cardId === cardId,
  );
  if (shape?.typeName !== "shape") return false;
  const page = instance.getAncestorPageId(shape);
  if (page) instance.setCurrentPage(page);
  instance.select(shape.id);
  const bounds = instance.getShapePageBounds(shape);
  if (bounds) instance.zoomToBounds(bounds, { targetZoom: 1 });
  return true;
}
function BoardEditor({
  board,
  license,
  handle,
  saved,
  ready,
  focusCard,
  navigate,
}: {
  board: BoardData;
  license: string;
  handle: React.RefObject<BoardHandle | null>;
  saved: (info: BoardInfo) => void;
  ready: (handle: BoardHandle | null, error?: Error) => void;
  focusCard?: string;
  navigate: (lessonId: string, cardId: string) => void;
}) {
  const editor = useRef<Editor | null>(null);
  const cards = useRef<Record<string, Card>>(
    Object.fromEntries((board.cards ?? []).map((card) => [card.id, card])),
  );
  const evidence = useRef<Record<string, Evidence>>(
    Object.fromEntries((board.evidence ?? []).map((item) => [item.id, item])),
  );
  const excerpts = useRef<Record<string, ConversationExcerpt>>(
    Object.fromEntries((board.excerpts ?? []).map((item) => [item.id, item])),
  );
  const [evidenceView, setEvidenceView] = useState(evidence.current);
  const [cardView, setCardView] = useState(cards.current);
  const [targets, setTargets] = useState(board.targets ?? {});
  const [search, setSearch] = useState<"find" | "reference" | null>(null);
  const [newType, setNewType] =
    useState<Exclude<Card["type"], "reference" | "experiment">>("question");
  const [experimentId, setExperimentId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Card | null>(null);
  const editingRef = useRef<Card | null>(null);
  const edit = (card: Card | null) => {
    editingRef.current = card;
    setEditing(card);
    if (card) {
      cards.current = { ...cards.current, [card.id]: card };
      setCardView(cards.current);
      schedule();
    }
  };
  const revision = useRef(board.revision);
  const name = useRef(board.name);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const running = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const [status, setStatus] = useState("已保存到本地");
  const [error, setError] = useState("");
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (running.current) {
      await running.current;
    }
    if (editingRef.current) {
      const card = editingRef.current;
      if (!card.title.trim()) throw new Error("请先填写卡片标题");
    }
    if (!dirty.current || !editor.current) return;
    const task = (async () => {
      while (dirty.current && editor.current) {
        dirty.current = false;
        if (mounted.current) {
          setStatus("保存中…");
          setError("");
        }
        try {
          const snapshot = getSnapshot(editor.current.store);
          const cardIds = new Set(
            Object.values(snapshot.document.store).flatMap((record) =>
              record.typeName === "shape" && record.type === "knowledge-card"
                ? [record.props.cardId]
                : [],
            ),
          );
          const currentCards = Object.values(cards.current).filter((card) =>
            cardIds.has(card.id),
          );
          const evidenceIds = new Set(
            currentCards.flatMap((card) => card.evidenceIds),
          );
          for (const id of evidenceIds) {
            const source = evidence.current[id];
            if (!source?.uri.trim())
              throw new Error("请填写证据内容，或移除空证据");
            if (source.sourceType === "url" && !evidenceHref(source.uri))
              throw new Error("请填写有效的 HTTP 或 HTTPS 来源链接");
          }
          const excerptIds = new Set(
            currentCards.flatMap((card) =>
              card.excerptId ? [card.excerptId] : [],
            ),
          );
          const result = await api<{
            revision: number;
            updatedAt: string;
            cards: Card[];
          }>(
            `/api/boards/${board.id}`,
            json("PUT", {
              name: name.current,
              ...snapshot,
              ...(board.lessonId
                ? {
                    cards: currentCards,
                    evidence: Object.values(evidence.current).filter((item) =>
                      evidenceIds.has(item.id),
                    ),
                    excerpts: Object.values(excerpts.current).filter((item) =>
                      excerptIds.has(item.id),
                    ),
                  }
                : {}),
              revision: revision.current,
            }),
          );
          revision.current = result.revision;
          // Preserve local edits made while the request was in flight.
          for (const card of result.cards) {
            if (cards.current[card.id])
              cards.current[card.id] = {
                ...cards.current[card.id],
                createdAt: card.createdAt,
                updatedAt: card.updatedAt,
              };
          }
          if (mounted.current) {
            setStatus("已保存到本地");
            saved({
              id: board.id,
              lessonId: board.lessonId,
              name: name.current,
              revision: result.revision,
              updatedAt: result.updatedAt,
            });
          }
        } catch (error) {
          dirty.current = true;
          if (mounted.current) {
            setStatus("未保存");
            setError((error as Error).message);
          }
          throw error;
        }
      }
    })();
    running.current = task;
    try {
      await task;
    } finally {
      running.current = null;
    }
  }, [board.id, board.lessonId, saved]);
  const schedule = useCallback(() => {
    dirty.current = true;
    setStatus("待保存…");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void flush().catch(() => {});
    }, 700);
  }, [flush]);
  useEffect(() => {
    if (name.current !== board.name) {
      name.current = board.name;
      if (editor.current) schedule();
    }
  }, [board.name, schedule]);
  useEffect(() => {
    mounted.current = true;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty.current || running.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      handle.current = null;
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [flush, handle]);
  const addCard = (target?: CardLocation, experiment = false) => {
    if (!editor.current) return;
    const shapeId = createShapeId();
    const id = shapeId.slice(6);
    const sourceId =
      !target && !experiment && newType === "source"
        ? createShapeId().slice(6)
        : undefined;
    const now = new Date().toISOString();
    const card: Card = {
      id,
      lessonId: board.lessonId!,
      type: experiment ? "experiment" : target ? "reference" : newType,
      title: experiment
        ? "React 18 · Keyed Diff"
        : (target?.title ??
          {
            question: "新的问题",
            text: "新的笔记",
            conclusion: "新的结论",
            source: "新的证据",
            conversation: "问答笔记",
          }[newType]),
      body: experiment
        ? "比较同级 keyed 宿主元素，逐步观察复用、移动、插入与删除。模型 v1 / React 18.2.0。"
        : "",
      status: "draft",
      createdAt: now,
      updatedAt: now,
      evidenceIds: sourceId ? [sourceId] : [],
      ...(target
        ? { target: { lessonId: target.lessonId, cardId: target.id } }
        : {}),
      ...(experiment ? { experiment: { ...initialExperiment } } : {}),
    };
    if (sourceId) {
      evidence.current = {
        ...evidence.current,
        [sourceId]: { id: sourceId, sourceType: "url", uri: "" },
      };
      setEvidenceView(evidence.current);
    }
    cards.current = { ...cards.current, [id]: card };
    setCardView(cards.current);
    const position = cardPosition(editor.current);
    editor.current
      .createShape({
        id: shapeId,
        type: "knowledge-card",
        ...position,
        props: { cardId: id },
      })
      .select(shapeId);
    const bounds = editor.current.getShapePageBounds(shapeId);
    if (bounds) editor.current.zoomToBounds(bounds, { targetZoom: 1 });
    if (target) setTargets((old) => ({ ...old, [id]: target }));
    else if (experiment) setExperimentId(id);
    else edit(card);
    schedule();
  };
  const insertDraft = async (draft: ConversationDraft) => {
    await flush();
    if (!editor.current || draft.card.lessonId !== board.lessonId)
      throw new Error("请重新打开章节主画布后保存");
    const card = draft.card;
    cards.current = { ...cards.current, [card.id]: card };
    if (draft.excerpt)
      excerpts.current = {
        ...excerpts.current,
        [draft.excerpt.id]: draft.excerpt,
      };
    setCardView(cards.current);
    const position = cardPosition(editor.current);
    const id = createShapeId(card.id);
    editor.current
      .createShape({
        id,
        type: "knowledge-card",
        ...position,
        props: { cardId: card.id },
      })
      .select(id);
    const bounds = editor.current.getShapePageBounds(id);
    if (bounds) editor.current.zoomToBounds(bounds, { targetZoom: 1 });
    edit(card);
    await flush();
  };
  return (
    <>
      {board.lessonId && (
        <div className="card-actions">
          <select
            aria-label="新建卡片类型"
            value={newType}
            onChange={(event) =>
              setNewType(event.target.value as typeof newType)
            }
          >
            <option value="question">问题</option>
            <option value="text">笔记</option>
            <option value="conclusion">结论</option>
            <option value="source">证据</option>
          </select>
          <button disabled={!!editing} onClick={() => addCard()}>
            ＋ 知识卡片
          </button>
          <button disabled={!!editing} onClick={() => setSearch("reference")}>
            ＋ 章节引用
          </button>
          <button disabled={!!editing} onClick={() => addCard(undefined, true)}>
            ＋ Diff 实验
          </button>
        </div>
      )}
      <div className="card-actions">
        {focusCard && cardView[focusCard] && (
          <button
            onClick={() => {
              const card = cards.current[focusCard];
              if (
                !editor.current ||
                !focusKnowledgeCard(editor.current, focusCard)
              ) {
                setError("已定位卡片已删除");
                return;
              }
              if (card.target)
                navigate(card.target.lessonId, card.target.cardId);
              else if (card.experiment) setExperimentId(card.id);
              else edit(card);
            }}
          >
            打开已定位卡片
          </button>
        )}
        <button onClick={() => setSearch("find")}>查找知识</button>
        <button onClick={() => editor.current?.zoomToFit()}>聚焦全部</button>
        <button
          onClick={() => {
            const instance = editor.current;
            if (!instance || instance.getSelectedShapeIds().length < 2) {
              setError("先选择至少两个对象，再整理间距");
              return;
            }
            instance.markHistoryStoppingPoint("整理间距");
            instance.stackShapes(
              instance.getSelectedShapeIds(),
              "vertical",
              24,
            );
          }}
        >
          整理所选间距
        </button>
      </div>
      {search && (
        <KnowledgeSearch
          reference={search === "reference"}
          lessonId={board.lessonId}
          close={() => setSearch(null)}
          choose={(card) => {
            setSearch(null);
            if (search === "reference") addCard(card);
            else navigate(card.lessonId, card.id);
          }}
        />
      )}
      {experimentId && cardView[experimentId]?.experiment && (
        <DiffExperiment
          config={cardView[experimentId].experiment!}
          close={() => setExperimentId(null)}
          save={async (config) => {
            cards.current = {
              ...cards.current,
              [experimentId]: {
                ...cards.current[experimentId],
                experiment: config,
              },
            };
            setCardView(cards.current);
            schedule();
            await flush();
          }}
        />
      )}
      {editing && (
        <form
          className="card-editor"
          aria-label="编辑知识卡片"
          onSubmit={(event) => {
            event.preventDefault();
            void flush()
              .then(() => edit(null))
              .catch((error) => setError(error.message));
          }}
        >
          <div className="card-editor-row">
            <select
              aria-label="卡片类型"
              value={editing.type}
              onChange={(event) =>
                edit({ ...editing, type: event.target.value as Card["type"] })
              }
            >
              <option value="text">笔记</option>
              <option value="question">问题</option>
              <option value="conclusion">结论</option>
              <option value="source">代码 / 来源</option>
              <option value="conversation">对话</option>
            </select>
            <select
              aria-label="验证状态"
              value={editing.status}
              onChange={(event) =>
                edit({
                  ...editing,
                  status: event.target.value as Card["status"],
                })
              }
            >
              <option value="draft">待验证</option>
              <option value="verified">已验证</option>
            </select>
            <button type="submit">完成</button>
          </div>
          <input
            aria-label="卡片标题"
            required
            maxLength={200}
            value={editing.title}
            onChange={(event) =>
              edit({ ...editing, title: event.target.value })
            }
          />
          <textarea
            aria-label="卡片正文"
            rows={4}
            maxLength={100000}
            value={editing.body}
            onChange={(event) => edit({ ...editing, body: event.target.value })}
          />
          <CardSources
            card={editing}
            evidence={evidenceView}
            excerpt={
              editing.excerptId
                ? excerpts.current[editing.excerptId]
                : undefined
            }
            change={edit}
            setEvidence={(value) => {
              evidence.current = { ...evidence.current, [value.id]: value };
              setEvidenceView(evidence.current);
              schedule();
            }}
          />
        </form>
      )}
      <div className="board-canvas">
        <CardContext.Provider
          value={{
            cards: cardView,
            evidence: evidenceView,
            targets,
            navigate,
            edit: (id) => {
              if (cards.current[id]?.experiment) setExperimentId(id);
              else if (cards.current[id]?.type !== "reference")
                edit(cards.current[id]);
            },
          }}
        >
          <Tldraw
            shapeUtils={knowledgeShapeUtils}
            assetUrls={assetUrls}
            assets={assets}
            licenseKey={license || undefined}
            onMount={(instance) => {
              editor.current = instance;
              instance.user.updateUserPreferences({
                locale: "zh-cn",
                colorScheme: "light",
              });
              try {
                if (board.document)
                  loadSnapshot(instance.store, {
                    document: board.document,
                    session: board.session,
                  });
              } catch {
                editor.current = null;
                setError("画板数据无法读取。请保留本地文件，不要覆盖保存。");
                ready(null, new Error("画板数据无法读取，未保存问答"));
                return;
              }
              handle.current = { flush, insertDraft };
              if (focusCard && !focusKnowledgeCard(instance, focusCard))
                setError("目标卡片已删除或不在当前章节画布中");
              ready(handle.current);
              const stopDocument = instance.store.listen(() => schedule(), {
                scope: "document",
              });
              const stopSession = instance.store.listen(
                ({ changes }) => {
                  if (
                    Object.values(changes.updated).some(
                      ([previous, record]) =>
                        record.typeName === "camera" ||
                        record.typeName === "instance_page_state" ||
                        (previous.typeName === "instance" &&
                          record.typeName === "instance" &&
                          previous.currentPageId !== record.currentPageId),
                    )
                  )
                    schedule();
                },
                { scope: "session" },
              );
              return () => {
                stopDocument();
                stopSession();
              };
            }}
          />
        </CardContext.Provider>
      </div>
      <footer className="board-status">
        <span>{status}</span>
        <button onClick={() => void flush().catch(() => {})}>立即保存</button>
      </footer>
      {error && (
        <p role="alert" className="error board-error">
          {error}
        </p>
      )}
    </>
  );
}
export function Boards({
  lesson,
  saveHandle,
  expanded,
  toggle,
  focus,
  navigate,
}: {
  lesson: Lesson | null;
  saveHandle: React.RefObject<BoardsHandle | null>;
  expanded: boolean;
  toggle: () => void;
  focus?: { cardId?: string; request: number };
  navigate: (lessonId: string, cardId: string) => void;
}) {
  const [boards, setBoards] = useState<BoardInfo[]>([]);
  const [board, setBoard] = useState<BoardData | null>(null);
  const [license, setLicense] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const handle = useRef<BoardHandle | null>(null);
  const generation = useRef(0);
  const operation = useRef<Promise<void> | null>(null);
  const pending = useRef<{
    draft: ConversationDraft;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);
  const [savingConversation, setSavingConversation] = useState(false);
  const ready = useCallback((commands: BoardHandle | null, error?: Error) => {
    const job = pending.current;
    if (!job) return;
    pending.current = null;
    if (!commands) job.reject(error ?? new Error("画布尚未准备好"));
    else void commands.insertDraft(job.draft).then(job.resolve, job.reject);
  }, []);
  useEffect(() => {
    const saveDraft = async (endpoint: string, input: unknown) => {
      if (!lesson || operation.current) throw new Error("请等待当前保存完成");
      const task = (async () => {
        await handle.current?.flush();
        const draft = await api<ConversationDraft>(
          `/api/lessons/${lesson.id}/${endpoint}`,
          json("POST", input),
        );
        if (board?.lessonId === lesson.id && handle.current) {
          await handle.current.insertDraft(draft);
          return;
        }
        const next = await api<BoardData>(
          `/api/lessons/${lesson.id}/board`,
          json("POST", {}),
        );
        await new Promise<void>((resolve, reject) => {
          pending.current = { draft, resolve, reject };
          setBoard(next);
          setBoards((old) => [
            ...old.filter((item) => item.id !== next.id),
            next,
          ]);
        });
      })();
      operation.current = task;
      setSavingConversation(true);
      try {
        await task;
      } finally {
        operation.current = null;
        setSavingConversation(false);
      }
    };
    saveHandle.current = {
      flush: async () => {
        await operation.current;
        await handle.current?.flush();
      },
      saveConversation: (input) => saveDraft("conversation-draft", input),
      saveHandout: (quote) => saveDraft("handout-draft", { quote }),
    };
    return () => {
      saveHandle.current = null;
    };
  }, [saveHandle, lesson?.id, board?.id, board?.lessonId]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        await handle.current?.flush();
        if (!alive) return;
        setLoading(true);
        setBoard(null);
        setError("");
        const [list, settings, primary] = await Promise.all([
          api<BoardInfo[]>("/api/boards"),
          api<{ tldrawLicense: string }>("/api/settings"),
          lesson
            ? api<BoardData | null>(`/api/lessons/${lesson.id}/board`)
            : Promise.resolve(null),
        ]);
        if (alive) {
          setBoards(list);
          setLicense(settings.tldrawLicense);
          setBoard(primary);
          if (focus?.cardId && !primary)
            setError("目标卡片所在的章节主画布不存在，可能已删除或尚未恢复");
        }
      } catch (error) {
        if (alive) setError((error as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    return () => {
      alive = false;
      ++generation.current;
    };
  }, [lesson?.id, focus?.request]);
  const saved = useCallback(
    (info: BoardInfo) =>
      setBoards((old) =>
        old.map((item) => (item.id === info.id ? info : item)),
      ),
    [],
  );
  const switchBoard = async (id?: string, primary = false) => {
    const current = ++generation.current;
    setError("");
    try {
      await operation.current;
      await handle.current?.flush();
      setLoading(true);
      const next = id
        ? await api<BoardData>(`/api/boards/${id}`)
        : primary && lesson
          ? await api<BoardData>(
              `/api/lessons/${lesson.id}/board`,
              json("POST", {}),
            )
          : await api<BoardData>("/api/boards", json("POST", {}));
      if (generation.current !== current) return;
      if (!id)
        setBoards((old) => [
          ...old.filter((item) => item.id !== next.id),
          next,
        ]);
      setBoard(next);
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  };
  return (
    <section className="boards-pane" aria-label="学习画板">
      <header>
        <h2>{board?.lessonId ? "章节主画布" : "学习画板"}</h2>
        <button
          className="primary small"
          disabled={loading || savingConversation}
          onClick={() => void switchBoard()}
        >
          <Plus size={16} />
          新建草稿
        </button>
      </header>
      <div className="board-controls">
        <select
          aria-label="选择画板"
          value={board?.id ?? ""}
          disabled={loading || savingConversation}
          onChange={(e) => void switchBoard(e.target.value)}
        >
          {!board && <option value="">选择画板</option>}
          {boards
            .filter((item) => !item.lessonId || item.lessonId === lesson?.id)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.lessonId ? "主画布 · " : "草稿 · "}
                {item.id === board?.id ? board.name : item.name}
              </option>
            ))}
        </select>
        <button
          aria-label={expanded ? "收起画板" : "展开画板"}
          onClick={toggle}
        >
          {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
        </button>
      </div>
      {lesson && !board?.lessonId && (
        <button
          className="open-primary"
          disabled={loading || savingConversation}
          onClick={() => void switchBoard(undefined, true)}
        >
          打开当前章节主画布
        </button>
      )}
      {board && (
        <label className="board-name">
          名称
          <input
            aria-label="画板名称"
            maxLength={100}
            value={board.name}
            disabled={loading || savingConversation}
            onChange={(e) => setBoard({ ...board, name: e.target.value })}
            onBlur={() => {
              if (!board.name.trim())
                setBoard({ ...board, name: "未命名画板" });
            }}
          />
        </label>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <div className="empty">正在读取画板…</div>
      ) : board ? (
        <BoardEditor
          key={board.id}
          board={board}
          license={license}
          handle={handle}
          saved={saved}
          ready={ready}
          focusCard={board.lessonId === lesson?.id ? focus?.cardId : undefined}
          navigate={navigate}
        />
      ) : (
        <div className="empty board-empty">
          <PencilLine size={30} />
          <p>留下你的思考</p>
          <span>为当前课节建立主画布，或选择已有草稿。</span>
          <button
            disabled={!lesson}
            onClick={() => void switchBoard(undefined, true)}
          >
            创建章节主画布
          </button>
        </div>
      )}
    </section>
  );
}
