-- task.scope holds only backend / frontend / qa / design, or NULL (roadmap
-- sub-project 2, 2026-09-29; spec docs/superpowers/specs/2026-09-29-scope-and-
-- meeting-projects-design.md). Before this, meeting tasks stored CSAAS's free-
-- text feature ("GitSync") as the scope. Nothing is lost: free text moves into
-- modules. Idempotent: afterwards every scope is one of the four or NULL, so
-- a second run matches no rows. The column collation is case-insensitive, so
-- step 1 compares bytes to find case variants. A modules value that is not a
-- JSON array (SQL NULL included) is treated as an empty array. task.updatedAt
-- is DATETIME(3) ... ON UPDATE CURRENT_TIMESTAMP(3) (schema.sql); every SET
-- below also assigns `updatedAt = updatedAt` because MySQL skips the implicit
-- auto-update only when the column is set explicitly — without this every
-- touched row's updatedAt would jump to deploy time, irreversibly.

-- 1. "Backend", " qa " → the lowercase value.
UPDATE task SET scope = LOWER(TRIM(scope)), updatedAt = updatedAt
 WHERE LOWER(TRIM(scope)) IN ('backend', 'frontend', 'qa', 'design')
   AND CAST(scope AS BINARY) <> CAST(LOWER(TRIM(scope)) AS BINARY);

-- 2. A blank scope → NULL.
UPDATE task SET scope = NULL, updatedAt = updatedAt
 WHERE scope IS NOT NULL AND TRIM(scope) = '';

-- 3. Any other text → appended to modules, unless already there.
UPDATE task SET modules = JSON_ARRAY_APPEND(IF(JSON_TYPE(modules) = 'ARRAY', modules, JSON_ARRAY()), '$', TRIM(scope)), updatedAt = updatedAt
 WHERE scope IS NOT NULL
   AND TRIM(scope) <> ''
   AND LOWER(TRIM(scope)) NOT IN ('backend', 'frontend', 'qa', 'design')
   AND NOT JSON_CONTAINS(IF(JSON_TYPE(modules) = 'ARRAY', modules, JSON_ARRAY()), JSON_QUOTE(TRIM(scope)));

-- 4. …and that text is cleared from scope.
UPDATE task SET scope = NULL, updatedAt = updatedAt
 WHERE scope IS NOT NULL
   AND LOWER(TRIM(scope)) NOT IN ('backend', 'frontend', 'qa', 'design');
