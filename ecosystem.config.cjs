/**
 * pm2 process definitions for a VM deployment.
 *
 * .cjs rather than .js because the package is ESM and pm2 reads this file with
 * require().
 *
 * Two apps, deploy whichever you need:
 *
 *   pm2 start ecosystem.config.cjs --only moi-mcp-read
 *   pm2 start ecosystem.config.cjs --only moi-mcp-write
 *
 * Secrets do not belong here. Put WC_PROJECT_ID in a .env file next to this
 * one; the server loads it. This file is committed, that one is not.
 */
module.exports = {
  apps: [
    {
      // Read-only gateway. Stateless, holds nothing, safe to run several of.
      name: "moi-mcp-read",
      script: "dist/http.js",
      // Pinned so pm2 resurrect after a reboot still resolves dist/ and .env,
      // whatever directory it happens to run from.
      cwd: "/opt/moi-mcp",
      instances: 1,
      env: {
        NODE_ENV: "production",
        PORT: 8787,
        MOI_NETWORK: "voyage",
        LOG_LEVEL: "info",
      },
    },
    {
      // Write gateway. Holds a wallet pairing per user.
      //
      // instances stays 1 and exec_mode stays fork. In cluster mode pm2 runs
      // several copies behind a shared socket, and a request landing on a copy
      // that is not holding your pairing cannot reach your phone. Setting
      // REDIS_URL is what makes more than one copy conceivable; without it this
      // is the only safe shape.
      //
      // Restart rather than reload for the same reason: reload deliberately
      // overlaps old and new processes, and two of these at once fight over the
      // same WalletConnect relay identity. A two second gap is the cheaper
      // failure.
      name: "moi-mcp-write",
      script: "dist/server.js",
      cwd: "/opt/moi-mcp",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        HOSTED_PORT: 8788,
        MOI_NETWORK: "voyage",
        LOG_LEVEL: "info",
        // Must match the public hostname exactly. It is the OAuth issuer, so a
        // mismatch makes sign-in fail in a way that reads as a client bug.
        PUBLIC_URL: "https://mcp.voyage.moi.technology",
        // Wallet pairings and the write journal. Back this up, or set
        // REDIS_URL and it stops mattering.
        MOI_DATA_DIR: "/var/lib/moi-mcp",
      },
    },
  ],
};
