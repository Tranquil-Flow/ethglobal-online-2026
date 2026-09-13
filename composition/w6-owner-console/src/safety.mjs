import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

const REDACTED = "[REDACTED]";

export function assertLoopbackHost(host) {
  if (host !== "127.0.0.1") throw new Error("LOOPBACK_BINDING_REQUIRED");
  return host;
}

export function redactSensitive(value) {
  let text = String(value ?? "");
  text = text.replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, REDACTED);
  let inPrivateBlock = false;
  text = text.split(/\r?\n/).map((line) => {
    if (/BEGIN[^\r\n]*PRIVATE/i.test(line)) inPrivateBlock = true;
    if (inPrivateBlock) {
      if (/END[^\r\n]*PRIVATE/i.test(line)) inPrivateBlock = false;
      return REDACTED;
    }
    return line;
  }).join("\n");
  text = text.replace(/0x[0-9a-f]{40,}/gi, REDACTED);
  text = text.replace(/(^|[^0-9a-z])[0-9a-f]{32,}(?=$|[^0-9a-z])/gi, (_, prefix) => `${prefix}${REDACTED}`);
  text = text.replace(/((?:"?(?:private[-_ ]?key|api[-_ ]?key|key|secret|bearer|signature)"?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, `$1${REDACTED}`);
  text = text.replace(/\b(?:bearer|secret)\b(?:\s+|\s*[:=]\s*)[^\s,;}]+/gi, REDACTED);
  return text;
}

function cleanFeedback(input, now) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_FEEDBACK");
  const allowed = new Set(["page", "text", "screenshotRef"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("INVALID_FEEDBACK");
  const text = typeof input.text === "string" ? redactSensitive(input.text.trim()) : "";
  const page = typeof input.page === "string" ? input.page.trim() : "";
  const screenshotRef = input.screenshotRef === undefined ? undefined : redactSensitive(String(input.screenshotRef).trim());
  if (!text || text.length > 4000 || /\0/.test(text)) throw new Error("INVALID_FEEDBACK_TEXT");
  if (!/^\/[A-Za-z0-9/_?&=.%#:-]{0,255}$/.test(page)) throw new Error("INVALID_FEEDBACK_PAGE");
  if (screenshotRef !== undefined && (!screenshotRef || screenshotRef.length > 512 || /[\0\r\n]/.test(screenshotRef))) throw new Error("INVALID_SCREENSHOT_REF");
  return Object.freeze({ ts: now().toISOString(), page, text, ...(screenshotRef ? { screenshotRef } : {}) });
}

export function createFeedbackStore(path, { now = () => new Date(), limit = 50 } = {}) {
  let queue = Promise.resolve();
  async function append(input) {
    const row = cleanFeedback(input, now);
    const task = queue.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await appendFile(path, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(path, 0o600);
      return row;
    });
    queue = task.catch(() => {});
    return task;
  }
  async function list() {
    await queue;
    let text;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row.ts === "string" && typeof row.page === "string" && typeof row.text === "string") rows.push(row);
      } catch {
        rows.push({ ts: null, page: "/console", text: "unavailable — malformed historical feedback entry" });
      }
    }
    return rows.slice(-limit);
  }
  return Object.freeze({ append, list });
}
