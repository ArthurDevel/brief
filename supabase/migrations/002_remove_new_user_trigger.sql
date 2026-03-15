-- Remove the auto-create subscription trigger.
-- Subscription rows are now created in app code on first login.

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists handle_new_user();
