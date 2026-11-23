// Build pipeline roles: the role definition format, the shipped role
// library, repository overrides, and the prompt for one task.
export { RoleError, parseRole } from "./parse.js";
export {
  ROLE_LIBRARY_DIR,
  UnknownRoleError,
  loadRole,
  loadRoles,
  type LoadRolesOptions,
} from "./load.js";
export { OWNED_FILES, rolePrompt, writablePaths, type RoleTask } from "./prompt.js";
