import { createApplication, logger } from "./app.js";
import { env } from "./config/env.js";

const { app, stop, shutdown } = createApplication();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "Feishu expense audit assistant is listening");
});

let shuttingDown = false;
const handleShutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Graceful shutdown started");
  stop();
  server.close((serverError) => {
    void shutdown()
      .then(() => {
        if (serverError) throw serverError;
        logger.info("Graceful shutdown completed");
        process.exitCode = 0;
      })
      .catch((error) => {
        logger.error({ error }, "Graceful shutdown failed");
        process.exitCode = 1;
      });
  });
};

process.once("SIGTERM", handleShutdown);
process.once("SIGINT", handleShutdown);
