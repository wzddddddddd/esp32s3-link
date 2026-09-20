import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("cloud isolation, upload registration and authenticated device lifecycle", async () => {
  const db = new PGlite();
  const owner = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  const outsider = "33333333-3333-4333-8333-333333333333";
  const hash = "a".repeat(64);
  const path = `${owner}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/payload`;
  try {
    // Supabase-managed schemas/roles are represented here; production SQL is unchanged.
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; create schema storage;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,public,storage to anon,authenticated,service_role;
      grant execute on function auth.uid() to anon,authenticated,service_role;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,metadata jsonb);
      alter table storage.objects enable row level security;
      grant select,insert,update,delete on storage.objects to authenticated;
      create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;
      insert into auth.users values('${owner}'),('${other}'),('${outsider}');
    `);
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202609200001_link_cloud.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await db.exec(
      `insert into private.link_members values('${owner}'),('${other}')`,
    );
    async function role(name, user = "") {
      await db.exec(
        `reset role; set role ${name}; select set_config('request.jwt.claim.sub','${user}',false)`,
      );
    }
    async function rpc(name, values) {
      const args = values.map((_, i) => `$${i + 1}`).join(",");
      const result = await db.query(
        `select public.${name}(${args}) as result`,
        values,
      );
      return result.rows[0].result;
    }
    await role("authenticated", owner);
    const device = await rpc("link_register_device", [
      "Test device",
      "ESP32-S3",
    ]);
    assert.match(device.token, /^[0-9a-f]{64}$/);
    await assert.rejects(
      db.query("select * from private.link_device_secrets"),
      /permission denied/,
    );
    await assert.rejects(
      db.query("update public.link_devices set used_bytes=0"),
      /permission denied/,
    );
    await assert.rejects(
      rpc("link_device_request", [device.device_id, device.token, "claim", {}]),
      /permission denied/,
    );
    await db.query(
      "insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)",
      ["link-resources", path, { size: 32, mimetype: "text/plain" }],
    );
    const resource = await rpc("link_register_resource", [
      path,
      "book.txt",
      "text",
      hash,
    ]);
    const removed = await db.query(
      "delete from storage.objects where name=$1 returning name",
      [path],
    );
    assert.equal(
      removed.rows.length,
      0,
      "registered objects must not be deletable by browser clients",
    );
    const task = await rpc("link_create_task", [
      device.device_id,
      resource,
      false,
    ]);
    await assert.rejects(
      rpc("link_create_task", [device.device_id, resource, false]),
      /进行中的任务/,
    );
    await role("authenticated", other);
    assert.equal(
      (await db.query("select * from public.link_devices")).rows.length,
      0,
    );
    assert.equal(
      (await db.query("select * from public.link_resources")).rows.length,
      0,
    );
    assert.equal(
      (await db.query("select * from public.link_tasks")).rows.length,
      0,
    );
    assert.equal(
      (await db.query("select * from storage.objects")).rows.length,
      0,
    );
    await assert.rejects(
      rpc("link_create_task", [device.device_id, resource, false]),
      /无权访问/,
    );
    await role("authenticated", outsider);
    await assert.rejects(
      rpc("link_register_device", ["Outsider", "ESP32-S3"]),
      /尚未获准/,
    );
    await role("anon");
    await assert.rejects(
      db.query("select * from public.link_tasks"),
      /permission denied/,
    );
    await assert.rejects(
      rpc("link_register_device", ["Anon", "ESP32-S3"]),
      /permission denied/,
    );
    await role("service_role");
    await assert.rejects(
      rpc("link_device_request", [
        device.device_id,
        "b".repeat(64),
        "claim",
        {},
      ]),
      /authentication failed/,
    );
    const request = (action, payload = {}) =>
      rpc("link_device_request", [
        device.device_id,
        device.token,
        action,
        payload,
      ]);
    assert.equal((await request("claim")).reason, "HEARTBEAT_REQUIRED");
    await request("heartbeat", {
      hardware: "ESP32-S3",
      firmware_version: "0.1.0",
      capacity_bytes: 1024,
      used_bytes: 0,
      files: [],
    });
    const claimed = await request("claim");
    assert.equal(claimed.task.id, task);
    assert.equal(
      (await request("claim")).task.id,
      task,
      "repeated claim resumes the existing task",
    );
    await assert.rejects(
      request("progress", {
        task_id: task,
        status: "completed",
        bytes_received: 32,
        observed_sha256: hash,
      }),
      /Invalid task transition/,
    );
    await assert.rejects(
      request("progress", {
        task_id: task,
        status: "verifying",
        bytes_received: 20,
      }),
      /incomplete/,
    );
    await request("progress", {
      task_id: task,
      status: "downloading",
      bytes_received: 16,
    });
    await assert.rejects(
      request("progress", {
        task_id: task,
        status: "downloading",
        bytes_received: 8,
      }),
      /Invalid progress/,
    );
    await request("progress", {
      task_id: task,
      status: "verifying",
      bytes_received: 32,
    });
    await assert.rejects(
      request("progress", {
        task_id: task,
        status: "completed",
        bytes_received: 32,
        observed_sha256: "b".repeat(64),
      }),
      /Hash verification failed/,
    );
    await request("progress", {
      task_id: task,
      status: "completed",
      bytes_received: 32,
      observed_sha256: hash,
    });
    assert.equal((await request("claim")).reason, "HEARTBEAT_REQUIRED");
    await role("authenticated", owner);
    assert.equal(
      (
        await db.query("select status from public.link_tasks where id=$1", [
          task,
        ])
      ).rows[0].status,
      "completed",
    );
    await assert.rejects(rpc("link_cancel_task", [task]), /无法取消/);
    const cancelled = await rpc("link_create_task", [
      device.device_id,
      resource,
      true,
    ]);
    await rpc("link_cancel_task", [cancelled]);
    assert.equal(
      (
        await db.query("select status from public.link_tasks where id=$1", [
          cancelled,
        ])
      ).rows[0].status,
      "cancelled",
    );
    const firmwarePath = `${owner}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/payload`;
    await db.query(
      "insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)",
      [
        "link-resources",
        firmwarePath,
        { size: 32, mimetype: "application/octet-stream" },
      ],
    );
    const firmware = await rpc("link_register_resource", [
      firmwarePath,
      "firmware.bin",
      "firmware",
      hash,
    ]);
    await assert.rejects(
      rpc("link_create_task", [device.device_id, firmware, false]),
      /OTA 尚未开放/,
    );
    const missingMimePath = `${owner}/cccccccc-cccc-4ccc-8ccc-cccccccccccc/payload`;
    await db.query(
      "insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)",
      ["link-resources", missingMimePath, { size: 32 }],
    );
    await assert.rejects(
      rpc("link_register_resource", [
        missingMimePath,
        "image.png",
        "image",
        hash,
      ]),
      /类型/,
    );
    const cleanup = await db.query(
      "delete from storage.objects where name=$1 returning name",
      [missingMimePath],
    );
    assert.equal(cleanup.rows.length, 1);
  } finally {
    await db.close();
  }
});
