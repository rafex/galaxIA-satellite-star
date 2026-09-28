//! Extracción de texto (`ocr-bridge.ts`): PDFs digitales por su capa de texto
//! (`pdftotext`), PDFs escaneados página por página (`pdftoppm` + Tesseract),
//! imágenes directo con Tesseract.
//!
//! Límites (DEC-0095), también para adjuntos inline: `pdfinfo` valida el PDF
//! y no se rasterizan más de 30 páginas, cada página a lo sumo 3000 px;
//! imágenes de hasta 40 MP (leído de la cabecera); texto de hasta 2 MB; 180 s
//! por archivo y 60 s por comando. Un adjunto IPFS se lee solo por el Kubo
//! local; `gatewayUrl` se ignora.

use std::path::{Path, PathBuf};
use std::time::Duration;

use galaxia_fhs::p2p::framing::MAX_ATTACHMENT_BYTES;
use galaxia_fhs::protocol::fhs::{artifact_ref::Transport, ArtifactRef};
use tokio::process::Command;
use tokio::time::Instant;

use crate::ipfs::IpfsAccess;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
pub const FILE_BUDGET: Duration = Duration::from_secs(180);
pub const MAX_PAGES: u32 = 30;
const SCALE_TO_PX: &str = "3000";
pub const MAX_PIXELS: u64 = 40_000_000;
pub const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_LANG: &str = "spa+eng";
const NO_TEXT: &str = "No se detectó texto en la imagen.";

pub struct Input {
    pub file: ArtifactRef,
    pub filename: Option<String>,
    pub lang: Option<String>,
}

/// Extrae el texto dentro del presupuesto por archivo.
pub async fn extract(input: Input, ipfs: Option<&IpfsAccess>) -> Result<String, String> {
    extract_within(input, ipfs, FILE_BUDGET).await
}

pub async fn extract_within(
    input: Input,
    ipfs: Option<&IpfsAccess>,
    budget: Duration,
) -> Result<String, String> {
    let deadline = Instant::now() + budget;
    match tokio::time::timeout_at(deadline, extract_until(input, ipfs, deadline)).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "el archivo no se procesó en {} s",
            budget.as_secs()
        )),
    }
}

async fn extract_until(
    input: Input,
    ipfs: Option<&IpfsAccess>,
    deadline: Instant,
) -> Result<String, String> {
    let work = TempDir::new()?;
    let filename = sanitize_filename(
        input
            .filename
            .filter(|f| !f.is_empty())
            .or_else(|| artifact_filename(&input.file))
            .unwrap_or_default(),
    );
    let path = work.0.join(&filename);
    let bytes = resolve(&input.file, ipfs).await?;
    let is_pdf = filename.to_lowercase().ends_with(".pdf");
    if !is_pdf {
        check_image(&bytes)?;
    }
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| format!("no se pudo guardar el archivo: {e}"))?;
    let lang = input
        .lang
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| DEFAULT_LANG.into());
    let text = if is_pdf {
        pdf_text_or_ocr(&path, &work.0, &lang, deadline).await?
    } else {
        tesseract(&path, &lang, deadline).await?
    };
    let text = truncate(text.trim(), MAX_TEXT_BYTES);
    Ok(if text.is_empty() {
        NO_TEXT.into()
    } else {
        text.into()
    })
}

/// Texto hasta `max` bytes, cortado en un límite de carácter.
fn truncate(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Dimensiones de la cabecera; rechaza formatos desconocidos y más de 40 MP
/// antes de que Tesseract reserve la imagen.
fn check_image(bytes: &[u8]) -> Result<(), String> {
    let size =
        imagesize::blob_size(bytes).map_err(|_| "Formato de imagen no reconocido".to_string())?;
    let pixels = size.width as u64 * size.height as u64;
    if pixels > MAX_PIXELS {
        return Err(format!(
            "La imagen tiene {} MP; el máximo es {} MP",
            pixels / 1_000_000,
            MAX_PIXELS / 1_000_000
        ));
    }
    Ok(())
}

/// Páginas según `pdfinfo`; un PDF que no abre es un error claro.
async fn pdf_pages(path: &Path, deadline: Instant) -> Result<u32, String> {
    let info = run("pdfinfo", &[path.as_os_str()], deadline)
        .await
        .map_err(|e| format!("PDF malformado: {e}"))?;
    info.lines()
        .find_map(|l| l.strip_prefix("Pages:"))
        .and_then(|n| n.trim().parse().ok())
        .ok_or_else(|| "PDF malformado: sin número de páginas".to_string())
}

async fn pdf_text_or_ocr(
    path: &Path,
    work: &Path,
    lang: &str,
    deadline: Instant,
) -> Result<String, String> {
    let pages = pdf_pages(path, deadline).await?;
    // La capa de texto evita OCR innecesario en PDFs digitales.
    let native = run(
        "pdftotext",
        &[path.as_os_str(), "-".as_ref(), "-layout".as_ref()],
        deadline,
    )
    .await?;
    if !native.trim().is_empty() {
        return Ok(native);
    }
    if pages > MAX_PAGES {
        return Err(format!(
            "El PDF escaneado tiene {pages} páginas; el máximo para OCR es {MAX_PAGES}"
        ));
    }
    let prefix = work.join("page");
    let last = MAX_PAGES.to_string();
    run(
        "pdftoppm",
        &[
            "-png".as_ref(),
            "-l".as_ref(),
            last.as_ref(),
            "-scale-to".as_ref(),
            SCALE_TO_PX.as_ref(),
            path.as_os_str(),
            prefix.as_os_str(),
        ],
        deadline,
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
        texts.push(tesseract(&page, lang, deadline).await?);
    }
    Ok(texts.join("\n\n"))
}

async fn tesseract(path: &Path, lang: &str, deadline: Instant) -> Result<String, String> {
    run(
        "tesseract",
        &[
            path.as_os_str(),
            "stdout".as_ref(),
            "-l".as_ref(),
            lang.as_ref(),
        ],
        deadline,
    )
    .await
    .map_err(|e| format!("Tesseract falló: {e}"))
}

/// Corre `program` con 60 s o lo que quede del presupuesto; al vencer se
/// mata el proceso (`kill_on_drop`).
async fn run(
    program: &str,
    args: &[&std::ffi::OsStr],
    deadline: Instant,
) -> Result<String, String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(format!("sin tiempo para {program}"));
    }
    let limit = remaining.min(COMMAND_TIMEOUT);
    let child = Command::new(program).args(args).kill_on_drop(true).output();
    let output = tokio::time::timeout(limit, child)
        .await
        .map_err(|_| format!("{program} no terminó en {} s", limit.as_secs()))?
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

/// Bytes del adjunto: inline tal cual; IPFS solo por el Kubo local (nunca
/// por `gatewayUrl`), con el tope de protocolo.
async fn resolve(file: &ArtifactRef, ipfs: Option<&IpfsAccess>) -> Result<Vec<u8>, String> {
    match &file.transport {
        Some(Transport::Inline(inline)) => {
            if inline.data.len() > MAX_ATTACHMENT_BYTES {
                return Err(format!(
                    "INVALID_ARGUMENTS: el adjunto supera {} MB",
                    MAX_ATTACHMENT_BYTES / (1024 * 1024)
                ));
            }
            Ok(inline.data.clone())
        }
        Some(Transport::Ipfs(artifact)) => {
            let Some(ipfs) = ipfs else {
                return Err("UNSUPPORTED_CAPABILITY: este OCR no tiene nodo IPFS".into());
            };
            ipfs.read(&artifact.cid, &artifact.network).await
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
        let text = extract(input, None).await.unwrap();
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
            Instant::now() + COMMAND_TIMEOUT,
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
        let text = extract(input, None).await.unwrap();
        assert!(text.to_uppercase().contains("SOVEREIGN"), "{text}");
    }

    fn inline(data: Vec<u8>, filename: &str) -> Input {
        Input {
            file: ArtifactRef {
                transport: Some(Transport::Inline(InlineArtifact {
                    data,
                    filename: filename.into(),
                })),
            },
            filename: None,
            lang: None,
        }
    }

    /// PDF sin texto con `pages` páginas en blanco.
    fn blank_pdf(pages: usize) -> Vec<u8> {
        let kids: Vec<String> = (0..pages).map(|i| format!("{} 0 R", i + 3)).collect();
        let mut objects = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            format!(
                "<< /Type /Pages /Kids [{}] /Count {pages} >>",
                kids.join(" ")
            ),
        ];
        for _ in 0..pages {
            objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>".into());
        }
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
    async fn rejects_malformed_and_too_long_scanned_pdfs() {
        if !has("pdfinfo") {
            eprintln!("sin pdfinfo: se omite");
            return;
        }
        let error = extract(inline(b"%PDF-1.4 basura".to_vec(), "x.pdf"), None)
            .await
            .unwrap_err();
        assert!(error.contains("PDF malformado"), "{error}");
        let error = extract(inline(blank_pdf(MAX_PAGES as usize + 1), "x.pdf"), None)
            .await
            .unwrap_err();
        assert!(error.contains("31 páginas"), "{error}");
    }

    /// PNG con solo la cabecera IHDR: basta para leer las dimensiones.
    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend(width.to_be_bytes());
        png.extend(height.to_be_bytes());
        png.extend([8, 2, 0, 0, 0, 0, 0, 0, 0]);
        png
    }

    #[tokio::test]
    async fn rejects_huge_and_unknown_images_before_tesseract() {
        let error = extract(inline(png_header(10_000, 5_000), "big.png"), None)
            .await
            .unwrap_err();
        assert!(error.contains("50 MP"), "{error}");
        let error = extract(inline(b"no es imagen".to_vec(), "x.png"), None)
            .await
            .unwrap_err();
        assert!(error.contains("no reconocido"), "{error}");
        assert!(check_image(&png_header(6_000, 6_000)).is_ok());
    }

    #[tokio::test]
    async fn ipfs_without_local_node_never_uses_the_gateway() {
        // Un servidor en gatewayUrl que cuenta peticiones: no debe recibir ninguna.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gateway = format!("http://{}/ipfs", listener.local_addr().unwrap());
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            while listener.accept().await.is_ok() {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        });
        let input = Input {
            file: ArtifactRef {
                transport: Some(Transport::Ipfs(galaxia_fhs::protocol::fhs::IpfsArtifact {
                    cid: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku".into(),
                    network: "public".into(),
                    gateway_url: gateway,
                    filename: "a.pdf".into(),
                    retention: "ephemeral".into(),
                })),
            },
            filename: None,
            lang: None,
        };
        let error = extract(input, None).await.unwrap_err();
        assert!(error.starts_with("UNSUPPORTED_CAPABILITY"), "{error}");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn budget_exhausted_is_a_clear_error() {
        let error = run("true", &[], Instant::now()).await.unwrap_err();
        assert!(error.contains("sin tiempo"), "{error}");
        assert_eq!(truncate("añoñ", 3), "añ");
    }
}
