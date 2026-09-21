-- The workflow role owns assign_user and accept_invitation; its UPDATE grant on profiles
-- is column-level (role, scope_all from migration 006), so the custom_role_id column
-- added in 039 needs its own grant before an assignment can carry a custom role.
GRANT UPDATE(custom_role_id) ON app.profiles TO intradocs_workflow;
GRANT UPDATE(custom_role_id) ON app.invitations TO intradocs_workflow;
