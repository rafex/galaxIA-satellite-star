//! Corpus de la KB: secciones por encabezado (Markdown) o ventanas de
//! palabras (texto plano) y búsqueda por cobertura de la pregunta.
//!
//! Crear una KB es soltar archivos `.md`/`.txt` en la carpeta del nodo: cada
//! sección con título se vuelve un fragmento citable ("archivo › sección").
//! El motor sigue siendo léxico (sin embeddings); el contrato `kb_query` no
//! cambia (DEC-0026).

use std::collections::{HashMap, HashSet};

const WINDOW_WORDS: usize = 200;
const WINDOW_OVERLAP: usize = 20;
/// Una sección más larga que esto se parte en ventanas (con su título).
const MAX_SECTION_WORDS: usize = 260;
/// Secciones con menos palabras que esto (solo un título, una línea) no aportan.
const MIN_SECTION_WORDS: usize = 6;

const STOPWORDS: &[&str] = &[
    "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "al", "a", "en", "y", "o",
    "u", "e", "que", "qué", "es", "son", "se", "por", "para", "con", "sin", "sobre", "como",
    "cómo", "cual", "cuál", "cuales", "cuáles", "lo", "le", "les", "su", "sus", "mi", "tu", "este",
    "esta", "esto", "ese", "esa", "eso", "ser", "hay", "ha", "han", "fue", "muy", "más", "mas",
    "pero", "si", "sí", "no", "ya", "me", "te", "nos", "dice", "dicen", "puede", "pueden", "hacer",
    "tiene", "tienen", "quien", "quién", "cuando", "cuándo", "donde", "dónde",
];

#[derive(Clone, Debug)]
pub struct Section {
    /// Texto citable (incluye el título para que el LLM vea el contexto).
    pub text: String,
    /// `archivo` o `archivo › título`.
    pub citation: String,
    /// Frecuencia de cada palabra (ya sin acentos ni palabras vacías).
    terms: HashMap<String, u32>,
    /// Palabras de la sección (para normalizar por longitud).
    len: usize,
    /// Palabras del título propio (el último encabezado, no los heredados).
    title_tokens: HashSet<String>,
}

fn fold(c: char) -> char {
    match c {
        'á' | 'à' | 'ä' => 'a',
        'é' | 'è' | 'ë' => 'e',
        'í' | 'ì' | 'ï' => 'i',
        'ó' | 'ò' | 'ö' => 'o',
        'ú' | 'ù' | 'ü' => 'u',
        _ => c,
    }
}

/// Raíz tosca para singular/plural ("satélites" ~ "satélite").
fn stem(word: &str) -> String {
    let n = word.chars().count();
    if n > 5 && word.ends_with("es") {
        word.chars().take(n - 2).collect()
    } else if n > 3 && word.ends_with('s') {
        word.chars().take(n - 1).collect()
    } else {
        word.to_string()
    }
}

/// Minúsculas sin acentos, sin palabras vacías; los números sí cuentan.
pub fn tokenize(text: &str) -> HashSet<String> {
    token_list(text).into_iter().collect()
}

fn token_list(text: &str) -> Vec<String> {
    let cleaned: String = text
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { fold(c) } else { ' ' })
        .collect();
    let stop: HashSet<String> = STOPWORDS
        .iter()
        .map(|w| w.chars().map(fold).collect())
        .collect();
    cleaned
        .split_whitespace()
        .filter(|t| {
            !stop.contains(*t) && (t.chars().count() > 1 || t.chars().all(|c| c.is_ascii_digit()))
        })
        .map(stem)
        .collect()
}

fn windows(text: &str) -> Vec<String> {
    let words: Vec<&str> = text.split_whitespace().collect();
    let step = WINDOW_WORDS - WINDOW_OVERLAP;
    let mut out = Vec::new();
    let mut start = 0;
    while start < words.len() {
        let end = (start + WINDOW_WORDS).min(words.len());
        out.push(words[start..end].join(" "));
        if end == words.len() {
            break;
        }
        start += step;
    }
    out
}

fn make(file: &str, title: Option<&str>, body: &str) -> Section {
    let text = match title {
        Some(t) => format!("{t}\n{body}"),
        None => body.to_string(),
    };
    let list = token_list(&text);
    let mut terms: HashMap<String, u32> = HashMap::new();
    for token in &list {
        *terms.entry(token.clone()).or_default() += 1;
    }
    // Solo el encabezado propio: el del documento entero coincidiría en todas.
    let leaf = title.and_then(|t| t.rsplit(" › ").next());
    Section {
        len: list.len(),
        terms,
        title_tokens: leaf.map(tokenize).unwrap_or_default(),
        citation: title.map_or_else(|| file.to_string(), |t| format!("{file} › {t}")),
        text,
    }
}

/// Parte un archivo en secciones. `.md`: una por encabezado (con la ruta de
/// títulos); otro texto: ventanas de palabras.
pub fn sections(file: &str, text: &str, markdown: bool) -> Vec<Section> {
    if !markdown {
        return windows(text)
            .into_iter()
            .map(|w| make(file, None, &w))
            .collect();
    }
    let mut out = Vec::new();
    let mut path: Vec<(usize, String)> = Vec::new();
    let mut body = String::new();
    let mut in_code = false;
    let flush = |path: &[(usize, String)], body: &mut String, out: &mut Vec<Section>| {
        let words = body.split_whitespace().count();
        if words >= MIN_SECTION_WORDS {
            let title = path
                .iter()
                .map(|(_, t)| t.as_str())
                .collect::<Vec<_>>()
                .join(" › ");
            let title = (!title.is_empty()).then_some(title);
            if words > MAX_SECTION_WORDS {
                for piece in windows(body) {
                    out.push(make(file, title.as_deref(), &piece));
                }
            } else {
                out.push(make(file, title.as_deref(), body.trim()));
            }
        }
        body.clear();
    };
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            in_code = !in_code;
        }
        let level = line.chars().take_while(|c| *c == '#').count();
        if !in_code && (1..=4).contains(&level) && line[level..].starts_with(' ') {
            flush(&path, &mut body, &mut out);
            while path.last().is_some_and(|(l, _)| *l >= level) {
                path.pop();
            }
            path.push((level, line[level..].trim().to_string()));
        } else {
            body.push_str(line);
            body.push('\n');
        }
    }
    flush(&path, &mut body, &mut out);
    out
}

/// Las `top_k` secciones con mayor BM25 para la pregunta (más un bono por el
/// título propio). Sin ninguna palabra en común no hay resultado: una KB que
/// no sabe, no inventa.
pub fn rank<'a>(sections: &'a [Section], query: &str, top_k: usize) -> Vec<(&'a Section, f64)> {
    const K1: f64 = 1.4;
    const B: f64 = 0.6;
    const TITLE_BONUS: f64 = 1.5;
    let query = tokenize(query);
    if query.is_empty() || sections.is_empty() {
        return vec![];
    }
    let n = sections.len() as f64;
    let avg_len = (sections.iter().map(|s| s.len).sum::<usize>() as f64 / n).max(1.0);
    let idf: HashMap<&String, f64> = query
        .iter()
        .map(|t| {
            let df = sections.iter().filter(|s| s.terms.contains_key(t)).count() as f64;
            (t, (1.0 + (n - df + 0.5) / (df + 0.5)).ln())
        })
        .collect();
    let mut scored: Vec<(&Section, f64)> = sections
        .iter()
        .filter_map(|s| {
            let mut score = 0.0;
            let mut hit = false;
            for t in &query {
                let Some(&tf) = s.terms.get(t) else { continue };
                hit = true;
                let tf = f64::from(tf);
                let norm = tf * (K1 + 1.0) / (tf + K1 * (1.0 - B + B * s.len as f64 / avg_len));
                score += idf[t] * norm;
                if s.title_tokens.contains(t) {
                    score += idf[t] * TITLE_BONUS;
                }
            }
            hit.then_some((s, score))
        })
        .collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    scored.truncate(top_k);
    scored
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = "# Vocabulario\n\nIntro de unas cuantas palabras para pasar el mínimo.\n\n\
## Satellite\n\nUn Satellite es un nodo que ofrece una capacidad concreta, como OCR o una base de conocimiento.\n\n\
## Navigator\n\nEl Navigator orquesta las misiones: publica la oferta, recibe las pujas y asigna al ganador.\n\n\
## Nota\n\ncorto\n";

    #[test]
    fn markdown_is_split_by_heading_with_the_title_path() {
        let s = sections("vocab.md", DOC, true);
        let titles: Vec<_> = s.iter().map(|x| x.citation.as_str()).collect();
        assert_eq!(
            titles,
            [
                "vocab.md › Vocabulario",
                "vocab.md › Vocabulario › Satellite",
                "vocab.md › Vocabulario › Navigator"
            ]
        );
        assert!(s[1].text.starts_with("Vocabulario › Satellite\n"));
    }

    #[test]
    fn ranks_by_question_coverage_and_ignores_stopwords_and_accents() {
        let s = sections("vocab.md", DOC, true);
        let best = rank(&s, "¿Qué es un Satellite?", 1);
        assert_eq!(best[0].0.citation, "vocab.md › Vocabulario › Satellite");
        let best = rank(&s, "¿Quién asigna las pujas ganadoras?", 1);
        assert_eq!(best[0].0.citation, "vocab.md › Vocabulario › Navigator");
    }

    #[test]
    fn unrelated_questions_return_nothing() {
        let s = sections("vocab.md", DOC, true);
        assert!(rank(&s, "¿Cuál es la capital de Australia?", 3).is_empty());
        assert!(rank(&s, "¿Qué es?", 3).is_empty());
    }

    #[test]
    fn numbers_count_and_plain_text_uses_windows() {
        let text = (1..=450)
            .map(|n| format!("palabra{n}"))
            .collect::<Vec<_>>()
            .join(" ");
        let s = sections("largo.txt", &format!("{text} Artículo 3 educación"), false);
        assert!(s.len() >= 2 && s.iter().all(|x| x.citation == "largo.txt"));
        let hit = rank(&s, "artículo 3", 1);
        assert!(hit[0].0.text.contains("Artículo 3"));
    }

    #[test]
    fn long_sections_are_windowed_keeping_their_title() {
        let body = vec!["término"; 600].join(" ");
        let s = sections("a.md", &format!("# Largo\n{body}"), true);
        assert!(s.len() >= 3);
        assert!(s.iter().all(|x| x.citation == "a.md › Largo"));
    }
}
