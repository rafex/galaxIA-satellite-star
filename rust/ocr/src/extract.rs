//! Extracción de texto (`ocr-bridge.ts`): PDFs digitales por su capa de texto
//! (`pdftotext`), PDFs escaneados página por página (`pdftoppm` + Tesseract),
//! imágenes directo con Tesseract. Cada comando tiene 60 s.

use std::path::{Path, PathBuf};
use std::time::Duration;

use galaxia_fhs::protocol::fhs::{artifact_ref::Transport, ArtifactRef};
use tokio::process::Command;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const DEFAULT_LANG: &str = "spa+eng";
const DEFAULT_GATEWAY: &str = "https://ipfs.io/ipfs";
const NO_TEXT: &str = "No se detectó texto en la imagen.";

pub struct Input {
    pub file: ArtifactRef,
    pub filename: Option<String>,
    pub lang: Option<String>,
}

pub async fn extract(input: Input, http: &reqwest::Client) -> Result<String, String> {
    let work = TempDir::new()?;
    let filename = sanitize_filename(
        input
            .filename
            .filter(|f| !f.is_empty())
            .or_else(|| artifact_filename(&input.file))
            .unwrap_or_default(),
    );
    let path = work.0.join(&filename);
    let bytes = resolve(&input.file, http).await?;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| format!("no se pudo guardar el archivo: {e}"))?;
    let lang = input
        .lang
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| DEFAULT_LANG.into());
    let text = if filename.to_lowercase().ends_with(".pdf") {
        pdf_text_or_ocr(&path, &work.0, &lang).await?
    } else {
        tesseract(&path, &lang).await?
    };
    let text = text.trim();
    Ok(if text.is_empty() {
        NO_TEXT.into()
    } else {
        text.into()
    })
}

async fn pdf_text_or_ocr(path: &Path, work: &Path, lang: &str) -> Result<String, String> {
    // La capa de texto evita OCR innecesario en PDFs digitales.
    let native = run(
        "pdftotext",
        &[path.as_os_str(), "-".as_ref(), "-layout".as_ref()],
    )
    .await?;
    if !native.trim().is_empty() {
        return Ok(native);
    }
    let prefix = work.join("page");
    run(
        "pdftoppm",
        &[
            "-png".as_ref(),
            "-r".as_ref(),
            "200".as_ref(),
            path.as_os_str(),
            prefix.as_os_str(),
        ],
    )
    .await?;
    let mut pages: Vec<(u32, PathBuf)> = std::fs::read_dir(work)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            page_number(&name).map(|n| (n, entry.path()))
        })
        .collect();
    if pages.is_empty() {
        return Err("El PDF no contiene páginas renderizables".into());
    }
    pages.sort_by_key(|(n, _)| *n);
    let mut texts = Vec::with_capacity(pages.len());
    for (_, page) in pages {
        texts.push(tesseract(&page, lang).await?);
    }
    Ok(texts.join("\n\n"))
}

async fn tesseract(path: &Path, lang: &str) -> Result<String, String> {
    run(
        "tesseract",
        &[
            path.as_os_str(),
            "stdout".as_ref(),
            "-l".as_ref(),
            lang.as_ref(),
        ],
    )
    .await
    .map_err(|e| format!("Tesseract falló: {e}"))
}

async fn run(program: &str, args: &[&std::ffi::OsStr]) -> Result<String, String> {
    let child = Command::new(program).args(args).kill_on_drop(true).output();
    let output = tokio::time::timeout(COMMAND_TIMEOUT, child)
        .await
        .map_err(|_| format!("{program} no terminó en {} s", COMMAND_TIMEOUT.as_secs()))?
        .map_err(|e| format!("no se pudo ejecutar {program}: {e}"))?;
    if !output.status.success() {
        let stderr: String = String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(300)
            .collect();
        return Err(format!(
            "{program} salió con {}{}",
            output.status,
            if stderr.is_empty() {
                String::new()
            } else {
                format!(" — {stderr}")
            }
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn resolve(file: &ArtifactRef, http: &reqwest::Client) -> Result<Vec<u8>, String> {
    match &file.transport {
        Some(Transport::Inline(inline)) => Ok(inline.data.clone()),
        Some(Transport::Ipfs(ipfs)) => {
            let gateway = if ipfs.gateway_url.is_empty() {
                DEFAULT_GATEWAY
            } else {
                &ipfs.gateway_url
            };
            let url = format!("{}/{}", gateway.trim_end_matches('/'), ipfs.cid);
            let response = http.get(&url).send().await.map_err(|e| e.to_string())?;
            if !response.status().is_success() {
                return Err(format!(
                    "IPFS gateway respondió {} para {}",
                    response.status().as_u16(),
                    ipfs.cid
                ));
            }
            Ok(response.bytes().await.map_err(|e| e.to_string())?.to_vec())
        }
        None => Err("ArtifactRef sin transporte".into()),
    }
}

fn artifact_filename(file: &ArtifactRef) -> Option<String> {
    match &file.transport {
        Some(Transport::Inline(inline)) => Some(inline.filename.clone()),
        Some(Transport::Ipfs(ipfs)) => Some(ipfs.filename.clone()),
        None => None,
    }
    .filter(|f| !f.is_empty())
}

/// Solo el nombre base, con `[^a-zA-Z0-9._-]` → `_`; vacío → aleatorio `.png`.
pub fn sanitize_filename(filename: String) -> String {
    let base = Path::new(&filename)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();
    let safe: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() {
        format!("ocr-{}.png", uuid::Uuid::new_v4())
    } else {
        safe
    }
}

fn page_number(name: &str) -> Option<u32> {
    name.strip_prefix("page-")?
        .strip_suffix(".png")?
        .parse()
        .ok()
}

/// Carpeta temporal que se borra al salir, aun con error.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!("fhs-ocr-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path)
            .map_err(|e| format!("no se pudo crear {}: {e}", path.display()))?;
        Ok(Self(path))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use galaxia_fhs::protocol::fhs::InlineArtifact;

    #[test]
    fn sanitizes_filenames() {
        assert_eq!(
            sanitize_filename("../../etc/Constitución 2024.pdf".into()),
            "Constituci_n_2024.pdf"
        );
        assert!(sanitize_filename(String::new()).starts_with("ocr-"));
    }

    #[test]
    fn orders_pages_numerically() {
        assert_eq!(page_number("page-10.png"), Some(10));
        assert_eq!(page_number("page-2.png"), Some(2));
        assert_eq!(page_number("otro.png"), None);
    }

    fn has(program: &str) -> bool {
        std::process::Command::new("which")
            .arg(program)
            .output()
            .is_ok_and(|o| o.status.success())
    }

    /// PDF con capa de texto, generado a mano (sin dependencias).
    fn text_pdf(text: &str) -> Vec<u8> {
        let stream = format!("BT /F1 18 Tf 72 720 Td ({text}) Tj ET");
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_string(),
            format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend(format!("{} 0 obj\n{object}\nendobj\n", i + 1).bytes());
        }
        let xref = pdf.len();
        pdf.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).bytes());
        for offset in offsets {
            pdf.extend(format!("{offset:010} 00000 n \n").bytes());
        }
        pdf.extend(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                objects.len() + 1
            )
            .bytes(),
        );
        pdf
    }

    #[tokio::test]
    async fn reads_the_text_layer_of_a_digital_pdf() {
        if !has("pdftotext") {
            eprintln!("sin pdftotext: se omite");
            return;
        }
        let input = Input {
            file: ArtifactRef {
                transport: Some(Transport::Inline(InlineArtifact {
                    data: text_pdf("Articulo 3 Toda persona tiene derecho a la educacion"),
                    filename: "constitucion.pdf".into(),
                })),
            },
            filename: None,
            lang: None,
        };
        let text = extract(input, &reqwest::Client::new()).await.unwrap();
        assert!(text.contains("derecho a la educacion"), "{text}");
    }

    #[tokio::test]
    async fn ocr_of_a_scanned_page() {
        if !(has("pdftoppm") && has("tesseract")) {
            eprintln!("sin pdftoppm/tesseract: se omite");
            return;
        }
        // Rasterizar el PDF de texto da una imagen "escaneada" para Tesseract.
        let work = TempDir::new().unwrap();
        let pdf = work.0.join("doc.pdf");
        std::fs::write(&pdf, text_pdf("HELLO SOVEREIGN NETWORK")).unwrap();
        let prefix = work.0.join("img");
        run(
            "pdftoppm",
            &[
                "-png".as_ref(),
                "-r".as_ref(),
                "150".as_ref(),
                pdf.as_os_str(),
                prefix.as_os_str(),
            ],
        )
        .await
        .unwrap();
        let png = std::fs::read(work.0.join("img-1.png")).unwrap();
        let input = Input {
            file: ArtifactRef {
                transport: Some(Transport::Inline(InlineArtifact {
                    data: png,
                    filename: "scan.png".into(),
                })),
            },
            filename: None,
            lang: Some("eng".into()),
        };
        let text = extract(input, &reqwest::Client::new()).await.unwrap();
        assert!(text.to_uppercase().contains("SOVEREIGN"), "{text}");
    }
}
