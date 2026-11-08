import {
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
  link,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Course, Lesson } from "../src/types.ts";

// Travels with the directory, so renaming does not change its identity.
async function identity(
  directory: string,
  initialId: string = randomUUID(),
): Promise<string> {
  const file = path.join(directory, ".coursex-id.json");
  const read = async () => {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (
      value.schemaVersion !== 1 ||
      typeof value.id !== "string" ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(value.id)
    )
      throw Object.assign(new Error(`课程身份文件无效：${file}`), {
        status: 422,
      });
    return value.id as string;
  };
  try {
    return await read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Publish a complete file without overwriting another scanner's identity.
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({ schemaVersion: 1, id: initialId }) + "\n",
  );
  try {
    try {
      await link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return await read();
  } finally {
    await unlink(temporary);
  }
}

export class Library {
  private lessons = new Map<string, string>();
  constructor(readonly root: string) {}
  async scan(): Promise<Course[]> {
    const courses: Course[] = [];
    const next = new Map<string, string>();
    const courseIds = new Set<string>();
    const root = await realpath(this.root);
    for (const course of (await readdir(root, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name, "zh"),
    )) {
      if (!course.isDirectory() || course.name.startsWith(".")) continue;
      const coursePath = path.join(root, course.name);
      const courseId = await identity(coursePath);
      if (courseIds.has(courseId))
        throw Object.assign(
          new Error(`课程 ID 重复：${courseId}，请检查复制的目录身份文件`),
          { status: 409 },
        );
      courseIds.add(courseId);
      let order: string[] = [];
      try {
        const manifest = JSON.parse(
          await readFile(path.join(coursePath, "课程清单.json"), "utf8"),
        );
        order = (manifest.videos ?? []).map(
          (video: { folder: string }) => video.folder,
        );
      } catch {
        /* A course folder can be used without a downloader manifest. */
      }
      const folders = (
        await readdir(coursePath, { withFileTypes: true })
      ).filter((item) => item.isDirectory() && !item.name.startsWith("."));
      folders.sort((a, b) => {
        const ai = order.indexOf(a.name),
          bi = order.indexOf(b.name);
        return (
          (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) ||
          a.name.localeCompare(b.name, "zh", { numeric: true })
        );
      });
      const lessons: Lesson[] = [];
      for (const folder of folders) {
        const location = path.join(coursePath, folder.name);
        const files = await readdir(location);
        if (!files.includes("视频.mp4") && !files.includes("课件.md")) continue;
        const legacyId = createHash("sha256")
          .update(`${course.name}/${folder.name}`)
          .digest("hex")
          .slice(0, 24);
        const id = await identity(location, legacyId);
        if (next.has(id))
          throw Object.assign(
            new Error(`课节 ID 重复：${id}，请检查复制的目录身份文件`),
            { status: 409 },
          );
        next.set(id, location);
        lessons.push({
          id,
          courseId,
          title: folder.name,
          folder: folder.name,
          video: files.includes("视频.mp4"),
          handout: files.includes("课件.md"),
        });
      }
      courses.push({ id: courseId, name: course.name, lessons });
    }
    this.lessons = next;
    return courses;
  }
  async file(id: string, relative: string): Promise<string> {
    const lesson = this.lessons.get(id);
    if (!lesson)
      throw Object.assign(new Error("课节不存在，请刷新课程目录"), {
        status: 404,
      });
    const candidate = path.resolve(lesson, relative);
    if (!candidate.startsWith(lesson + path.sep))
      throw Object.assign(new Error("文件路径无效"), { status: 403 });
    const target = await realpath(candidate);
    if (!target.startsWith(lesson + path.sep))
      throw Object.assign(new Error("文件路径无效"), { status: 403 });
    if (!(await stat(target)).isFile())
      throw Object.assign(new Error("文件不存在"), { status: 404 });
    return target;
  }
  async navigation(courseId: string) {
    const course = (await this.scan()).find(item => item.id === courseId);
    if (!course) throw Object.assign(new Error("课程不存在"), { status: 404 });
    let folders: string[] = [];
    try {
      const manifest = JSON.parse(await readFile(path.join(this.root, course.name, "课程清单.json"), "utf8"));
      folders = (manifest.videos ?? []).map((video: { folder: string }) => video.folder);
    } catch { /* No source numbering is guessed when the original catalog is unavailable. */ }
    return { schemaVersion: 1, courseId: course.id, courseTitle: course.name, lessons: course.lessons.map(lesson => ({
      id: lesson.id, title: lesson.title, sourceNumber: folders.includes(lesson.folder) ? folders.indexOf(lesson.folder) + 1 : null,
    })) };
  }
  async handout(id: string) {
    try {
      return await readFile(await this.file(id, "课件.md"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }
}
