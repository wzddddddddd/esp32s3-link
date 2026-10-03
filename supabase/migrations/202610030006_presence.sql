-- Device presence is separate from storage heartbeats. Reject offline work atomically.
begin;
alter table public.link_devices add column wifi_connected boolean not null default false;
alter table public.link_devices add column presence_seen timestamptz;
alter table public.link_devices add column connection_session uuid;

create function public.link_device_presence(p_device_id uuid,p_token text,p_event text,p_session uuid default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare d public.link_devices;
begin
 perform public.link_device_session(p_device_id,p_token);
 select * into d from public.link_devices where id=p_device_id for update;
 if p_event not in ('open','renew','close','http') then raise exception 'Invalid presence event'; end if;
 if p_event in ('open','renew','close') and p_session is null then raise exception 'Missing session'; end if;
 if p_event in ('renew','close') and d.connection_session is distinct from p_session then return false; end if;
 if p_event='renew' and not d.wifi_connected then return false; end if;
 if p_event='close' then
   update public.link_devices set wifi_connected=false,presence_seen=clock_timestamp() where id=p_device_id;
 else
   -- Requests that never reached an offline device must not execute on reconnect.
   if p_event in ('open','http') and (not d.wifi_connected or d.presence_seen is null or d.presence_seen<clock_timestamp()-interval '10 seconds') then
     update public.link_commands set status='cancelled',error='WIFI_NOT_CONNECTED',updated_at=now() where device_id=p_device_id and status='waiting';
     update public.link_tasks set status='cancelled',error='WIFI_NOT_CONNECTED',updated_at=now() where device_id=p_device_id and status='waiting';
   end if;
   update public.link_devices set wifi_connected=true,presence_seen=clock_timestamp(),
     connection_session=case when p_event='http' and d.wifi_connected and d.presence_seen>=clock_timestamp()-interval '10 seconds' then d.connection_session when p_event='http' then null else p_session end where id=p_device_id;
 end if;
 if p_event='close' then
   update public.link_commands set status='cancelled',error='WIFI_NOT_CONNECTED',updated_at=now() where device_id=p_device_id and status='waiting';
   update public.link_tasks set status='cancelled',error='WIFI_NOT_CONNECTED',updated_at=now() where device_id=p_device_id and status='waiting';
 end if;
 return true;
end $$;
revoke all on function public.link_device_presence(uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.link_device_presence(uuid,text,text,uuid) to service_role;

create function private.link_require_online(p_device_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare own uuid:=private.link_require_owner(); d public.link_devices;
begin
 select * into d from public.link_devices where id=p_device_id and owner_id=own for update;
 if not found then raise exception 'Device not owned'; end if;
 if not d.wifi_connected or d.presence_seen is null or d.presence_seen<clock_timestamp()-interval '10 seconds' then
   raise exception using errcode='P0001',message='WIFI_NOT_CONNECTED';
 end if;
end $$;
revoke all on function private.link_require_online(uuid) from public,anon,authenticated,service_role;

alter function public.link_queue_command(uuid,text,text,uuid,integer,boolean) rename to link_queue_command_before_presence;
revoke all on function public.link_queue_command_before_presence(uuid,text,text,uuid,integer,boolean) from public,anon,authenticated,service_role;
create function public.link_queue_command(p_device_id uuid,p_op text,p_path text,p_resource_id uuid default null,p_cursor integer default 0,p_overwrite boolean default false)
returns uuid language plpgsql security definer set search_path='' as $$
begin
 perform private.link_require_online(p_device_id);
 return public.link_queue_command_before_presence(p_device_id,p_op,p_path,p_resource_id,p_cursor,p_overwrite);
end $$;

alter function public.link_queue_remote(uuid,text,text,jsonb) rename to link_queue_remote_before_presence;
revoke all on function public.link_queue_remote_before_presence(uuid,text,text,jsonb) from public,anon,authenticated,service_role;
create function public.link_queue_remote(p_device_id uuid,p_op text,p_path text default '/',p_args jsonb default '{}')
returns uuid language plpgsql security definer set search_path='' as $$
begin
 perform private.link_require_online(p_device_id);
 return public.link_queue_remote_before_presence(p_device_id,p_op,p_path,p_args);
end $$;

alter function public.link_create_task(uuid,uuid,boolean) rename to link_create_task_before_presence;
revoke all on function public.link_create_task_before_presence(uuid,uuid,boolean) from public,anon,authenticated,service_role;
create function public.link_create_task(p_device_id uuid,p_resource_id uuid,p_overwrite boolean default false)
returns uuid language plpgsql security definer set search_path='' as $$
begin
 perform private.link_require_online(p_device_id);
 return public.link_create_task_before_presence(p_device_id,p_resource_id,p_overwrite);
end $$;
revoke all on function public.link_queue_command(uuid,text,text,uuid,integer,boolean),public.link_queue_remote(uuid,text,text,jsonb),public.link_create_task(uuid,uuid,boolean) from public,anon;
grant execute on function public.link_queue_command(uuid,text,text,uuid,integer,boolean),public.link_queue_remote(uuid,text,text,jsonb),public.link_create_task(uuid,uuid,boolean) to authenticated;
commit;
