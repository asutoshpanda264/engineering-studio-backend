package com.engineeringstudio.api.auth;

/**
 * The three roles the whole RBAC design hinges on. Kept as a plain enum (not a
 * separate `roles` table with a many-to-many join) because membership is
 * single-valued and fixed — a user is exactly one of these, never several, and
 * the set of roles itself isn't user-editable data. A join table would be the
 * right call if roles became dynamic/composable later; they aren't planned to.
 */
public enum Role {
    ADMIN,
    CONTRIBUTOR,
    USER
}
