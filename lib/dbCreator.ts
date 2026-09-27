import mysql from "mysql2/promise";

export interface DirectDbConfig {
  host: string;
  port?: number;
  adminUser: string;
  adminPass: string;
  targetDbName: string;
  targetDbUser: string;
  targetDbPass: string;
}

export interface CpanelDbConfig {
  cpanelHost: string;
  cpanelUser: string;
  apiToken: string;
  targetDbName: string;
  targetDbUser: string;
  targetDbPass: string;
}

export class DatabaseProvisioningService {
  static async provisionDirectMySQL(cfg: DirectDbConfig): Promise<{ success: boolean; message: string }> {
    let connection: mysql.Connection | null = null;
    try {
      connection = await mysql.createConnection({
        host: cfg.host,
        port: cfg.port || 3306,
        user: cfg.adminUser,
        password: cfg.adminPass,
      });

      const safeDb = cfg.targetDbName.replace(/[^a-zA-Z0-9_]/g, "");
      const safeUser = cfg.targetDbUser.replace(/[^a-zA-Z0-9_]/g, "");

      await connection.query(`CREATE DATABASE IF NOT EXISTS \`${safeDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
      await connection.query(`CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?;`, [safeUser, cfg.targetDbPass]);
      await connection.query(`GRANT ALL PRIVILEGES ON \`${safeDb}\`.* TO ?@'%';`, [safeUser]);
      await connection.query(`FLUSH PRIVILEGES;`);

      return {
        success: true,
        message: `Database '${safeDb}' and user '${safeUser}' created and mapped successfully.`,
      };
    } catch (err: any) {
      return { success: false, message: `Direct MySQL Provisioning Error: ${err.message}` };
    } finally {
      if (connection) await connection.end();
    }
  }

  static async provisionCpanel(cfg: CpanelDbConfig): Promise<{ success: boolean; message: string }> {
    try {
      const authHeader = `cpanel ${cfg.cpanelUser}:${cfg.apiToken}`;
      const baseUrl = `https://${cfg.cpanelHost}:2083/execute`;

      const createDbRes = await fetch(`${baseUrl}/Mysql/create_database?name=${encodeURIComponent(cfg.targetDbName)}`, {
        headers: { Authorization: authHeader }
      });
      const createDbData = await createDbRes.json();
      if (createDbData.status === 0) throw new Error(createDbData.errors?.[0] || "Failed to create cPanel DB");

      return {
        success: true,
        message: `cPanel DB '${cfg.targetDbName}' provisioned successfully.`,
      };
    } catch (err: any) {
      return { success: false, message: `cPanel API Provisioning Error: ${err.message}` };
    }
  }
}
