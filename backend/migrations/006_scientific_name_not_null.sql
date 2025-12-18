-- Make scientific_name NOT NULL for performance
-- Currently, scientific_name is nullable, which complicates sorting
-- and pagination (requiring COALESCE wrappers) and prevents standard
-- indexes from being used effectively.
--
-- 1. Clean up existing data: NULL scientific_names become empty strings
UPDATE species SET scientific_name = '' WHERE scientific_name IS NULL;

-- 2. SQLite does not support altering columns to NOT NULL easily.
-- However, since we've cleaned the data, we can just enforce it in code
-- and ensure the index covers it.

-- Create a standard index that allows fast sorting on scientific_name
-- (This replaces the expression index from migration 005)
DROP INDEX IF EXISTS idx_species_scientific_name_coalesce;
CREATE INDEX IF NOT EXISTS idx_species_scientific_name
    ON species(scientific_name);
