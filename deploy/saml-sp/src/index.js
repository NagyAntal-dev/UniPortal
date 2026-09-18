import { loadConfig } from './config.js';
import { IdpCertStore, createSaml } from './saml.js';
import { createProvisioner } from './provision.js';
import { createApp } from './server.js';

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  console.error(`[saml] ${e.message}`);
  process.exit(1);
}

const certStore = new IdpCertStore(cfg);
certStore.start();

const app = createApp(cfg, {
  saml: createSaml(cfg, certStore),
  provisioner: createProvisioner(cfg),
});

const server = app.listen(cfg.port, () => {
  console.info(`[saml] SP fut: ${cfg.entityId}  (ACS: ${cfg.acsUrl}, port ${cfg.port})`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
