import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { IMAGE_BASE_URL, PORT } from "./config.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const imgDir = join(__dirname, "..", "generated_images");

export function saveImageAndGetUrl(imageBase64, host) {
  const imgId = randomUUID();
  mkdirSync(imgDir, { recursive: true });
  const imgPath = join(imgDir, `${imgId}.png`);
  writeFileSync(imgPath, Buffer.from(imageBase64, "base64"));
  
  let baseUrl = IMAGE_BASE_URL;
  if (baseUrl) {
    baseUrl = baseUrl.replace(/\/+$/, "");
    return `${baseUrl}/images/${imgId}.png`;
  }
  
  const finalHost = host || `127.0.0.1:${PORT}`;
  return `http://${finalHost}/images/${imgId}.png`;
}
