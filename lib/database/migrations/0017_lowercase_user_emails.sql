-- Case-insensitive collision groups (more than one existing row sharing the
-- same lower(email), e.g. "User@x.com" and "user@x.com" both already
-- present) are deliberately left untouched here rather than auto-merged -
-- which of two distinct accounts should "win" isn't a decision this
-- migration can safely make, and blindly lowercasing every row would abort
-- the whole statement the moment two rows collide under the unique
-- constraint. Only rows whose lowercased email doesn't collide with any
-- other existing row are normalized automatically; the NOT EXISTS check
-- below correctly leaves an entire collision group (2 or more rows)
-- untouched, not just the second row it encounters.
UPDATE "users" u
SET "email" = lower(u."email")
WHERE u."email" <> lower(u."email")
  AND NOT EXISTS (
    SELECT 1 FROM "users" u2
    WHERE u2."id" <> u."id" AND lower(u2."email") = lower(u."email")
  );
--> statement-breakpoint
DO $$
DECLARE
  collision_count integer;
BEGIN
  SELECT count(*) INTO collision_count FROM (
    SELECT lower(email) FROM "users" GROUP BY lower(email) HAVING count(*) > 1
  ) AS collisions;
  IF collision_count > 0 THEN
    RAISE NOTICE 'users: % case-insensitive email collision group(s) left un-normalized - resolve manually (merge or rename) before they can satisfy the users_email_lowercase check constraint added in a later migration', collision_count;
  END IF;
END $$;
