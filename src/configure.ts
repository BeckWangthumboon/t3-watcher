import {
  DEFAULT_CONFIG_DIR,
  exchangeT3PairingUrl,
  saveT3Connection,
} from "./t3-connection.ts";

const pairingUrl = Bun.argv[2]?.trim();
if (!pairingUrl) {
  console.error("Usage: bun run configure '<T3 pairing URL>'");
  console.error("Create one on the T3 host with: npx t3 pair");
  process.exit(1);
}

const connection = await exchangeT3PairingUrl(pairingUrl);
await saveT3Connection(connection);

console.log(`Connected T3 Watcher to ${connection.label} (${connection.t3HttpUrl}).`);
console.log(`Saved connection details under ${DEFAULT_CONFIG_DIR} with owner-only permissions.`);
