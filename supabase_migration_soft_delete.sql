-- ═══════════════════════════════════════════════════════════════
-- MIGRATION: soft delete + block hard-delete via anon key
-- Runs ONCE in Supabase SQL Editor. Non-destructive — existing
-- quotes are unaffected and remain visible.
--
-- All three shops (Spartan / Italnord / Mondial) share one
-- Supabase project, so this migration runs once for all of them.
-- ═══════════════════════════════════════════════════════════════

-- 1. Add soft-delete timestamp column. NULL = active, NOT NULL = in trash.
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 2. Indexes for fast active-vs-trash queries.
CREATE INDEX IF NOT EXISTS idx_quotes_active
    ON quotes(shop_id, updated_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_quotes_trash
    ON quotes(shop_id, deleted_at DESC)
    WHERE deleted_at IS NOT NULL;

-- 3. Block hard-delete via the anon key. The app now soft-deletes by
--    setting deleted_at; permanent deletion requires the service role
--    (Supabase dashboard or server-side code). This prevents anyone
--    with the public anon key from wiping the database.
DROP POLICY IF EXISTS "quotes_delete" ON quotes;

-- 4. Block direct mutation of the id column — clients should never
--    change an existing quote's primary key. (Belt + suspenders.)
CREATE OR REPLACE FUNCTION prevent_quote_id_change() RETURNS trigger AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id THEN
        RAISE EXCEPTION 'Cannot change quote id (was %, tried to set %)', OLD.id, NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_quotes_lock_id ON quotes;
CREATE TRIGGER trg_quotes_lock_id
BEFORE UPDATE ON quotes
FOR EACH ROW EXECUTE FUNCTION prevent_quote_id_change();

-- ═══════════════════════════════════════════════════════════════
-- DONE. No data was modified. The quotes table now has:
--   • deleted_at column (NULL for existing rows)
--   • Two indexes for active/trash filtering
--   • No DELETE policy (hard delete blocked for anon key)
--   • Trigger preventing id mutation
-- ═══════════════════════════════════════════════════════════════
