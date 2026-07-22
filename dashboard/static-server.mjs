import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("./out", import.meta.url)));
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

function isInsideRoot(filePath) {
  const pathFromRoot = relative(root, filePath);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`))
  );
}

async function findFile(pathname) {
  let decodedPath;

  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decodedPath.includes("\0")) {
    return null;
  }

  const relativePath = decodedPath.replace(/^\/+/u, "");
  const candidates = [
    join(root, relativePath),
    join(root, `${relativePath}.html`),
    join(root, relativePath, "index.html"),
    join(root, "index.html"),
  ];

  for (const candidate of candidates) {
    const filePath = resolve(candidate);
    if (!isInsideRoot(filePath)) {
      continue;
    }

    try {
      const fileStat = await stat(filePath);
      if (fileStat.isFile()) {
        return { filePath, fileStat };
      }
    } catch {
      // Try the next static export candidate.
    }
  }

  return null;
}

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end("Method Not Allowed\n");
    return;
  }

  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const result = await findFile(pathname);

  if (!result) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not Found\n");
    return;
  }

  const extension = extname(result.filePath).toLowerCase();
  const headers = {
    "Cache-Control": result.filePath.includes(`${sep}_next${sep}`)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "Content-Length": result.fileStat.size,
    "Content-Type": contentTypes[extension] ?? "application/octet-stream",
  };

  response.writeHead(200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }

  createReadStream(result.filePath)
    .on("error", () => {
      if (!response.headersSent) {
        response.writeHead(500, {
          "Content-Type": "text/plain; charset=utf-8",
        });
      }
      response.end("Internal Server Error\n");
    })
    .pipe(response);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Static server listening on port ${port}`);
});
