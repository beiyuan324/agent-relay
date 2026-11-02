use anyhow::{anyhow, bail, ensure, Result};
use serde_json::{json, Map, Value};

// Validate against the original server request, never a permission profile supplied by a peer.
pub fn response(request: &Value, result: Value) -> Result<Value> {
    let params = &request["params"];
    match request["method"].as_str().unwrap_or_default() {
        "item/commandExecution/requestApproval" => {
            let decision = &result["decision"];
            if let Some(available) = params["availableDecisions"].as_array() {
                ensure!(available.contains(decision), "此决定不在执行电脑提供的审批选项中");
            } else {
                ensure!(matches!(decision.as_str(), Some("accept" | "acceptForSession" | "decline" | "cancel")), "审批决定无效");
            }
            Ok(json!({"decision": decision}))
        }
        "item/fileChange/requestApproval" => {
            ensure!(matches!(result["decision"].as_str(), Some("accept" | "acceptForSession" | "decline" | "cancel")), "审批决定无效");
            Ok(json!({"decision": result["decision"]}))
        }
        "item/tool/requestUserInput" | "tool/requestUserInput" => {
            let questions = params["questions"].as_array().ok_or_else(|| anyhow!("补充输入问题无效"))?;
            let answers = result["answers"].as_object().ok_or_else(|| anyhow!("补充输入格式无效"))?;
            ensure!(answers.len() == questions.len(), "请回答全部问题");
            let mut validated = Map::new();
            for question in questions {
                let key = question["id"].as_str().ok_or_else(|| anyhow!("补充输入问题标识无效"))?;
                let answer = answers.get(key).and_then(|answer| answer["answers"].as_array()).ok_or_else(|| anyhow!("补充输入格式无效"))?;
                ensure!(!answer.is_empty() && answer.iter().all(|answer| answer.as_str().is_some_and(|answer| !answer.trim().is_empty())), "请回答全部问题");
                validated.insert(key.into(), json!({"answers": answer}));
            }
            Ok(json!({"answers": validated}))
        }
        "item/permissions/requestApproval" => {
            let granted = result["permissions"].as_object().ok_or_else(|| anyhow!("权限审批结果无效"))?;
            let scope = result["scope"].as_str().unwrap_or("turn");
            ensure!(matches!(scope, "turn" | "session"), "权限授权范围无效");
            if granted.is_empty() { return Ok(json!({"permissions": {}, "scope": "turn"})); }
            let requested = params["permissions"].as_object().ok_or_else(|| anyhow!("执行电脑未提供有效的权限申请"))?;
            ensure!(requested.keys().all(|key| matches!(key.as_str(), "network" | "fileSystem")), "此权限申请包含尚未支持的权限类型");
            let requested: Map<String, Value> = requested.iter().filter(|(_, value)| !value.is_null()).map(|(key, value)| (key.clone(), value.clone())).collect();
            ensure!(*granted == requested, "只能批准此请求的原始权限或拒绝授权");
            Ok(json!({"permissions": granted, "scope": scope}))
        }
        "mcpServer/elicitation/request" => {
            let action = result["action"].as_str().ok_or_else(|| anyhow!("缺少工具授权决定"))?;
            ensure!(matches!(action, "accept" | "decline" | "cancel"), "工具授权决定无效");
            if action != "accept" {
                return Ok(json!({"action": action, "content": null, "_meta": null}));
            }
            match params["mode"].as_str() {
                Some("form" | "openai/form" | "openaiForm") => validate_form(&params["requestedSchema"], &result["content"])?,
                Some("url") => ensure!(result["content"].is_null(), "地址验证无需提交表单内容"),
                _ => bail!("请在执行电脑完成此类工具验证，或拒绝／取消请求"),
            }
            Ok(json!({"action": action, "content": result["content"], "_meta": null}))
        }
        _ => bail!("此审批类型尚未支持。请保留待处理或停止当前回合，并更新 Relay"),
    }
}

fn enum_values(schema: &Value, key: &str) -> Option<Vec<Value>> {
    if let Some(values) = schema["enum"].as_array() { return Some(values.clone()); }
    schema[key].as_array().map(|values| values.iter().map(|value| value["const"].clone()).collect())
}

fn validate_form(schema: &Value, content: &Value) -> Result<()> {
    ensure!(schema["type"] == "object", "此工具表单格式尚未支持");
    let properties = schema["properties"].as_object().ok_or_else(|| anyhow!("工具表单字段无效"))?;
    let content = content.as_object().ok_or_else(|| anyhow!("工具表单内容必须是对象"))?;
    ensure!(content.keys().all(|key| properties.contains_key(key)), "工具表单包含未请求的字段");
    if let Some(required) = schema["required"].as_array() {
        for key in required {
            ensure!(key.as_str().is_some_and(|key| content.contains_key(key)), "请填写工具表单中的全部必填项");
        }
    }
    for (key, value) in content {
        let field = &properties[key];
        let valid = match field["type"].as_str() {
            Some("string") => value.as_str().is_some_and(|text| {
                let len = text.chars().count() as u64;
                field["minLength"].as_u64().is_none_or(|min| len >= min)
                    && field["maxLength"].as_u64().is_none_or(|max| len <= max)
                    && enum_values(field, "oneOf").is_none_or(|options| options.contains(value))
            }),
            Some("boolean") => value.is_boolean(),
            Some("number" | "integer") => value.as_f64().is_some_and(|number| {
                number.is_finite() && (field["type"] != "integer" || number.fract() == 0.0)
                    && field["minimum"].as_f64().is_none_or(|min| number >= min)
                    && field["maximum"].as_f64().is_none_or(|max| number <= max)
            }),
            Some("array") => value.as_array().is_some_and(|values| {
                let len = values.len() as u64;
                field["minItems"].as_u64().is_none_or(|min| len >= min)
                    && field["maxItems"].as_u64().is_none_or(|max| len <= max)
                    && enum_values(&field["items"], "anyOf").is_some_and(|options| {
                        values.iter().enumerate().all(|(index, value)| value.is_string() && options.contains(value) && !values[..index].contains(value))
                    })
            }),
            _ => false,
        };
        ensure!(valid, "工具表单字段 {key} 的内容无效");
    }
    Ok(())
}
