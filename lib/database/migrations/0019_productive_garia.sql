-- NOT VALID: existing rows aren't checked (migration 0017 may have left
-- some rows un-lowercased if they were part of a case-insensitive collision
-- group it deliberately didn't auto-merge), but every new INSERT/UPDATE is
-- enforced immediately. Run `ALTER TABLE "users" VALIDATE CONSTRAINT
-- "users_email_lowercase";` once any such collisions have been resolved
-- manually, to fully close the gap for the remaining legacy rows too.
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email")) NOT VALID;