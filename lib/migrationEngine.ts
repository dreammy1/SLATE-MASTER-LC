import {
  addMigration,
  deleteMigration,
  getMigration,
  getMigrations,
  MigrationJob,
  ServerEndpoint,
  updateMigration,
} from "./storage";
import { verifyEndpoint, handshakeEndpoint } from "./migrationExecutor";

export type { MigrationJob, ServerEndpoint };

export class MigrationManager {
  static async getAll(): Promise<MigrationJob[]> {
    return getMigrations();
  }

  static async getById(id: string): Promise<MigrationJob | undefined> {
    return getMigration(id);
  }

  static async save(job: MigrationJob): Promise<MigrationJob> {
    const existing = await getMigration(job.id);
    if (existing) {
      const updated = await updateMigration(job.id, job);
      return updated || job;
    }

    return addMigration(job);
  }

  static async delete(id: string): Promise<boolean> {
    return deleteMigration(id);
  }

  /**
   * Real endpoint verification — proxied to migrationExecutor.verifyEndpoint.
   * No more fake setTimeout / hardcoded cpanelVersion / fake Latency values.
   *
   * @deprecated Prefer using verifyEndpoint / handshakeEndpoint directly.
   */
  static async testConnection(
    endpoint: ServerEndpoint & { handshakeToken?: string }
  ): Promise<{ success: boolean; message: string; details?: any }> {
    const diag = await verifyEndpoint(endpoint);
    if (!diag.ok) {
      return {
        success: false,
        message: diag.message,
        details: { diagnostics: diag.details, agentUrl: diag.agentUrl },
      };
    }

    let handshake: any = null;
    const token = (endpoint as any).handshakeToken as string | undefined;
    if (token) {
      const hs = await handshakeEndpoint(endpoint, token, "master-os");
      handshake = { handshakeOk: hs.ok, handshakeMessage: hs.message };
    }

    return {
      success: true,
      message: diag.message,
      details: {
        agentUrl: diag.agentUrl,
        diagnostics: diag.details,
        ...(handshake ?? {}),
      },
    };
  }
}
