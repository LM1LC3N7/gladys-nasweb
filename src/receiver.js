// -----------------------------------------------------------------------------
// Entry point of the `nasweb-push` sub-container (manifest `containers`,
// same image, command `node src/receiver.js`): the HTTP endpoint the module
// posts its status to. No Gladys credentials and no module credentials here:
// see src/push/service.js.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { startPushService } from './push/service.js';

const logger = createLogger({ name: 'nasweb-push' });

try {
  const service = await startPushService({ env: process.env, logger });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      logger.info(`${signal}: stopping`);
      service.stop().finally(() => process.exit(0));
    });
  }
} catch (err) {
  logger.error('The push receiver could not start', err);
  process.exit(1);
}
