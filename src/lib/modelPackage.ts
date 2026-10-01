/** Portable package definitions describe invocation and lifecycle, never capabilities. */
export type PackageCommand = { executable: string; executableEnv?: string; args?: string[]; env?: Record<string, string> };
export type ModelPackage = {
  version: 1;
  kind?: "model" | "runtime";
  id: string;
  name: string;
  revision: string;
  adapter: { id: string; command?: PackageCommand; files?: string[] };
  model?: string;
  access: 'local_http' | 'remote_http' | 'cli' | 'proofreader';
  config?: Record<string, unknown>;
  dependencies?: string[];
  environment?: string[];
  artifacts?: string[];
  artifactDirectories?: Array<{ path: string; rootEnv?: string; subdirectory?: string }>;
  setup?: PackageCommand;
  lifecycle?: Partial<Record<'install' | 'installation-status' | 'start' | 'health' | 'stop', PackageCommand>>;
  service?: { id: string; concurrency?: number; resource?: string; device?: string };
};

export type PackageAttachment = { name: string; path: string; mimeType: string };
export type AdapterRequest = {
  protocol: 1;
  requestId: string;
  action: 'execute' | 'install' | 'installation-status' | 'start' | 'health' | 'stop';
  task?: { id: string; version: number };
  input: Record<string, unknown>;
  attachments: PackageAttachment[];
  model: { id: string; slug: string; revision: string; config: Record<string, unknown> };
  settings: { workDirectory: string; device?: string };
};
