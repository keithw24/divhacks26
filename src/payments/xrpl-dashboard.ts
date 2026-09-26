import "dotenv/config";
import { config } from "../config.js";
import { XrplDashboardBuilder } from "./xrpl/dashboard.js";
import { DASHBOARD_PATH, startXrplDashboardServer } from "./xrpl/dashboard-server.js";
import { createLiveRippleGuard } from "./xrpl/runtime.js";

/**
 * Serves the XRPL Testnet dashboard for the website without starting the iMessage agent.
 *   npm run xrpl:dashboard
 * Read-only. It never provisions wallets or signs transactions.
 */
async function main(): Promise<void> {
  const { guard, ledger, secrets } = createLiveRippleGuard({ autoProvision: false, autonomousEnabled: false });
  const builder = new XrplDashboardBuilder({
    registry: guard.registry,
    audit: guard.audit,
    ledger,
    secrets: () => secrets.knownSecrets(),
  });
  const server = await startXrplDashboardServer(config.xrplDashboardPort, () => builder.build());
  console.info(`XRPL Testnet dashboard: http://127.0.0.1:${server.port}${DASHBOARD_PATH}`);
  console.info("Read-only. No real money. Start the site with: cd frontend && npm run dev");
  const stop = async () => {
    await server.close().catch(() => undefined);
    await ledger.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : "dashboard failed");
  process.exitCode = 1;
});
