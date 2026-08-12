import { execFile } from "child_process";
import { existsSync, statSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import path from "path";
import { promisify } from "util";
import { ToolSchema } from "./deepseek";

const run = promisify(execFile);

/** What the model gets back, plus a one-line version for the trace shown to the user. */
export interface ToolResult {
  text: string;
  summary: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolDeps {
  tavilyApiKey?: string;
  downloadDir: string;
  /** The file tools may not read outside this root, or outside downloadDir. */
  root: string;
  /** Raycast-only readers. Omitted outside the Raycast runtime, e.g. in tests. */
  readSelection?: () => Promise<string | null>;
  readClipboard?: () => Promise<string | null>;
  readFrontmostApp?: () => Promise<string | null>;
}

const MAX_PAGE_CHARS = 12_000;
const MAX_FILE_CHARS = 12_000;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

/** Index and cache noise that buries the results a person actually wants. */
const NOISE = ["/node_modules/", "/.git/", "/Library/", "/.Trash/", "/.cache/", "/dist/", "/build/"];

/** Reading these leaks credentials, and no answer is worth that. */
const SECRETS = [".ssh", ".aws", ".gnupg", ".env", "keychains", "id_rsa", "id_ed25519", ".netrc", "credentials"];

export function createTools(deps: ToolDeps): Tool[] {
  const tools: Tool[] = [];

  // Only offered when a key exists — a tool that always fails wastes a round trip.
  if (deps.tavilyApiKey) tools.push(webSearch(deps.tavilyApiKey));

  // Whatever download_file writes has to be readable afterwards, even when the
  // download folder sits outside the home directory.
  const roots = [deps.root, deps.downloadDir];
  tools.push(readWebpage(), searchFiles(roots), searchInFiles(roots), readLocalFile(roots));
  tools.push(downloadFile(deps.downloadDir));

  if (deps.readSelection || deps.readClipboard || deps.readFrontmostApp) tools.push(getContext(deps));

  return tools;
}

export function toSchemas(tools: Tool[]): ToolSchema[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

// ---------------------------------------------------------------- web

function webSearch(apiKey: string): Tool {
  return {
    name: "web_search",
    description:
      "Search the web. Returns a ranked list of title, URL and a short extract per result. " +
      "The extracts are often too thin to answer with — follow up with read_webpage on the URLs worth reading.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query. Prefer the language the answer is likely written in." },
        max_results: { type: "integer", description: "How many results to return, 1-10. Defaults to 5." },
      },
      required: ["query"],
    },
    run: async (args) => {
      const query = String(args.query ?? "").trim();
      if (!query) throw new Error("query is required");
      const maxResults = clamp(Number(args.max_results) || 5, 1, 10);

      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query, max_results: maxResults, search_depth: "basic" }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Tavily returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
      }

      const data = (await response.json()) as { results?: { title?: string; url?: string; content?: string }[] };
      const results = data.results ?? [];
      if (results.length === 0) return { text: `No results for "${query}".`, summary: "0 results" };

      const text = results
        .map((r, i) => `${i + 1}. ${r.title ?? "(untitled)"}\n   ${r.url ?? ""}\n   ${(r.content ?? "").trim()}`)
        .join("\n\n");
      return { text, summary: `${results.length} results` };
    },
  };
}

function readWebpage(): Tool {
  return {
    name: "read_webpage",
    description:
      "Fetch a web page and return its main content as Markdown. Use it on URLs from web_search, or on a URL " +
      "the user gave you directly. Long pages are truncated.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute http(s) URL." } },
      required: ["url"],
    },
    run: async (args) => {
      const url = String(args.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");

      // r.jina.ai renders the page and hands back clean Markdown, which beats
      // anything a regex over raw HTML would produce.
      const response = await fetch(`https://r.jina.ai/${url}`, {
        headers: { Accept: "text/plain" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Reader returned ${response.status} for ${url}`);

      const body = await response.text();
      const { text, truncated } = truncate(body, MAX_PAGE_CHARS);
      return {
        text: truncated ? `${text}\n\n[truncated — page continues]` : text,
        summary: `${body.length.toLocaleString()} chars${truncated ? ", truncated" : ""}`,
      };
    },
  };
}

// ---------------------------------------------------------------- local

function searchFiles(roots: string[]): Tool {
  return {
    name: "search_files",
    description:
      "Find files on this Mac by name or content using the Spotlight index. Fast, but only covers indexed " +
      "locations. Use search_in_files instead when you need the matching lines rather than the file list.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for in file names and contents." },
        folder: { type: "string", description: "Optional folder to restrict the search to, e.g. ~/Documents." },
      },
      required: ["query"],
    },
    run: async (args) => {
      const query = String(args.query ?? "").trim();
      if (!query) throw new Error("query is required");
      const folder = resolveInside(roots, args.folder ? String(args.folder) : roots[0]);

      const { stdout } = await run("/usr/bin/mdfind", ["-onlyin", folder, query], {
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      });

      const hits = stdout
        .split("\n")
        .filter(Boolean)
        .filter((p) => !NOISE.some((n) => p.includes(n)))
        .slice(0, 25);

      if (hits.length === 0) return { text: `No files matched "${query}" under ${folder}.`, summary: "0 files" };

      const text = hits
        .map((p) => {
          try {
            const stat = statSync(p);
            return `${p}  (${formatBytes(stat.size)}, modified ${stat.mtime.toISOString().slice(0, 10)})`;
          } catch {
            return p;
          }
        })
        .join("\n");
      return { text, summary: `${hits.length} files` };
    },
  };
}

function searchInFiles(roots: string[]): Tool {
  return {
    name: "search_in_files",
    description:
      "Search the contents of files under a folder and return the matching lines with their file and line number. " +
      "Use this when you need to see the match itself, not just which file it is in.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Text or regular expression to search for." },
        folder: { type: "string", description: "Folder to search, e.g. ~/Downloads/project." },
        file_glob: { type: "string", description: "Optional filename filter, e.g. *.ts" },
      },
      required: ["pattern", "folder"],
    },
    run: async (args) => {
      const pattern = String(args.pattern ?? "").trim();
      if (!pattern) throw new Error("pattern is required");
      const folder = resolveInside(roots, String(args.folder ?? roots[0]));
      const glob = args.file_glob ? String(args.file_glob) : undefined;

      const ripgrep = findRipgrep();
      // Arguments go as an array, never through a shell, so a pattern containing
      // quotes or semicolons is data and cannot become a command.
      const argv = ripgrep
        ? ["--line-number", "--max-count", "3", "--max-columns", "200", "--no-heading", "--color", "never"]
        : ["-rnI", "--"];

      if (ripgrep) {
        if (glob) argv.push("--glob", glob);
        argv.push("--regexp", pattern, folder);
      } else {
        argv.splice(1, 0, pattern);
        argv.push(folder);
      }

      let stdout = "";
      try {
        ({ stdout } = await run(ripgrep ?? "/usr/bin/grep", argv, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }));
      } catch (error) {
        // Both tools exit 1 on "no matches", which is not a failure here.
        const code = (error as { code?: number }).code;
        if (code !== 1) throw error;
      }

      const lines = stdout
        .split("\n")
        .filter(Boolean)
        .filter((l) => !NOISE.some((n) => l.includes(n)))
        .slice(0, 60);

      if (lines.length === 0) return { text: `No matches for "${pattern}" under ${folder}.`, summary: "0 matches" };
      return { text: lines.join("\n"), summary: `${lines.length} matching lines` };
    },
  };
}

function readLocalFile(roots: string[]): Tool {
  return {
    name: "read_local_file",
    description: "Read a text file from this Mac. Long files are truncated. Binary files are refused.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path, or a path starting with ~." } },
      required: ["path"],
    },
    run: async (args) => {
      const target = resolveInside(roots, String(args.path ?? ""));
      if (SECRETS.some((s) => target.toLowerCase().includes(s))) {
        throw new Error(`Refusing to read ${target}: it looks like it holds credentials.`);
      }

      const stat = statSync(target);
      if (stat.isDirectory()) throw new Error(`${target} is a directory — use search_files instead.`);
      if (stat.size > 5 * 1024 * 1024) throw new Error(`${target} is ${formatBytes(stat.size)}, too large to read.`);

      const buffer = await readFile(target);
      if (buffer.subarray(0, 8000).includes(0)) throw new Error(`${target} looks like a binary file.`);

      const { text, truncated } = truncate(buffer.toString("utf8"), MAX_FILE_CHARS);
      return {
        text: truncated ? `${text}\n\n[truncated — file continues]` : text,
        summary: `${formatBytes(stat.size)}${truncated ? ", truncated" : ""}`,
      };
    },
  };
}

// ---------------------------------------------------------------- system

function downloadFile(downloadDir: string): Tool {
  return {
    name: "download_file",
    description: "Download a file from a URL and save it to the user's download folder. Returns the saved path.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL of the file." },
        filename: { type: "string", description: "Optional name to save it as. Defaults to the name in the URL." },
      },
      required: ["url"],
    },
    run: async (args) => {
      const url = String(args.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");

      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} for ${url}`);

      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`File is ${formatBytes(declared)}, above the 50 MB cap.`);

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
        throw new Error(`File is ${formatBytes(buffer.byteLength)}, above the 50 MB cap.`);
      }

      // basename strips any path the URL or the model tried to smuggle in.
      const requested = args.filename ? String(args.filename) : decodeURIComponent(new URL(url).pathname);
      const name = path.basename(requested) || "download";
      await mkdir(downloadDir, { recursive: true });
      const target = uniquePath(path.join(downloadDir, name));

      await writeFile(target, buffer);
      return { text: `Saved to ${target} (${formatBytes(buffer.byteLength)}).`, summary: path.basename(target) };
    },
  };
}

function getContext(deps: ToolDeps): Tool {
  return {
    name: "get_context",
    description:
      "Read what the user is currently looking at: the text they have selected, their clipboard, and the " +
      "frontmost app. Call this when the request says 'this', 'that', 'the selected text' or similar.",
    parameters: { type: "object", properties: {} },
    run: async () => {
      const [selection, clipboard, app] = await Promise.all([
        deps.readSelection?.().catch(() => null) ?? null,
        deps.readClipboard?.().catch(() => null) ?? null,
        deps.readFrontmostApp?.().catch(() => null) ?? null,
      ]);

      const parts: string[] = [];
      if (app) parts.push(`Frontmost app: ${app}`);
      parts.push(selection ? `Selected text:\n${truncate(selection, 4000).text}` : "Selected text: (none)");
      parts.push(clipboard ? `Clipboard:\n${truncate(clipboard, 4000).text}` : "Clipboard: (empty)");

      return { text: parts.join("\n\n"), summary: selection ? "selection + clipboard" : "clipboard" };
    },
  };
}

// ---------------------------------------------------------------- helpers

/** Resolves ~ and relative paths, then refuses anything outside the allowed roots. */
function resolveInside(roots: string[], input: string): string {
  const expanded = input.startsWith("~") ? path.join(homedir(), input.slice(1)) : input;
  const resolved = path.resolve(roots[0], expanded);
  const allowed = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!allowed) throw new Error(`${resolved} is outside ${roots.join(" and ")}, which this command may not leave.`);
  if (!existsSync(resolved)) throw new Error(`${resolved} does not exist.`);
  return resolved;
}

function findRipgrep(): string | undefined {
  // Raycast runs with a minimal PATH, so a bare "rg" would not resolve.
  const candidates = [
    "/opt/homebrew/bin/rg",
    "/usr/local/bin/rg",
    path.join(homedir(), ".local/bin/rg"),
    path.join(homedir(), ".cargo/bin/rg"),
  ];
  return candidates.find((c) => existsSync(c));
}

function uniquePath(target: string): string {
  if (!existsSync(target)) return target;
  const ext = path.extname(target);
  const stem = target.slice(0, target.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  return text.length <= limit ? { text, truncated: false } : { text: text.slice(0, limit), truncated: true };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
