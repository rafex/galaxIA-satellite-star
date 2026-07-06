import { execFile } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export interface OcrInput {
  fileBase64: string;
  filename?: string;
  lang?: string;
}

export interface OcrOutput {
  text: string;
}

export class OcrBridge {
  private serviceUrl: string;
  private apiKey: string;

  constructor(serviceUrl: string, apiKey: string = "") {
    this.serviceUrl = serviceUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  async extract(input: OcrInput): Promise<OcrOutput> {
    const filename = input.filename || `ocr-${randomUUID()}.png`;
    const tmpPath = join(tmpdir(), filename);

    try {
      const buffer = Buffer.from(input.fileBase64, "base64");
      await writeFile(tmpPath, buffer);

      const url = `${this.serviceUrl}/api/v1/ocr`;
      const stdout = await this.curlMultipart(url, tmpPath, input.lang || "spa+eng");

      const data = JSON.parse(stdout) as {
        status?: string;
        text?: string;
      };

      return {
        text: data.text || data.status || "No se detectó texto en la imagen.",
      };
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  }

  private curlMultipart(
    url: string,
    filePath: string,
    lang: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        "-sfS", "--max-time", "30",
        "-X", "POST", url,
        "-H", `X-API-Key: ${this.apiKey}`,
        "-F", `file=@${filePath}`,
        "-F", `lang=${lang}`,
      ];

      const child = execFile(
        "curl", args,
        { timeout: 35_000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            reject(
              new Error(
                `OCR request failed: ${err.message}${stderr ? ` — ${stderr.slice(0, 200)}` : ""}`
              )
            );
            return;
          }
          resolve(stdout);
        }
      );
      child.on("error", reject);
    });
  }
}
