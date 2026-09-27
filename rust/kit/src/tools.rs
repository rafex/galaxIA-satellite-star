//! Definiciones de tools y argumentos (`toolDefinitionFromLocal`,
//! `dynamicValueToJson` de `fhs-wire`).

use std::collections::HashMap;
use std::future::Future;

use galaxia_fhs::p2p::dynamic;
use galaxia_fhs::p2p::provider::Reply;
use galaxia_fhs::protocol::fhs::{
    ToolCall, ToolCallRequestMessage, ToolDefinition, ToolInputSchema,
};
use serde_json::Value;

/// Tool a partir de su esquema de entrada en JSON Schema.
pub fn tool(name: &str, description: &str, schema: &Value) -> ToolDefinition {
    ToolDefinition {
        name: name.into(),
        description: description.into(),
        input_schema: Some(input_schema(schema)),
    }
}

fn input_schema(schema: &Value) -> ToolInputSchema {
    let properties: HashMap<String, ToolInputSchema> = schema["properties"]
        .as_object()
        .map(|props| {
            props
                .iter()
                .map(|(key, value)| (key.clone(), input_schema(value)))
                .collect()
        })
        .unwrap_or_default();
    let strings = |key: &str| -> Vec<String> {
        schema[key]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|v| {
                        v.as_str()
                            .map(String::from)
                            .unwrap_or_else(|| v.to_string())
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    ToolInputSchema {
        r#type: schema["type"].as_str().unwrap_or("object").into(),
        description: schema["description"].as_str().unwrap_or_default().into(),
        properties,
        required: strings("required"),
        enum_values: strings("enum"),
    }
}

/// Nombre y argumentos (JSON) de un tool call; sin argumentos, `{}`.
pub fn call_parts(call: &ToolCall) -> (String, Value) {
    let function = call.function.as_ref();
    let name = function.map(|f| f.name.clone()).unwrap_or_default();
    let args = function
        .and_then(|f| f.arguments.as_ref())
        .map(dynamic::to_json)
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Default::default()));
    (name, args)
}

/// Texto de un argumento (`String(args.x ?? default)` del TS).
pub fn arg_str(args: &Value, key: &str, default: &str) -> String {
    match &args[key] {
        Value::Null => default.into(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Número positivo de un argumento, o `default`.
pub fn arg_count(args: &Value, keys: &[&str], default: usize) -> usize {
    keys.iter()
        .find_map(|key| args[*key].as_f64())
        .filter(|n| *n >= 1.0)
        .map(|n| n as usize)
        .unwrap_or(default)
}

/// Responde una misión `tool_call`: `dispatch_ack` y luego un `tool_result`
/// o `tool_error` por cada llamada. `run` recibe el nombre de la tool y sus
/// argumentos, y devuelve el resultado en JSON o el texto del error.
pub async fn answer<F, Fut>(request: ToolCallRequestMessage, reply: &mut Reply, mut run: F)
where
    F: FnMut(String, Value) -> Fut + Send,
    Fut: Future<Output = Result<Value, String>> + Send,
{
    let mission = request.mission_id;
    reply.dispatch_ack(&mission).await;
    for call in &request.tool_calls {
        let (name, args) = call_parts(call);
        match run(name.clone(), args).await {
            Ok(result) => match dynamic::from_json(&result) {
                Ok(value) => {
                    reply.tool_result(&mission, &call.id, value).await;
                    tracing::info!("[mission] {mission}/{} — {name} resuelta", call.id);
                }
                Err(_) => {
                    reply
                        .tool_error(&mission, &call.id, "resultado vacío")
                        .await
                }
            },
            Err(error) => {
                tracing::warn!("[mission] {mission}/{} — {name}: {error}", call.id);
                reply.tool_error(&mission, &call.id, &error).await;
            }
        }
    }
}

/// Error estándar para una tool que el provider no ofrece.
pub fn unknown_tool(name: &str) -> String {
    format!("Herramienta desconocida: {name}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn schema_keeps_properties_and_required() {
        let def = tool(
            "kb_query",
            "Recupera fragmentos",
            &json!({"type": "object",
                "properties": {"query": {"type": "string", "description": "Consulta"}},
                "required": ["query"]}),
        );
        let schema = def.input_schema.unwrap();
        assert_eq!(schema.required, vec!["query"]);
        assert_eq!(schema.properties["query"].r#type, "string");
    }

    #[test]
    fn reads_arguments_with_defaults() {
        let args = json!({"query": "reloj", "top_k": 5});
        assert_eq!(arg_str(&args, "query", ""), "reloj");
        assert_eq!(arg_str(&args, "source", "user-upload"), "user-upload");
        assert_eq!(arg_count(&args, &["topK", "top_k"], 3), 5);
        assert_eq!(arg_count(&json!({}), &["topK"], 3), 3);
    }
}
