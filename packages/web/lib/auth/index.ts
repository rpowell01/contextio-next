/**
 * Auth module exports for the web package.
 */

export { getSession, getUser, clearSession, isAuthenticated, getUserId, getUserEmail, getUserName, getUserPicture } from "./session";
export type { AuthSession } from "./session";

export { withAuth, withOptionalAuth } from "./guards";
export type { WithAuthContext, WithOptionalAuthContext } from "./guards";