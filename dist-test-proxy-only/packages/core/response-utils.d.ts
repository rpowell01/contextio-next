/**
 * Response utility functions for adding service identification to API responses.
 *
 * All client-facing messages (errors, warnings, info, success) should clearly
 * indicate they come from the contextio-next service, not the upstream provider.
 */
export declare const SERVICE_IDENTIFIER = "contextio-next";
/**
 * Options for creating a service-identified response
 */
export interface ServiceResponseOptions {
    /** The main message content */
    message: string;
    /** Optional error code for programmatic handling */
    code?: string;
    /** Optional additional details */
    details?: unknown;
    /** HTTP status code (for error responses) */
    status?: number;
    /** Optional stack trace for debugging */
    stack?: string;
    /** Optional errno for system errors */
    errno?: number;
    /** Optional syscall for system errors */
    syscall?: string;
    /** Optional path for file system errors */
    path?: string;
}
/**
 * Create an error response with service identification
 */
export declare function createErrorResponse(options: ServiceResponseOptions): Record<string, unknown>;
/**
 * Create a success response with service identification
 */
export declare function createSuccessResponse<T extends object>(data: T, message?: string): T & {
    service: string;
    message?: string;
};
/**
 * Create an info/warning response with service identification
 */
export declare function createInfoResponse(message: string, data?: Record<string, unknown>): Record<string, unknown>;
/**
 * Add service identification to an existing response object
 */
export declare function addServiceIdentifier<T extends Record<string, unknown>>(response: T): T & {
    service: string;
};
/**
 * Type guard to check if a response already has service identification
 */
export declare function hasServiceIdentifier(response: unknown): response is {
    service: string;
};
//# sourceMappingURL=response-utils.d.ts.map