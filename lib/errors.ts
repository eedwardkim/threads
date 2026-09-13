export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "invalid_request",
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function readableError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const status = typeof error === "object" && error !== null && "statusCode" in error
    ? Number(error.statusCode)
    : 0;
  if (status === 401) return new AppError("Your API key was rejected. Check your provider keys and restart the app.", 401, "invalid_key");
  if (status === 404) return new AppError("This model is unavailable or your API key does not have access to it. Choose another model or update the model configuration.", 404, "model_unavailable");
  if (status === 429) return new AppError("The provider is receiving too many requests. Wait a moment, then retry.", 429, "rate_limit");
  if (status === 503) return new AppError("The provider is busy right now. Please retry in a moment.", 503, "busy");
  return new AppError("The connection was interrupted. Your text is saved. Please retry.", 502, "network");
}
