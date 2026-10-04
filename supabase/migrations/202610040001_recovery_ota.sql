-- Real OTA uses the independent recovery application; ordinary file transfer remains separate.
begin;
alter table public.link_devices add column firmware_mode text not null default 'main'
 check(firmware_mode in ('main','recovery'));
alter table public.link_devices add column ota jsonb;
alter table public.link_commands drop constraint link_commands_op_check;
alter table public.link_commands add constraint link_commands_op_check check(op in (
 'list','mkdir','put','get','delete','info','capabilities','music.list','music.status',
 'music.play','music.pause','music.resume','music.stop','music.volume',
 'ota.enter','ota.status','ota.install','ota.cancel','ota.return'));

create function private.link_require_main(p_device_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare d public.link_devices;
begin
 select * into d from public.link_devices where id=p_device_id for update;
 if d.firmware_mode<>'main' or d.ota->>'phase'='handoff' or exists(
   select 1 from public.link_commands where device_id=p_device_id and op='ota.enter' and status in ('waiting','running'))
 then raise exception 'DEVICE_RECOVERY_MODE'; end if;
end $$;
revoke all on function private.link_require_main(uuid) from public,anon,authenticated,service_role;

alter function public.link_queue_command(uuid,text,text,uuid,integer,boolean) rename to link_queue_command_before_ota;
revoke all on function public.link_queue_command_before_ota(uuid,text,text,uuid,integer,boolean) from public,anon,authenticated,service_role;
create function public.link_queue_command(p_device_id uuid,p_op text,p_path text,p_resource_id uuid default null,p_cursor integer default 0,p_overwrite boolean default false)
returns uuid language plpgsql security definer set search_path='' as $$
begin
 perform private.link_require_online(p_device_id); perform private.link_require_main(p_device_id);
 return public.link_queue_command_before_ota(p_device_id,p_op,p_path,p_resource_id,p_cursor,p_overwrite);
end $$;
alter function public.link_create_task(uuid,uuid,boolean) rename to link_create_task_before_ota;
revoke all on function public.link_create_task_before_ota(uuid,uuid,boolean) from public,anon,authenticated,service_role;
create function public.link_create_task(p_device_id uuid,p_resource_id uuid,p_overwrite boolean default false)
returns uuid language plpgsql security definer set search_path='' as $$
begin
 perform private.link_require_online(p_device_id); perform private.link_require_main(p_device_id);
 return public.link_create_task_before_ota(p_device_id,p_resource_id,p_overwrite);
end $$;
alter function public.link_queue_remote(uuid,text,text,jsonb) rename to link_queue_remote_before_ota;
revoke all on function public.link_queue_remote_before_ota(uuid,text,text,jsonb) from public,anon,authenticated,service_role;
create function public.link_queue_remote(p_device_id uuid,p_op text,p_path text default '/',p_args jsonb default '{}')
returns uuid language plpgsql security definer set search_path='' as $$
declare own uuid:=private.link_require_owner(); item uuid;
begin
 perform private.link_require_online(p_device_id);
 if p_op not in ('info','capabilities') then perform private.link_require_main(p_device_id); end if;
 if p_op='info' then
  if p_path is distinct from '/' or p_args is distinct from '{}'::jsonb then raise exception 'Invalid info arguments'; end if;
  if (select count(*) from public.link_commands where device_id=p_device_id and status in ('waiting','running'))>=30 then raise exception 'Device queue is full'; end if;
  insert into public.link_commands(owner_id,device_id,op,path) values(own,p_device_id,p_op,'/') returning id into item;
  return item;
 end if;
 return public.link_queue_remote_before_ota(p_device_id,p_op,p_path,p_args);
end $$;

create function public.link_queue_ota(p_device_id uuid,p_op text,p_args jsonb default '{}',p_resource_id uuid default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare own uuid:=private.link_require_owner(); d public.link_devices; r public.link_resources; item uuid; job text;
begin
 perform private.link_require_online(p_device_id);
 select * into d from public.link_devices where id=p_device_id and owner_id=own for update;
 if not found then raise exception 'Device not owned'; end if;
 if p_op is null or p_op not in ('ota.enter','ota.status','ota.install','ota.cancel','ota.return')
    or p_args is null or jsonb_typeof(p_args)<>'object' or octet_length(p_args::text)>1024
    or exists(select 1 from jsonb_object_keys(p_args) k where k not in ('job','target_role'))
 then raise exception 'Invalid OTA arguments'; end if;
 job:=p_args->>'job';
 if p_args ? 'job' and (jsonb_typeof(p_args->'job')<>'string' or length(job) not between 1 and 64 or job !~ '^[A-Za-z0-9_-]+$') then raise exception 'Invalid OTA job'; end if;
 if p_args ? 'target_role' and p_args->>'target_role' is distinct from 'main' then raise exception 'OTA target must be main'; end if;
 if p_op in ('ota.enter','ota.install') and (job is null or p_args->>'target_role' is distinct from 'main') then raise exception 'Missing OTA job/target_role'; end if;
 if p_op='ota.enter' then
  perform private.link_require_main(p_device_id);
  if d.ota is null then raise exception 'OTA_NOT_SUPPORTED'; end if;
  if exists(select 1 from public.link_commands where device_id=d.id and status='running')
     or exists(select 1 from public.link_tasks where device_id=d.id and status in ('downloading','verifying'))
  then raise exception 'DEVICE_BUSY'; end if;
  update public.link_commands set status='cancelled',error='OTA_ENTERING',updated_at=now() where device_id=d.id and status='waiting';
  update public.link_tasks set status='cancelled',error='OTA_ENTERING',updated_at=now() where device_id=d.id and status='waiting';
 elsif p_op<>'ota.status' and d.firmware_mode<>'recovery' then raise exception 'OTA_RECOVERY_REQUIRED'; end if;
 if p_op='ota.install' then
  if coalesce((d.ota->>'active')::boolean,false) or coalesce((d.ota->>'return_pending')::boolean,false)
    or exists(select 1 from public.link_commands where device_id=d.id and op='ota.install' and status in ('waiting','running')) then raise exception 'OTA_BUSY'; end if;
  select * into r from public.link_resources where id=p_resource_id and owner_id=own;
  if not found or r.kind<>'firmware' or r.size_bytes not between 288 and 4194304 then raise exception 'Invalid main firmware resource'; end if;
  p_args:=p_args||jsonb_build_object('size',r.size_bytes,'sha256',r.sha256);
 elsif p_resource_id is not null then raise exception 'Unexpected OTA resource'; end if;
 if p_op='ota.return' and (d.ota->>'can_return' is distinct from 'true'
   or d.ota->>'main_dirty' is distinct from 'false' or coalesce((d.ota->>'active')::boolean,false)) then raise exception 'OTA_MAIN_DIRTY_OR_BUSY'; end if;
 if p_op in ('ota.cancel','ota.return') and job is not null and d.ota->>'job' is distinct from job then raise exception 'OTA_JOB_MISMATCH'; end if;
 if (select count(*) from public.link_commands where device_id=d.id and status in ('waiting','running'))>=30 then raise exception 'Device queue is full'; end if;
 insert into public.link_commands(owner_id,device_id,op,path,args,resource_id) values(own,d.id,p_op,'/',p_args,p_resource_id) returning id into item;
 return item;
end $$;

alter function public.link_device_request(uuid,text,text,jsonb) rename to link_device_request_before_ota;
revoke all on function public.link_device_request_before_ota(uuid,text,text,jsonb) from public,anon,authenticated,service_role;
create function public.link_device_request(p_device_id uuid,p_token text,p_action text,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare reply jsonb; d public.link_devices; mode text; snapshot jsonb;
begin
 perform public.link_device_session(p_device_id,p_token);
 select * into d from public.link_devices where id=p_device_id for update;
 if p_action='claim' and d.firmware_mode<>'main' then return jsonb_build_object('task',null,'reason','DEVICE_RECOVERY_MODE'); end if;
 if p_action='heartbeat' then
  mode:=coalesce(p_payload->>'mode','main'); snapshot:=p_payload->'ota';
  if mode not in ('main','recovery') or (snapshot is not null and (jsonb_typeof(snapshot)<>'object' or octet_length(snapshot::text)>8192)) then raise exception 'Invalid firmware mode/OTA snapshot'; end if;
  if snapshot is not null and (
    (snapshot ? 'job' and (jsonb_typeof(snapshot->'job')<>'string' or length(snapshot->>'job')>64))
    or (snapshot ? 'received' and (jsonb_typeof(snapshot->'received')<>'number' or (snapshot->>'received')::numeric not between 0 and 4194304))
    or (snapshot ? 'total' and (jsonb_typeof(snapshot->'total')<>'number' or (snapshot->>'total')::numeric not between 0 and 4194304))
    or (snapshot ? 'received' and trunc((snapshot->>'received')::numeric)<>(snapshot->>'received')::numeric)
    or (snapshot ? 'total' and trunc((snapshot->>'total')::numeric)<>(snapshot->>'total')::numeric)
    or (snapshot ? 'received' and snapshot ? 'total' and (snapshot->>'received')::numeric>(snapshot->>'total')::numeric)
    or (snapshot ? 'sha256' and snapshot->>'sha256'<>'' and snapshot->>'sha256' !~ '^[0-9a-f]{64}$')
    or (snapshot ? 'active' and jsonb_typeof(snapshot->'active')<>'boolean')
    or (snapshot ? 'main_dirty' and jsonb_typeof(snapshot->'main_dirty')<>'boolean')
    or (snapshot ? 'can_return' and jsonb_typeof(snapshot->'can_return')<>'boolean')
  ) then raise exception 'Invalid OTA snapshot'; end if;
 end if;
 reply:=public.link_device_request_before_ota(p_device_id,p_token,p_action,p_payload);
 if p_action='heartbeat' then
  update public.link_devices set firmware_mode=mode,ota=snapshot where id=d.id;
  if mode='recovery' then
   update public.link_commands set status='cancelled',error='DEVICE_RECOVERY_MODE',updated_at=now()
    where device_id=d.id and status in ('waiting','running') and op not in ('info','capabilities','ota.status','ota.install','ota.cancel','ota.return');
   update public.link_tasks set status='cancelled',error='DEVICE_RECOVERY_MODE',updated_at=now() where device_id=d.id and status in ('waiting','downloading','verifying');
  elsif d.firmware_mode='recovery' then
   update public.link_commands set status='cancelled',error='DEVICE_MAIN_MODE',updated_at=now()
    where device_id=d.id and status in ('waiting','running') and op in ('ota.install','ota.cancel','ota.return');
  end if;
 end if;
 return reply;
end $$;

alter function public.link_device_command(uuid,text,text,jsonb) rename to link_device_command_before_ota;
revoke all on function public.link_device_command_before_ota(uuid,text,text,jsonb) from public,anon,authenticated,service_role;
create function public.link_device_command(p_device_id uuid,p_token text,p_action text,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.link_devices; c public.link_commands; r public.link_resources;
begin
 perform public.link_device_session(p_device_id,p_token);
 select * into d from public.link_devices where id=p_device_id for update;
 if p_action<>'command_claim' then return public.link_device_command_before_ota(p_device_id,p_token,p_action,p_payload); end if;
 update public.link_devices set last_seen=now() where id=d.id;
 select * into c from public.link_commands where device_id=d.id and status in ('running','waiting')
  and (d.firmware_mode='main' and op not in ('ota.install','ota.cancel','ota.return')
    or d.firmware_mode='recovery' and op in ('info','capabilities','ota.status','ota.install','ota.cancel','ota.return'))
  order by case when status='running' then 0 when op in ('ota.cancel','ota.return','ota.status') then 1 else 2 end,created_at,id limit 1 for update;
 if not found then return jsonb_build_object('command',null); end if;
 if c.status='waiting' then update public.link_commands set status='running',updated_at=now() where id=c.id returning * into c; end if;
 if c.op in ('put','ota.install') then select * into r from public.link_resources where id=c.resource_id and owner_id=d.owner_id; end if;
 return jsonb_build_object('command',jsonb_build_object('id',c.id,'op',c.op,'path',c.path,'cursor',c.cursor,'limit',32,
   'overwrite',c.overwrite,'bytes_done',c.bytes_done,'size',r.size_bytes,'sha256',r.sha256,
   'download_path',r.storage_path,'upload_path',d.owner_id::text||'/'||c.id::text||'/payload')||c.args);
end $$;
revoke all on function public.link_queue_command(uuid,text,text,uuid,integer,boolean),public.link_create_task(uuid,uuid,boolean),
 public.link_queue_remote(uuid,text,text,jsonb),public.link_queue_ota(uuid,text,jsonb,uuid) from public,anon;
grant execute on function public.link_queue_command(uuid,text,text,uuid,integer,boolean),public.link_create_task(uuid,uuid,boolean),
 public.link_queue_remote(uuid,text,text,jsonb),public.link_queue_ota(uuid,text,jsonb,uuid) to authenticated;
revoke all on function public.link_device_request(uuid,text,text,jsonb),public.link_device_command(uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.link_device_request(uuid,text,text,jsonb),public.link_device_command(uuid,text,text,jsonb) to service_role;
commit;
