-- Better Auth 1.7 distinguishes local credential accounts by issuer.
ALTER TABLE auth.account ADD COLUMN issuer text;
UPDATE auth.account SET issuer = 'local:credential' WHERE "providerId" = 'credential';
ALTER TABLE auth.account ALTER COLUMN issuer SET NOT NULL;