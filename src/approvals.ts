import type { Json } from "./api";

export const isThreadApproval = (request: Json, threadId: string | null) => !request.params?.threadId || request.params.threadId === threadId;

export interface ApprovalChoice { decision: unknown; label: string; primary: boolean }
export function approvalChoices(request: Json): ApprovalChoice[] {
  const available: unknown[] = request.method === "item/commandExecution/requestApproval" && Array.isArray(request.params?.availableDecisions)
    ? request.params.availableDecisions : ["decline", "accept"];
  return available.flatMap(decision => {
    let label = "", primary = true;
    switch (decision) {
      case "accept": label = "允许这一次"; break;
      case "acceptForSession": label = "在此会话中允许"; break;
      case "decline": label = "拒绝"; primary = false; break;
      case "cancel": label = "取消本次回合"; primary = false; break;
      default:
        if (decision && typeof decision === "object") {
          if ("acceptWithExecpolicyAmendment" in decision) label = "允许并保存命令规则";
          else if ("applyNetworkPolicyAmendment" in decision) label = "应用此网络规则";
        }
    }
    return label ? [{ decision, label, primary }] : [];
  });
}

export function requestedPermissions(params: Json): Json | null {
  const profile = params.permissions;
  if (!profile || typeof profile !== "object" || Array.isArray(profile) || Object.keys(profile).some(key => !["network", "fileSystem"].includes(key))) return null;
  return Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== null));
}

export interface FormOption { value: string; label: string }
export interface FormField { key: string; schema: Json; options: FormOption[] | null; required: boolean }
export type FormAnswers = Record<string, string | string[]>;

function enumOptions(schema: Json, key: "oneOf" | "anyOf"): FormOption[] | null {
  if (Array.isArray(schema.enum) && schema.enum.every((value: unknown) => typeof value === "string")) {
    return schema.enum.map((value: string, index: number) => ({ value, label: schema.enumNames?.[index] || value }));
  }
  if (Array.isArray(schema[key]) && schema[key].every((option: Json) => option && typeof option.const === "string")) {
    return schema[key].map((option: Json) => ({ value: option.const, label: option.title || option.const }));
  }
  return null;
}

export function mcpFormFields(schema: Json | undefined): FormField[] | null {
  if (schema?.type !== "object" || !schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) return null;
  // More complex OpenAI forms remain rejectable; do not submit guessed values.
  if (Object.keys(schema).some(key => !["$schema", "type", "properties", "required", "title", "description", "additionalProperties"].includes(key))) return null;
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key: unknown) => typeof key !== "string" || !Object.hasOwn(schema.properties, key)))) return null;
  const fields: FormField[] = [];
  for (const [key, value] of Object.entries(schema.properties)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const field = value as Json;
    if (!["string", "boolean", "number", "integer", "array"].includes(field.type)) return null;
    if (Object.keys(field).some(key => !["type", "title", "description", "default", "format", "minLength", "maxLength", "minimum", "maximum", "enum", "enumNames", "oneOf", "items", "minItems", "maxItems"].includes(key))) return null;
    const options = enumOptions(field.type === "array" ? field.items || {} : field, field.type === "array" ? "anyOf" : "oneOf");
    if ((field.type === "array" || field.enum !== undefined || field.oneOf !== undefined) && !options) return null;
    fields.push({ key, schema: field, options, required: schema.required?.includes(key) || false });
  }
  return fields;
}

export function mcpFormContent(fields: FormField[], answers: FormAnswers): Json {
  const content: Json = Object.create(null);
  for (const { key, schema, options, required } of fields) {
    const answer = answers[key] ?? (required && schema.type === "array" ? [] : undefined);
    const label = schema.title || key;
    if (answer === undefined || answer === "") {
      if (required) throw new Error(`请填写“${label}”`);
      continue;
    }
    if (schema.type === "array") {
      if (!Array.isArray(answer) || answer.some(value => !options?.some(option => option.value === value)) || (schema.minItems !== undefined && answer.length < schema.minItems) || (schema.maxItems !== undefined && answer.length > schema.maxItems)) throw new Error(`请检查“${label}”的选择数量`);
      content[key] = answer;
    } else {
      if (typeof answer !== "string") throw new Error(`“${label}”格式无效`);
      if (schema.type === "boolean") {
        if (!["true", "false"].includes(answer)) throw new Error(`请选择“${label}”`);
        content[key] = answer === "true";
      } else if (schema.type === "number" || schema.type === "integer") {
        const value = Number(answer);
        if (!answer.trim() || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value)) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) throw new Error(`“${label}”的数值超出范围`);
        content[key] = value;
      } else {
        const length = [...answer].length;
        if ((schema.minLength !== undefined && length < schema.minLength) || (schema.maxLength !== undefined && length > schema.maxLength) || (options && !options.some(option => option.value === answer))) throw new Error(`请检查“${label}”的内容`);
        content[key] = answer;
      }
    }
  }
  return content;
}
