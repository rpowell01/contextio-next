/**
 * Response utility functions for adding service identification to API responses.
 *
 * All client-facing messages (errors, warnings, info, success) should clearly
 * indicate they come from the contextio-next service, not the upstream provider.
 */
export const SERVICE_IDENTIFIER = "contextio-next";
/**
 * Create an error response with service identification
 */
export function createErrorResponse(options) {
    const { message, code, details, status, stack, errno, syscall, path } = options;
    const response = {
        error: message,
        service: SERVICE_IDENTIFIER,
    };
    if (code)
        response.code = code;
    if (details !== undefined)
        response.details = details;
    if (status)
        response.status = status;
    if (stack)
        response.stack = stack;
    if (errno !== undefined)
        response.errno = errno;
    if (syscall)
        response.syscall = syscall;
    if (path)
        response.path = path;
    return response;
}
/**
 * Create a success response with service identification
 */
export function createSuccessResponse(data, message) {
    return {
        ...data,
        service: SERVICE_IDENTIFIER,
        ...(message ? { message } : {}),
    };
}
/**
 * Create an info/warning response with service identification
 */
export function createInfoResponse(message, data) {
    return {
        message,
        service: SERVICE_IDENTIFIER,
        ...data,
    };
}
/**
 * Add service identification to an existing response object
 */
export function addServiceIdentifier(response) {
    return {
        ...response,
        service: SERVICE_IDENTIFIER,
    };
}
/**
 * Type guard to check if a response already has service identification
 */
export function hasServiceIdentifier(response) {
    return (typeof response === "object" &&
        response !== null &&
        "service" in response &&
        typeof response.service === "string");
}
//# sourceMappingURL=response-utils.js.map