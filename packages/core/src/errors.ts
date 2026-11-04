/** Errors carrying a safe, plain-language message for the UI. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly userMessage: string,
    public readonly status = 400,
  ) {
    super(`${code}: ${userMessage}`);
  }
}

export const notFound = (what = "Item") => new AppError("not_found", `${what} not found.`, 404);
