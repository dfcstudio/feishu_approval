export class AppError extends Error {
  constructor(
    message: string,
    public readonly errorCode: string,
    public readonly statusCode = 500,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export class BusinessError extends AppError {
  constructor(message: string, errorCode: string, details?: unknown) {
    super(message, errorCode, 200, details);
  }
}

export const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};
