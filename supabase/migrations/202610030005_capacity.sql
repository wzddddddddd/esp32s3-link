-- Storage snapshots share the authenticated heartbeat, including absent SD cards.
begin;
alter table public.link_devices add column storage jsonb;
alter function public.link_device_request(uuid,text,text,jsonb) rename to link_device_request_before_capacity;
revoke all on function public.link_device_request_before_capacity(uuid,text,text,jsonb) from public,anon,authenticated,service_role;
create function public.link_device_request(p_device_id uuid,p_token text,p_action text,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.link_devices; capacity bigint; used bigint; metrics jsonb;
begin
 if p_action is distinct from 'heartbeat' then
   return public.link_device_request_before_capacity(p_device_id,p_token,p_action,p_payload);
 end if;
 perform public.link_device_session(p_device_id,p_token);
 select * into d from public.link_devices where id=p_device_id for update;
 if coalesce(p_payload->>'hardware','')<>d.hardware then raise exception 'Hardware mismatch'; end if;
 capacity:=(p_payload->>'capacity_bytes')::bigint;
 used:=(p_payload->>'used_bytes')::bigint;
 if capacity is null or capacity not between 0 and 1099511627776 or used is null or used not between 0 and capacity then raise exception 'Invalid storage capacity'; end if;
 metrics:=p_payload->'storage';
 if metrics is not null and (
   jsonb_typeof(metrics) is distinct from 'object' or metrics->>'version' is distinct from '1'
   or octet_length(metrics::text)>8192
   or jsonb_typeof(metrics->'memory') is distinct from 'array'
   or jsonb_typeof(metrics->'sd') is distinct from 'object'
 ) then raise exception 'Invalid storage snapshot'; end if;
 if p_payload ? 'files' and (jsonb_typeof(p_payload->'files') is distinct from 'array' or jsonb_array_length(p_payload->'files')>1000) then raise exception 'Invalid file list'; end if;
 update public.link_devices set capacity_bytes=capacity,used_bytes=used,last_seen=now(),last_heartbeat=now(),
   firmware_version=left(coalesce(p_payload->>'firmware_version',''),60),
   files=coalesce(p_payload->'files',files),storage=metrics where id=d.id;
 return jsonb_build_object('ok',true,'server_time',now());
end $$;
revoke all on function public.link_device_request(uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.link_device_request(uuid,text,text,jsonb) to service_role;
do $$
begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime' and not puballtables)
   and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='link_devices') then
   alter publication supabase_realtime add table public.link_devices;
 end if;
end $$;
commit;
