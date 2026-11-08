import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  LearningContent,
  BoardInfo,
  ChatMessage,
  ModelSettings,
  Progress,
} from "../src/types.ts";
export interface SavedBoard extends BoardInfo {
  session?: unknown;
  document: unknown;
}
export interface LearningState extends LearningContent {
  schemaVersion: 1;
  boards: SavedBoard[];
  chats: Record<string, ChatMessage[]>;
  progress: Record<string, Progress>;
  settings: ModelSettings;
  lastLesson: string;
}
export class Store {
  state: LearningState = {
    schemaVersion: 1,
    primaryBoards: {},
    cards: {},
    excerpts: {},
    evidence: {},
    boards: [],
    chats: {},
    progress: {},
    settings: { baseUrl: "", model: "", apiKey: "" },
    lastLesson: "",
  };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const file = path.join(this.directory, "state.json");
      const raw = await readFile(file, "utf8");
      const saved = JSON.parse(raw);
      if (saved.schemaVersion !== undefined && saved.schemaVersion !== 1)
        throw new Error(`不支持学习数据版本：${saved.schemaVersion}`);
      if (saved.schemaVersion === 1) {
        this.state = saved;
        return;
      }
      // Preserve the original file before the first versioned write.
      try {
        await writeFile(
          path.join(this.directory, "state.v0.backup.json"),
          raw,
          { mode: 0o600, flag: "wx" },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const chats: LearningState["chats"] = {};
      for (const [lessonId, messages] of Object.entries(
        saved.chats as Record<string, ChatMessage[]>,
      )) {
        chats[lessonId] = messages.map((message) => ({
          ...message,
          id: randomUUID(),
          lessonId,
          createdAt: null,
        }));
      }
      this.state = { ...this.state, ...saved, schemaVersion: 1, chats };
      await this.update(() => {});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  update<T>(change: (state: LearningState) => T): Promise<T> {
    const task = this.queue.then(async () => {
      // Commit only after the atomic disk write succeeds.
      const next = structuredClone(this.state);
      const result = change(next);
      const file = path.join(this.directory, "state.json");
      await writeFile(file + ".tmp", JSON.stringify(next), { mode: 0o600 });
      await rename(file + ".tmp", file);
      this.state = next;
      return result;
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async snapshot(): Promise<LearningState> {
    await this.queue;
    return structuredClone(this.state);
  }
}
