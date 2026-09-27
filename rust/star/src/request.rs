//! IDL FHS → formato OpenAI de llama-server (`llm-request.ts`). Sin campos
//! vacíos que en OpenAI significan otra cosa (`tool_call_id: ""`,
//! `tool_calls: []`); los argumentos de un tool call van como texto JSON.

use galaxia_fhs::p2p::dynamic;
use galaxia_fhs::protocol::fhs::{Message, ToolCall, ToolDefinition, ToolInputSchema};
use serde_json::{json, Map, Value};

const LLM_ROLES: [&str; 4] = ["system", "user", "assistant", "tool"];

pub fn llm_messages(messages: &[Message]) -> Result<Vec<Value>, String> {
    messages
        .iter()
        .enumerate()
        .map(|(index, message)| {
            if !LLM_ROLES.contains(&message.role.as_str()) {
                return Err(format!(
                    "mensaje {index} con rol no soportado por el LLM: \"{}\"",
                    message.role
                ));
            }
            let mut out = Map::new();
            out.insert("role".into(), json!(message.role));
            out.insert("content".into(), json!(message.content));
            if !message.tool_call_id.is_empty() {
                out.insert("tool_call_id".into(), json!(message.tool_call_id));
            }
            if !message.tool_calls.is_empty() {
                let calls: Vec<Value> = message.tool_calls.iter().map(llm_tool_call).collect();
                out.insert("tool_calls".into(), Value::Array(calls));
            }
            Ok(Value::Object(out))
        })
        .collect()
}

pub fn llm_tools(tools: &[ToolDefinition]) -> Option<Vec<Value>> {
    if tools.is_empty() {
        return None;
    }
    Some(
        tools
            .iter()
            .map(|tool| {
                let mut function = Map::new();
                function.insert("name".into(), json!(tool.name));
                if !tool.description.is_empty() {
                    function.insert("description".into(), json!(tool.description));
                }
                let parameters = tool
                    .input_schema
                    .as_ref()
                    .map(json_schema)
                    .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
                function.insert("parameters".into(), parameters);
                json!({ "type": "function", "function": function })
            })
            .collect(),
    )
}

fn llm_tool_call(call: &ToolCall) -> Value {
    let function = call.function.as_ref();
    let args = function
        .and_then(|f| f.arguments.as_ref())
        .map(dynamic::to_json)
        .unwrap_or_else(|| json!({}));
    json!({
        "id": call.id,
        "type": "function",
        "function": {
            "name": function.map(|f| f.name.clone()).unwrap_or_default(),
            "arguments": args.to_string(),
        },
    })
}

fn json_schema(schema: &ToolInputSchema) -> Value {
    let mut out = Map::new();
    let kind = if schema.r#type.is_empty() {
        "object"
    } else {
        &schema.r#type
    };
    out.insert("type".into(), json!(kind));
    if !schema.description.is_empty() {
        out.insert("description".into(), json!(schema.description));
    }
    if !schema.properties.is_empty() || kind == "object" {
        // Orden estable: prost guarda el map en un HashMap.
        let mut keys: Vec<&String> = schema.properties.keys().collect();
        keys.sort();
        let properties: Map<String, Value> = keys
            .into_iter()
            .map(|key| (key.clone(), json_schema(&schema.properties[key])))
            .collect();
        out.insert("properties".into(), Value::Object(properties));
    }
    if !schema.required.is_empty() {
        out.insert("required".into(), json!(schema.required));
    }
    if !schema.enum_values.is_empty() {
        out.insert("enum".into(), json!(schema.enum_values));
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use galaxia_fhs::protocol::fhs::ToolCallFunction;
    use std::collections::HashMap;

    fn message(role: &str, content: &str) -> Message {
        Message {
            role: role.into(),
            content: content.into(),
            ..Default::default()
        }
    }

    #[test]
    fn omits_empty_fields() {
        let json = serde_json::to_string(
            &llm_messages(&[
                message("system", "Responde en español."),
                message("user", "hola"),
            ])
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            json,
            r#"[{"content":"Responde en español.","role":"system"},{"content":"hola","role":"user"}]"#
        );
    }

    #[test]
    fn tool_call_arguments_become_json_text() {
        let assistant = Message {
            role: "assistant".into(),
            tool_calls: vec![ToolCall {
                id: "call_1".into(),
                r#type: "function".into(),
                function: Some(ToolCallFunction {
                    name: "kb.query".into(),
                    arguments: Some(dynamic::from_json(&json!({"query": "reloj"})).unwrap()),
                }),
            }],
            ..Default::default()
        };
        let out = llm_messages(&[assistant]).unwrap();
        assert_eq!(
            out[0]["tool_calls"],
            json!([{"id": "call_1", "type": "function",
                    "function": {"name": "kb.query", "arguments": "{\"query\":\"reloj\"}"}}])
        );
    }

    #[test]
    fn rejects_unknown_roles() {
        let error = llm_messages(&[message("navigator", "x")]).unwrap_err();
        assert!(error.contains("rol no soportado"));
    }

    #[test]
    fn tools_become_json_schema() {
        assert!(llm_tools(&[]).is_none());
        let tools = llm_tools(&[ToolDefinition {
            name: "kb.query".into(),
            description: "Busca en la base de conocimiento".into(),
            input_schema: Some(ToolInputSchema {
                r#type: "object".into(),
                properties: HashMap::from([(
                    "query".to_string(),
                    ToolInputSchema {
                        r#type: "string".into(),
                        description: "texto".into(),
                        ..Default::default()
                    },
                )]),
                required: vec!["query".into()],
                ..Default::default()
            }),
        }])
        .unwrap();
        assert_eq!(
            tools[0],
            json!({"type": "function", "function": {
                "name": "kb.query",
                "description": "Busca en la base de conocimiento",
                "parameters": {"type": "object",
                    "properties": {"query": {"type": "string", "description": "texto"}},
                    "required": ["query"]}}})
        );
    }
}
