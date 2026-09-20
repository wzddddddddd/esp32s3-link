export type ResourceKind = "image" | "text" | "firmware";
export type Page =
  "overview" | "resources" | "send" | "tasks" | "ota" | "settings";
export type TaskStatus =
  | "waiting"
  | "downloading"
  | "verifying"
  | "restarting"
  | "completed"
  | "failed"
  | "cancelled";
export interface Resource {
  id: string;
  name: string;
  kind: ResourceKind;
  size: number;
  addedAt: string;
  origin: "sample" | "local";
  preview?: string;
  excerpt?: string;
  file?: File;
  version?: string;
  hardware?: string;
  notes?: string;
}
export interface Device {
  id: string;
  name: string;
  online: boolean;
  hardware: string;
  version: string;
  capacity: number;
  used: number;
  lastSeen: string;
}
export interface TransferTask {
  id: string;
  deviceId: string;
  resourceId: string;
  resourceName: string;
  size: number;
  kind: ResourceKind;
  version?: string;
  status: TaskStatus;
  progress: number;
  createdAt: string;
  error?: string;
  overwrite: boolean;
}
export interface DeviceFile {
  id: string;
  deviceId: string;
  resourceName: string;
  size: number;
  kind: ResourceKind;
}
// Future cloud adapter. Browser code must never contain device/admin secrets.
export interface CloudGateway {
  listDevices(): Promise<Device[]>;
  listResources(): Promise<Resource[]>;
  uploadResource(
    file: File,
    onProgress: (percent: number) => void,
  ): Promise<Resource>;
  createTask(input: {
    deviceId: string;
    resourceId: string;
    overwrite: boolean;
  }): Promise<TransferTask>;
  listTasks(): Promise<TransferTask[]>;
  cancelTask(taskId: string): Promise<void>;
}
