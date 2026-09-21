/**
 * Structured error envelope for MCP tool results.
 *
 * A caller that gets back prose has to guess whether to retry. A caller that gets
 * back a category and a retry flag does not. The four categories:
 *
 *   transient   the call could succeed if repeated (timeout, 429, 5xx)
 *   validation  the request was malformed and will fail again unchanged
 *   business    the service understood it and declined (insufficient balance)
 *   permission  not allowed (no key, wrong auth tier, refused by policy)
 *
 * Only `transient` is retryable.
 *
 * Note the distinction this enforces: an access failure is an error, but a query
 * that legitimately returned nothing is a success with an empty result. Never
 * report the second as the first.
 */

export type ErrorCategory = "transient" | "validation" | "business" | "permission";

export interface McpErrorResult {
  // Index signature so the shape satisfies the MCP SDK's ServerResult union,
  // which otherwise tries to match the task-shaped variant and complains.
  [key: string]: unknown;
  isError: true;
  content: Array<{ type: "text"; text: string }>;
}

export function mcpError(
  errorCategory: ErrorCategory,
  message: string,
  extra?: Record<string, unknown>,
): McpErrorResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          errorCategory,
          isRetryable: errorCategory === "transient",
          message,
          ...extra,
        }),
      },
    ],
  };
}

/** Map an HTTP status onto a category. */
export function categoryForStatus(status: number): ErrorCategory {
  if (status === 401 || status === 403) return "permission";
  if (status === 402) return "business";
  if (status === 408 || status === 429 || status >= 500) return "transient";
  if (status >= 400) return "validation";
  return "transient";
}
