import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  PanelLeftClose,
  PanelRightClose,
  RefreshCw,
  Settings2,
  Download,
  Upload,
  Search,
} from "lucide-react";
import { api, json } from "./api";
import { Handout } from "./Handout";
import { Export } from "./Export";
import { Import } from "./Import";
import { KnowledgeSearch } from "./KnowledgeSearch";
import {
  learningLink,
  learningLocation,
  type LearningLocation,
} from "./navigation";
import { Video } from "./Video";
import { Chat } from "./Chat";
import { Boards, type BoardsHandle } from "./Boards";
import { Settings } from "./Settings";
import type { Course, Lesson, ChatMessage, Progress } from "./types";
interface LessonData {
  handout: string;
  chat: ChatMessage[];
  progress: Progress;
}
export function App() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [data, setData] = useState<LessonData | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [left, setLeft] = useState(() => window.innerWidth >= 900);
  const [right, setRight] = useState(() => window.innerWidth >= 900);
  const [expanded, setExpanded] = useState(false);
  const [settings, setSettings] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [searching, setSearching] = useState(false);
  const [focus, setFocus] = useState<{ cardId?: string; request: number }>();
  const [error, setError] = useState("");
  const [height, setHeight] = useState(300);
  const [pictureInPicture, setPictureInPicture] = useState(false);
  const boardHandle = useRef<BoardsHandle | null>(null);
  const request = useRef(0);
  const activeURL = useRef(window.location.href);
  const learning = useRef<HTMLElement>(null);
  const selectLesson = async (
    next: Lesson,
    location?: LearningLocation,
    history = true,
  ) => {
    const generation = ++request.current;
    setError("");
    try {
      await boardHandle.current?.flush();
      if (generation !== request.current) return;
      setLesson(next);
      const course = courses.find((course) => course.id === next.courseId);
      if (course) setOpen((old) => ({ ...old, [course.name]: true }));
      setFocus({ cardId: location?.cardId, request: generation });
      if (location?.board) {
        setRight(true);
        setExpanded(true);
        if (window.innerWidth < 900) setLeft(false);
      }
      setData(null);
      setPictureInPicture(false);
      const result = await api<LessonData>(`/api/lessons/${next.id}`);
      if (generation !== request.current) return;
      setData(result);
      if (history)
        window.history.pushState(
          null,
          "",
          learningLink(next.id, location?.cardId, location?.board ?? false),
        );
      activeURL.current = window.location.href;
      await api("/api/session", json("PUT", { lessonId: next.id }));
    } catch (e) {
      if (!history && generation === request.current)
        window.history.replaceState(null, "", activeURL.current);
      if (generation === request.current) setError((e as Error).message);
    }
  };
  const load = async (initial = false) => {
    setError("");
    try {
      const list = await api<Course[]>("/api/library");
      setCourses(list);
      if (initial) {
        const location = learningLocation(window.location.search);
        const session = await api<{ lastLesson: string }>("/api/session");
        const firstCourse =
          list.find((item) => item.name.includes("React")) ?? list[0];
        const linked = location
          ? list
              .flatMap((item) => item.lessons)
              .find((item) => item.id === location.lessonId)
          : undefined;
        if (location && !linked)
          throw new Error("链接中的章节未找到，请确认课程目录和稳定身份文件");
        const next =
          linked ??
          list
            .flatMap((item) => item.lessons)
            .find((item) => item.id === session.lastLesson) ??
          firstCourse?.lessons[0];
        if (next) {
          if (!location)
            window.history.replaceState(
              null,
              "",
              learningLink(next.id, undefined, false),
            );
          setOpen({
            [list.find((item) =>
              item.lessons.some((lesson) => lesson.id === next.id),
            )!.name]: true,
          });
          await selectLesson(next, location ?? undefined, false);
        }
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load(true);
  }, []);
  useEffect(() => {
    const pop = () => {
      try {
        const location = learningLocation(window.location.search);
        if (!location) return;
        const next = courses
          .flatMap((course) => course.lessons)
          .find((item) => item.id === location.lessonId);
        if (!next) throw new Error("链接中的章节未找到");
        void selectLesson(next, location, false);
      } catch (error) {
        setError((error as Error).message);
      }
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [courses]);
  const navigate = (lessonId: string, cardId: string) => {
    const next = courses
      .flatMap((course) => course.lessons)
      .find((item) => item.id === lessonId);
    if (!next) {
      setError("目标章节已失联，请恢复课程目录后重试");
      return;
    }
    void selectLesson(next, { lessonId, cardId, board: true });
  };
  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    const start = event.clientY,
      original = height;
    const move = (next: PointerEvent) =>
      setHeight(
        Math.max(
          130,
          Math.min(
            (learning.current?.clientHeight ?? 700) - 180,
            original + next.clientY - start,
          ),
        ),
      );
    const stop = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", stop);
      element.removeEventListener("pointercancel", stop);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", stop);
    element.addEventListener("pointercancel", stop);
  };
  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          Course<span>X</span>
        </div>
        <span className="current-lesson">
          {lesson?.title ?? "本地课程学习"}
        </span>
        <div className="header-actions">
          <button
            aria-label="查找全部知识"
            onClick={() => {
              void (boardHandle.current?.flush() ?? Promise.resolve())
                .then(() => setSearching(true))
                .catch((error) => setError(error.message));
            }}
          >
            <Search size={17} />
          </button>
          <button
            aria-label={left ? "收起课程目录" : "打开课程目录"}
            onClick={() => {
              setLeft(!left);
              if (window.innerWidth < 900) setRight(false);
            }}
          >
            <PanelLeftClose size={17} />
          </button>
          <button
            aria-label={right ? "收起笔记区域" : "打开笔记区域"}
            onClick={() => {
              setRight(!right);
              if (window.innerWidth < 900) setLeft(false);
            }}
          >
            <PanelRightClose size={17} />
          </button>
          <button
            aria-label="导出学习成果"
            onClick={() => {
              void (boardHandle.current?.flush() ?? Promise.resolve())
                .then(() => setExporting(true))
                .catch((error) => setError(error.message));
            }}
          >
            <Download size={16} />
            <span>导出</span>
          </button>
          <button
            aria-label="导入学习成果"
            onClick={() => {
              void (boardHandle.current?.flush() ?? Promise.resolve())
                .then(() => setImporting(true))
                .catch((error) => setError(error.message));
            }}
          >
            <Upload size={16} />
            <span>导入</span>
          </button>
          <button onClick={() => setSettings(true)}>
            <Settings2 size={16} />
            <span>模型设置</span>
          </button>
        </div>
      </header>
      {error && (
        <div role="alert" className="error app-error">
          {error}
          <button
            onClick={() =>
              lesson ? void selectLesson(lesson) : void load(true)
            }
          >
            重试
          </button>
        </div>
      )}
      <div
        className={`workspace ${left ? "" : "hide-left"} ${right ? "" : "hide-right"} ${expanded && right ? "board-expanded" : ""}`}
      >
        <aside className="catalog">
          <header>
            <h2>课程目录</h2>
            <button aria-label="刷新课程目录" onClick={() => void load()}>
              <RefreshCw size={15} />
            </button>
          </header>
          <nav>
            {courses.map((course) => (
              <div className="course" key={course.name}>
                <button
                  className="course-title"
                  aria-expanded={Boolean(open[course.name])}
                  onClick={() =>
                    setOpen({ ...open, [course.name]: !open[course.name] })
                  }
                >
                  {open[course.name] ? (
                    <ChevronDown size={15} />
                  ) : (
                    <ChevronRight size={15} />
                  )}
                  <Folder size={17} />
                  <span>{course.name}</span>
                </button>
                {open[course.name] && (
                  <div className="lessons">
                    {course.lessons.map((item) => (
                      <button
                        key={item.id}
                        className={item.id === lesson?.id ? "selected" : ""}
                        aria-current={
                          item.id === lesson?.id ? "page" : undefined
                        }
                        title={item.title}
                        onClick={() => {
                          void selectLesson(item);
                          if (window.innerWidth < 900) setLeft(false);
                        }}
                      >
                        {item.title}
                        {!item.video && <small>暂无视频</small>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </nav>
          {!courses.length && <p className="empty">library 中暂无课程</p>}
          {lesson && (
            <a
              className="chapter-link"
              href={learningLink(lesson.id)}
              target="_blank"
              rel="noreferrer"
            >
              当前章节固定链接 ↗
            </a>
          )}
          {lesson && (
            <a
              className="chapter-link"
              href={`/api/navigation?courseId=${encodeURIComponent(lesson.courseId)}`}
            >
              下载本课程导航（用于 Learning Hub）
            </a>
          )}
        </aside>
        <main className="learning" ref={learning}>
          {lesson && data ? (
            <div
              key={lesson.id}
              className={`lesson-content ${pictureInPicture ? "pip-active" : ""}`}
              style={{ "--video-height": `${height}px` } as React.CSSProperties}
            >
              <Video
                lesson={lesson}
                progress={data.progress}
                onPictureInPictureChange={setPictureInPicture}
              />
              <div
                className="resize-handle"
                role="separator"
                aria-label="调整视频区域高度"
                aria-orientation="horizontal"
                tabIndex={0}
                onPointerDown={resize}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                    e.preventDefault();
                    setHeight((old) =>
                      Math.max(
                        130,
                        Math.min(450, old + (e.key === "ArrowUp" ? -20 : 20)),
                      ),
                    );
                  }
                }}
              >
                <span />
              </div>
              <Handout
                lesson={lesson.id}
                text={data.handout}
                save={async (quote) => {
                  if (!boardHandle.current)
                    throw new Error("画布尚未准备好，请重试");
                  await boardHandle.current.saveHandout(quote);
                  setRight(true);
                  if (window.innerWidth < 900) setLeft(false);
                }}
              />
              <Chat
                lesson={lesson.id}
                initial={data.chat}
                saveConversation={async (input) => {
                  if (!boardHandle.current)
                    throw new Error("画布尚未准备好，请重试");
                  await boardHandle.current.saveConversation(input);
                  setRight(true);
                  if (window.innerWidth < 900) setLeft(false);
                }}
              />
            </div>
          ) : (
            <div className="empty">
              {lesson ? "正在读取课节…" : "选择一节课程开始学习"}
            </div>
          )}
        </main>
        <aside className="notes">
          <Boards
            lesson={lesson}
            focus={focus}
            navigate={navigate}
            saveHandle={boardHandle}
            expanded={expanded}
            toggle={() => {
              setExpanded(!expanded);
              setRight(true);
            }}
          />
        </aside>
      </div>
      {exporting && (
        <Export
          courses={courses}
          courseId={
            courses.find((course) =>
              course.lessons.some((item) => item.id === lesson?.id),
            )?.id
          }
          flush={() => boardHandle.current?.flush() ?? Promise.resolve()}
          close={() => setExporting(false)}
        />
      )}
      {importing && (
        <Import
          flush={() => boardHandle.current?.flush() ?? Promise.resolve()}
          close={() => setImporting(false)}
        />
      )}
      {searching && (
        <KnowledgeSearch
          close={() => setSearching(false)}
          choose={(card) => {
            setSearching(false);
            navigate(card.lessonId, card.id);
          }}
        />
      )}
      {settings && <Settings close={() => setSettings(false)} />}
    </div>
  );
}
