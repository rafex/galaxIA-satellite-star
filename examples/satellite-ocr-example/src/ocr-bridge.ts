import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
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
  async extract(input: OcrInput, signal?: AbortSignal): Promise<OcrOutput> {
    const workDir = await mkdtemp(join(tmpdir(), "fhs-ocr-"));
    // Navigator conserva el nombre en el ArtifactRef; `args.filename` es
    // opcional y normalmente no se envía en la llamada de la tool. Derivarlo
    // aquí es necesario para seleccionar la ruta PDF en vez de Tesseract como
    // si el archivo fuese una imagen PNG.
    const filename = sanitizeFilename(input.filename || artifactFilename(input.file) || `ocr-${randomUUID()}.png`);
    const tmpPath = join(workDir, filename);

    try {
      const buffer = await this.resolveArtifact(input.file, signal);
      await writeFile(tmpPath, buffer);

      const text = isPdf(filename)
        ? await this.pdfTextOrOcr(tmpPath, workDir, input.lang || "spa+eng", signal)
        : await this.tesseract(tmpPath, input.lang || "spa+eng", signal);

      return {
        text: text.trim() || "No se detectó texto en la imagen.",
      };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async pdfTextOrOcr(
    filePath: string,
    workDir: string,
    lang: string,
    signal?: AbortSignal,
  ): Promise<string> {
    // Preferir la capa de texto evita OCR innecesario en PDFs digitales.
    const nativeText = await this.runCommand("pdftotext", [filePath, "-", "-layout"], signal);
    if (nativeText.trim()) return nativeText;

    // Los PDFs escaneados no tienen capa de texto: rasterizar todas sus
    // páginas y procesarlas una por una con Tesseract.
    const prefix = join(workDir, "page");
    await this.runCommand("pdftoppm", ["-png", "-r", "200", filePath, prefix], signal);
    const pages = (await readdir(workDir))
      .filter((entry) => /^page-\d+\.png$/u.test(entry))
      .sort((a, b) => pageNumber(a) - pageNumber(b));

    if (pages.length === 0) {
      throw new Error("El PDF no contiene páginas renderizables");
    }

    const texts: string[] = [];
    for (const page of pages) {
      texts.push(await this.tesseract(join(workDir, page), lang, signal));
    }
    return texts.join("\n\n");
  }

  private tesseract(filePath: string, lang: string, signal?: AbortSignal): Promise<string> {
    return this.runCommand("tesseract", [filePath, "stdout", "-l", lang], signal)
      .catch((error: unknown) => {
        throw new Error(`Tesseract falló: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  private runCommand(command: string, args: string[], signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        command,
        args,
        { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, signal },
        (err, stdout, stderr) => {
          if (err) {
            if (err.name === "AbortError") { reject(err); return; }
            reject(new Error(`${err.message}${stderr ? ` — ${stderr.slice(0, 300)}` : ""}`));
            return;
          }
          resolve(stdout);
        },
      );
      child.on("error", reject);
    });
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

}

function sanitizeFilename(filename: string): string {
  const safe = basename(filename).replace(/[^a-zA-Z0-9._-]/gu, "_");
  return safe || `ocr-${randomUUID()}.png`;
}

function isPdf(filename: string): boolean {
  return filename.toLowerCase().endsWith(".pdf");
}

function artifactFilename(file: ArtifactRef): string | undefined {
  if (file.transport === "inline") return file.filename;
  if (file.transport === "ipfs") return file.filename;
  return undefined;
}

function pageNumber(filename: string): number {
  return Number(filename.match(/page-(\d+)\.png/u)?.[1] ?? 0);
}
