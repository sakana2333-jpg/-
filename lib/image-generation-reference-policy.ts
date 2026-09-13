export type UserReferenceImagePolicy = {
  canAttemptImageInput: boolean;
  normalizedModel: string;
  reason?: "model_not_supported";
};

/**
 * 中转站常给同一个模型加 models/ 前缀、大小写或分隔符差异。
 * 这里只接纳仍能明确归一到 gpt-image-2 的名称，不把所有 image 模型误判为支持。
 */
export function normalizeImageModelName(model: string): string {
  return model.trim().toLowerCase().replace(/^models\//, "").replace(/[\s_.]+/g, "-");
}

export function getUserReferenceImagePolicy(model: string): UserReferenceImagePolicy {
  const normalizedModel = normalizeImageModelName(model);
  const compact = normalizedModel.replace(/-/g, "");
  const supported = normalizedModel === "gpt-image-2"
    || compact === "gptimage2"
    || normalizedModel === "chatgpt-image-2";
  return supported
    ? { canAttemptImageInput: true, normalizedModel }
    : { canAttemptImageInput: false, normalizedModel, reason: "model_not_supported" };
}

/** 仅这些状态通常表示 edits/multipart/图片参数不被兼容站接受；鉴权、限流、超时和 5xx 不降级。 */
export function isReferenceInputUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const status = Number(/(?:API 错误|HTTP|请求失败)\s*(400|404|405|415|422)\b/i.exec(message)?.[1] || 0);
  if (!status) return false;
  return /(?:edit|edits|multipart|image|图片|参考图|unsupported|not supported|不支持|unknown field|invalid.*image)/i.test(message);
}

export type OwnedAppMediaRecord = { id?: unknown; category?: unknown };
export type AppMediaMetadata = { category: string; mimeType: string; bytes: number };

export function validateOwnedAppImageReference(input: {
  ref: string;
  ownedRows: OwnedAppMediaRecord[];
  media: AppMediaMetadata | null;
  maxBytes: number;
}): void {
  if (!input.ref.startsWith("media-store://")) throw new Error("App 用户参考图必须是 media-store:// 引用。");
  const owned = input.ownedRows.some(row => String(row.id) === input.ref && String(row.category) === "image");
  if (!owned) throw new Error("App 用户参考图不是当前 APP 拥有的图片媒体。");
  if (!input.media) throw new Error("App 用户参考图已被删除或不可用。");
  if (input.media.category !== "image" || !input.media.mimeType.startsWith("image/")) {
    throw new Error("App 用户参考图必须是图片媒体。");
  }
  if (input.media.bytes > input.maxBytes) throw new Error("App 用户参考图不能超过 25MB。");
}

export function redactImageGenerationError(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value ?? "");
  text = text
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/(["']?(?:api[_-]?key|authorization|token|secret|password)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[REDACTED]")
    .replace(/data:image\/[^;,\s]+;base64,[A-Za-z0-9+/=]+/gi, "[IMAGE_DATA_REDACTED]")
    .replace(/[A-Za-z0-9+/]{512,}={0,2}/g, "[BASE64_REDACTED]");
  return text.slice(0, 600);
}
