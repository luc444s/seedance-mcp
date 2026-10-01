#!/usr/bin/env node
// Servidor MCP (stdio) para generar video con Seedance 2.0 de ByteDance/Ark.
// Sirve para que OpenClaw (u otro cliente MCP) pueda crear y consultar videos
// sin depender del monolito de orquestador_ardi.
//
// Herramientas:
//   seedance_generate  Crea una tarea de video (t2v / i2v) y opcionalmente espera
//   seedance_status    Consulta el estado de una tarea
//   seedance_wait      Espera bloqueante hasta que la tarea termine
//   seedance_list      Lista tareas recientes guardadas en el estado local
//
// Config por env:
//   SEEDANCE_API_KEY   (obligatorio) token Bearer de Ark/BytePlus
//   SEEDANCE_BASE_URL  (opcional) default https://ark.ap-southeast.bytepluses.com
//   SEEDANCE_POLL_MAX  (opcional) segundos max de espera, default 300

import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { r2Upload, fetchBinary } from "./r2.mjs";

const API_KEY = process.env.SEEDANCE_API_KEY?.trim();
const BASE_URL = (process.env.SEEDANCE_BASE_URL || "https://ark.ap-southeast.bytepluses.com").replace(/\/$/, "");
const POLL_MAX = Number(process.env.SEEDANCE_POLL_MAX || 300);
const STATE_DIR = process.env.SEEDANCE_STATE_DIR || "/tmp/seedance-mcp";
// Donde se dejan los videos descargados para poder adjuntarlos al chat.
const OUTBOX_DIR = process.env.SEEDANCE_OUTBOX_DIR || path.join(STATE_DIR, "videos");
const KEEP_LOCAL = process.env.SEEDANCE_KEEP_LOCAL !== "false";
const MODEL_DEFAULT = "dreamina-seedance-2-0-260128";

// Cloudflare R2: las URLs de ByteDance expiran en 24h, asi que para conservar
// un resultado o para reutilizarlo como referencia de v2v hay que publicarlo.
const R2 = {
  enabled: process.env.R2_ENABLED === "true" || Boolean(process.env.R2_ACCESS_KEY_ID),
  accountId: process.env.R2_ACCOUNT_ID || "",
  accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  bucket: process.env.R2_BUCKET || "ai-uploads",
  publicUrl: (process.env.R2_PUBLIC_URL || "").replace(/\/$/, ""),
};
const R2_AVAILABLE = R2.enabled && R2.accountId && R2.accessKeyId && R2.secretAccessKey && R2.bucket;

const TERMINAL_OK = new Set(["succeeded", "completed", "success", "done"]);
const TERMINAL_FAIL = new Set(["failed", "cancelled", "canceled", "expired", "error"]);

// --- transporte JSON-RPC 2.0 sobre stdio -------------------------------------

const pending = new Map();
const buffer = { raw: "" };

const rpc = {
  send(msg) {
    process.stdout.write(JSON.stringify(msg) + "\n");
  },
  ok(id, result) {
    this.send({ jsonrpc: "2.0", id, result });
  },
  fail(id, code, message) {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  },
  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  },
};

function textResult(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function toolResult(value, isError = false) {
  const r = textResult(value);
  if (isError) r.isError = true;
  return r;
}

/**
 * Empaqueta el resultado con adjuntos estructurados para que el canal los
 * renderice como media y no como texto.
 *
 * `content` es lo que lee el modelo; `details.media` es metadata de runtime que
 * OpenClaw usa para entregar el archivo (ver docs/concepts/messages.md,
 * "Tool result metadata"). Por eso el texto va en ambos lados: el agente debe
 * poder razonar sobre la URL sin parsear la respuesta del canal.
 *
 * Se prefiere `path` sobre `url` cuando el archivo esta en disco: los canales
 * como Discord y WhatsApp necesitan el binario para subirlo, y una URL firmada
 * de 24h puede no ser accesible desde su lado.
 */
function mediaResult(value, media = []) {
  const r = toolResult(value);
  if (media.length) {
    r.details = { media };
  }
  return r;
}

// --- API ---------------------------------------------------------------------

async function api(path, init = {}) {
  if (!API_KEY) throw new Error("Falta SEEDANCE_API_KEY en el entorno");
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(body?.error?.message || body?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- estado local -------------------------------------------------------------

async function recordSave(id, entry) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(`${STATE_DIR}/${id}.json`, JSON.stringify(entry, null, 2));
}

async function recordGet(id) {
  try {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(`${STATE_DIR}/${id}.json`, "utf8"));
  } catch {
    return null;
  }
}

// --- herramientas ---------------------------------------------------------------

function buildPrompt(prompt, opts) {
  const flags = [];
  if (opts.resolution) flags.push(`--resolution ${opts.resolution}`);
  if (opts.duration) flags.push(`--duration ${opts.duration}`);
  if (opts.ratio) flags.push(`--ratio ${opts.ratio}`);
  if (opts.cameraFixed !== undefined) flags.push(`--camerafixed ${opts.cameraFixed}`);
  if (opts.watermark !== undefined) flags.push(`--watermark ${opts.watermark}`);
  if (opts.seed !== undefined) flags.push(`--seed ${opts.seed}`);
  return flags.length ? `${prompt}  ${flags.join("  ")}` : prompt;
}

// Directorio donde OpenClaw deja los archivos que el usuario sube al chat.
// Un path local no le sirve a ByteDance (sus servidores no ven tu disco), asi
// que hay que publicarlo en R2 antes de usarlo como referencia.
const OPENCLAW_MEDIA_DIR = process.env.OPENCLAW_MEDIA_DIR || "";

const CONTENT_TYPES = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

/** Resuelve un input del usuario a un path absoluto legible. */
function resolveInputPath(input) {
  if (!input) return null;

  // Si ya es un id de media de OpenClaw (o un path relativo media/inbound/...)
  const bare = String(input).replace(/^\/+/, "").replace(/^media\/inbound\//, "");
  if (OPENCLAW_MEDIA_DIR && /^[A-Za-z0-9_-]{8,}$/.test(bare)) {
    const candidate = path.join(OPENCLAW_MEDIA_DIR, bare);
    if (existsSync(candidate)) return candidate;
  }
  if (existsSync(input)) return path.resolve(input);
  if (OPENCLAW_MEDIA_DIR) {
    const candidate = path.join(OPENCLAW_MEDIA_DIR, bare);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function r2UploadLocal(filePath, keyPrefix) {
  if (!R2_AVAILABLE) {
    throw new Error("R2 no esta configurado. Define R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY y R2_BUCKET.");
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || "application/octet-stream";
  const data = await readFile(filePath);
  const key = `${keyPrefix}${Date.now()}${ext}`;
  const publicUrl = await r2Upload(data, key, contentType, R2);
  return { publicUrl, key, bytes: data.length, contentType };
}

/**
 * Prepara el video para entregarlo: lo deja en disco (para que el canal lo
 * pueda subir) y devuelve el fact de media en el formato que OpenClaw espera
 * (`PluginHookMediaFact`: path, url, contentType, kind).
 *
 * Sin esto el video vuelve como texto con una URL, que el usuario tiene que
 * copiar a mano. Con esto aparece el reproductor en el chat y llega como
 * archivo a Discord/WhatsApp.
 */
async function deliverableMedia(taskId, videoUrl) {
  if (!KEEP_LOCAL || !videoUrl) return [];
  try {
    await mkdir(OUTBOX_DIR, { recursive: true });
    const filePath = path.join(OUTBOX_DIR, `${taskId}.mp4`);
    const data = await fetchBinary(videoUrl);
    await writeFile(filePath, data);
    return [
      {
        path: filePath,
        url: videoUrl,
        contentType: "video/mp4",
        kind: "video",
        workspaceDir: OUTBOX_DIR,
      },
    ];
  } catch (err) {
    // El video sigue siendo accesible por URL aunque no se pueda adjuntar.
    process.stderr.write(`[seedance] no se pudo preparar el adjunto: ${err.message}\n`);
    return [];
  }
}

const TOOLS = [
  {
    name: "seedance_generate",
    description:
      "Genera un video con Seedance 2.0 (ByteDance). Modo texto-a-video, imagen-a-video o video-a-video. " +
      "Requiere prompt en ingles o chino. Si wait=true (default) espera el resultado y devuelve la URL del mp4. " +
      "Duracion admitida: 2-12s (recomendado 5 o 10). Resoluciones: 480p, 720p, 1080p. " +
      "Nota: con videoUrl el job tarda bastante mas (varios minutos) que con solo texto.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", description: "Descripcion del video. Formato recomendado: FORMAT / SUBJECT / ENVIRONMENT / MOOD / STYLE / SHOT n" },
        imageUrl: { type: "string", description: "URL publica de la imagen inicial para image-to-video (requerida en modo i2v)" },
        videoUrls: {
          type: "array",
          items: { type: "string" },
          description: "URLs publicas de videos de referencia para video-to-video. Max 3, duracion total <=15s, mp4/mov. Requiere prompt de instruccion (que cambiar).",
        },
        model: { type: "string", default: MODEL_DEFAULT },
        resolution: { type: "string", enum: ["480p", "720p", "1080p"], default: "720p" },
        duration: { type: "number", default: 5, description: "Segundos (2-12)" },
        ratio: { type: "string", description: "Aspecto: 16:9, 9:16, 1:1, 4:3, 21:9" },
        generateAudio: { type: "boolean", default: true },
        watermark: { type: "boolean", default: false },
        cameraFixed: { type: "boolean" },
        seed: { type: "number" },
        wait: { type: "boolean", default: true },
        pollInterval: { type: "number", default: 5 },
        archive: { type: "boolean", default: false, description: "Si true, sube el resultado a Cloudflare R2 y devuelve una URL permanente (requiere R2 configurado)." },
      },
    },
    handler: async (args) => {
      const text = buildPrompt(args.prompt, args);
      const content = [{ type: "text", text }];
      if (args.imageUrl) content.push({ type: "image_url", image_url: { url: args.imageUrl } });
      for (const url of args.videoUrls || []) {
        content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
      }

      const task = await api("/api/v3/contents/generations/tasks", {
        method: "POST",
        body: JSON.stringify({
          model: args.model || MODEL_DEFAULT,
          content,
          generate_audio: args.generateAudio !== false,
        }),
      });

      const entry = {
        id: task.id,
        model: args.model || MODEL_DEFAULT,
        status: task.status,
        createdAt: new Date().toISOString(),
        prompt: text,
        mode: args.videoUrls?.length ? "v2v" : args.imageUrl ? "i2v" : "t2v",
      };
      await recordSave(task.id, entry);

      if (args.wait === false) {
        return toolResult({ taskId: task.id, status: task.status, mode: entry.mode, message: "Tarea creada. Usa seedance_wait o seedance_status para seguirla." });
      }

      // El v2v puede tardar varios minutos: se le da mas margen que al t2v/i2v.
      const budget = args.videoUrls?.length ? Math.max(POLL_MAX, 900) : POLL_MAX;
      const finished = await waitForTask(task.id, args.pollInterval || 5, budget);
      const result = describe(finished);

      if (args.archive && result.videoUrl) {
        if (!R2_AVAILABLE) {
          result.archiveError = "R2 no configurado; se devuelve la URL temporal de ByteDance (expira en 24h).";
        } else {
          try {
            const data = await fetchBinary(result.videoUrl);
            result.publicUrl = await r2Upload(data, `seedance/${task.id}.mp4`, "video/mp4", R2);
            result.bytes = data.length;
            await recordSave(task.id, { ...entry, ...result, id: task.id, archivedUrl: result.publicUrl });
          } catch (err) {
            result.archiveError = err.message;
          }
        }
      }

      const media = await deliverableMedia(task.id, result.videoUrl);
      if (media.length) result.delivered = "El video viene adjuntado a este mensaje; no hace falta copiar la URL.";
      return mediaResult(result, media);
    },
  },
  {
    name: "seedance_status",
    description: "Consulta el estado actual de una tarea de Seedance por su task id.",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: { taskId: { type: "string" } },
    },
    handler: async ({ taskId }) => toolResult(describe(await api(`/api/v3/contents/generations/tasks/${encodeURIComponent(taskId)}`))),
  },
  {
    name: "seedance_wait",
    description: "Espera hasta que una tarea de Seedance termine (ok o error) y devuelve la URL del video.",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: {
        taskId: { type: "string" },
        pollInterval: { type: "number", default: 5 },
        maxSeconds: { type: "number", default: POLL_MAX },
      },
    },
    handler: async ({ taskId, pollInterval = 5, maxSeconds = POLL_MAX }) => {
      const done = await waitForTask(taskId, pollInterval, maxSeconds);
      const result = describe(done);
      const media = await deliverableMedia(taskId, result.videoUrl);
      if (media.length) result.delivered = "El video viene adjuntado a este mensaje; no hace falta copiar la URL.";
      return mediaResult(result, media);
    },
  },
  {
    name: "seedance_archive",
    description:
      "Descarga el video de una tarea de Seedance y lo sube a Cloudflare R2, devolviendo una URL publica permanente. " +
      "Usalo siempre que necesites conservar el video o reutilizarlo como referencia de v2v, porque las URLs de ByteDance expiran en 24h.",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: {
        taskId: { type: "string", description: "Id de la tarea. Opcionalmente acepta directamente una URL de video." },
        key: { type: "string", description: "Clave del objeto en R2. Por defecto seedance/<taskId>.mp4" },
      },
    },
    handler: async ({ taskId, key }) => {
      if (!R2_AVAILABLE) {
        return toolResult({ error: "R2 no esta configurado. Define R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY y R2_BUCKET." }, true);
      }
      const isUrl = /^https?:\/\//.test(taskId);
      const videoUrl = isUrl ? taskId : describe(await api(`/api/v3/contents/generations/tasks/${encodeURIComponent(taskId)}`)).videoUrl;
      if (!videoUrl) throw new Error(`La tarea ${taskId} no tiene video todavia (o no exponia video_url)`);

      const data = await fetchBinary(videoUrl);
      const objectKey = key || `seedance/${isUrl ? Date.now() : taskId}.mp4`;
      const publicUrl = await r2Upload(data, objectKey, "video/mp4", R2);
      const prev = (await recordGet(String(taskId))) || {};
      await recordSave(String(taskId), { ...prev, id: String(taskId), archivedUrl: publicUrl, archivedAt: new Date().toISOString() });

      // Ademas de publicar, deja el archivo en disco para adjuntarlo al chat.
      let localPath;
      if (KEEP_LOCAL) {
        try {
          await mkdir(OUTBOX_DIR, { recursive: true });
          localPath = path.join(OUTBOX_DIR, `${path.basename(objectKey)}`);
          await writeFile(localPath, data);
        } catch {
          /* la URL publica ya sirve */
        }
      }
      const result = { taskId, publicUrl, key: objectKey, bytes: data.length, sourceUrl: videoUrl };
      if (localPath) {
        result.delivered = "El video viene adjuntado a este mensaje.";
        return mediaResult(result, [{ path: localPath, url: publicUrl, contentType: "video/mp4", kind: "video", workspaceDir: OUTBOX_DIR }]);
      }
      return toolResult(result);
    },
  },
  {
    name: "seedance_upload",
    description:
      "Sube un archivo local a Cloudflare R2 y devuelve su URL publica, para poder usarlo como referencia de Seedance. " +
      "Sirve cuando el usuario adjunto un video o una imagen en el chat: OpenClaw los guarda en disco local y ByteDance no puede verlos. " +
      "Acepta una ruta absoluta, un id de media de OpenClaw, o una URL http(s) que se descargue y se vuelva a publicar. " +
      "Devuelve tambien un fragmento listo para pegar en prompt/videoUrl/videoUrls.",
    inputSchema: {
      type: "object",
      required: ["source"],
      properties: {
        source: { type: "string", description: "Ruta local, id de media de OpenClaw, o URL publica" },
        keyPrefix: { type: "string", default: "seedance/refs/", description: "Prefijo de la clave en R2" },
        archive: { type: "boolean", default: false, description: "Noop: la subida a R2 ya es el archivado. Se acepta por simetria." },
      },
    },
    handler: async ({ source, keyPrefix = "seedance/refs/" }) => {
      if (!R2_AVAILABLE) {
        return toolResult({ error: "R2 no esta configurado. Sin el no se puede publicar un archivo local." }, true);
      }

      // (a) URL publica: se puede pasar directo a Seedance, pero se re-publica
      // para dejar una copia propia que no expire.
      if (/^https?:\/\//i.test(source)) {
        const data = await fetchBinary(source);
        const ext = (new URL(source).pathname.match(/\.[a-z0-9]{2,5}$/i) || [".bin"])[0];
        const publicUrl = await r2Upload(data, `${keyPrefix}${Date.now()}${ext}`, CONTENT_TYPES[ext.toLowerCase()] || "application/octet-stream", R2);
        return toolResult({ source, publicUrl, bytes: data.length, note: "Descargado y republicado en R2." });
      }

      // (b) archivo local
      const filePath = resolveInputPath(source);
      if (!filePath) {
        return toolResult(
          {
            error: `No encuentro el archivo: ${source}`,
            hint: OPENCLAW_MEDIA_DIR
              ? `Se busca en ${OPENCLAW_MEDIA_DIR} y tambien rutas absolutas.`
              : "Define OPENCLAW_MEDIA_DIR para resolver ids de media de OpenClaw automaticamente.",
          },
          true
        );
      }
      const { publicUrl, key, bytes, contentType } = await r2UploadLocal(filePath, keyPrefix);
      return toolResult({
        source: filePath,
        publicUrl,
        key,
        bytes,
        contentType,
        usage: contentType.startsWith("video/") ? { videoUrls: [publicUrl] } : { imageUrl: publicUrl },
        hint: contentType.startsWith("video/")
          ? "Usar como videoUrls en seedance_generate (v2v)."
          : "Usar como imageUrl en seedance_generate (i2v).",
      });
    },
  },
  {
    name: "seedance_from_file",
    description:
      "Atajo: toma un archivo del chat (video o imagen), lo publica en R2 y genera un video nuevo de una sola llamada. " +
      "Es la via recomendada cuando el usuario ya subio un archivo: sin publicar, ByteDance no puede leerlo. " +
      "Para video usa v2v (tarda ~6 min); para imagen usa i2v (~1 min).",
    inputSchema: {
      type: "object",
      required: ["prompt", "source"],
      properties: {
        prompt: { type: "string", description: "Instruccion de que cambiar. En v2v NO es una descripcion completa." },
        source: { type: "string", description: "Ruta local, id de media de OpenClaw, o URL publica" },
        resolution: { type: "string", enum: ["480p", "720p", "1080p"], default: "720p" },
        duration: { type: "number", default: 5 },
        ratio: { type: "string" },
        generateAudio: { type: "boolean", default: true },
        watermark: { type: "boolean", default: false },
        wait: { type: "boolean", default: true },
        pollInterval: { type: "number", default: 5 },
      },
    },
    handler: async (args) => {
      if (!R2_AVAILABLE) {
        return toolResult({ error: "R2 no configurado; no se puede publicar el archivo local." }, true);
      }

      let ref;
      let isVideo;
      if (/^https?:\/\//i.test(args.source)) {
        const isVideoUrl = /\.(mp4|mov|webm)(\?|$)/i.test(args.source);
        ref = args.source;
        isVideo = isVideoUrl;
      } else {
        const filePath = resolveInputPath(args.source);
        if (!filePath) {
          return toolResult(
            { error: `No encuentro el archivo: ${args.source}`, hint: OPENCLAW_MEDIA_DIR ? `Buscando en ${OPENCLAW_MEDIA_DIR}` : "Define OPENCLAW_MEDIA_DIR." },
            true
          );
        }
        const up = await r2UploadLocal(filePath, "seedance/refs/");
        ref = up.publicUrl;
        isVideo = up.contentType.startsWith("video/");
      }

      const opts = { ...args };
      if (isVideo) opts.videoUrls = [ref];
      else opts.imageUrl = ref;

      // Reutiliza la logica de generate sin duplicarla.
      const generate = TOOLS.find((t) => t.name === "seedance_generate");
      const result = await generate.handler(opts);
      const parsed = JSON.parse(result.content[0].text);
      return toolResult({ reference: ref, referenceType: isVideo ? "v2v" : "i2v", ...parsed });
    },
  },
  {
    name: "seedance_list",
    description: "Lista las tareas de Seedance registradas localmente por este servidor.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const { readdir } = await import("node:fs/promises");
      const files = (await readdir(STATE_DIR).catch(() => [])).filter((f) => f.endsWith(".json"));
      const rows = [];
      for (const f of files) {
        const r = await recordGet(f.replace(/\.json$/, ""));
        if (r) rows.push(r);
      }
      rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return toolResult(rows);
    },
  },
];

async function waitForTask(taskId, interval, maxSeconds) {
  const deadline = Date.now() + maxSeconds * 1000;
  let last = null;
  while (Date.now() < deadline) {
    last = await api(`/api/v3/contents/generations/tasks/${encodeURIComponent(taskId)}`);
    const s = String(last.status || "").toLowerCase();
    if (TERMINAL_OK.has(s) || TERMINAL_FAIL.has(s)) {
      const prev = (await recordGet(taskId)) || {};
      await recordSave(taskId, { ...prev, ...last, id: taskId, status: last.status, updatedAt: new Date().toISOString() });
      return last;
    }
    await sleep(interval * 1000);
  }
  const prev = (await recordGet(taskId)) || {};
  await recordSave(taskId, { ...prev, ...last, id: taskId, status: last?.status ?? "unknown", updatedAt: new Date().toISOString() });
  throw new Error(`Timeout esperando ${taskId} tras ${maxSeconds}s. La tarea sigue: ${last?.status}. Reintenta con seedance_wait.`);
}

function describe(task) {
  const s = String(task.status || "").toLowerCase();
  const out = { taskId: task.id, status: task.status, model: task.model, generateAudio: task.generate_audio };
  if (TERMINAL_OK.has(s)) {
    out.videoUrl = task.content?.video_url || task.video_url || null;
    const first = task.content?.video_urls?.[0];
    if (first && !out.videoUrl) out.videoUrl = typeof first === "string" ? first : first.url;
    out.duration = task.duration ?? null;
    out.ratio = task.ratio ?? null;
    out.resolution = task.resolution ?? null;
    out.message = out.videoUrl ? "Video listo." : "Tarea ok pero la respuesta no trae video_url; revisa el payload crudo.";
    out.raw = task;
  } else if (TERMINAL_FAIL.has(s)) {
    out.error = task.error?.message || task.error || "La tarea fallo sin detalle.";
    out.raw = task;
  } else {
    out.message = "Tarea en curso.";
    out.raw = task;
  }
  return out;
}

// --- dispatch -------------------------------------------------------------------

async function handle(msg) {
  const { id, method, params = {} } = msg;

  switch (method) {
    case "initialize":
      return rpc.ok(id, {
        protocolVersion: params.protocolVersion || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "seedance-mcp", version: "1.0.0" },
        instructions:
          `Generacion de video con Seedance 2.0 (ByteDance Ark). ` +
          `Escribe prompts en ingles, cinematograficos y concretos. Duracion 2-12s. ` +
          `Para image-to-video pasa una URL publica de imagen. ` +
          `IMPORTANTE: cuando el resultado trae "delivered", el video ya viene adjunto al mensaje. ` +
          `En ese caso responde con una frase corta y NO repitas la URL ni digas que expira, ` +
          `porque el usuario no tiene que hacer nada para verlo.`,
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      return rpc.ok(id, {});
    case "tools/list":
      return rpc.ok(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpc.fail(id, -32602, `Herramienta desconocida: ${params.name}`);
      try {
        return rpc.ok(id, await tool.handler(params.arguments || {}));
      } catch (err) {
        return rpc.ok(id, toolResult({ error: err.message, status: err.status, detail: err.body }, true));
      }
    }
    default:
      if (id !== undefined) rpc.fail(id, -32601, `Metodo no soportado: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  try {
    await handle(msg);
  } catch (err) {
    if (msg?.id !== undefined) rpc.fail(msg.id, -32603, err.message);
  }
});
