import { handlePublishQueue } from "./queue.ts";
import { handleConnectorRequest } from "./router.ts";
import { D1ConnectorStore } from "./storage.ts";
import type { ConnectorEnv, ConnectorQueueMessage, QueueBatchLike } from "./types.ts";

const connectorWorker = {
  fetch(request: Request, env: ConnectorEnv): Promise<Response> {
    return handleConnectorRequest(request, env);
  },

  queue(batch: QueueBatchLike<ConnectorQueueMessage>, env: ConnectorEnv): Promise<void> {
    return handlePublishQueue(batch, env);
  },

  async scheduled(_controller: ScheduledController, env: ConnectorEnv): Promise<void> {
    await new D1ConnectorStore(env.CONNECTOR_DB).purgeExpiredData(Date.now());
  },
};

export default connectorWorker;
