import path from "node:path";
import os from "node:os";
import express from "express";
import { createApp } from "./app.ts";
import { Library } from "./library.ts";
import { Store } from "./store.ts";

const root = path.resolve(import.meta.dirname, "..");
const app = await createApp(
  new Library(
    path.resolve(process.env.COURSEX_LIBRARY ?? path.join(root, "library")),
  ),
  new Store(
    path.resolve(process.env.COURSEX_DATA ?? path.join(root, ".coursex-data")),
  ),
);
if (process.argv.includes("--dev")) {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.join(root, "dist")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(root, "dist/index.html")),
  );
}
const port = Number(process.env.PORT ?? 4310);
const host = process.env.HOST ?? "0.0.0.0";
app.listen(port, host, () => {
  console.log(`CourseX: http://localhost:${port}`);
  for (const [name, addresses] of Object.entries(os.networkInterfaces()))
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal)
        console.log(`网络地址 (${name}): http://${address.address}:${port}`);
    }
});
