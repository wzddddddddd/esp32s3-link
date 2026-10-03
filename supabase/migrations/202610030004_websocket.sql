-- Authenticated device WSS sessions and existing owner-filtered result streams.
begin;
create function public.link_device_session(p_device_id uuid, p_token text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from private.link_device_secrets s
   join public.link_devices d on d.id=s.device_id
   join private.link_members m on m.user_id=d.owner_id
   where s.device_id=p_device_id and s.revoked_at is null
   and s.token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex'))
 then raise exception using errcode='28000',message='Unauthorized'; end if;
 return true;
end $$;
revoke all on function public.link_device_session(uuid,text) from public,anon,authenticated;
grant execute on function public.link_device_session(uuid,text) to service_role;
do $$
begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime' and not puballtables) then
   if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='link_commands') then
     alter publication supabase_realtime add table public.link_commands;
   end if;
   if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='link_tasks') then
     alter publication supabase_realtime add table public.link_tasks;
   end if;
 end if;
end $$;
commit;
