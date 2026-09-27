//! Motor de recuperación de los providers de referencia KB y RAG: solapamiento
//! de palabras (Jaccard), no embeddings. El protocolo define el contrato de
//! las tools, nunca el motor (DEC-0026); esto es lo mínimo, a propósito.

use std::collections::HashSet;

/// Minúsculas, todo lo que no sea letra, número o espacio pasa a espacio, y
/// se descartan las palabras de un carácter (`tokenize` de los bridges TS).
pub fn tokenize(text: &str) -> HashSet<String> {
    let cleaned: String = text
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c.is_whitespace() {
                c
            } else {
                ' '
            }
        })
        .collect();
    cleaned
        .split_whitespace()
        .filter(|t| t.chars().count() > 1)
        .map(String::from)
        .collect()
}

/// Intersección / unión de tokens.
pub fn similarity(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let intersection = a.iter().filter(|t| b.contains(*t)).count();
    let union = a.len() + b.len() - intersection;
    if union == 0 {
        0.0
    } else {
        intersection as f64 / union as f64
    }
}

/// Ventanas de `size` palabras que se solapan `overlap` palabras.
pub fn chunk_text(text: &str, size: usize, overlap: usize) -> Vec<String> {
    let words: Vec<&str> = text.split_whitespace().collect();
    let step = size.saturating_sub(overlap).max(1);
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < words.len() {
        let end = (start + size).min(words.len());
        chunks.push(words[start..end].join(" "));
        if start + size >= words.len() {
            break;
        }
        start += step;
    }
    if chunks.is_empty() {
        chunks.push(text.to_string());
    }
    chunks
}

/// Fragmento indexado con sus tokens precalculados.
#[derive(Clone, Debug)]
pub struct Chunk {
    pub text: String,
    pub tokens: HashSet<String>,
    /// Archivo de origen (KB) o procedencia `source` (RAG).
    pub source: String,
}

impl Chunk {
    pub fn new(text: String, source: &str) -> Self {
        Self {
            tokens: tokenize(&text),
            text,
            source: source.into(),
        }
    }
}

/// Los `top_k` fragmentos más parecidos a la consulta, de mayor a menor
/// puntaje; los empates conservan el orden de indexado (sort estable).
pub fn rank<'a>(chunks: &'a [Chunk], query: &str, top_k: usize) -> Vec<(&'a Chunk, f64)> {
    let query = tokenize(query);
    let mut scored: Vec<(&Chunk, f64)> = chunks
        .iter()
        .map(|chunk| (chunk, similarity(&query, &chunk.tokens)))
        .collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    scored.truncate(top_k);
    scored
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizes_like_the_ts_bridges() {
        let tokens = tokenize("¿Qué dice el Artículo 3º? La educación, y 2 más.");
        for expected in ["qué", "dice", "el", "artículo", "la", "educación", "más"] {
            assert!(tokens.contains(expected), "falta {expected}");
        }
        // Palabras de un carácter fuera: "y", "2".
        assert!(!tokens.contains("y") && !tokens.contains("2"));
    }

    #[test]
    fn jaccard_similarity() {
        let a = tokenize("derecho a la educación");
        let b = tokenize("la educación es un derecho");
        // {derecho, la, educación} ∩ = 3; ∪ = 3 + 5 - 3 = 5 ("es", "un" cuentan).
        assert!((similarity(&a, &b) - 3.0 / 5.0).abs() < 1e-9);
        assert_eq!(similarity(&a, &HashSet::new()), 0.0);
    }

    #[test]
    fn chunks_overlap_and_cover_the_text() {
        let text = (1..=10)
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(
            chunk_text(&text, 4, 1),
            vec!["1 2 3 4", "4 5 6 7", "7 8 9 10"]
        );
        assert_eq!(chunk_text("", 4, 1), vec![""]);
    }

    #[test]
    fn ranks_by_score_keeping_ties_in_order() {
        let chunks = vec![
            Chunk::new("nada que ver".into(), "a"),
            Chunk::new("educación laica".into(), "b"),
            Chunk::new("educación gratuita".into(), "c"),
        ];
        let top = rank(&chunks, "educación laica", 2);
        assert_eq!(top[0].0.source, "b");
        assert_eq!(top[1].0.source, "c");
    }
}
