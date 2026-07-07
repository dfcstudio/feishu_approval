import { createApp, logger } from "./app.js";
import { env } from "./config/env.js";

const app = createApp();

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "Feishu expense audit assistant is listening");
});
