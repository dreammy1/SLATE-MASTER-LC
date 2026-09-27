export interface ServerEndpoint {
  serverName: string;
  cpanelHost: string;
  cpanelPort?: number;
  cpanelUser: string;
  cpanelApiToken: string;
  fileManagerPath: string;
  siteUrl: string;
  dbHost: string;
  dbName: string;
  dbUser: string;
  dbPass: string;
  handshakeToken?: string;
  token?: string;
}

export interface MigrationJobMeta {
  srcZipPaths?: Record<string, string>;
  srcSqlPaths?: Record<string, string>;
  tgtCredentials?: Array<{ index: number; db_name: string; db_user: string; db_password: string; db_host?: string }>;
  [key: string]: any;
}

export interface MigrationJob {
  id: string;
  title: string;
  source: ServerEndpoint;
  destination: ServerEndpoint;
  targets?: ServerEndpoint[];
  options: {
    syncFiles: boolean;
    syncDatabase: boolean;
    replaceDomainUrls: boolean;
    fixFilePermissions: boolean;
  };
  status: "IDLE" | "TESTING" | "READY" | "RUNNING" | "COMPLETED" | "FAILED";
  progress: number;
  totalFiles: number;
  transferredFiles: number;
  totalDbTables: number;
  transferredDbTables: number;
  currentStep: string;
  logs: Array<{ timestamp: string; message: string; type: "info" | "success" | "warn" | "error" }>;
  createdAt: string;
  completedAt?: string;
  error?: string;
  _meta?: MigrationJobMeta;
}
