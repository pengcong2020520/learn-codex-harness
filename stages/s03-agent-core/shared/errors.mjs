export class AppError extends Error {
  constructor(message, status = 400, code = "INVALID_REQUEST") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function requireText(value, label = "消息", max = 100000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new AppError(`${label}不能为空，且不能超过 ${max} 个字符。`);
  }
  return value.trim();
}

export function requireId(value, label = "ID") {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new AppError(`${label} 格式不正确。`);
  }
  return value;
}
