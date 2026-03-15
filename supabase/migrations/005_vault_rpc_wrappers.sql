-- Thin public wrappers around vault.create_secret / vault.update_secret
-- so PostgREST (supabase-js) can call them via .rpc()

create or replace function public.vault_create_secret(secret text, name text)
returns uuid
language plpgsql
security definer
as $$
begin
  return vault.create_secret(secret, name);
end;
$$;

create or replace function public.vault_update_secret(secret_id uuid, new_secret text)
returns void
language plpgsql
security definer
as $$
begin
  perform vault.update_secret(secret_id, new_secret);
end;
$$;

create or replace function public.vault_delete_secret(secret_id uuid)
returns void
language plpgsql
security definer
as $$
begin
  delete from vault.secrets where id = secret_id;
end;
$$;
