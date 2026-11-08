export interface Lesson {
  id: string;
  courseId: string;
  title: string;
  folder: string;
  video: boolean;
  handout: boolean;
}
export interface Course {
  id: string;
  name: string;
  lessons: Lesson[];
}
export interface ChatMessage {
  id: string;
  lessonId: string;
  createdAt: string | null;
  replyTo?: string;
  context?: { handoutHash: string; model: string };
  role: "user" | "assistant";
  text: string;
  incomplete?: boolean;
}
export interface Progress {
  position: number;
  rate: number;
}
export interface ModelSettings {
  baseUrl: string;
  model: string;
  apiKey: string;
}
export interface BoardInfo {
  lessonId?: string;
  id: string;
  name: string;
  updatedAt: string;
  revision: number;
}

// Semantic content is independent of tldraw coordinates and shape records.
export interface Card {
  id: string;
  lessonId: string;
  type: "text" | "question" | "conclusion" | "source" | "conversation" | "reference" | "experiment";
  title: string;
  body: string;
  status: "draft" | "verified";
  createdAt: string;
  updatedAt: string;
  evidenceIds: string[];
  excerptId?: string;
  target?: { lessonId: string; cardId: string };
  experiment?: import("./diff").DiffExperiment;
  handoutSource?: { lessonId: string; hash: string; quote: string };
}
export interface CardLocation {
  id: string;
  lessonId: string;
  title: string;
  type: Card["type"];
  status: Card["status"];
  courseTitle: string;
  lessonTitle: string;
  available: boolean;
}
export interface ConversationExcerpt {
  id: string;
  lessonId: string;
  createdAt: string;
  messageIds: string[];
  // Keep the selected text readable even if the original conversation changes.
  turns: Pick<
    ChatMessage,
    "id" | "role" | "text" | "createdAt" | "context" | "incomplete"
  >[];
}
export interface SaveConversationInput {
  answerId: string;
  selectedText?: string;
  mode: "conversation" | "distill";
}
export interface ConversationDraft {
  card: Card;
  excerpt?: ConversationExcerpt;
}
export interface ExportOptions {
  courseId?: string;
  mode: "private" | "share";
  excerptIds: string[];
  includeAssets: boolean;
}
export interface ImportPreview {
  token: string;
  mode: "private" | "share";
  rows: {
    key: string;
    title: string;
    lessonId?: string;
    status: "ready" | "conflict" | "missing" | "empty";
    reason: string;
    cards: number;
    excerpts: number;
  }[];
  assets: number;
  warnings: string[];
}
export interface Evidence {
  id: string;
  sourceType: "lesson" | "url" | "commit" | "file" | "test";
  uri: string;
  version?: string;
}
export interface LearningContent {
  primaryBoards: Record<string, string>;
  cards: Record<string, Card>;
  excerpts: Record<string, ConversationExcerpt>;
  evidence: Record<string, Evidence>;
}
