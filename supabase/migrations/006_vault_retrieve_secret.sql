-- RPC wrapper to retrieve a decrypted secret by ID
create or replace function public.vault_retrieve_secret(secret_id uuid)
returns text
language plpgsql
security definer
as $$
declare
  result text;
begin
  select decrypted_secret into result
  from vault.decrypted_secrets
  where id = secret_id;

  return result;
end;
$$;
