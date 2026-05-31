-- Platform role on users — retires the dev_user-bypass stopgap from the
-- enforcement workstream (rbac::require_grant treated only the bootstrap
-- dev_user as platform-admin). Now any user with role='admin' is a platform
-- admin; the bootstrap user is promoted to 'admin' by bootstrap.rs on startup
-- (idempotent), so the dev-mode bypass keeps working.
--
-- Spec: docs/internal/specs/rbac/index.md (Platform role — users.role).
-- Case: CAS_A3B5D5F8E2A3483EA44EAA5B437A6A92.

ALTER TABLE users
    ADD COLUMN role text NOT NULL DEFAULT 'user'
        CHECK (role IN ('admin', 'user'));
