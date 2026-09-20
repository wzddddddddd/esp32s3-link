-- LINK private cloud. Run once through Supabase migrations / SQL Editor.
-- No service keys or device credentials are stored in the public schema.
begin;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.link_members (
  user_id uuid primary key references auth.users(id) on delete cascade
);
create table public.link_devices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  name text not null check (length(name) between 1 and 40),
  hardware text not null check (length(hardware) between 1 and 60),
  firmware_version text not null default '',
  capacity_bytes bigint not null default 0 check (capacity_bytes between 0 and 1099511627776),
  used_bytes bigint not null default 0 check (used_bytes between 0 and capacity_bytes),
  files jsonb not null default '[]' check (jsonb_typeof(files) = 'array'),
  last_seen timestamptz,
  last_heartbeat timestamptz,
  created_at timestamptz not null default now()
);
create table private.link_device_secrets (
  device_id uuid primary key references public.link_devices(id) on delete cascade,
  token_hash text not null,
  revoked_at timestamptz
);
alter table private.link_members enable row level security;
alter table private.link_device_secrets enable row level security;
create table public.link_resources (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  name text not null check (length(name) between 1 and 120),
  kind text not null check (kind in ('image', 'text', 'firmware')),
  size_bytes bigint not null check (size_bytes between 1 and 52428800),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text not null unique,
  created_at timestamptz not null default now()
);
create table public.link_tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  device_id uuid not null references public.link_devices(id),
  resource_id uuid not null references public.link_resources(id),
  resource_name text not null,
  kind text not null check (kind in ('image', 'text')),
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text not null,
  storage_path text not null,
  overwrite boolean not null default false,
  status text not null default 'waiting' check (status in ('waiting','downloading','verifying','completed','failed','cancelled')),
  bytes_received bigint not null default 0 check (bytes_received between 0 and size_bytes),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index link_devices_owner on public.link_devices(owner_id);
create index link_resources_owner on public.link_resources(owner_id);
create index link_tasks_owner_created on public.link_tasks(owner_id, created_at desc);
create index link_tasks_device_active on public.link_tasks(device_id, created_at) where status in ('waiting','downloading','verifying');
create unique index link_tasks_unique_active_name on public.link_tasks(device_id, resource_name) where status in ('waiting','downloading','verifying');

create function public.link_is_member() returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from private.link_members where user_id = auth.uid());
$$;
create function private.link_require_owner() returns uuid language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.link_is_member() then
    raise exception '此账号尚未获准使用 LINK 工作空间' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;
alter table public.link_devices enable row level security;
alter table public.link_resources enable row level security;
alter table public.link_tasks enable row level security;
revoke all on public.link_devices, public.link_resources, public.link_tasks from anon, authenticated;
grant select on public.link_devices, public.link_resources, public.link_tasks to authenticated;
create policy link_devices_read on public.link_devices for select to authenticated using (owner_id = (select auth.uid()) and (select public.link_is_member()));
create policy link_resources_read on public.link_resources for select to authenticated using (owner_id = (select auth.uid()) and (select public.link_is_member()));
create policy link_tasks_read on public.link_tasks for select to authenticated using (owner_id = (select auth.uid()) and (select public.link_is_member()));

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('link-resources','link-resources',false,52428800,array['image/png','image/jpeg','image/webp','text/plain','application/octet-stream']);
create policy link_storage_read on storage.objects for select to authenticated
using (bucket_id='link-resources' and (storage.foldername(name))[1]=(select auth.uid())::text and (select public.link_is_member()));
create policy link_storage_upload on storage.objects for insert to authenticated
with check (bucket_id='link-resources' and name ~ ('^' || (select auth.uid())::text || '/[0-9a-f-]{36}/payload$') and (select public.link_is_member()));
-- Only unregistered objects can be removed, for failed-upload cleanup.
create policy link_storage_cleanup on storage.objects for delete to authenticated
using (bucket_id='link-resources' and (storage.foldername(name))[1]=(select auth.uid())::text and (select public.link_is_member()) and not exists(select 1 from public.link_resources r where r.storage_path = storage.objects.name));

create function public.link_register_device(p_name text, p_hardware text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner uuid := private.link_require_owner();
  device uuid;
  token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  perform pg_advisory_xact_lock(hashtextextended(owner::text, 0));
  if (select count(*) from public.link_devices where owner_id=owner) >= 10 then raise exception '设备数量已达到第一版限制（10 台）'; end if;
  if p_name is null or length(trim(p_name)) not between 1 and 40 or p_hardware <> 'ESP32-S3' or p_hardware is null then raise exception '设备名称或硬件型号无效'; end if;
  insert into public.link_devices(owner_id,name,hardware) values(owner,trim(p_name),p_hardware) returning id into device;
  insert into private.link_device_secrets(device_id,token_hash) values(device,encode(sha256(convert_to(token,'UTF8')),'hex'));
  return jsonb_build_object('device_id',device,'token',token);
end;
$$;
create function public.link_register_resource(p_path text, p_name text, p_kind text, p_sha256 text) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  owner uuid := private.link_require_owner();
  object_size bigint;
  object_type text;
  resource uuid;
begin
  if p_path is null or p_path !~ ('^' || owner::text || '/[0-9a-f-]{36}/payload$') then raise exception '无权登记此文件'; end if;
  if p_name is null or length(trim(p_name)) not between 1 and 120 or position('/' in p_name)>0 or position(chr(92) in p_name)>0 then raise exception '文件名无效'; end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then raise exception '校验值无效'; end if;
  select (metadata->>'size')::bigint, metadata->>'mimetype' into object_size,object_type
  from storage.objects where bucket_id='link-resources' and name=p_path for share;
  if object_size is null or object_size not between 1 and 52428800 then raise exception '找不到完整上传的文件，或文件超过限制'; end if;
  if p_kind is null or not coalesce((
    (p_kind='image' and object_type in ('image/png','image/jpeg','image/webp')) or
    (p_kind='text' and object_type='text/plain') or
    (p_kind='firmware' and object_type='application/octet-stream')
  ),false) then raise exception '文件类型与上传信息不一致'; end if;
  insert into public.link_resources(owner_id,name,kind,size_bytes,sha256,storage_path)
  values(owner,trim(p_name),p_kind,object_size,p_sha256,p_path) returning id into resource;
  return resource;
end;
$$;
create function public.link_create_task(p_device_id uuid, p_resource_id uuid, p_overwrite boolean default false) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  owner uuid := private.link_require_owner();
  device public.link_devices;
  resource public.link_resources;
  reserved bigint;
  task uuid;
begin
  select * into device from public.link_devices where id=p_device_id and owner_id=owner for update;
  if not found then raise exception '设备不存在或无权访问'; end if;
  select * into resource from public.link_resources where id=p_resource_id and owner_id=owner;
  if not found then raise exception '资源不存在或无权访问'; end if;
  if resource.kind='firmware' then raise exception '真实 OTA 尚未开放，请先完成设备端分区与回滚方案'; end if;
  if exists(select 1 from public.link_tasks where device_id=device.id and resource_name=resource.name and status in ('waiting','downloading','verifying')) then raise exception '同名资源已有进行中的任务'; end if;
  if not coalesce(p_overwrite,false) and exists(select 1 from jsonb_array_elements(device.files) f where f->>'name'=resource.name) then raise exception '设备存在同名文件，请明确允许覆盖'; end if;
  select coalesce(sum(size_bytes),0) into reserved from public.link_tasks where device_id=device.id and status in ('waiting','downloading','verifying');
  if device.capacity_bytes>0 and resource.size_bytes+reserved > device.capacity_bytes-device.used_bytes then raise exception '设备剩余空间不足（含等待任务）'; end if;
  if (select count(*) from public.link_tasks where device_id=device.id and status in ('waiting','downloading','verifying')) >= 20 then raise exception '设备待执行任务超过限制（20 项）'; end if;
  insert into public.link_tasks(owner_id,device_id,resource_id,resource_name,kind,size_bytes,sha256,storage_path,overwrite)
  values(owner,device.id,resource.id,resource.name,resource.kind,resource.size_bytes,resource.sha256,resource.storage_path,coalesce(p_overwrite,false)) returning id into task;
  return task;
end;
$$;
create function public.link_cancel_task(p_task_id uuid) returns void language plpgsql security definer set search_path = '' as $$
declare owner uuid := private.link_require_owner();
begin
  update public.link_tasks set status='cancelled',updated_at=now() where id=p_task_id and owner_id=owner and status='waiting';
  if not found then raise exception '任务已被领取、已取消或无权访问，无法取消'; end if;
end;
$$;

-- Only the Edge Function service identity may invoke the device endpoint.
create function public.link_device_request(p_device_id uuid, p_token text, p_action text, p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  device public.link_devices;
  task public.link_tasks;
  capacity bigint;
  used bigint;
  received bigint;
  next_status text;
begin
  if p_token is null or length(p_token)<>64 or not exists (
    select 1 from private.link_device_secrets s join public.link_devices d on d.id=s.device_id
    join private.link_members m on m.user_id=d.owner_id
    where s.device_id=p_device_id and s.revoked_at is null and s.token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex')
  ) then raise exception 'Device authentication failed' using errcode='28000'; end if;
  select * into device from public.link_devices where id=p_device_id for update;
  if p_action='heartbeat' then
    if coalesce(p_payload->>'hardware','')<>device.hardware then raise exception 'Hardware mismatch'; end if;
    capacity := (p_payload->>'capacity_bytes')::bigint;
    used := (p_payload->>'used_bytes')::bigint;
    if capacity is null or capacity not between 1 and 1099511627776 or used is null or used not between 0 and capacity then raise exception 'Invalid storage capacity'; end if;
    if p_payload ? 'files' and (jsonb_typeof(p_payload->'files')<>'array' or jsonb_array_length(p_payload->'files')>1000) then raise exception 'Invalid file list'; end if;
    update public.link_devices set capacity_bytes=capacity,used_bytes=used,last_seen=now(),last_heartbeat=now(),
      firmware_version=left(coalesce(p_payload->>'firmware_version',''),60),files=coalesce(p_payload->'files',files) where id=device.id;
    return jsonb_build_object('ok',true,'server_time',now());
  elsif p_action='claim' then
    update public.link_devices set last_seen=now() where id=device.id;
    if device.capacity_bytes=0 or exists(select 1 from public.link_tasks where device_id=device.id and status='completed' and updated_at>device.last_heartbeat) then return jsonb_build_object('task',null,'reason','HEARTBEAT_REQUIRED'); end if;
    select * into task from public.link_tasks where device_id=device.id and status in ('downloading','verifying') order by created_at limit 1 for update;
    if not found then
      select * into task from public.link_tasks where device_id=device.id and status='waiting' order by created_at,id limit 1 for update;
      if not found then return jsonb_build_object('task',null); end if;
      if task.size_bytes > device.capacity_bytes-device.used_bytes then
        update public.link_tasks set status='failed',error='NO_SPACE',updated_at=now() where id=task.id;
        return jsonb_build_object('task',null,'reason','NO_SPACE');
      end if;
      if not task.overwrite and exists(select 1 from jsonb_array_elements(device.files) f where f->>'name'=task.resource_name) then
        update public.link_tasks set status='failed',error='FILE_EXISTS',updated_at=now() where id=task.id;
        return jsonb_build_object('task',null,'reason','FILE_EXISTS');
      end if;
      update public.link_tasks set status='downloading',updated_at=now() where id=task.id returning * into task;
    end if;
    return jsonb_build_object('task',jsonb_build_object('id',task.id,'name',task.resource_name,'kind',task.kind,'size_bytes',task.size_bytes,'sha256',task.sha256,'storage_path',task.storage_path,'status',task.status,'bytes_received',task.bytes_received,'overwrite',task.overwrite));
  elsif p_action='progress' then
    select * into task from public.link_tasks where id=(p_payload->>'task_id')::uuid and device_id=device.id for update;
    if not found then raise exception 'Unknown task'; end if;
    received := (p_payload->>'bytes_received')::bigint;
    next_status := p_payload->>'status';
    if received is null or received < task.bytes_received or received > task.size_bytes then raise exception 'Invalid progress'; end if;
    if next_status=task.status and next_status in ('completed','failed') then return jsonb_build_object('ok',true,'status',task.status); end if;
    if next_status is null or not (
      (task.status='downloading' and next_status in ('downloading','verifying','failed')) or
      (task.status='verifying' and next_status in ('verifying','completed','failed'))
    ) then raise exception 'Invalid task transition'; end if;
    if next_status in ('verifying','completed') and received<>task.size_bytes then raise exception 'File is incomplete'; end if;
    if next_status='completed' and coalesce(p_payload->>'observed_sha256','')<>task.sha256 then raise exception 'Hash verification failed'; end if;
    update public.link_tasks set bytes_received=received,status=next_status,error=case when next_status='failed' then left(coalesce(p_payload->>'error','DEVICE_ERROR'),300) else null end,updated_at=now() where id=task.id;
    update public.link_devices set last_seen=now() where id=device.id;
    return jsonb_build_object('ok',true,'status',next_status);
  else raise exception 'Unsupported action';
  end if;
end;
$$;

revoke all on function public.link_is_member() from public,anon;
grant execute on function public.link_is_member() to authenticated;
revoke all on function private.link_require_owner() from public,anon,authenticated;
revoke all on function public.link_register_device(text,text), public.link_register_resource(text,text,text,text), public.link_create_task(uuid,uuid,boolean), public.link_cancel_task(uuid) from public,anon;
grant execute on function public.link_register_device(text,text), public.link_register_resource(text,text,text,text), public.link_create_task(uuid,uuid,boolean), public.link_cancel_task(uuid) to authenticated;
revoke all on function public.link_device_request(uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.link_device_request(uuid,text,text,jsonb) to service_role;
commit;
