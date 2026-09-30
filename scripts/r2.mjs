// Cliente S3 minimo (AWS SigV4) para subir binarios a Cloudflare R2.
// Sin dependencias: usa fetch + crypto nativo. Suficiente para PUT de objetos
// via la API S3-compatible de R2, que es lo unico que necesita Seedance para
// recibir imagenes y videos de referencia por URL publica.

import { createHash, createHmac } from "node:crypto";

function hmac(key, data) {
  return createHmac("sha256", key).update(data, "utf8").digest();
}
const sha256hex = (data) => createHash("sha256").update(data).digest("hex");

function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Sube un buffer a R2 y devuelve la URL publica.
 * @param {Buffer} data
 * @param {string} key            clave del objeto, p.ej. "seedance/2026/x.mp4"
 * @param {string} contentType
 * @param {object} cfg            { accountId, accessKeyId, secretAccessKey, bucket, publicUrl }
 */
export async function r2Upload(data, key, contentType, cfg) {
  const { accountId, accessKeyId, secretAccessKey, bucket, publicUrl } = cfg;
  for (const [k, v] of Object.entries({ accountId, accessKeyId, secretAccessKey, bucket })) {
    if (!v) throw new Error(`Falta configuracion R2: ${k}`);
  }

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const endpoint = `https://${host}/${bucket}/${key.split("/").map(encodeRfc3986).join("/")}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(data);

  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = ["PUT", `/${bucket}/${key.split("/").map(encodeRfc3986).join("/")}`, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, "auto");
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authHeader =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(endpoint, {
    method: "PUT",
    headers: {
      Authorization: authHeader,
      "Content-Type": contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
    body: data,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`R2 upload fallo (${res.status}): ${text.slice(0, 300)}`);
  }

  const base = (publicUrl || `https://${host}`).replace(/\/$/, "");
  return `${base}/${key.split("/").map(encodeRfc3986).join("/")}`;
}

/** Descarga una URL remota a Buffer, con limite de tamano. */
export async function fetchBinary(url, maxBytes = 200 * 1024 * 1024) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Descarga fallo (${res.status}) para ${url.slice(0, 120)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`El archivo excede ${Math.round(maxBytes / 1024 / 1024)}MB`);
  return buf;
}
