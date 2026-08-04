import { execFile } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ArtifactRef } from "@rafex/galaxia-fhs-protocol";

export interface OcrInput {
  file: ArtifactRef;
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

  async extract(input: OcrInput, signal?: AbortSignal): Promise<OcrOutput> {
    const filename = input.filename || `ocr-${randomUUID()}.png`;
    const tmpPath = join(tmpdir(), filename);

    try {
      const buffer = await this.resolveArtifact(input.file, signal);
      await writeFile(tmpPath, buffer);

      const url = `${this.serviceUrl}/api/v1/ocr`;
      const stdout = await this.curlMultipart(url, tmpPath, input.lang || "spa+eng", signal);

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

  private async resolveArtifact(file: ArtifactRef, signal?: AbortSignal): Promise<Buffer> {
    if (file.transport === "inline") {
      return Buffer.from(file.base64, "base64");
    }

    const gateway = file.gatewayUrl || "https://ipfs.io/ipfs";
    const response = await fetch(`${gateway.replace(/\/$/, "")}/${encodeURIComponent(file.cid)}`, { signal });
    if (!response.ok) {
      throw new Error(`IPFS gateway respondió ${response.status} para ${file.cid}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private curlMultipart(
    url: string,
    filePath: string,
    lang: string,
    signal?: AbortSignal
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
        { timeout: 35_000, maxBuffer: 16 * 1024 * 1024, signal },
        (err, stdout, stderr) => {
          if (err) {
            if (err.name === "AbortError") { reject(err); return; }
            reject(new Error(`OCR request failed: ${err.message}${stderr ? ` — ${stderr.slice(0, 200)}` : ""}`));
            return;
          }
          resolve(stdout);
        }
      );
      child.on("error", reject);
    });
  }
}
