-- Advertise 32-entry cloud pages; older firmware may still return eight.
-- Keep authentication, ownership, result-size checks and idempotent replies.
begin;
create or replace function public.link_device_command(p_device_id uuid,p_token text,p_action text,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.link_devices; c public.link_commands; r public.link_resources;
 n bigint; actual bigint; hash text; path text; rid uuid; k text; next_status text;
begin
 if not exists(select 1 from private.link_device_secrets s join public.link_devices v on v.id=s.device_id
   join private.link_members m on m.user_id=v.owner_id
   where s.device_id=p_device_id and s.revoked_at is null and s.token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex'))
 then raise exception using errcode='28000',message='Unauthorized'; end if;
 select * into d from public.link_devices where id=p_device_id for update;
 update public.link_devices set last_seen=now() where id=d.id;
 if p_action='command_claim' then
   select * into c from public.link_commands where device_id=d.id and status='running' order by created_at,id limit 1 for update;
   if not found then
     select * into c from public.link_commands where device_id=d.id and status='waiting' order by created_at,id limit 1 for update;
     if not found then return jsonb_build_object('command',null); end if;
     update public.link_commands set status='running',updated_at=now() where id=c.id returning * into c;
   end if;
   if c.op='put' then select * into r from public.link_resources where id=c.resource_id and owner_id=d.owner_id; end if;
   return jsonb_build_object('command',jsonb_build_object('id',c.id,'op',c.op,'path',c.path,'cursor',c.cursor,'limit',32,
     'overwrite',c.overwrite,'bytes_done',c.bytes_done,'size',r.size_bytes,'sha256',r.sha256,
     'download_path',r.storage_path,'upload_path',d.owner_id::text||'/'||c.id::text||'/payload') || c.args);
 end if;
 select * into c from public.link_commands where id=(p_payload->>'id')::uuid and device_id=d.id for update;
 if not found then raise exception 'Unknown command'; end if;
 if c.status in ('completed','failed') then return jsonb_build_object('ok',true,'status',c.status); end if;
 if c.status<>'running' then raise exception 'Command is not running'; end if;
 if p_action='command_progress' then
   n:=(p_payload->>'bytes')::bigint;
   if n is null or n<c.bytes_done or n>52428800 then raise exception 'Invalid progress'; end if;
   update public.link_commands set bytes_done=n,updated_at=now() where id=c.id;
 elsif p_action='command_result' then
   next_status:=p_payload->>'status';
   if next_status not in ('completed','failed') or next_status is null then raise exception 'Invalid result'; end if;
   if next_status='failed' then
     update public.link_commands set status='failed',error=left(coalesce(p_payload->>'error','DEVICE_ERROR'),300),updated_at=now() where id=c.id;
     return jsonb_build_object('ok',true);
   end if;
   if c.op in ('put','get') then
     n:=(p_payload->>'bytes')::bigint; hash:=p_payload->>'sha256';
     if n is null or n<c.bytes_done or n>52428800 or hash is null or hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid file result'; end if;
   end if;
   if c.op='put' then
     select * into r from public.link_resources where id=c.resource_id and owner_id=d.owner_id;
     if n<>r.size_bytes or hash<>r.sha256 then raise exception 'File verification failed'; end if;
   elsif c.op='get' then
     path:=d.owner_id::text||'/'||c.id::text||'/payload';
     select (metadata->>'size')::bigint into actual from storage.objects where bucket_id='link-resources' and name=path;
     if actual is null or actual<>n then raise exception 'Upload not complete'; end if;
     k:=case when lower(c.path) ~ '\.txt$' then 'text' when lower(c.path) ~ '\.(png|jpe?g|webp)$' then 'image' else 'file' end;
     insert into public.link_resources(owner_id,name,kind,size_bytes,sha256,storage_path)
       values(d.owner_id,regexp_replace(c.path,'^.*/',''),k,n,hash,path) returning id into rid;
   else
     if jsonb_typeof(p_payload->'result') is distinct from 'object' or octet_length((p_payload->'result')::text)>16384 then raise exception 'Invalid result payload'; end if;
     if c.op in ('list','music.list') then
       if jsonb_typeof(p_payload->'result'->'entries') is distinct from 'array' or
          jsonb_typeof(p_payload->'result'->'end') is distinct from 'boolean' or
          jsonb_typeof(p_payload->'result'->'cursor') is distinct from 'number'
       then raise exception 'Invalid directory page'; end if;
       if jsonb_array_length(p_payload->'result'->'entries')>32 or
          (p_payload->'result'->>'cursor')::bigint<c.cursor or
          (not (p_payload->'result'->>'end')::boolean and (p_payload->'result'->>'cursor')::bigint<=c.cursor)
       then raise exception 'Invalid directory cursor'; end if;
     end if;
   end if;
   update public.link_commands set status='completed',bytes_done=coalesce(n,0),result=case when c.op='get' then jsonb_build_object('resource_id',rid)
     else coalesce(p_payload->'result','{}') end,updated_at=now() where id=c.id;
 else raise exception 'Unsupported action'; end if;
 return jsonb_build_object('ok',true);
end $$;
commit;
