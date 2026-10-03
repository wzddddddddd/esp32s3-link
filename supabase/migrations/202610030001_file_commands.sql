-- Add bidirectional SD file operations; apply AFTER 202609200001_link_cloud.sql.
-- Does not enable OTA or grant browser/device access to service_role secrets.
begin;
alter table public.link_resources drop constraint link_resources_kind_check;
alter table public.link_resources add constraint link_resources_kind_check check(kind in ('image','text','firmware','file'));
alter table public.link_resources drop constraint link_resources_size_bytes_check;
alter table public.link_resources add constraint link_resources_size_bytes_check check(size_bytes between 0 and 52428800);

create table public.link_commands (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id),
 device_id uuid not null references public.link_devices(id),
 op text not null check(op in ('list','mkdir','put','get')),
 path text not null, cursor integer not null default 0 check(cursor>=0),
 resource_id uuid references public.link_resources(id), overwrite boolean not null default false,
 status text not null default 'waiting' check(status in ('waiting','running','completed','failed','cancelled')),
 bytes_done bigint not null default 0 check(bytes_done>=0), result jsonb,
 error text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.link_commands enable row level security;
revoke all on public.link_commands from public,anon,authenticated;
grant select on public.link_commands to authenticated;
create policy link_commands_read on public.link_commands for select to authenticated
 using(owner_id=(select auth.uid()) and (select public.link_is_member()));
create index link_commands_pending on public.link_commands(device_id,created_at) where status in ('waiting','running');

create function private.link_safe_path(p text) returns boolean language sql immutable set search_path='' as $$
 select p is not null and left(p,1)='/' and octet_length(p)<=240 and
 p !~ '[[:cntrl:]\\:*?"<>|]' and p !~ '(^|/)\.\.?(/|$)' and
 p !~ '//|[. ](/|$)' and (p='/' or right(p,1)<>'/') and lower(split_part(p,'/',2))<>'.link';
$$;
revoke all on function private.link_safe_path(text) from public,anon,authenticated;

create function public.link_register_file(p_path text,p_name text,p_sha256 text) returns uuid
language plpgsql security definer set search_path='' as $$
declare own uuid; n bigint; item uuid; k text;
begin
 own:=private.link_require_owner();
 if p_path !~ ('^'||own::text||'/[0-9a-f-]{36}/payload$') then raise exception 'Invalid storage path'; end if;
 if p_name is null or octet_length(p_name) not between 1 and 120 or p_name ~ '[/\\[:cntrl:]]' or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'Invalid file'; end if;
 select (metadata->>'size')::bigint into n from storage.objects where bucket_id='link-resources' and name=p_path;
 if n is null or n<0 or n>52428800 then raise exception 'Missing or oversized upload'; end if;
 k:=case when lower(p_name) ~ '\.txt$' then 'text' when lower(p_name) ~ '\.(png|jpe?g|webp)$' then 'image' else 'file' end;
 insert into public.link_resources(owner_id,name,kind,size_bytes,sha256,storage_path)
 values(own,p_name,k,n,p_sha256,p_path) returning id into item;
 return item;
end $$;

create function public.link_queue_command(p_device_id uuid,p_op text,p_path text,
 p_resource_id uuid default null,p_cursor integer default 0,p_overwrite boolean default false)
returns uuid language plpgsql security definer set search_path='' as $$
declare own uuid; item uuid;
begin
 own:=private.link_require_owner();
 perform 1 from public.link_devices where id=p_device_id and owner_id=own for update;
 if not found then raise exception 'Device not owned'; end if;
 if p_op is null or p_op not in ('list','mkdir','put','get') or not private.link_safe_path(p_path) or
    (p_op in ('put','get') and p_path='/') or p_cursor is null or p_cursor<0 then raise exception 'Invalid command'; end if;
 if p_op='get' and octet_length(regexp_replace(p_path,'^.*/',''))>120 then raise exception 'Cloud file name exceeds 120 UTF-8 bytes'; end if;
 if p_op='put' then
   perform 1 from public.link_resources where id=p_resource_id and owner_id=own;
   if not found then raise exception 'Resource not owned'; end if;
 elsif p_resource_id is not null then raise exception 'Unexpected resource'; end if;
 if (select count(*) from public.link_commands where device_id=p_device_id and status in ('waiting','running'))>=30 then raise exception 'Device queue is full'; end if;
 insert into public.link_commands(owner_id,device_id,op,path,resource_id,cursor,overwrite)
 values(own,p_device_id,p_op,p_path,p_resource_id,p_cursor,coalesce(p_overwrite,false)) returning id into item;
 return item;
end $$;

create function public.link_cancel_command(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare own uuid:=private.link_require_owner();
begin
 update public.link_commands set status='cancelled',updated_at=now() where id=p_id and owner_id=own and status='waiting';
 if not found then raise exception 'Only waiting commands can be cancelled'; end if;
end $$;

create function public.link_device_command(p_device_id uuid,p_token text,p_action text,p_payload jsonb default '{}')
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
   return jsonb_build_object('command',jsonb_build_object('id',c.id,'op',c.op,'path',c.path,'cursor',c.cursor,
     'overwrite',c.overwrite,'bytes_done',c.bytes_done,'size',r.size_bytes,'sha256',r.sha256,
     'download_path',r.storage_path,'upload_path',d.owner_id::text||'/'||c.id::text||'/payload'));
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
     if c.op='list' then
       if jsonb_typeof(p_payload->'result'->'entries') is distinct from 'array' or
          jsonb_typeof(p_payload->'result'->'end') is distinct from 'boolean' or
          jsonb_typeof(p_payload->'result'->'cursor') is distinct from 'number'
       then raise exception 'Invalid directory page'; end if;
       if jsonb_array_length(p_payload->'result'->'entries')>8 or
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

revoke all on function public.link_register_file(text,text,text),public.link_queue_command(uuid,text,text,uuid,integer,boolean),public.link_cancel_command(uuid) from public,anon;
grant execute on function public.link_register_file(text,text,text),public.link_queue_command(uuid,text,text,uuid,integer,boolean),public.link_cancel_command(uuid) to authenticated;
revoke all on function public.link_device_command(uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.link_device_command(uuid,text,text,jsonb) to service_role;
commit;
