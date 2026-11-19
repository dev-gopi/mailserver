require("dotenv").config();

const fs = require("node:fs");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

function readSecret(name) {
    const secretFile = process.env[`${name}_FILE`];

    if (secretFile) {
        try {
            return fs.readFileSync(secretFile, "utf8").replace(/\r?\n$/, "");
        } catch (error) {
            throw new Error(`${name}_FILE could not be read: ${error.message}`);
        }
    }

    return process.env[name];
}

function validateAdministratorPassword(password, username) {
    const commonPasswords = new Set([
        "passwordpassword",
        "password123456",
        "12345678901234",
        "qwertyuiopasdf",
        "adminadminadmin",
        "welcome1234567",
        "letmein1234567",
        "changeme123456"
    ]);

    if (password.length < 14) {
        throw new Error("Administrator passwords must contain at least 14 characters.");
    }

    if (password.length > 128) {
        throw new Error("Administrator passwords cannot exceed 128 characters.");
    }

    if (/^(.)(\1){7,}$/.test(password)) {
        throw new Error("Choose a less predictable password.");
    }

    const normalizedPassword = password.toLowerCase().replace(/[\s._-]/g, "");

    if (commonPasswords.has(normalizedPassword)) {
        throw new Error("This password is too common.");
    }

    const normalizedUsername = String(username || "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");

    if (normalizedUsername && normalizedPassword.includes(normalizedUsername)) {
        throw new Error("Password must not contain the username.");
    }
}

function createPool() {
    const configuredMax = Number.parseInt(process.env.PG_POOL_MAX || "10", 10);

    const max = Number.isFinite(configuredMax)
        ? Math.min(40, Math.max(2, configuredMax))
        : 10;

    const common = {
        max,
        min: 0,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        allowExitOnIdle: false,
        application_name: "mailcore-admin-password-reset",
        keepAlive: true
    };

    const databaseUrl = readSecret("DATABASE_URL");

    if (databaseUrl) {
        return new Pool({
            connectionString: databaseUrl,
            ...common
        });
    }

    const host = process.env.PGHOST;
    const database = process.env.PGDATABASE;
    const user = process.env.PGUSER;
    const password = readSecret("PGPASSWORD");
    const port = Number.parseInt(process.env.PGPORT || "5432", 10);

    if (!host || !database || !user || !password) {
        throw new Error(
            "Database configuration missing. Set DATABASE_URL or PGHOST, PGDATABASE, PGUSER and PGPASSWORD."
        );
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("PGPORT must be a valid TCP port.");
    }

    return new Pool({
        host,
        port,
        database,
        user,
        password,
        ...common
    });
}

async function resetAdministratorPassword(pool, username, newPassword) {
    const client = await pool.connect();
    let transactionOpen = false;

    try {
        await client.query("BEGIN");
        transactionOpen = true;

        const lookup = await client.query(
            `SELECT id, username, password_hash
       FROM admins
       WHERE username = $1
       FOR UPDATE`,
            [username]
        );

        const admin = lookup.rows[0];

        if (!admin) {
            throw new Error(`Administrator "${username}" was not found.`);
        }

        validateAdministratorPassword(newPassword, admin.username);

        if (await bcrypt.compare(newPassword, admin.password_hash)) {
            throw new Error("New password must differ from the current password.");
        }

        const passwordHash = await bcrypt.hash(newPassword, 12);

        await client.query(
            `UPDATE admins
       SET password_hash = $1,
           must_change_password = FALSE,
           password_changed_at = now(),
           failed_login_count = 0,
           locked_until = NULL,
           reset_token_hash = NULL,
           reset_token_expires_at = NULL
       WHERE id = $2`,
            [passwordHash, admin.id]
        );

        const revoked = await client.query(
            `UPDATE admin_sessions
       SET revoked_at = now()
       WHERE admin_id = $1
         AND revoked_at IS NULL`,
            [admin.id]
        );

        await client.query(
            `INSERT INTO audit_log
       (admin_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [
                admin.id,
                "admin.password.reset.cli",
                "admin",
                String(admin.id),
                JSON.stringify({
                    source: "cli",
                    revokedSessions: revoked.rowCount || 0
                })
            ]
        );

        await client.query("COMMIT");
        transactionOpen = false;

        return {
            username: admin.username,
            revokedSessions: revoked.rowCount || 0
        };
    } catch (error) {
        if (transactionOpen) {
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                console.error("Database rollback failed:", rollbackError.message);
            }
        }

        throw error;
    } finally {
        client.release();
    }
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length !== 2 || !args[0] || !args[1]) {
        console.error(
            "Usage: node dist/scripts/reset-password.js <username> <new_password>"
        );
        process.exitCode = 2;
        return;
    }

    const username = args[0].trim();
    const newPassword = args[1];

    if (!username) {
        throw new Error("Username cannot be empty.");
    }

    const pool = createPool();

    pool.on("error", (error) => {
        console.error("Unexpected PostgreSQL pool error:", error.message);
    });

    try {
        const result = await resetAdministratorPassword(
            pool,
            username,
            newPassword
        );

        console.log(
            `Success: password for administrator "${result.username}" has been reset.`
        );

        console.log(
            `Revoked ${result.revokedSessions} active session(s).`
        );
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(`Failed to reset administrator password: ${error.message}`);
    process.exitCode = 1;
});
